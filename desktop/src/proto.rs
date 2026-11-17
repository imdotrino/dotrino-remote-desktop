//! El cable del agente (agent/scene.js, agent/index.js): la escena, los parches y cómo se aplican.
//!
//! Es la misma lógica que `applyPatch` de scene.js, en Rust: un parche que no es para la escena
//! que se tiene no se pinta a medias, se pide la escena entera.

use serde::Deserialize;
use std::collections::{HashMap, HashSet};

/// Un nodo de accesibilidad, como viaja (agent/atspi.js).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Node {
    pub id: i64,
    #[serde(default)]
    pub p: Option<i64>,
    /// Rol (`push button`, `frame`…).
    #[serde(default)]
    pub r: String,
    #[serde(default)]
    pub n: Option<String>,
    #[serde(default)]
    pub t: Option<String>,
    /// Estados en letras: f (foco), s (seleccionado), d (habilitado), c (marcado), e (editable), m (multilínea).
    #[serde(default)]
    pub s: Option<String>,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    /// Un hueco (lo que no publica accesibilidad): el agente lo marca con `hole: 1`.
    #[serde(default)]
    pub hole: Option<serde_json::Value>,
}

impl Node {
    pub fn states(&self) -> &str {
        self.s.as_deref().unwrap_or("")
    }
    pub fn is_hole(&self) -> bool {
        match &self.hole {
            Some(serde_json::Value::Bool(b)) => *b,
            Some(serde_json::Value::Number(n)) => n.as_f64().is_some_and(|v| v != 0.0),
            _ => false,
        }
    }
    pub fn rect(&self) -> Rect {
        Rect { x: self.x, y: self.y, w: self.w, h: self.h }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Screen {
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Win {
    pub id: i64,
    #[serde(default)]
    pub app: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Scene {
    pub seq: i64,
    pub screen: Screen,
    pub wins: Vec<Win>,
    pub nodes: Vec<Node>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Patch {
    pub seq: i64,
    pub base: i64,
    #[serde(default)]
    pub screen: Option<Screen>,
    #[serde(default)]
    pub wins: Option<Vec<Win>>,
    #[serde(default)]
    pub order: Option<Vec<i64>>,
    #[serde(default)]
    pub put: Vec<Node>,
    #[serde(default)]
    pub del: Vec<i64>,
}

/// Por qué no se pudo aplicar un parche.
#[derive(Debug, PartialEq)]
pub enum PatchError {
    /// El parche es para otra escena: se pide la entera.
    Stale,
    /// El orden nombra un nodo que nadie trae.
    Bad(i64),
}

/// Aplica un parche a una escena (scene.js `applyPatch`).
pub fn apply_patch(scene: &Scene, patch: &Patch) -> Result<Scene, PatchError> {
    if patch.base != scene.seq {
        return Err(PatchError::Stale);
    }
    let mut by_id: HashMap<i64, Node> = scene.nodes.iter().map(|n| (n.id, n.clone())).collect();
    for id in &patch.del {
        by_id.remove(id);
    }
    for n in &patch.put {
        by_id.insert(n.id, n.clone());
    }
    let nodes = if let Some(order) = &patch.order {
        let mut out = Vec::with_capacity(order.len());
        for id in order {
            match by_id.remove(id) {
                Some(n) => out.push(n),
                None => return Err(PatchError::Bad(*id)),
            }
        }
        out
    } else {
        // Sin orden nuevo, el de la escena: los nodos nuevos sin `order` no existen (scene.js
        // siempre manda `order` si se añadió alguno).
        scene.nodes.iter().filter_map(|n| by_id.get(&n.id).cloned()).collect()
    };
    Ok(Scene {
        seq: patch.seq,
        screen: patch.screen.unwrap_or(scene.screen),
        wins: patch.wins.clone().unwrap_or_else(|| scene.wins.clone()),
        nodes,
    })
}

/// Qué aspecto tiene un nodo (render.js `kindOf`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Hole,
    Win,
    Field,
    Check,
    Btn,
    Band,
    Cell,
    Heading,
    Silent,
    Text,
}

const BUTTONS: &[&str] = &["push button", "button", "toggle button", "menu item", "check menu item", "radio menu item", "page tab", "combo box", "link", "spin button", "tool bar item"];
const FIELDS: &[&str] = &["entry", "text", "password text", "terminal", "document text", "spin button"];
const BANDS: &[&str] = &["menu bar", "tool bar", "status bar", "page tab list", "header", "title bar"];
const WINDOWS: &[&str] = &["frame", "window", "dialog", "alert", "file chooser", "menu", "popup menu", "tool tip"];
const SILENT: &[&str] = &["panel", "filler", "section", "scroll pane", "viewport", "layered pane", "split pane", "grouping", "form", "table", "tree table", "list", "tree", "document web", "document frame", "redundant object", "unknown", "application", "internal frame", "desktop frame"];

pub fn kind_of(n: &Node) -> Kind {
    let r = n.r.as_str();
    if n.is_hole() {
        Kind::Hole
    } else if WINDOWS.contains(&r) {
        Kind::Win
    } else if FIELDS.contains(&r) && n.states().contains('e') {
        Kind::Field
    } else if r == "check box" || r == "radio button" {
        Kind::Check
    } else if BUTTONS.contains(&r) {
        Kind::Btn
    } else if BANDS.contains(&r) {
        Kind::Band
    } else if matches!(r, "table cell" | "list item" | "tree item" | "table row") {
        Kind::Cell
    } else if r == "heading" {
        Kind::Heading
    } else if SILENT.contains(&r) {
        Kind::Silent
    } else {
        Kind::Text
    }
}

/// El texto que enseña un nodo: el de dentro si lo tiene, si no su nombre (render.js `labelOf`).
pub fn label_of(n: &Node) -> String {
    let s = n.t.as_deref().or(n.n.as_deref()).unwrap_or("");
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Corta un texto a lo que cabe en `w` px con letra de `fs` px (una estimación, como render.js `fit`).
pub fn fit(s: &str, w: f32, fs: f32) -> String {
    let max = (w / (fs * 0.56)).floor().max(0.0) as usize;
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    if max > 1 {
        let mut out: String = s.chars().take(max - 1).collect();
        out.push('…');
        out
    } else {
        String::new()
    }
}

/// Las apps que pintan el fondo de un monitor: esa «ventana» es una pantalla (main.js `isMonitorWin`).
const DESKTOP_APPS: &[&str] = &["xfdesktop", "nautilus-desktop", "pcmanfm", "plasmashell", "caja", "nemo-desktop"];

pub fn is_monitor_win(w: &Win) -> bool {
    DESKTOP_APPS.contains(&w.app.as_str()) || w.name.eq_ignore_ascii_case("desktop") || w.name.eq_ignore_ascii_case("escritorio")
}

/// De qué ventana es cada nodo: se sube por los padres hasta una de la lista de ventanas (-1 si ninguna).
pub fn owners(scene: &Scene) -> HashMap<i64, i64> {
    let wins: HashSet<i64> = scene.wins.iter().map(|w| w.id).collect();
    let parent: HashMap<i64, Option<i64>> = scene.nodes.iter().map(|n| (n.id, n.p)).collect();
    let mut out = HashMap::with_capacity(scene.nodes.len());
    for n in &scene.nodes {
        let mut id = n.id;
        let mut hops = 0;
        while !wins.contains(&id) && hops < 80 {
            match parent.get(&id).copied().flatten() {
                Some(p) => id = p,
                None => break,
            }
            hops += 1;
        }
        out.insert(n.id, if wins.contains(&id) { id } else { -1 });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: i64, t: &str) -> Node {
        Node { id, p: None, r: "label".into(), n: None, t: Some(t.into()), s: None, x: 0.0, y: 0.0, w: 10.0, h: 10.0, hole: None }
    }
    fn scene() -> Scene {
        Scene { seq: 1, screen: Screen { w: 100.0, h: 50.0 }, wins: vec![], nodes: vec![node(1, "a"), node(2, "b"), node(3, "c")] }
    }

    #[test]
    fn un_parche_de_texto_cambia_solo_ese_nodo() {
        let p = Patch { seq: 2, base: 1, screen: None, wins: None, order: None, put: vec![node(2, "B")], del: vec![] };
        let s = apply_patch(&scene(), &p).unwrap();
        assert_eq!(s.seq, 2);
        assert_eq!(s.nodes.iter().map(|n| n.t.clone().unwrap()).collect::<Vec<_>>(), ["a", "B", "c"]);
    }

    #[test]
    fn borrar_anadir_y_reordenar() {
        let p = Patch { seq: 2, base: 1, screen: Some(Screen { w: 200.0, h: 80.0 }), wins: None, order: Some(vec![4, 3, 1]), put: vec![node(4, "d")], del: vec![2] };
        let s = apply_patch(&scene(), &p).unwrap();
        assert_eq!(s.nodes.iter().map(|n| n.id).collect::<Vec<_>>(), [4, 3, 1]);
        assert_eq!(s.screen.w, 200.0);
    }

    #[test]
    fn un_parche_para_otra_escena_es_stale() {
        let p = Patch { seq: 9, base: 7, screen: None, wins: None, order: None, put: vec![], del: vec![] };
        assert_eq!(apply_patch(&scene(), &p), Err(PatchError::Stale));
        let bad = Patch { seq: 2, base: 1, screen: None, wins: None, order: Some(vec![1, 99]), put: vec![], del: vec![] };
        assert_eq!(apply_patch(&scene(), &bad), Err(PatchError::Bad(99)));
    }

    #[test]
    fn la_escena_del_cable_se_lee() {
        let line = r#"{"type":"scene","seq":3,"screen":{"w":1920,"h":1080},"wins":[{"id":5,"app":"thunar","name":"Home","active":true}],"nodes":[{"id":5,"r":"frame","n":"Home","s":"d","x":0,"y":0,"w":800,"h":600},{"id":6,"p":5,"r":"push button","n":"OK","s":"df","x":10,"y":10,"w":60,"h":24},{"id":7,"p":5,"r":"canvas","x":0,"y":40,"w":300,"h":200,"hole":1}]}"#;
        let s: Scene = serde_json::from_str(line).unwrap();
        assert_eq!(s.wins[0].name, "Home");
        assert_eq!(kind_of(&s.nodes[0]), Kind::Win);
        assert_eq!(kind_of(&s.nodes[1]), Kind::Btn);
        assert_eq!(kind_of(&s.nodes[2]), Kind::Hole);
        let o = owners(&s);
        assert_eq!(o[&6], 5);
        assert_eq!(o[&7], 5);
    }

    #[test]
    fn fit_y_label() {
        assert_eq!(fit("hola mundo", 1000.0, 10.0), "hola mundo");
        assert_eq!(fit("hola mundo", 28.0, 10.0), "hola…");
        assert_eq!(fit("hola", 5.0, 10.0), "");
        let mut n = node(1, "  dos   palabras \n");
        assert_eq!(label_of(&n), "dos palabras");
        n.t = None;
        n.n = Some("nombre".into());
        assert_eq!(label_of(&n), "nombre");
    }

    #[test]
    fn campos_y_pantallas() {
        let mut n = node(1, "x");
        n.r = "entry".into();
        assert_eq!(kind_of(&n), Kind::Text);
        n.s = Some("de".into());
        assert_eq!(kind_of(&n), Kind::Field);
        assert!(is_monitor_win(&Win { id: 1, app: "xfdesktop".into(), name: "x".into(), active: false }));
        assert!(is_monitor_win(&Win { id: 1, app: "x".into(), name: "Escritorio".into(), active: false }));
        assert!(!is_monitor_win(&Win { id: 1, app: "thunar".into(), name: "Home".into(), active: false }));
    }
}
