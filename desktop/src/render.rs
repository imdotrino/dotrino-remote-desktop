//! La vista de un escritorio: dibuja la escena (los nodos de accesibilidad) en un lienzo, con el
//! aspecto del tema y no el de la app de la máquina — igual que src/render.js en la PWA —, y
//! convierte el ratón y el teclado en mensajes para el agente.
//!
//! El encuadre (zoom y desplazamiento) se hace aquí a mano: cada nodo se pasa a coordenadas del
//! lienzo y el texto se dibuja ya a su tamaño final. Así no se dibuja nada fuera de la vista y
//! el texto sale nítido con cualquier zoom.

use crate::keys;
use crate::proto::{Kind, Node, Rect, Scene, fit, kind_of, label_of};
use dotrino_theme::{BODY, BOLD, Pal};
use iced::keyboard;
use iced::mouse;
use iced::widget::canvas::{self, Action, Event, Frame, Geometry, Path, Stroke, Text};
use iced::{Color, Pixels, Point, Rectangle, Renderer, Size, Theme, Vector, alignment};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// El zoom más grande, sobre el encuadre del escritorio entero.
pub const ZOOM_MAX: f32 = 12.0;
/// Lo más seguido que se mueve el ratón de la máquina (~25 veces por segundo).
const MOVE_EVERY: Duration = Duration::from_millis(40);

/// Dónde está el escritorio en el lienzo: `k` píxeles del lienzo por píxel de la máquina, más el
/// desplazamiento.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ViewBox {
    pub zoom: f32,
    pub tx: f32,
    pub ty: f32,
    pub size: Size,
}

impl Default for ViewBox {
    fn default() -> Self {
        ViewBox { zoom: 1.0, tx: 0.0, ty: 0.0, size: Size::ZERO }
    }
}

/// Un eje: el lienzo nunca sale del área. Si es más chico, se mueve dentro; si es más grande, la cubre.
pub fn clamp_axis(t: f32, view: f32, size: f32) -> f32 {
    if size <= view { t.max(0.0).min(view - size) } else { t.min(0.0).max(view - size) }
}

impl ViewBox {
    /// Píxeles del lienzo por píxel de la máquina con zoom 1: el escritorio entero entra.
    pub fn base(&self, screen: Size) -> f32 {
        if self.size.width <= 0.0 || self.size.height <= 0.0 {
            return 1.0;
        }
        (self.size.width / screen.width.max(1.0)).min(self.size.height / screen.height.max(1.0))
    }
    pub fn k(&self, screen: Size) -> f32 {
        self.base(screen) * self.zoom
    }
    pub fn clamp(&mut self, screen: Size) {
        let k = self.k(screen);
        self.tx = clamp_axis(self.tx, self.size.width, screen.width * k);
        self.ty = clamp_axis(self.ty, self.size.height, screen.height * k);
    }
    /// Un punto del lienzo, en la pantalla de la máquina.
    pub fn to_screen(self, screen: Size, p: Point) -> Point {
        let k = self.k(screen);
        Point::new(((p.x - self.tx) / k).round(), ((p.y - self.ty) / k).round())
    }
    /// Cambia el zoom dejando quieto el punto `c` del lienzo.
    pub fn zoom_at(&mut self, screen: Size, nz: f32, c: Point) {
        let nz = nz.clamp(1.0, ZOOM_MAX);
        let f = nz / self.zoom;
        self.tx = c.x - (c.x - self.tx) * f;
        self.ty = c.y - (c.y - self.ty) * f;
        self.zoom = nz;
        self.clamp(screen);
    }
    /// Encuadra un rectángulo de la máquina (una ventana) entero y centrado; `None`: todo, sin zoom.
    pub fn fit(&mut self, screen: Size, r: Option<Rect>) {
        let b = self.base(screen);
        match r {
            Some(r) if r.w > 0.0 && r.h > 0.0 => {
                self.zoom = (self.size.width / (r.w * b)).min(self.size.height / (r.h * b)).clamp(1.0, ZOOM_MAX);
                let k = b * self.zoom;
                self.tx = self.size.width / 2.0 - (r.x + r.w / 2.0) * k;
                self.ty = self.size.height / 2.0 - (r.y + r.h / 2.0) * k;
            }
            _ => {
                self.zoom = 1.0;
                self.tx = (self.size.width - screen.width * b) / 2.0;
                self.ty = 0.0;
            }
        }
        self.clamp(screen);
    }
}

/// Lo que la vista le pide a la app.
#[derive(Debug, Clone)]
pub enum Input {
    /// El tamaño del lienzo cambió.
    Resized(Size),
    /// Mensaje para el agente (ya en coordenadas de la máquina).
    Send(serde_json::Value),
    /// Zoom alrededor de un punto del lienzo.
    Zoom(f32, Point),
    /// Desplazar la vista (Ctrl + arrastrar).
    Pan(Vector),
}

/// La imagen guardada de un hueco.
#[derive(Debug, Clone)]
pub struct Tile {
    pub rect: Rect,
    pub handle: iced::widget::image::Handle,
}

/// Los textos de la interfaz que van dentro del dibujo.
pub struct Words {
    pub no_view: &'static str,
    pub loading: &'static str,
}

/// La vista de un escritorio, para un fotograma.
pub struct DeskView<'a> {
    pub scene: &'a Scene,
    pub order: &'a [usize],
    pub view: ViewBox,
    pub pal: Pal,
    pub tiles: &'a HashMap<i64, Tile>,
    /// La ventana que se mira (encima de las demás): con una a la vista, solo se ven sus imágenes.
    pub top: Option<i64>,
    /// De qué ventana es cada nodo.
    pub owner: &'a HashMap<i64, i64>,
    /// El hueco que espera su primer cuadro: se pinta «Cargando imagen…».
    pub loading: Option<Rect>,
    pub words: Words,
    /// No mandar teclado (se está escribiendo la clave de la máquina).
    pub keyboard: bool,
    pub cache: &'a canvas::Cache,
}

/// Lo que recuerda el lienzo entre eventos.
#[derive(Default)]
pub struct State {
    /// Botones pulsados en la máquina (1–3).
    pressed: [bool; 4],
    /// Ctrl + arrastrar: desde dónde.
    pan_from: Option<Point>,
    last_move: Option<Instant>,
    modifiers: keyboard::Modifiers,
}

fn send(v: serde_json::Value) -> Option<Action<Input>> {
    Some(Action::publish(Input::Send(v)).and_capture())
}

impl DeskView<'_> {
    fn screen(&self) -> Size {
        Size::new(self.scene.screen.w, self.scene.screen.h)
    }
}

impl canvas::Program<Input> for DeskView<'_> {
    type State = State;

    fn update(&self, state: &mut State, event: &Event, bounds: Rectangle, cursor: mouse::Cursor) -> Option<Action<Input>> {
        if bounds.size() != self.view.size {
            return Some(Action::publish(Input::Resized(bounds.size())));
        }
        let screen = self.screen();
        match event {
            Event::Keyboard(keyboard::Event::ModifiersChanged(m)) => {
                state.modifiers = *m;
                None
            }
            Event::Keyboard(keyboard::Event::KeyPressed { key, text, modifiers, .. }) if self.keyboard => {
                if let keyboard::Key::Named(named) = key
                    && let Some(sym) = keys::keysym(*named) {
                        return send(serde_json::json!({ "type": "key", "keysym": sym }));
                    }
                // Con Ctrl o Alt no es texto, y el agente todavía no sabe de combinaciones.
                if modifiers.control() || modifiers.alt() || modifiers.logo() {
                    return None;
                }
                match text {
                    Some(t) if keys::printable(t) => send(serde_json::json!({ "type": "text", "text": t.as_str() })),
                    _ => None,
                }
            }
            Event::Mouse(m) => {
                let pos = cursor.position_in(bounds);
                match m {
                    mouse::Event::ButtonPressed(b) => {
                        let p = pos?;
                        if *b == mouse::Button::Left && state.modifiers.control() {
                            state.pan_from = Some(p);
                            return Some(Action::capture());
                        }
                        let n = button_number(*b)?;
                        state.pressed[n as usize] = true;
                        let s = self.view.to_screen(screen, p);
                        send(serde_json::json!({ "type": "press", "x": s.x, "y": s.y, "button": n }))
                    }
                    mouse::Event::ButtonReleased(b) => {
                        if *b == mouse::Button::Left && state.pan_from.take().is_some() {
                            return Some(Action::capture());
                        }
                        let n = button_number(*b)?;
                        if !state.pressed[n as usize] {
                            return None;
                        }
                        state.pressed[n as usize] = false;
                        // Se suelta donde esté el puntero, aunque haya salido del lienzo.
                        let p = cursor.position().map(|c| Point::new(c.x - bounds.x, c.y - bounds.y))?;
                        let s = self.view.to_screen(screen, p);
                        send(serde_json::json!({ "type": "release", "x": s.x, "y": s.y, "button": n }))
                    }
                    mouse::Event::CursorMoved { .. } => {
                        if let Some(from) = state.pan_from {
                            let p = cursor.position().map(|c| Point::new(c.x - bounds.x, c.y - bounds.y))?;
                            state.pan_from = Some(p);
                            return Some(Action::publish(Input::Pan(p - from)).and_capture());
                        }
                        let p = pos?;
                        let now = Instant::now();
                        if state.last_move.is_some_and(|t| now.duration_since(t) < MOVE_EVERY) {
                            return None;
                        }
                        state.last_move = Some(now);
                        let s = self.view.to_screen(screen, p);
                        send(serde_json::json!({ "type": "move", "x": s.x, "y": s.y }))
                    }
                    mouse::Event::WheelScrolled { delta } => {
                        let p = pos?;
                        let y = match delta {
                            mouse::ScrollDelta::Lines { y, .. } => *y,
                            mouse::ScrollDelta::Pixels { y, .. } => *y / 60.0,
                        };
                        if y == 0.0 {
                            return None;
                        }
                        // Ctrl + rueda: zoom de la vista, como en el navegador.
                        if state.modifiers.control() {
                            return Some(Action::publish(Input::Zoom(if y > 0.0 { 1.15 } else { 1.0 / 1.15 }, p)).and_capture());
                        }
                        let s = self.view.to_screen(screen, p);
                        // La rueda hacia arriba (y > 0) es dy < 0 para el agente.
                        let dy = -y.signum() * y.abs().round().max(1.0);
                        send(serde_json::json!({ "type": "wheel", "x": s.x, "y": s.y, "dy": dy }))
                    }
                    _ => None,
                }
            }
            _ => None,
        }
    }

    fn draw(&self, _state: &State, renderer: &Renderer, _theme: &Theme, bounds: Rectangle, _cursor: mouse::Cursor) -> Vec<Geometry> {
        let geo = self.cache.draw(renderer, bounds.size(), |frame| self.paint(frame));
        vec![geo]
    }

    fn mouse_interaction(&self, state: &State, bounds: Rectangle, cursor: mouse::Cursor) -> mouse::Interaction {
        if state.pan_from.is_some() {
            mouse::Interaction::Grabbing
        } else if cursor.is_over(bounds) {
            mouse::Interaction::Crosshair
        } else {
            mouse::Interaction::default()
        }
    }
}

fn button_number(b: mouse::Button) -> Option<u8> {
    match b {
        mouse::Button::Left => Some(1),
        mouse::Button::Middle => Some(2),
        mouse::Button::Right => Some(3),
        _ => None,
    }
}

fn with_alpha(c: Color, a: f32) -> Color {
    Color { a: c.a * a, ..c }
}

/// Las rayas de un hueco: diagonales, recortadas a mano dentro del rectángulo.
fn hatch(frame: &mut Frame, r: Rectangle, step: f32, color: Color) {
    let stroke = Stroke::default().with_color(color).with_width(1.0);
    let mut c = -r.height;
    while c < r.width {
        // La recta x = c + t, y = t (t ≥ 0), dentro del rectángulo.
        let t0 = (-c).max(0.0);
        let t1 = r.height.min(r.width - c);
        if t1 > t0 {
            frame.stroke(&Path::line(Point::new(r.x + c + t0, r.y + t0), Point::new(r.x + c + t1, r.y + t1)), stroke);
        }
        c += step;
    }
}

impl DeskView<'_> {
    fn paint(&self, frame: &mut Frame) {
        let pal = self.pal;
        let size = frame.size();
        frame.fill_rectangle(Point::ORIGIN, size, pal.surface_2);
        let screen = self.screen();
        let k = self.view.k(screen);
        let (tx, ty) = (self.view.tx, self.view.ty);
        // El fondo del escritorio.
        frame.fill_rectangle(Point::new(tx, ty), Size::new(screen.width * k, screen.height * k), pal.bg);
        let view = Rectangle::new(Point::ORIGIN, size);
        for &i in self.order {
            let n = &self.scene.nodes[i];
            let r = Rectangle::new(Point::new(n.x * k + tx, n.y * k + ty), Size::new(n.w * k, n.h * k));
            if r.width < 1.0 || r.height < 1.0 || !r.intersects(&view) {
                continue;
            }
            self.node(frame, n, r, k);
        }
        // Encima: las imágenes de los huecos.
        for (id, t) in self.tiles {
            // Con una ventana a la vista, solo sus imágenes: la congelada de otra que está en el mismo
            // sitio la tapaba (src/main.js `follow`).
            if let Some(top) = self.top
                && *id != top && self.owner.get(id) != Some(&top) {
                    continue;
                }
            let r = Rectangle::new(Point::new(t.rect.x * k + tx, t.rect.y * k + ty), Size::new(t.rect.w * k, t.rect.h * k));
            if r.intersects(&view) {
                frame.draw_image(r, canvas::Image::new(t.handle.clone()));
            }
        }
        if let Some(l) = self.loading {
            let c = Point::new((l.x + l.w / 2.0) * k + tx, (l.y + l.h / 2.0) * k + ty);
            frame.fill_text(Text {
                content: self.words.loading.to_string(),
                position: c,
                color: pal.text_dim,
                size: Pixels(15.0),
                font: BODY,
                align_x: alignment::Horizontal::Center.into(),
                align_y: alignment::Vertical::Center,
                ..Default::default()
            });
        }
    }

    fn node(&self, frame: &mut Frame, n: &Node, r: Rectangle, k: f32) {
        let pal = self.pal;
        let kind = kind_of(n);
        if kind == Kind::Silent {
            return;
        }
        let s = n.states();
        let selected = s.contains('s');
        let focused = s.contains('f');
        let off = !s.contains('d');
        let radius = match kind {
            Kind::Win => 8.0 * k,
            Kind::Btn | Kind::Field => 4.0 * k,
            _ => 0.0,
        };
        let shape = Path::rounded_rectangle(r.position(), r.size(), radius.into());
        // El fondo y el borde, según lo que es.
        let (fill, line): (Option<Color>, Option<Color>) = match kind {
            Kind::Win => (Some(pal.surface), Some(pal.line)),
            Kind::Band => (Some(pal.surface_2), None),
            Kind::Btn => (Some(pal.surface_3), Some(pal.line)),
            Kind::Field => (Some(pal.bg), Some(pal.accent)),
            Kind::Hole => (Some(pal.surface_2), Some(pal.text_faint)),
            _ => (None, None),
        };
        let fill = if selected && kind != Kind::Text && kind != Kind::Heading { Some(pal.accent_soft) } else { fill };
        if let Some(c) = fill {
            frame.fill(&shape, c);
        }
        if kind == Kind::Hole {
            hatch(frame, r, (12.0 * k).max(6.0), with_alpha(pal.text_faint, 0.35));
        }
        if focused && kind != Kind::Text && kind != Kind::Heading {
            frame.stroke(&shape, Stroke::default().with_color(pal.accent).with_width(2.0));
        } else if let Some(c) = line {
            frame.stroke(&shape, Stroke::default().with_color(c).with_width(1.0));
        }
        if kind == Kind::Check {
            let b = (n.h - 4.0).min(14.0) * k;
            let radio = n.r == "radio button";
            let bx = Point::new(r.x + 2.0 * k, r.y + (r.height - b) / 2.0);
            let boxp = Path::rounded_rectangle(bx, Size::new(b, b), (if radio { b / 2.0 } else { 3.0 * k }).into());
            frame.fill(&boxp, pal.bg);
            frame.stroke(&boxp, Stroke::default().with_color(pal.text_dim).with_width(1.0));
            if s.contains('c') {
                let m = (b - 6.0 * k).max(1.0);
                frame.fill(&Path::rounded_rectangle(Point::new(bx.x + 3.0 * k, bx.y + 3.0 * k), Size::new(m, m), (if radio { m / 2.0 } else { 2.0 * k }).into()), pal.accent);
            }
        }
        // El texto.
        let mut label = label_of(n);
        if kind == Kind::Hole {
            label = if label.is_empty() { self.words.no_view.to_string() } else { format!("{label} · {}", self.words.no_view) };
        }
        if label.is_empty() || n.h < 8.0 {
            return;
        }
        let fs = match kind {
            Kind::Win => 12.0,
            Kind::Heading => (n.h - 4.0).clamp(10.0, 18.0),
            _ => (n.h - 4.0).clamp(8.0, 13.0),
        };
        let px = fs * k;
        if px < 4.0 {
            return;
        }
        let mut color = if selected { pal.accent_soft_ink } else if kind == Kind::Win { pal.text_dim } else if kind == Kind::Hole { pal.text_faint } else { pal.text };
        if off {
            color = with_alpha(color, 0.5);
        }
        let font = if matches!(kind, Kind::Win | Kind::Heading) { BOLD } else { BODY };
        let pad = if kind == Kind::Check { (n.h.min(18.0) + 4.0) * k } else { 4.0 * k };
        let multi = (s.contains('m') || n.r == "paragraph" || n.r == "terminal") && n.h > fs * 2.4 && n.t.is_some();
        if multi {
            let t = n.t.as_deref().unwrap_or("");
            let max = ((n.h - 4.0) / (fs * 1.25)).floor().max(0.0) as usize;
            for (i, line) in t.split('\n').take(max).enumerate() {
                frame.fill_text(Text {
                    content: fit(line, n.w - 8.0, fs),
                    position: Point::new(r.x + pad, r.y + 2.0 * k + fs * k * 1.15 * i as f32),
                    color,
                    size: Pixels(px),
                    font,
                    align_y: alignment::Vertical::Top,
                    ..Default::default()
                });
            }
        } else {
            let (y, align_y) = if kind == Kind::Win { (r.y + 4.0 * k, alignment::Vertical::Top) } else { (r.y + r.height / 2.0, alignment::Vertical::Center) };
            frame.fill_text(Text {
                content: fit(&label, n.w - pad / k * 2.0, fs),
                position: Point::new(r.x + pad, y),
                color,
                size: Pixels(px),
                font,
                align_y,
                ..Default::default()
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_lienzo_no_sale_del_area() {
        assert_eq!(clamp_axis(50.0, 100.0, 40.0), 50.0);
        assert_eq!(clamp_axis(80.0, 100.0, 40.0), 60.0);
        assert_eq!(clamp_axis(-10.0, 100.0, 40.0), 0.0);
        assert_eq!(clamp_axis(10.0, 100.0, 400.0), 0.0);
        assert_eq!(clamp_axis(-500.0, 100.0, 400.0), -300.0);
    }

    #[test]
    fn encuadrar_y_volver_a_la_pantalla() {
        let screen = Size::new(1920.0, 1080.0);
        let mut v = ViewBox { size: Size::new(960.0, 540.0), ..Default::default() };
        v.fit(screen, None);
        assert_eq!(v.k(screen), 0.5);
        assert_eq!(v.to_screen(screen, Point::new(480.0, 270.0)), Point::new(960.0, 540.0));
        // Una ventana de 480×270 en (0,0): zoom 4 (llena el área) y la esquina en el origen.
        v.fit(screen, Some(Rect { x: 0.0, y: 0.0, w: 480.0, h: 270.0 }));
        assert_eq!(v.zoom, 4.0);
        assert_eq!((v.tx, v.ty), (0.0, 0.0));
        assert_eq!(v.to_screen(screen, Point::new(960.0, 540.0)), Point::new(480.0, 270.0));
        // El zoom alrededor de un punto lo deja quieto.
        v.fit(screen, None);
        v.zoom_at(screen, 2.0, Point::new(480.0, 270.0));
        assert_eq!(v.to_screen(screen, Point::new(480.0, 270.0)), Point::new(960.0, 540.0));
    }
}
