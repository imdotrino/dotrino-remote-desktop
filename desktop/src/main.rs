//! Dotrino Remote Desktop — la ventana para ver y usar el escritorio de tus otras máquinas.
//!
//! Como la app de escritorio de Dotrino Terminal, esta ventana no implementa ni la identidad ni
//! el transporte ni el cifrado: le habla al agente de ESTA máquina (`@dotrino/remote-desktop-agent`
//! ≥ 0.7.0) por su socket local, y el agente entra en las otras máquinas con su propio enlace
//! (agent/far.js). El protocolo es el mismo que el de la PWA (agent/index.js): la escena de
//! accesibilidad, sus parches, el vídeo de los huecos y el ratón y el teclado de vuelta.
//!
//! Lo que se ve es un ESQUEMA del escritorio (render.rs), con el aspecto del tema y no el de las
//! apps de la máquina; lo que no publica accesibilidad llega como vídeo (video.rs).
//!
//! Opciones: `--name <n>` (qué agente de esta máquina usar, si hay varios) y `--this-machine`
//! (abre esta misma máquina, SOLO PARA VER: sirve para probar sin otra máquina. No manda ratón ni
//! teclado, porque mover el ratón sobre la ventana movería el mismo ratón que se está mirando).

#![cfg_attr(windows, windows_subsystem = "windows")]

mod agent;
mod keys;
mod proto;
mod render;
mod video;

use agent::{Conn, Event as AgentEvent, Fail, Instance, Machine, Target};
use dotrino_theme::{BODY, BRAND, Pal, card, fonts, ghost, primary, tab};
use iced::widget::{button, canvas, column, container, row, scrollable, space, text, text_input};
use iced::{Element, Length, Size, Subscription, Task, Theme, theme, window};
use proto::{Rect, Scene, apply_patch, is_monitor_win, owners};
use render::{DeskView, Input, Tile, ViewBox, Words};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender;

const ICON_PNG: &[u8] = include_bytes!("../assets/icon-512.png");
/// Sin escena en este rato tras pedirla, se abre otra sesión (un canal puede quedar abierto y muerto).
/// Más que los 8 s de la PWA: leer un escritorio con muchas ventanas por accesibilidad tarda (medido
/// 21 s con 26 ventanas y 1241 nodos), y cortar antes lo vuelve a empezar de cero.
const SCENE_WAIT: Duration = Duration::from_secs(30);
const MAX_TRIES: u32 = 3;
/// Sin cuadro en este rato, se vuelve a pedir el vídeo (el agente rehace la captura).
const VIDEO_RETRY: Duration = Duration::from_secs(3);
/// Cada cuánto se refresca la lista de máquinas, y se reintenta el agente local si no estaba.
const LIST_EVERY: Duration = Duration::from_secs(10);
const AGENT_RETRY: Duration = Duration::from_secs(3);

fn main() -> iced::Result {
    let icon = window::icon::from_file_data(ICON_PNG, None).ok();
    iced::application(App::boot, App::update, App::view)
        .title(App::title)
        .subscription(App::subscription)
        .theme(App::theme)
        .font(fonts::QUICKSAND)
        .font(fonts::QUICKSAND_BOLD)
        .font(fonts::COMFORTAA)
        .default_font(BODY)
        .window(window::Settings {
            size: Size::new(1200.0, 800.0),
            min_size: Some(Size::new(560.0, 420.0)),
            icon,
            // Linux: la clase de la ventana, para que el escritorio la ate al .desktop (su icono).
            #[cfg(target_os = "linux")]
            platform_specific: window::settings::PlatformSpecific { application_id: "dotrino-remote-desktop".into(), ..Default::default() },
            ..Default::default()
        })
        .run()
}

/// Las opciones de la línea de órdenes.
#[derive(Debug, Default, Clone)]
struct Args {
    name: Option<String>,
    this_machine: bool,
}

fn args() -> Args {
    let mut a = Args::default();
    let mut it = std::env::args().skip(1);
    while let Some(x) = it.next() {
        match x.as_str() {
            "--name" => a.name = it.next(),
            "--this-machine" => a.this_machine = true,
            _ => {}
        }
    }
    a
}

/// Qué se mira del escritorio: la ventana activa (por defecto), todo, o una ventana elegida.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Watch {
    Active,
    All,
    Win(i64),
}

#[derive(Debug, Clone)]
enum Message {
    Mode(theme::Mode),
    Tick(Instant),
    List((u64, AgentEvent)),
    Desk((u64, AgentEvent)),
    Open(Option<Machine>),
    Back,
    Retry,
    StartAgent,
    View(Input),
    Pick(Watch),
    ZoomBy(f32),
    Fit,
    CodeInput(String),
    CodeSend,
}

/// Lo que se sabe de la conexión de un escritorio.
enum Phase {
    Connecting,
    Locked,
    Live,
    Failed(String),
}

struct Desk {
    /// `None`: esta misma máquina (`--this-machine`).
    machine: Option<Machine>,
    conn: Conn,
    tx: Option<UnboundedSender<String>>,
    phase: Phase,
    status: String,
    attempt: u32,
    scene_due: Option<Instant>,
    reconnect_at: Option<Instant>,
    scene: Option<Scene>,
    owner: HashMap<i64, i64>,
    order: Vec<usize>,
    code: Option<String>,
    code_input: String,
    code_error: Option<String>,
    watch: Watch,
    task_order: Vec<i64>,
    view: ViewBox,
    /// La ventana que se encuadró la última vez (para encuadrar solo al cambiar).
    last_fit: Option<Option<i64>>,
    need_fit: bool,
    video_id: Option<i64>,
    video_got: bool,
    video_asked: Option<Instant>,
    video_tries: u32,
    tiles: HashMap<i64, Tile>,
    cache: canvas::Cache,
}

impl Desk {
    fn send(&self, v: serde_json::Value) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(v.to_string());
        }
    }
    fn rect_of(&self, id: i64) -> Option<Rect> {
        self.scene.as_ref()?.nodes.iter().find(|n| n.id == id).map(|n| n.rect())
    }
    fn label(&self, es: bool) -> String {
        match &self.machine {
            Some(m) => m.label(),
            None => (if es { "Esta máquina" } else { "This machine" }).to_string(),
        }
    }
    /// Los monitores (el fondo de cada uno es una ventana más), de izquierda a derecha.
    fn monitors(&self) -> Vec<(i64, Rect)> {
        let Some(s) = &self.scene else { return Vec::new() };
        let mut m: Vec<(i64, Rect)> = s.wins.iter().filter(|w| is_monitor_win(w)).filter_map(|w| self.rect_of(w.id).map(|r| (w.id, r))).collect();
        m.sort_by(|a, b| a.1.x.total_cmp(&b.1.x).then(a.1.y.total_cmp(&b.1.y)));
        m
    }
    fn is_monitor(&self, id: i64) -> bool {
        self.monitors().iter().any(|(m, _)| *m == id)
    }
    /// La ventana que se mira ahora (o None = todo el escritorio).
    fn target(&self) -> Option<i64> {
        let s = self.scene.as_ref()?;
        match self.watch {
            Watch::All => None,
            Watch::Active => s.wins.iter().find(|w| w.active).map(|w| w.id),
            Watch::Win(id) => Some(id),
        }
    }
    /// La ventana que va encima de las demás (no un monitor).
    fn top(&self) -> Option<i64> {
        self.target().filter(|id| self.rect_of(*id).is_some() && !self.is_monitor(*id))
    }
    fn screen(&self) -> Size {
        self.scene.as_ref().map(|s| Size::new(s.screen.w, s.screen.h)).unwrap_or(Size::new(1.0, 1.0))
    }
}

struct App {
    es: bool,
    mode: theme::Mode,
    args: Args,
    instances: Vec<Instance>,
    instance: Option<Instance>,
    agent_version: Option<String>,
    next_id: u64,
    list_conn: Option<Conn>,
    list_tx: Option<UnboundedSender<String>>,
    list_asked: Option<Instant>,
    machines: Option<Vec<Machine>>,
    list_error: Option<String>,
    no_agent: Option<String>,
    agent_retry_at: Option<Instant>,
    notice: Option<String>,
    desk: Option<Desk>,
}

impl App {
    fn boot() -> (Self, Task<Message>) {
        let mut app = App {
            es: dotrino_theme::system_is_spanish(),
            mode: theme::Mode::Light,
            args: args(),
            instances: Vec::new(),
            instance: None,
            agent_version: None,
            next_id: 0,
            list_conn: None,
            list_tx: None,
            list_asked: None,
            machines: None,
            list_error: None,
            no_agent: None,
            agent_retry_at: None,
            notice: None,
            desk: None,
        };
        app.find_agent();
        if app.args.this_machine {
            app.open_desk(None, 0, None);
        }
        (app, iced::system::theme().map(Message::Mode))
    }

    fn t(&self, es: &'static str, en: &'static str) -> &'static str {
        if self.es { es } else { en }
    }

    fn title(&self) -> String {
        match &self.desk {
            Some(d) => format!("{} — Dotrino Remote Desktop", d.label(self.es)),
            None => "Dotrino Remote Desktop".to_string(),
        }
    }

    fn theme(&self) -> Theme {
        dotrino_theme::theme(self.mode)
    }

    fn id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    /// Busca el agente de esta máquina y abre la conexión de la lista.
    fn find_agent(&mut self) {
        let root = agent::instances_root();
        self.instances = root.as_deref().map(agent::instances).unwrap_or_default();
        self.instance = agent::pick(&self.instances, self.args.name.as_deref());
        self.list_tx = None;
        self.list_conn = None;
        match self.instance.clone() {
            Some(i) => {
                let id = self.id();
                self.list_conn = Some(Conn { id, dir: i.dir, target: Target::Machines });
                self.list_asked = Some(Instant::now());
            }
            None => {
                self.no_agent = Some(match &self.args.name {
                    Some(n) => format!("{} «{n}»", self.t("No hay ningún agente con el nombre", "There is no agent named")),
                    None => self.t("Esta máquina no tiene el agente del escritorio remoto enlazado.", "This machine has no remote desktop agent linked.").to_string(),
                });
                self.agent_retry_at = Some(Instant::now() + AGENT_RETRY);
            }
        }
    }

    fn subscription(&self) -> Subscription<Message> {
        let mut subs = vec![iced::time::every(Duration::from_millis(500)).map(Message::Tick), iced::system::theme_changes().map(Message::Mode)];
        if let Some(c) = &self.list_conn {
            subs.push(Subscription::run_with(c.clone(), agent::connect).with(c.id).map(Message::List));
        }
        if let Some(d) = &self.desk {
            subs.push(Subscription::run_with(d.conn.clone(), agent::connect).with(d.conn.id).map(Message::Desk));
        }
        Subscription::batch(subs)
    }

    /// Un fallo, en palabras de la persona (main.js `errorText`).
    fn fail_text(&self, f: &Fail) -> String {
        let es = self.es;
        match (f.code.as_str(), f.reason.as_deref()) {
            ("unauthorized", Some("missing-cap")) => self.t(
                "El agente de esta máquina no tiene el permiso «desktop». Dáselo en tu bóveda: dotrino-vault caps <ID> +desktop (el ID sale con: dotrino-remote-desktop-agent info).",
                "This machine's agent lacks the «desktop» permission. Grant it in your vault: dotrino-vault caps <ID> +desktop (the ID comes from: dotrino-remote-desktop-agent info).",
            ).to_string(),
            ("unauthorized", r) => format!("{} {}", self.t("No autorizado:", "Not authorized:"), r.unwrap_or("?")),
            ("bad-code", _) => self.t("Clave incorrecta.", "Wrong code.").to_string(),
            ("wait", _) => {
                let s = (f.retry_ms.unwrap_or(0.0) / 1000.0).ceil();
                if es { format!("Demasiados intentos: espera {s} s.") } else { format!("Too many tries: wait {s} s.") }
            }
            ("blocked", _) => self.t("Un aprobador bloqueó este aparato; se desbloquea en la bóveda.", "An approver blocked this device; unblock it in the vault.").to_string(),
            ("no-session-bus", _) => self.t("Esa máquina no tiene una sesión de escritorio abierta.", "That machine has no desktop session open.").to_string(),
            ("no-a11y-bus", _) => self.t("Esa máquina no tiene el servicio de accesibilidad del escritorio (at-spi2-core).", "That machine has no desktop accessibility service (at-spi2-core).").to_string(),
            ("no-raise", _) => self.t("Esa máquina no deja traer ventanas al frente desde aquí: la ves, pero puede estar tapada por otra.", "That machine does not let windows be brought to the front from here: you see it, but another may cover it.").to_string(),
            ("no-video", _) => self.t("Esa máquina no puede enviar la imagen de esta ventana (le falta ffmpeg, o usa Wayland).", "That machine cannot send the picture of this window (it lacks ffmpeg, or uses Wayland).").to_string(),
            ("unknown-type", _) => self.t("Esa máquina tiene una versión anterior del escritorio remoto: actualízala.", "That machine runs an older version of the remote desktop: update it.").to_string(),
            ("window-not-found", _) => self.t("Esa ventana ya no está abierta.", "That window is no longer open.").to_string(),
            ("not-linked", _) => self.t("El agente de esta máquina no está enlazado a tu bóveda.", "This machine's agent is not linked to your vault.").to_string(),
            ("no-machine", _) => self.t("Esa máquina ya no tiene el escritorio remoto encendido.", "That machine no longer has the remote desktop running.").to_string(),
            ("no-record", _) => self.t("No se pudo consultar tu bóveda (¿está encendida?).", "Could not reach your vault (is it on?).").to_string(),
            _ => format!("{}{}", self.t("Error: ", "Error: "), if f.message.is_empty() { &f.code } else { &f.message }),
        }
    }

    fn open_desk(&mut self, machine: Option<Machine>, attempt: u32, keep: Option<Desk>) {
        let Some(dir) = self.instance.as_ref().map(|i| i.dir.clone()) else { return };
        let target = match &machine {
            Some(m) => Target::Machine(m.sub.clone()),
            None => Target::ThisMachine,
        };
        let id = self.id();
        let conn = Conn { id, dir, target };
        let label = match &machine {
            Some(m) => m.label(),
            None => self.t("esta máquina", "this machine").to_string(),
        };
        let connecting = if self.es { format!("Conectando con {label}…") } else { format!("Connecting to {label}…") };
        let d = match keep {
            // Otra sesión con la misma máquina: se conserva lo que se mira, la clave y las imágenes.
            Some(mut d) => {
                d.conn = conn;
                d.tx = None;
                d.attempt = attempt;
                d.phase = Phase::Connecting;
                d.scene_due = None;
                d.reconnect_at = None;
                d.status = if self.es { format!("No llega nada de {label}: conectando otra vez…") } else { format!("Nothing is arriving from {label}: connecting again…") };
                d.video_got = false;
                d.video_asked = None;
                d
            }
            None => Desk {
                machine,
                conn,
                tx: None,
                phase: Phase::Connecting,
                status: connecting,
                attempt,
                scene_due: None,
                reconnect_at: None,
                scene: None,
                owner: HashMap::new(),
                order: Vec::new(),
                code: None,
                code_input: String::new(),
                code_error: None,
                watch: Watch::Active,
                task_order: Vec::new(),
                view: ViewBox::default(),
                last_fit: None,
                need_fit: false,
                video_id: None,
                video_got: false,
                video_asked: None,
                video_tries: 0,
                tiles: HashMap::new(),
                cache: canvas::Cache::new(),
            },
        };
        self.desk = Some(d);
    }

    fn update(&mut self, msg: Message) -> Task<Message> {
        match msg {
            Message::Mode(m) => {
                self.mode = m;
                if let Some(d) = &self.desk {
                    d.cache.clear();
                }
            }
            Message::Tick(now) => self.tick(now),
            Message::List((id, ev)) => {
                if self.list_conn.as_ref().map(|c| c.id) == Some(id) {
                    self.on_list(ev);
                }
            }
            Message::Desk((id, ev)) => {
                if self.desk.as_ref().map(|d| d.conn.id) == Some(id) {
                    self.on_desk(ev);
                }
            }
            Message::Open(m) => {
                self.notice = None;
                self.open_desk(m, 0, None);
            }
            Message::Back => {
                if let Some(d) = &self.desk {
                    d.send(serde_json::json!({ "type": "leave" }));
                }
                self.desk = None;
            }
            Message::Retry => {
                if let Some(d) = self.desk.take() {
                    let m = d.machine.clone();
                    self.open_desk(m, 0, Some(d));
                } else {
                    self.find_agent();
                }
            }
            Message::StartAgent => {
                let name = self.instances.iter().find(|i| i.linked).map(|i| i.name.clone());
                match name {
                    Some(n) => match agent::start_agent(&n) {
                        Ok(()) => {
                            self.notice = Some(self.t("Arrancando el agente…", "Starting the agent…").to_string());
                            self.agent_retry_at = Some(Instant::now() + AGENT_RETRY);
                        }
                        Err(e) => self.notice = Some(format!("{} {e} ({})", self.t("No se pudo arrancar el agente:", "Could not start the agent:"), agent::AGENT_PKG)),
                    },
                    None => self.notice = Some(self.t("Primero enlaza esta máquina desde una terminal: dotrino-remote-desktop-agent", "First link this machine from a terminal: dotrino-remote-desktop-agent").to_string()),
                }
            }
            Message::View(input) => self.on_input(input),
            Message::Pick(w) => {
                if let Some(d) = &mut self.desk {
                    d.watch = w;
                    if let Watch::Win(id) = w {
                        // Elegir una ventana es querer trabajar en ella: se trae al frente en la máquina.
                        if !d.is_monitor(id) && d.machine.is_some() {
                            d.send(serde_json::json!({ "type": "raise", "id": id }));
                        }
                    }
                    self.follow();
                }
            }
            Message::ZoomBy(f) => {
                if let Some(d) = &mut self.desk {
                    let c = iced::Point::new(d.view.size.width / 2.0, d.view.size.height / 2.0);
                    let z = d.view.zoom * f;
                    let screen = d.screen();
                    d.view.zoom_at(screen, z, c);
                    d.cache.clear();
                }
            }
            Message::Fit => {
                if let Some(d) = &mut self.desk {
                    d.last_fit = None;
                }
                self.follow();
            }
            Message::CodeInput(s) => {
                if let Some(d) = &mut self.desk {
                    d.code_input = s;
                }
            }
            Message::CodeSend => {
                if let Some(d) = &mut self.desk {
                    let code = std::mem::take(&mut d.code_input);
                    if !code.is_empty() {
                        d.send(serde_json::json!({ "type": "unlock", "code": code }));
                        d.code = Some(code);
                        d.code_error = None;
                    }
                }
            }
        }
        Task::none()
    }

    fn tick(&mut self, now: Instant) {
        // El agente local no estaba: se vuelve a buscar.
        if self.agent_retry_at.is_some_and(|t| now >= t) && self.desk.is_none() {
            self.agent_retry_at = None;
            self.find_agent();
        }
        // La lista se refresca por detrás.
        if let (Some(tx), Some(asked)) = (&self.list_tx, self.list_asked)
            && now.duration_since(asked) >= LIST_EVERY && self.desk.is_none() {
                let _ = tx.send(r#"{"type":"machines"}"#.to_string());
                self.list_asked = Some(now);
            }
        let es = self.es;
        let Some(d) = &mut self.desk else { return };
        // VIGILANTE: pedida la escena, si no llega se abre otra sesión (hasta MAX_TRIES).
        if d.scene_due.is_some_and(|t| now >= t) {
            d.scene_due = None;
            if d.attempt + 1 >= MAX_TRIES {
                let l = d.label(es);
                d.phase = Phase::Failed(if es { format!("No se pudo conectar con {l}.") } else { format!("Could not connect to {l}.") });
            } else {
                let next = d.attempt + 1;
                let m = d.machine.clone();
                let keep = self.desk.take();
                self.open_desk(m, next, keep);
                return;
            }
        }
        if d.reconnect_at.is_some_and(|t| now >= t) {
            let next = d.attempt + 1;
            let m = d.machine.clone();
            let keep = self.desk.take();
            self.open_desk(m, next, keep);
            return;
        }
        // El vídeo pedido sin cuadro: se vuelve a pedir.
        if let (Some(id), Some(at)) = (d.video_id, d.video_asked)
            && !d.video_got && d.video_tries < 3 && now.duration_since(at) >= VIDEO_RETRY {
                d.video_tries += 1;
                d.video_asked = Some(now);
                d.send(serde_json::json!({ "type": "video", "id": id }));
            }
    }

    fn on_list(&mut self, ev: AgentEvent) {
        match ev {
            AgentEvent::Ready(tx) => {
                self.no_agent = None;
                self.list_tx = Some(tx);
            }
            AgentEvent::Hello { version } => self.agent_version = Some(version),
            AgentEvent::Machines(l) => {
                self.list_error = None;
                self.machines = Some(l);
            }
            AgentEvent::Fail(f) => self.list_error = Some(self.fail_text(&f)),
            AgentEvent::NoAgent(why) => {
                self.list_tx = None;
                self.no_agent = Some(why);
                self.agent_retry_at = Some(Instant::now() + AGENT_RETRY);
            }
            AgentEvent::Closed => {
                self.list_tx = None;
                self.no_agent = Some(self.t("El agente de esta máquina se cerró.", "This machine's agent closed.").to_string());
                self.agent_retry_at = Some(Instant::now() + AGENT_RETRY);
            }
            _ => {}
        }
    }

    fn on_desk(&mut self, ev: AgentEvent) {
        let es = self.es;
        let text_of = |app: &App, f: &Fail| app.fail_text(f);
        let fail_msg = match &ev {
            AgentEvent::Fail(f) => Some(text_of(self, f)),
            _ => None,
        };
        let Some(d) = &mut self.desk else { return };
        match ev {
            AgentEvent::Ready(tx) => {
                d.tx = Some(tx);
                d.send(serde_json::json!({ "type": "scene" }));
                d.scene_due = Some(Instant::now() + SCENE_WAIT);
                if let Some(id) = d.video_id {
                    d.send(serde_json::json!({ "type": "video", "id": id }));
                    d.video_asked = Some(Instant::now());
                }
            }
            AgentEvent::Hello { version } => self.agent_version = Some(version),
            AgentEvent::Via(m) => {
                if let Some(old) = &mut d.machine {
                    *old = m;
                }
            }
            AgentEvent::Scene(s) => {
                d.scene_due = None;
                d.attempt = 0;
                d.phase = Phase::Live;
                d.status.clear();
                Self::paint(d, *s);
                self.follow();
            }
            AgentEvent::Patch(p) => {
                let Some(scene) = &d.scene else { return };
                match apply_patch(scene, &p) {
                    Ok(next) => {
                        Self::paint(d, next);
                        self.follow();
                    }
                    // Un parche que no casa (se perdió uno): la escena entera, no a medias.
                    Err(_) => d.send(serde_json::json!({ "type": "scene" })),
                }
            }
            AgentEvent::Frame(f) => {
                if Some(f.id) != d.video_id {
                    return;
                }
                d.video_got = true;
                let msg = if f.relay {
                    (if es { "Imagen reducida: tus aparatos no están conectados directamente, y así gasta menos." } else { "Reduced picture: your devices are not connected directly, so it uses less data." }).to_string()
                } else {
                    String::new()
                };
                if matches!(d.phase, Phase::Live) {
                    d.status = msg;
                }
                let handle = iced::widget::image::Handle::from_rgba(f.width, f.height, f.rgba);
                d.tiles.insert(f.id, Tile { rect: f.rect, handle });
                d.cache.clear();
            }
            AgentEvent::VideoWait(id) => {
                if Some(id) == d.video_id {
                    d.status = (if es { "La imagen de esta ventana solo viaja por conexión directa entre tus aparatos. Esperando a que se abra…" } else { "The picture of this window only travels over a direct connection between your devices. Waiting for it to open…" }).to_string();
                }
            }
            AgentEvent::Unlocked => {
                d.phase = Phase::Connecting;
                d.code_error = None;
                d.status = if es { format!("Conectando con {}…", d.label(es)) } else { format!("Connecting to {}…", d.label(es)) };
                d.send(serde_json::json!({ "type": "scene" }));
                d.scene_due = Some(Instant::now() + SCENE_WAIT);
                if let Some(id) = d.video_id {
                    d.send(serde_json::json!({ "type": "video", "id": id }));
                    d.video_asked = Some(Instant::now());
                }
            }
            AgentEvent::Resumed => {
                // La sesión con la otra máquina se rehízo sola: se vuelve a pedir la escena.
                d.send(serde_json::json!({ "type": "scene" }));
                if let Some(id) = d.video_id {
                    d.send(serde_json::json!({ "type": "video", "id": id }));
                    d.video_asked = Some(Instant::now());
                }
            }
            AgentEvent::Fail(f) => {
                let text = fail_msg.unwrap_or_default();
                match f.code.as_str() {
                    // LA CLAVE DE LA MÁQUINA: mientras se pide no llega la escena, y eso no es un canal muerto.
                    "locked" | "bad-code" | "wait" => {
                        d.scene_due = None;
                        if f.code == "locked" {
                            if let Some(c) = &d.code {
                                d.send(serde_json::json!({ "type": "unlock", "code": c }));
                                return;
                            }
                            d.code_error = None;
                        } else {
                            d.code = None;
                            d.code_error = Some(text);
                        }
                        d.phase = Phase::Locked;
                    }
                    // No hay sesión posible: se dice y no se reintenta solo.
                    "unauthorized" | "blocked" | "not-linked" | "no-machine" | "no-record" => {
                        d.scene_due = None;
                        d.phase = Phase::Failed(text);
                    }
                    _ => d.status = text,
                }
            }
            AgentEvent::NoAgent(_) | AgentEvent::Closed => {
                d.tx = None;
                d.scene_due = None;
                if matches!(d.phase, Phase::Failed(_)) {
                    return;
                }
                if d.attempt + 1 >= MAX_TRIES * 2 {
                    d.phase = Phase::Failed((if es { "Se perdió la conexión con el agente de esta máquina." } else { "Lost the connection to this machine's agent." }).to_string());
                } else {
                    d.status = (if es { "Se cortó la conexión: conectando otra vez…" } else { "The connection dropped: connecting again…" }).to_string();
                    d.reconnect_at = Some(Instant::now() + AGENT_RETRY);
                }
            }
            AgentEvent::Machines(_) => {}
        }
    }

    /// Una escena nueva: el orden de pintado, de quién es cada nodo, la barra de tareas.
    fn paint(d: &mut Desk, s: Scene) {
        d.owner = owners(&s);
        // Una ventana elegida que se cerró: se vuelve a la activa.
        if let Watch::Win(id) = d.watch
            && !s.nodes.iter().any(|n| n.id == id) {
                d.watch = Watch::Active;
            }
        // ORDEN FIJO en la barra: cada ventana conserva su sitio desde que aparece.
        let alive: Vec<i64> = s.wins.iter().filter(|w| !w.name.is_empty() && s.nodes.iter().any(|n| n.id == w.id)).map(|w| w.id).collect();
        d.task_order.retain(|id| alive.contains(id));
        for id in alive {
            if !d.task_order.contains(&id) {
                d.task_order.push(id);
            }
        }
        // Los huecos que ya no están se olvidan; los demás siguen a su nodo.
        d.tiles.retain(|id, t| match s.nodes.iter().find(|n| n.id == *id) {
            Some(n) => {
                t.rect = n.rect();
                true
            }
            None => false,
        });
        d.scene = Some(s);
        d.cache.clear();
    }

    /// Lo que se mira: el orden de pintado (la ventana elegida encima), el encuadre y el vídeo.
    fn follow(&mut self) {
        let Some(d) = &mut self.desk else { return };
        let Some(s) = &d.scene else { return };
        let top = d.top();
        let mut order: Vec<usize> = (0..s.nodes.len()).collect();
        if let Some(t) = top {
            // La ventana elegida se pinta encima de todas (src/render.js `applyTop`).
            let (mine, rest): (Vec<usize>, Vec<usize>) = order.into_iter().partition(|&i| d.owner.get(&s.nodes[i].id) == Some(&t));
            order = rest;
            order.extend(mine);
        }
        d.order = order;
        // El encuadre solo al CAMBIAR de ventana: después, el zoom y el desplazamiento son tuyos.
        let target = d.target().filter(|id| d.rect_of(*id).is_some());
        if d.last_fit != Some(target) {
            d.last_fit = Some(target);
            d.need_fit = true;
        }
        if d.need_fit && d.view.size.width > 0.0 {
            d.need_fit = false;
            let screen = d.screen();
            let r = target.and_then(|id| d.rect_of(id));
            d.view.fit(screen, r);
        }
        // EL VÍDEO: de la ventana que se mira, ella entera si no publica nada, o su hueco más grande.
        let want = top.and_then(|win| {
            let s = d.scene.as_ref()?;
            if s.nodes.iter().find(|n| n.id == win).is_some_and(|n| n.is_hole()) {
                return Some(win);
            }
            s.nodes
                .iter()
                .filter(|n| n.is_hole() && d.owner.get(&n.id) == Some(&win) && n.w >= 64.0 && n.h >= 64.0)
                .max_by(|a, b| (a.w * a.h).total_cmp(&(b.w * b.h)))
                .map(|n| n.id)
        });
        if want != d.video_id {
            d.video_id = want;
            d.video_got = false;
            d.video_tries = 0;
            d.video_asked = Some(Instant::now());
            d.send(serde_json::json!({ "type": "video", "id": want }));
        }
        d.cache.clear();
    }

    fn on_input(&mut self, input: Input) {
        let Some(d) = &mut self.desk else { return };
        let screen = d.screen();
        match input {
            Input::Resized(size) => {
                // Cambió el tamaño de la ventana: se vuelve a encuadrar lo que se mira.
                let first = d.view.size.width <= 0.0;
                d.view.size = size;
                if first || d.need_fit {
                    d.need_fit = true;
                    self.follow();
                } else {
                    d.last_fit = None;
                    self.follow();
                }
            }
            Input::Send(v) => {
                // Esta misma máquina (`--this-machine`) es solo para ver: el ratón se perseguiría a sí mismo.
                if matches!(d.phase, Phase::Live) && d.machine.is_some() {
                    d.send(v);
                }
            }
            Input::Zoom(f, c) => {
                let z = d.view.zoom * f;
                d.view.zoom_at(screen, z, c);
                d.cache.clear();
            }
            Input::Pan(v) => {
                d.view.tx += v.x;
                d.view.ty += v.y;
                d.view.clamp(screen);
                d.cache.clear();
            }
        }
    }

    // ------------------------------- la vista --------------------------------

    fn view(&self) -> Element<'_, Message> {
        let pal = Pal::of(self.mode);
        let body = match &self.desk {
            Some(d) => self.desk_view(d, pal),
            None => self.list_view(pal),
        };
        container(column![self.top_bar(pal), body]).width(Length::Fill).height(Length::Fill).style(move |_| container::Style { background: Some(pal.bg.into()), text_color: Some(pal.text), ..Default::default() }).into()
    }

    fn top_bar(&self, pal: Pal) -> Element<'_, Message> {
        let brand = text("Dotrino Remote Desktop").font(BRAND).size(18).color(pal.accent);
        let mut bar = row![].spacing(8).align_y(iced::Alignment::Center);
        if let Some(d) = &self.desk {
            bar = bar.push(button(text(self.t("← Volver", "← Back"))).style(move |_, st| ghost(pal, st)).on_press(Message::Back));
            bar = bar.push(brand);
            bar = bar.push(text(format!("· {}", d.label(self.es))).color(pal.text_dim));
            bar = bar.push(space::horizontal());
            if matches!(d.phase, Phase::Live) {
                bar = bar.push(button(text("−")).style(move |_, st| ghost(pal, st)).on_press(Message::ZoomBy(1.0 / 1.25)));
                bar = bar.push(button(text("+")).style(move |_, st| ghost(pal, st)).on_press(Message::ZoomBy(1.25)));
                bar = bar.push(button(text(self.t("Encuadrar", "Fit"))).style(move |_, st| ghost(pal, st)).on_press(Message::Fit));
            }
        } else {
            bar = bar.push(brand);
            bar = bar.push(space::horizontal());
        }
        container(bar).padding([10, 16]).width(Length::Fill).style(move |_| container::Style { background: Some(pal.surface.into()), border: iced::Border { color: pal.line_soft, width: 1.0, radius: 0.0.into() }, ..Default::default() }).into()
    }

    fn list_view(&self, pal: Pal) -> Element<'_, Message> {
        let mut col = column![text(self.t("Tus escritorios", "Your desktops")).size(20).color(pal.text_dim)].spacing(12);
        if let Some(why) = &self.no_agent {
            col = col.push(text(self.t(
                "No se pudo hablar con el agente del escritorio remoto de esta máquina. Tiene que estar enlazado y corriendo, en la versión 0.7.0 o posterior.",
                "Could not talk to this machine's remote desktop agent. It has to be linked and running, version 0.7.0 or later.",
            )).color(pal.text));
            col = col.push(text(why.clone()).size(13).color(pal.text_faint));
            if self.instances.iter().any(|i| i.linked) {
                col = col.push(button(text(self.t("Arrancar el agente", "Start the agent"))).style(move |_, st| primary(pal, st)).on_press(Message::StartAgent));
            } else {
                col = col.push(text(self.t(
                    "Para enlazarla, en una terminal: npm install -g @dotrino/remote-desktop-agent y después dotrino-remote-desktop-agent",
                    "To link it, in a terminal: npm install -g @dotrino/remote-desktop-agent and then dotrino-remote-desktop-agent",
                )).color(pal.text_dim));
            }
        } else {
            match &self.machines {
                None if self.list_error.is_none() => col = col.push(text(self.t("Buscando tus máquinas…", "Looking for your machines…")).color(pal.text_dim)),
                Some(l) if l.is_empty() => col = col.push(text(self.t("Ninguna de tus máquinas tiene el escritorio remoto encendido.", "None of your machines has the remote desktop running.")).color(pal.text_dim)),
                Some(l) => {
                    for m in l {
                        let row = row![text("●").color(pal.ok), text(m.label()).color(pal.text), text(m.id.clone()).size(13).color(pal.text_faint)].spacing(10).align_y(iced::Alignment::Center);
                        col = col.push(button(container(row).padding([10, 14]).width(Length::Fill).style(move |_| card(pal, false))).padding(0).style(|_, _| button::Style::default()).on_press(Message::Open(Some(m.clone()))));
                    }
                }
                None => {}
            }
            if let Some(e) = &self.list_error {
                col = col.push(text(e.clone()).color(pal.danger));
            }
            if self.args.this_machine {
                col = col.push(button(text(self.t("Esta máquina (prueba)", "This machine (test)"))).style(move |_, st| ghost(pal, st)).on_press(Message::Open(None)));
            }
        }
        if let Some(n) = &self.notice {
            col = col.push(text(n.clone()).color(pal.text_dim));
        }
        let mut foot = String::new();
        if let Some(i) = &self.instance {
            foot = format!("{} «{}»", self.t("Agente de esta máquina:", "This machine's agent:"), i.name);
            if let Some(v) = &self.agent_version {
                foot.push_str(&format!(" · {v}"));
            }
        }
        foot.push_str(&format!("{}{} {}", if foot.is_empty() { "" } else { " · " }, self.t("ventana", "window"), env!("CARGO_PKG_VERSION")));
        col = col.push(space::vertical()).push(text(foot).size(12).color(pal.text_faint));
        container(scrollable(col.padding([20, 24]).height(Length::Shrink))).width(Length::Fill).height(Length::Fill).into()
    }

    fn desk_view<'a>(&'a self, d: &'a Desk, pal: Pal) -> Element<'a, Message> {
        let mut col = column![].spacing(0);
        match &d.phase {
            Phase::Failed(why) => {
                let c = column![
                    text(why.clone()).color(pal.danger),
                    button(text(self.t("Intentar de nuevo", "Try again"))).style(move |_, st| primary(pal, st)).on_press(Message::Retry)
                ]
                .spacing(12);
                return container(c).padding(24).width(Length::Fill).height(Length::Fill).into();
            }
            Phase::Locked => {
                let label = d.label(self.es);
                let ask = if self.es { format!("{label} pide su clave.") } else { format!("{label} asks for its code.") };
                let mut c = column![text(ask).color(pal.text)].spacing(10);
                if let Some(e) = &d.code_error {
                    c = c.push(text(e.clone()).color(pal.danger));
                }
                c = c.push(
                    row![
                        text_input(self.t("Clave de la máquina", "Machine code"), &d.code_input).secure(true).on_input(Message::CodeInput).on_submit(Message::CodeSend).width(Length::Fixed(280.0)),
                        button(text(self.t("Entrar", "Enter"))).style(move |_, st| primary(pal, st)).on_press(Message::CodeSend)
                    ]
                    .spacing(8),
                );
                return container(c).padding(24).width(Length::Fill).height(Length::Fill).into();
            }
            _ => {}
        }
        if !d.status.is_empty() {
            col = col.push(container(text(d.status.clone()).size(13).color(pal.text_dim)).padding([6, 16]));
        }
        match &d.scene {
            Some(s) => {
                let loading = d.video_id.filter(|id| !d.video_got && !d.tiles.contains_key(id)).and_then(|id| d.rect_of(id));
                let program = DeskView {
                    scene: s,
                    order: &d.order,
                    view: d.view,
                    pal,
                    tiles: &d.tiles,
                    top: d.top(),
                    owner: &d.owner,
                    loading,
                    words: Words { no_view: self.t("sin vista", "no view"), loading: self.t("Cargando imagen…", "Loading picture…") },
                    keyboard: matches!(d.phase, Phase::Live) && d.machine.is_some(),
                    cache: &d.cache,
                };
                col = col.push(canvas(program).width(Length::Fill).height(Length::Fill).into_element_map());
                col = col.push(self.taskbar(d, pal));
            }
            None => {
                col = col.push(container(text("")).height(Length::Fill));
            }
        }
        col.into()
    }

    /// La barra de tareas de abajo: Activa, Todo, cada pantalla, y una por ventana, en orden fijo.
    fn taskbar<'a>(&'a self, d: &'a Desk, pal: Pal) -> Element<'a, Message> {
        let Some(s) = &d.scene else { return space::horizontal().into() };
        let active = s.wins.iter().find(|w| w.active).map(|w| w.id);
        let item = |label: String, what: Watch| {
            let on = d.watch == what;
            let focus = matches!(what, Watch::Win(id) if Some(id) == active);
            let label = if focus { format!("● {label}") } else { label };
            button(text(label).size(13).wrapping(text::Wrapping::None)).padding([5, 12]).style(move |_, st| tab(pal, on, st)).on_press(Message::Pick(what))
        };
        let mut bar = row![item(self.t("Activa", "Active").into(), Watch::Active), item(self.t("Todo", "All").into(), Watch::All)].spacing(6);
        let mons = d.monitors();
        for (i, (id, _)) in mons.iter().enumerate() {
            let l = if mons.len() > 1 { format!("{} {}", self.t("Pantalla", "Screen"), i + 1) } else { self.t("Pantalla", "Screen").to_string() };
            bar = bar.push(item(l, Watch::Win(*id)));
        }
        for id in &d.task_order {
            if mons.iter().any(|(m, _)| m == id) {
                continue;
            }
            if let Some(w) = s.wins.iter().find(|w| w.id == *id) {
                let mut name: String = w.name.chars().take(28).collect();
                if w.name.chars().count() > 28 {
                    name.push('…');
                }
                bar = bar.push(item(name, Watch::Win(*id)));
            }
        }
        container(scrollable(bar.padding([6, 10])).direction(scrollable::Direction::Horizontal(scrollable::Scrollbar::new().width(4).scroller_width(4)))).width(Length::Fill).style(move |_| container::Style { background: Some(pal.surface.into()), border: iced::Border { color: pal.line_soft, width: 1.0, radius: 0.0.into() }, ..Default::default() }).into()
    }
}

/// Un lienzo cuyo mensaje es una entrada de la vista, como mensaje de la app.
trait IntoElementMap<'a> {
    fn into_element_map(self) -> Element<'a, Message>;
}

impl<'a, P: canvas::Program<Input> + 'a> IntoElementMap<'a> for iced::widget::Canvas<P, Input> {
    fn into_element_map(self) -> Element<'a, Message> {
        Element::from(self).map(Message::View)
    }
}
