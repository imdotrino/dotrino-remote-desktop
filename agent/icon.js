/**
 * icon.js — el ICONO de la app de una ventana, para la barra de tareas de la tableta (dueño,
 * 2026-11-17: «el taskbar debe tener los iconos de las apps»).
 *
 * Lo da el gestor de ventanas: cada ventana X11 publica sus iconos en `_NET_WM_ICON` (varios
 * tamaños seguidos, cada uno `ancho, alto` y luego un ARGB por píxel). Se lee con `xprop`, se
 * elige el tamaño más cercano a `SIZE`, se reduce si hace falta y sale como PNG, que el navegador
 * pinta sin más. La accesibilidad no tiene iconos de app. Solo X11, como traer al frente.
 *
 * El PNG se escribe aquí (unas líneas con `zlib`): no vale una dependencia.
 */
import { execFile } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { pickWindow, windowsOf } from './raise.js'

/** El lado del icono que se manda: la barra lo pinta a 20 px, y así se ve nítido a 2× y 2,4×. */
export const SIZE = 48

/** @type {(code: string, message: string) => Error & { code: string }} */
const fail = (code, message) => Object.assign(new Error(message), { code })

/** @param {string} cmd @param {string[]} args @returns {Promise<string>} */
const run = (cmd, args) => new Promise((resolve, reject) => {
  // Los iconos en texto pesan: uno de 256×256 son ~700 KB de números.
  execFile(cmd, args, { timeout: 3000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => { if (err) reject(err); else resolve(String(stdout)) })
})

/**
 * Los iconos que contesta `xprop -notype 32c _NET_WM_ICON`. Vacío si la ventana no tiene.
 * @param {string} out
 * @returns {Array<{ w: number, h: number, argb: number[] }>}
 */
export function parseIcons (out) {
  const eq = out.indexOf('=')
  if (eq < 0) return []
  const v = out.slice(eq + 1).split(',').map((s) => Number(s.trim()))
  /** @type {Array<{ w: number, h: number, argb: number[] }>} */
  const icons = []
  for (let i = 0; i + 2 <= v.length;) {
    const w = v[i]; const h = v[i + 1]
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 || i + 2 + w * h > v.length) break
    icons.push({ w, h, argb: v.slice(i + 2, i + 2 + w * h) })
    i += 2 + w * h
  }
  return icons
}

/**
 * El tamaño que se usa: el más pequeño que llegue a `size`; si ninguno llega, el más grande.
 * @param {Array<{ w: number, h: number, argb: number[] }>} icons @param {number} [size]
 */
export function pickIcon (icons, size = SIZE) {
  if (!icons.length) return null
  const big = icons.filter((i) => Math.min(i.w, i.h) >= size).sort((a, b) => a.w * a.h - b.w * b.h)
  return big[0] || icons.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a))
}

/**
 * ARGB → RGBA de `dw`×`dh`, promediando cada caja de píxeles (con el alfa como peso, para que el
 * borde transparente no oscurezca el color). Sin reducir si ya mide eso.
 * @param {{ w: number, h: number, argb: number[] }} icon @param {number} dw @param {number} dh
 */
export function toRgba ({ w, h, argb }, dw, dh) {
  const out = new Uint8Array(dw * dh * 4)
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * h / dh); const y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / dh))
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * w / dw); const x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / dw))
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const p = argb[sy * w + sx] >>> 0
          const pa = p >>> 24
          r += ((p >>> 16) & 255) * pa; g += ((p >>> 8) & 255) * pa; b += (p & 255) * pa; a += pa; n++
        }
      }
      const o = (y * dw + x) * 4
      if (a) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a) }
      out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

/** @type {Uint32Array | null} */
let crcTable = null
/** @param {Uint8Array} buf */
function crc32 (buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
  }
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Un PNG RGBA de 8 bits.
 * @param {number} w @param {number} h @param {Uint8Array} rgba
 * @returns {Buffer}
 */
export function encodePng (w, h, rgba) {
  /** @param {string} type @param {Uint8Array} data */
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8 bits, RGBA
  // Cada fila empieza con su filtro (0: ninguno).
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))
  ])
}

/**
 * El icono de la ventana de ese proceso que corresponde a esa ventana de accesibilidad, como PNG
 * en base64. `null` si la ventana no publica icono (es un estado normal, no un fallo).
 * Guarda lo leído por ventana X11: el icono de una ventana casi nunca cambia.
 * @param {{ session?: string, exec?: typeof run }} [o]
 */
export function makeIcons ({ session = process.env.XDG_SESSION_TYPE || '', exec = run } = {}) {
  /** @type {Map<string, string | null>} */
  const cache = new Map()
  /**
   * @param {{ pid: number, title: string, rect?: { x: number, y: number, w: number, h: number } | null }} o
   * @returns {Promise<string | null>}
   */
  async function iconOf ({ pid, title, rect = null }) {
    if (session === 'wayland') throw fail('no-icon', 'window icons are X11 only for now')
    const win = pickWindow(await windowsOf(pid, exec, 'no-icon'), title, rect)
    if (!win) throw fail('window-not-found', `no window like "${title.slice(0, 60)}" in process ${pid}`)
    if (cache.has(win)) return /** @type {string | null} */ (cache.get(win))
    let out
    try { out = await exec('xprop', ['-id', win, '-notype', '32c', '_NET_WM_ICON']) } catch (e) {
      const err = /** @type {NodeJS.ErrnoException} */ (e)
      if (err.code === 'ENOENT') throw fail('no-icon', 'xprop is not installed on this machine')
      throw fail('icon-failed', err.message)
    }
    const icon = pickIcon(parseIcons(out))
    let png = null
    if (icon) {
      const k = Math.min(1, SIZE / Math.max(icon.w, icon.h))
      const dw = Math.max(1, Math.round(icon.w * k)); const dh = Math.max(1, Math.round(icon.h * k))
      png = encodePng(dw, dh, toRgba(icon, dw, dh)).toString('base64')
    }
    if (cache.size > 200) cache.clear()
    cache.set(win, png)
    return png
  }
  return { iconOf }
}
