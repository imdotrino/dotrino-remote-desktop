/**
 * video.js — pinta el vídeo de un hueco (agent/video.js) encima de su sitio en el SVG.
 *
 * Decodifica WebCodecs, que viene en el navegador: nada de librerías ni de WebRTC de medios.
 * El flujo es H.264 baseline en Annex B, así que no hace falta `description`: basta el códec,
 * que sale del SPS del primer cuadro completo.
 *
 * El lienzo va dentro de un `<foreignObject>` del propio SVG, en las coordenadas de la pantalla
 * de la máquina: se escala, se recorta y se desplaza con la vista sin cuentas aparte.
 */

const NS = 'http://www.w3.org/2000/svg'

/** base64 → bytes. @param {string} b64 */
function bytesOf (b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * El códec WebCodecs de un flujo H.264: `avc1.PPCCLL` con los tres bytes que siguen a la
 * cabecera del SPS (perfil, restricciones, nivel). `null` si el cuadro no trae SPS.
 * @param {Uint8Array} f
 */
export function codecOf (f) {
  for (let i = 0; i + 7 < f.length; i++) {
    if (f[i] === 0 && f[i + 1] === 0 && f[i + 2] === 1 && (f[i + 3] & 0x1f) === 7) {
      return 'avc1.' + [f[i + 4], f[i + 5], f[i + 6]].map((b) => b.toString(16).padStart(2, '0')).join('')
    }
  }
  return null
}

/** ¿Puede este navegador mostrar el vídeo? */
export const canDecode = () => typeof globalThis.VideoDecoder === 'function'

/**
 * La capa de vídeo de una vista.
 * @param {SVGGElement} overlay  el grupo del SVG que va encima de la escena
 * @param {(e: Error) => void} onError
 */
export function makeVideoLayer (overlay, onError) {
  /** @type {VideoDecoder | null} */
  let decoder = null
  let codec = ''
  /** @type {SVGForeignObjectElement | null} */
  let fo = null
  /** @type {HTMLCanvasElement | null} */
  let canvas = null
  let ts = 0
  /** Hasta el próximo cuadro completo no se puede empezar a decodificar. */
  let waitingKey = true

  function clear () {
    try { decoder?.close() } catch (_) {}
    decoder = null; codec = ''; waitingKey = true
    fo?.remove(); fo = null; canvas = null
  }

  /** @param {{ x: number, y: number, w: number, h: number }} r */
  function place (r) {
    if (!fo) {
      fo = /** @type {SVGForeignObjectElement} */ (document.createElementNS(NS, 'foreignObject'))
      canvas = document.createElement('canvas')
      canvas.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none'
      fo.appendChild(canvas)
      overlay.appendChild(fo)
    }
    fo.setAttribute('x', String(r.x)); fo.setAttribute('y', String(r.y))
    fo.setAttribute('width', String(r.w)); fo.setAttribute('height', String(r.h))
  }

  /**
   * Un cuadro que llega del agente.
   * @param {{ key: boolean, rect: { x: number, y: number, w: number, h: number }, data: string }} m
   */
  function frame (m) {
    if (!canDecode()) return
    const data = bytesOf(m.data)
    if (m.key) {
      const c = codecOf(data)
      if (c && (c !== codec || !decoder || decoder.state === 'closed')) {
        try { decoder?.close() } catch (_) {}
        codec = c
        decoder = new VideoDecoder({
          output: (vf) => {
            if (canvas) {
              if (canvas.width !== vf.displayWidth) canvas.width = vf.displayWidth
              if (canvas.height !== vf.displayHeight) canvas.height = vf.displayHeight
              canvas.getContext('2d')?.drawImage(vf, 0, 0)
            }
            vf.close()
          },
          error: (e) => { waitingKey = true; onError(e) }
        })
        decoder.configure({ codec, optimizeForLatency: true })
      }
      waitingKey = false
    }
    if (waitingKey || !decoder || decoder.state !== 'configured') return
    place(m.rect)
    decoder.decode(new EncodedVideoChunk({ type: m.key ? 'key' : 'delta', timestamp: ts, data }))
    ts += 66_666
  }

  return { frame, clear, get showing () { return !!fo } }
}
