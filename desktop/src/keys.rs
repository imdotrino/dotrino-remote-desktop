//! El teclado: lo que es texto va como texto (`{type:'text'}`), lo demás por su keysym de X
//! (`{type:'key', keysym}`), que es lo que entiende el agente (main.js `KEYSYMS`, ampliado).

use iced::keyboard::key::Named;

/// El keysym de X de una tecla que no es texto. `None`: se escribe como texto, o no se manda.
pub fn keysym(named: Named) -> Option<u32> {
    Some(match named {
        Named::Enter => 0xff0d,
        Named::Backspace => 0xff08,
        Named::Tab => 0xff09,
        Named::Escape => 0xff1b,
        Named::Delete => 0xffff,
        Named::Insert => 0xff63,
        Named::ArrowLeft => 0xff51,
        Named::ArrowUp => 0xff52,
        Named::ArrowRight => 0xff53,
        Named::ArrowDown => 0xff54,
        Named::Home => 0xff50,
        Named::End => 0xff57,
        Named::PageUp => 0xff55,
        Named::PageDown => 0xff56,
        Named::F1 => 0xffbe,
        Named::F2 => 0xffbf,
        Named::F3 => 0xffc0,
        Named::F4 => 0xffc1,
        Named::F5 => 0xffc2,
        Named::F6 => 0xffc3,
        Named::F7 => 0xffc4,
        Named::F8 => 0xffc5,
        Named::F9 => 0xffc6,
        Named::F10 => 0xffc7,
        Named::F11 => 0xffc8,
        Named::F12 => 0xffc9,
        Named::ContextMenu => 0xff67,
        _ => return None,
    })
}

/// ¿Es texto lo que produjo la tecla? Solo caracteres que se ven (no los de control).
pub fn printable(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| !c.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn teclas() {
        assert_eq!(keysym(Named::Enter), Some(0xff0d));
        assert_eq!(keysym(Named::ArrowDown), Some(0xff54));
        assert_eq!(keysym(Named::Shift), None);
        assert!(printable("ñ"));
        assert!(!printable("\r"));
        assert!(!printable(""));
    }
}
