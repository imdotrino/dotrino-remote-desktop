/**
 * video.js — pinta el vídeo de los huecos (agent/video.js) encima de su sitio en el SVG.
 *
 * Decodifica WebCodecs, que viene en el navegador: nada de librerías ni de WebRTC de medios.
 * El flujo es H.264 baseline en Annex B, así que no hace falta `description`: basta el códec,
 * que sale del SPS del primer cuadro completo.
 *
 * Cada hueco tiene SU lienzo, dentro de un `<foreignObject>` del propio SVG y en coordenadas de
 * la pantalla de la máquina: se escala, se recorta y se desplaza con la vista sin cuentas aparte.
 * Solo uno recibe vídeo vivo a la vez (el de la ventana que se mira); los demás se quedan con su
 * ÚLTIMA IMAGEN. Esos píxeles ya llegaron: al pasar a «Todo el escritorio» no se tiran, se ven
 * congelados en su sitio (dueño, 2026-11-16).
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

/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */
/** @typedef {{ fo: SVGForeignObjectElement, canvas: HTMLCanvasElement, rect: Rect }} Tile */

/**
 * La capa de vídeo de una vista.
 * @param {SVGGElement} overlay  el grupo del SVG que va encima de la escena
 * @param {(e: Error) => void} onError
 */
export function makeVideoLayer (overlay, onError) {
  /** @type {Map<number, Tile>} el lienzo de cada hueco que ya recibió imagen */
  const tiles = new Map()
  /** @type {VideoDecoder | null} */
  let decoder = null
  let codec = ''
  /** @type {number | null} el hueco que recibe vídeo vivo */
  let liveId = null
  let ts = 0
  /** Hasta el próximo cuadro completo no se puede empezar a decodificar. */
  let waitingKey = true

  /** @param {number} id @param {Rect} r */
  function tileFor (id, r) {
    let t = tiles.get(id)
    if (!t) {
      const fo = /** @type {SVGForeignObjectElement} */ (document.createElementNS(NS, 'foreignObject'))
      const canvas = document.createElement('canvas')
      canvas.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none'
      fo.appendChild(canvas)
      overlay.appendChild(fo)
      t = { fo, canvas, rect: r }
      tiles.set(id, t)
    }
    place(t, r)
    return t
  }

  /** @param {Tile} t @param {Rect} r */
  function place (t, r) {
    t.rect = r
    t.fo.setAttribute('x', String(r.x)); t.fo.setAttribute('y', String(r.y))
    t.fo.setAttribute('width', String(r.w)); t.fo.setAttribute('height', String(r.h))
  }

  /** Deja de recibir vídeo vivo; la última imagen de ese hueco se queda. */
  function stopLive () {
    try { decoder?.close() } catch (_) {}
    decoder = null; codec = ''; waitingKey = true; liveId = null
  }

  /**
   * Un cuadro que llega del agente para el hueco `id`.
   * @param {{ id: number, key: boolean, rect: Rect, data: string }} m
   */
  function frame (m) {
    if (!canDecode()) return
    if (m.id !== liveId) { stopLive(); liveId = m.id }
    const data = bytesOf(m.data)
    if (m.key) {
      const c = codecOf(data)
      if (c && (c !== codec || !decoder || decoder.state === 'closed')) {
        try { decoder?.close() } catch (_) {}
        codec = c
        const id = m.id
        decoder = new VideoDecoder({
          output: (vf) => {
            const t = tiles.get(id)
            if (t) {
              if (t.canvas.width !== vf.displayWidth) t.canvas.width = vf.displayWidth
              if (t.canvas.height !== vf.displayHeight) t.canvas.height = vf.displayHeight
              t.canvas.getContext('2d')?.drawImage(vf, 0, 0)
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
    tileFor(m.id, m.rect)
    decoder.decode(new EncodedVideoChunk({ type: m.key ? 'key' : 'delta', timestamp: ts, data }))
    ts += 66_666
  }

  /**
   * Pone cada imagen guardada donde está ahora su hueco, quita las de los que ya no existen y
   * esconde las que no tocan (con una sola ventana a la vista, solo las de esa ventana).
   * @param {(id: number) => Rect | null} rectOf
   * @param {(id: number) => boolean} visible
   */
  function sync (rectOf, visible) {
    for (const [id, t] of tiles) {
      const r = rectOf(id)
      if (!r) { t.fo.remove(); tiles.delete(id); if (id === liveId) stopLive(); continue }
      if (r.x !== t.rect.x || r.y !== t.rect.y || r.w !== t.rect.w || r.h !== t.rect.h) place(t, r)
      t.fo.style.display = visible(id) ? '' : 'none'
    }
  }

  /** Todo fuera (otra máquina, desconectar). */
  function clear () {
    stopLive()
    for (const t of tiles.values()) t.fo.remove()
    tiles.clear()
  }

  return { frame, stopLive, sync, clear, get live () { return liveId } }
}
