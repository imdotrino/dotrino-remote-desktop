//! El vídeo de los huecos (agent/video.js): H.264 baseline en Annex B, un cuadro por mensaje.
//!
//! Lo decodifica OpenH264 (el de Cisco, compilado con la app desde su fuente): ni librerías del
//! sistema ni nada que se baje al arrancar. Un decodificador por hueco vivo: al cambiar de hueco
//! se empieza otro, y hasta el primer cuadro completo (con su SPS) no se decodifica nada.

use openh264::decoder::Decoder as H264;
use openh264::formats::YUVSource;

#[derive(Default)]
pub struct Decoder {
    live: Option<(i64, H264)>,
}

/// ¿Trae este cuadro un SPS (NAL 7)? Sin él no se puede empezar.
pub fn has_sps(data: &[u8]) -> bool {
    data.windows(4).any(|w| w[0] == 0 && w[1] == 0 && w[2] == 1 && (w[3] & 0x1f) == 7)
}

impl Decoder {
    /// Decodifica un cuadro del hueco `id`. `Ok(None)`: todavía no hay imagen (esperando el
    /// cuadro completo). La imagen sale en RGBA.
    pub fn decode(&mut self, id: i64, data: &[u8]) -> Result<Option<(u32, u32, Vec<u8>)>, String> {
        if self.live.as_ref().map(|(x, _)| *x) != Some(id) {
            self.live = None;
            if !has_sps(data) {
                return Ok(None);
            }
            self.live = Some((id, H264::new().map_err(|e| e.to_string())?));
        }
        let Some((_, dec)) = self.live.as_mut() else { return Ok(None) };
        match dec.decode(data) {
            Ok(Some(yuv)) => {
                let (w, h) = yuv.dimensions();
                let mut rgba = vec![0u8; w * h * 4];
                yuv.write_rgba8(&mut rgba);
                Ok(Some((w as u32, h as u32, rgba)))
            }
            Ok(None) => Ok(None),
            Err(e) => {
                // El flujo se rompió: se empieza de nuevo con el próximo cuadro completo.
                self.live = None;
                Err(e.to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sin_sps_no_se_empieza() {
        let mut d = Decoder::default();
        // Un cuadro P suelto (NAL 1) no tiene con qué decodificarse.
        assert_eq!(d.decode(1, &[0, 0, 0, 1, 9, 0xf0, 0, 0, 0, 1, 0x41, 0x9a]).unwrap(), None);
        assert!(has_sps(&[0, 0, 0, 1, 0x67, 0x42]));
        assert!(!has_sps(&[0, 0, 0, 1, 0x41, 0x9a]));
    }

    /// Un cuadro de verdad: lo codifica OpenH264 y se decodifica de vuelta.
    #[test]
    fn un_cuadro_codificado_se_decodifica() {
        use openh264::encoder::Encoder;
        use openh264::formats::{RgbSliceU8, YUVBuffer};
        let (w, h) = (64usize, 48usize);
        let rgb: Vec<u8> = (0..w * h).flat_map(|i| [(i % 255) as u8, 80, 160]).collect();
        let yuv = YUVBuffer::from_rgb_source(RgbSliceU8::new(&rgb, (w, h)));
        let mut enc = Encoder::new().unwrap();
        let bits = enc.encode(&yuv).unwrap().to_vec();
        let mut d = Decoder::default();
        let (dw, dh, rgba) = d.decode(7, &bits).unwrap().expect("a picture");
        assert_eq!((dw, dh), (64, 48));
        assert_eq!(rgba.len(), 64 * 48 * 4);
    }
}
