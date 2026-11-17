//! El agente de ESTA máquina: dónde está su socket y la conexión con él.
//!
//! La ventana no habla con la red ni sabe de llaves: le habla al agente local
//! (`@dotrino/remote-desktop-agent` ≥ 0.7.0) por su socket (`remote-desktop.sock` en la carpeta
//! del enlace, `~/.dotrino/agent/remote-desktop-agent/<nombre>/`), en JSON por líneas. El agente
//! hace de cliente de las otras máquinas con su propio enlace (agent/far.js): la identidad, el
//! transporte y el cifrado siguen en los pilares.
//!
//! Cada conexión es una suscripción: lee líneas, las convierte en eventos (la escena, los
//! parches, los cuadros de vídeo YA decodificados) y se cierra al soltarla.

use crate::proto::{Patch, Rect, Scene};
use crate::video::Decoder;
use iced::futures::{SinkExt, Stream};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// El tipo del agente: nombra su carpeta.
pub const KIND: &str = "remote-desktop-agent";
/// El socket del agente en la carpeta del enlace (agent/index.js `LOCAL_SOCKET`).
pub const SOCKET: &str = "remote-desktop.sock";
/// Windows: el archivo con el nombre de la tubería y su llave (`@dotrino/remote-agent/local`).
pub const PIPE_FILE: &str = "remote-desktop.pipe";

/// ¿Hay (o hubo) un agente escuchando en esa carpeta?
fn listening(dir: &Path) -> bool {
    if cfg!(windows) { dir.join(PIPE_FILE).is_file() } else { dir.join(SOCKET).exists() }
}
/// El paquete y el comando del agente.
pub const AGENT_PKG: &str = "@dotrino/remote-desktop-agent";
pub const AGENT_CMD: &str = "dotrino-remote-desktop-agent";

/// La raíz de los agentes de este tipo (`DOTRINO_AGENT_HOME` la cambia, igual que en el agente).
pub fn instances_root() -> Option<PathBuf> {
    let home = match std::env::var_os("DOTRINO_AGENT_HOME") {
        Some(h) if !h.is_empty() => PathBuf::from(h),
        _ => PathBuf::from(std::env::var_os("HOME")?).join(".dotrino").join("agent"),
    };
    Some(home.join(KIND))
}

/// Un agente de esta máquina: su nombre, su carpeta, si está enlazado y si su socket existe.
#[derive(Debug, Clone, PartialEq)]
pub struct Instance {
    pub name: String,
    pub dir: PathBuf,
    pub linked: bool,
    pub socket: bool,
}

fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 32 && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Los agentes de esta máquina, por nombre.
pub fn instances(root: &Path) -> Vec<Instance> {
    let Ok(rd) = std::fs::read_dir(root) else { return Vec::new() };
    let mut out: Vec<Instance> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            if !valid_name(&name) || !e.path().is_dir() {
                return None;
            }
            let dir = e.path();
            Some(Instance { linked: dir.join("link.json").is_file(), socket: listening(&dir), name, dir })
        })
        .filter(|i| i.linked || i.socket)
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// El agente que usa la ventana: el pedido (`--name`), o el único, o el primero con socket.
pub fn pick(list: &[Instance], wanted: Option<&str>) -> Option<Instance> {
    if let Some(w) = wanted {
        return list.iter().find(|i| i.name == w).cloned();
    }
    list.iter().find(|i| i.socket).or_else(|| list.first()).cloned()
}

/// Una máquina de la cuenta con el escritorio remoto encendido (agent/far.js).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Machine {
    pub sub: String,
    pub id: String,
    #[serde(default)]
    pub name: String,
}

impl Machine {
    pub fn label(&self) -> String {
        if self.name.is_empty() { self.id.clone() } else { self.name.clone() }
    }
}

/// Un fallo que contestó el agente (o la otra máquina por él).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Fail {
    pub code: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default, rename = "retryMs")]
    pub retry_ms: Option<f64>,
}

/// Un cuadro de vídeo ya decodificado, en RGBA.
#[derive(Debug, Clone)]
pub struct Frame {
    pub id: i64,
    pub rect: Rect,
    pub relay: bool,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Lo que llega de una conexión.
#[derive(Debug, Clone)]
pub enum Event {
    /// La conexión está abierta: por aquí se le manda.
    Ready(mpsc::UnboundedSender<String>),
    Hello { version: String },
    Machines(Vec<Machine>),
    Via(Machine),
    Scene(Box<Scene>),
    Patch(Box<Patch>),
    Frame(Box<Frame>),
    /// El vídeo de ese nodo espera a un camino directo (agentes anteriores).
    VideoWait(i64),
    Unlocked,
    Resumed,
    Fail(Fail),
    /// No se pudo abrir el socket (no hay agente, o es anterior a la 0.7.0).
    NoAgent(String),
    /// El agente cerró la conexión (se reinició, o se paró).
    Closed,
}

/// Qué abre una conexión: la lista de máquinas, o una máquina (`via`), o esta máquina.
#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub enum Target {
    Machines,
    Machine(String),
    ThisMachine,
}

/// La clave de una suscripción: cambiarla abre otra conexión (así se reconecta).
#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub struct Conn {
    pub id: u64,
    /// La carpeta del enlace del agente.
    pub dir: PathBuf,
    pub target: Target,
}

trait Duplex: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin> Duplex for T {}

/// Abre el socket del agente. En Windows, la tubería con nombre y su llave en la primera línea.
#[cfg(unix)]
async fn open(dir: &Path) -> Result<Box<dyn Duplex>, String> {
    let file = dir.join(SOCKET);
    tokio::net::UnixStream::connect(&file).await.map(|s| Box::new(s) as Box<dyn Duplex>).map_err(|e| format!("{}: {e}", file.display()))
}

#[cfg(windows)]
async fn open(dir: &Path) -> Result<Box<dyn Duplex>, String> {
    let file = dir.join(PIPE_FILE);
    let text = std::fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?;
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", file.display()))?;
    let (Some(pipe), Some(key)) = (v["pipe"].as_str(), v["key"].as_str()) else { return Err(format!("{} is malformed", file.display())) };
    let mut c = tokio::net::windows::named_pipe::ClientOptions::new().open(pipe).map_err(|e| format!("{pipe}: {e}"))?;
    let auth = serde_json::json!({ "type": "local-auth", "key": key }).to_string() + "\n";
    c.write_all(auth.as_bytes()).await.map_err(|e| format!("{pipe}: {e}"))?;
    Ok(Box::new(c))
}

#[derive(Deserialize)]
struct Wire {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
struct VFrame {
    id: i64,
    rect: Rect,
    #[serde(default)]
    q: Option<String>,
    data: String,
}

/// Una línea del agente, como evento. `None` si no es nada que la ventana use. Un mensaje que la
/// ventana SÍ usa y no se puede leer no se calla: sale como fallo `bad-message`, con el motivo.
pub fn parse(line: &str, decoder: &mut Decoder) -> Option<Event> {
    let w: Wire = serde_json::from_str(line).ok()?;
    let bad = |e: String| Event::Fail(Fail { code: "bad-message".into(), message: format!("{}: {e}", w.kind), reason: None, retry_ms: None });
    let read = |f: &dyn Fn(Value) -> Result<Event, serde_json::Error>| -> Event {
        match serde_json::from_str::<Value>(line).and_then(f) {
            Ok(ev) => ev,
            Err(e) => bad(e.to_string()),
        }
    };
    Some(match w.kind.as_str() {
        "hello" => read(&|v| Ok(Event::Hello { version: v["version"].as_str().unwrap_or("?").to_string() })),
        "machines" => read(&|v| serde_json::from_value::<Vec<Machine>>(v["list"].clone()).map(Event::Machines)),
        "via" => read(&|v| serde_json::from_value::<Machine>(v["machine"].clone()).map(Event::Via)),
        "scene" => match serde_json::from_str::<Scene>(line) {
            Ok(s) => Event::Scene(Box::new(s)),
            Err(e) => bad(e.to_string()),
        },
        "patch" => match serde_json::from_str::<Patch>(line) {
            Ok(p) => Event::Patch(Box::new(p)),
            Err(e) => bad(e.to_string()),
        },
        "vframe" => {
            let f: VFrame = match serde_json::from_str(line) {
                Ok(f) => f,
                Err(e) => return Some(bad(e.to_string())),
            };
            use base64::Engine;
            let data = match base64::engine::general_purpose::STANDARD.decode(f.data.as_bytes()) {
                Ok(d) => d,
                Err(e) => return Some(bad(e.to_string())),
            };
            match decoder.decode(f.id, &data) {
                Ok(Some((width, height, rgba))) => Event::Frame(Box::new(Frame { id: f.id, rect: f.rect, relay: f.q.as_deref() == Some("relay"), width, height, rgba })),
                Ok(None) => return None,
                Err(e) => Event::Fail(Fail { code: "video-decode".into(), message: e, reason: None, retry_ms: None }),
            }
        }
        "vwait" => read(&|v| serde_json::from_value::<i64>(v["id"].clone()).map(Event::VideoWait)),
        "unlocked" => Event::Unlocked,
        "resumed" => Event::Resumed,
        "fail" => match serde_json::from_str::<Fail>(line) {
            Ok(f) => f.into(),
            Err(e) => bad(e.to_string()),
        },
        _ => return None,
    })
}

impl From<Fail> for Event {
    fn from(f: Fail) -> Self {
        Event::Fail(f)
    }
}

/// La conexión con el agente local, como flujo de eventos.
pub fn connect(conn: &Conn) -> impl Stream<Item = Event> + use<> {
    let conn = conn.clone();
    iced::stream::channel(256, async move |mut out: iced::futures::channel::mpsc::Sender<Event>| {
        let stream = match open(&conn.dir).await {
            Ok(s) => s,
            Err(e) => {
                let _ = out.send(Event::NoAgent(e)).await;
                return;
            }
        };
        let (read, mut write) = tokio::io::split(stream);
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        // Lo primero, según a qué se abre: la lista, o el tubo a otra máquina.
        match &conn.target {
            Target::Machines => {
                let _ = tx.send(r#"{"type":"machines"}"#.to_string());
            }
            Target::Machine(sub) => {
                let _ = tx.send(serde_json::json!({ "type": "via", "machine": sub }).to_string());
            }
            Target::ThisMachine => {}
        }
        let _ = out.send(Event::Ready(tx)).await;
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if write.write_all(line.as_bytes()).await.is_err() || write.write_all(b"\n").await.is_err() {
                    break;
                }
            }
        });
        let mut lines = BufReader::new(read).lines();
        let mut decoder = Decoder::default();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(ev) = parse(&line, &mut decoder)
                && out.send(ev).await.is_err() {
                    return;
                }
        }
        let _ = out.send(Event::Closed).await;
    })
}

/// Arranca el agente de ese nombre por detrás (ya enlazado: sin terminal no puede enlazarse).
pub fn start_agent(name: &str) -> Result<(), String> {
    let mut cmd = std::process::Command::new(AGENT_CMD);
    cmd.args(["--name", name]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // En su propio grupo: cerrar la ventana no se lleva al agente.
        cmd.process_group(0);
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("{AGENT_CMD}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn las_instancias_se_encuentran_y_se_elige_la_que_escucha() {
        let root = std::env::temp_dir().join(format!("rd-inst-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (n, link, sock) in [("default", true, false), ("work", true, true), ("Bad Name", true, true), ("empty", false, false)] {
            let d = root.join(n);
            std::fs::create_dir_all(&d).unwrap();
            if link {
                std::fs::write(d.join("link.json"), "{}").unwrap();
            }
            if sock {
                std::fs::write(d.join(SOCKET), "").unwrap();
            }
        }
        let list = instances(&root);
        assert_eq!(list.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["default", "work"]);
        assert_eq!(pick(&list, None).unwrap().name, "work");
        assert_eq!(pick(&list, Some("default")).unwrap().name, "default");
        assert!(pick(&list, Some("nope")).is_none());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn las_lineas_del_agente_se_leen() {
        let mut d = Decoder::default();
        match parse(r#"{"type":"hello","product":"remote-desktop-agent","version":"0.7.0"}"#, &mut d) {
            Some(Event::Hello { version }) => assert_eq!(version, "0.7.0"),
            other => panic!("{other:?}"),
        }
        match parse(r#"{"type":"machines","list":[{"sub":"P","id":"AB12-CD34","name":""}]}"#, &mut d) {
            Some(Event::Machines(l)) => assert_eq!(l[0].label(), "AB12-CD34"),
            other => panic!("{other:?}"),
        }
        match parse(r#"{"type":"fail","code":"unauthorized","message":"no","reason":"missing-cap"}"#, &mut d) {
            Some(Event::Fail(f)) => assert_eq!(f.reason.as_deref(), Some("missing-cap")),
            other => panic!("{other:?}"),
        }
        match parse(r#"{"type":"fail","code":"wait","message":"slow down","retryMs":30000}"#, &mut d) {
            Some(Event::Fail(f)) => assert_eq!(f.retry_ms, Some(30000.0)),
            other => panic!("{other:?}"),
        }
        assert!(matches!(parse(r#"{"type":"patch","seq":2,"base":1,"put":[],"del":[3]}"#, &mut d), Some(Event::Patch(_))));
        assert!(matches!(parse(r#"{"type":"resumed"}"#, &mut d), Some(Event::Resumed)));
        assert!(parse(r#"{"type":"nope"}"#, &mut d).is_none());
        // Un mensaje que se usa y no se puede leer se dice, no se calla.
        match parse(r#"{"type":"scene","seq":"x"}"#, &mut d) {
            Some(Event::Fail(f)) => assert_eq!(f.code, "bad-message"),
            other => panic!("{other:?}"),
        }
        assert!(parse("not json", &mut d).is_none());
    }
}
