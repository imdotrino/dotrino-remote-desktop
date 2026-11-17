/**
 * video.js — el VÍDEO DE UN HUECO: lo que no publica accesibilidad (Chrome, VS Code, una foto,
 * un lienzo) se manda como vídeo, pero solo ese rectángulo, no la pantalla entera.
 *
 * Captura y codifica `ffmpeg` (x11grab → H.264 baseline, sin cuadros B, con un AUD delante de
 * cada cuadro para poder separarlos sin entender el resto del flujo). El navegador lo decodifica
 * con WebCodecs, que viene en él. Medido el 2026-11-16: una ventana de 1426×896 a 15 cuadros por
 * segundo son ~100 KB/s; un cuadro mediano, 2,8 KB; uno completo, ~63 KB. Y quieta, nada:
 * los cuadros iguales se descartan antes de codificar.
 *
 * Solo X11. En Wayland la pantalla se pide por el portal del escritorio (PipeWire), que es otra
 * pieza: hasta entonces se dice con su `code` (`no-video`) y el hueco se queda como recuadro.
 */
import { spawn as nodeSpawn } from 'node:child_process'

export const FPS = 15
/** Un cuadro completo cada GOP cuadros CAMBIADOS (con la pantalla quieta no sale ninguno). */
export const GOP = FPS * 2
/** Lo más pequeño que vale la pena mandar en vídeo. */
export const MIN_SIDE = 32

const AUD = [0, 0, 0, 1, 9]
/** Sin datos durante esto, lo pendiente es un cuadro entero (ver `flush`). */
const IDLE_MS = 40

/** @type {(code: string, message: string) => Error & { code: string }} */
const fail = (code, message) => Object.assign(new Error(message), { code })

/**
 * El rectángulo que se puede codificar: H.264 con 4:2:0 quiere lados pares, y dentro de la
 * pantalla. `null` si queda demasiado pequeño para que valga la pena.
 * @param {{ x: number, y: number, w: number, h: number }} r
 * @param {{ w: number, h: number }} screen
 */
export function evenRect (r, screen) {
  const x = Math.max(0, Math.round(r.x)); const y = Math.max(0, Math.round(r.y))
  let w = Math.min(Math.round(r.w), screen.w - x); let h = Math.min(Math.round(r.h), screen.h - y)
  w -= w % 2; h -= h % 2
  return w >= MIN_SIDE && h >= MIN_SIDE ? { x, y, w, h } : null
}

/**
 * Parte un flujo H.264 Annex B en cuadros, por los AUD. Devuelve los cuadros completos y lo
 * que sobra (el principio del siguiente), que hay que volver a pasar con lo que llegue después.
 * @param {Uint8Array} buf
 * @returns {{ frames: Uint8Array[], rest: Uint8Array }}
 */
export function splitFrames (buf) {
  /** @type {number[]} */
  const starts = []
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1 && (buf[i + 4] & 0x1f) === 9) starts.push(i)
  }
  /** @type {Uint8Array[]} */
  const frames = []
  for (let k = 0; k + 1 < starts.length; k++) frames.push(buf.subarray(starts[k], starts[k + 1]))
  const rest = starts.length ? buf.subarray(starts[starts.length - 1]) : buf
  return { frames, rest }
}

/** ¿Es un cuadro completo (lleva un IDR, NAL tipo 5)? @param {Uint8Array} f */
export function isKey (f) {
  for (let i = 0; i + 3 < f.length; i++) {
    if (f[i] === 0 && f[i + 1] === 0 && f[i + 2] === 1 && (f[i + 3] & 0x1f) === 5) return true
  }
  return false
}

/**
 * Los dos perfiles. Por el proxio o el TURN de Dotrino la imagen va, pero MUY conservadora
 * (dueño, 2026-11-16: «la imagen sí debe ir por proxy, pero mucho más conservador que directa»):
 * un cuarto de los píxeles, 3 cuadros por segundo y un tope de datos bajo.
 */
export const PROFILES = /** @type {const} */ ({
  direct: { fps: FPS, scale: 1, bitrate: '800k', maxrate: '1200k', bufsize: '600k' },
  relay: { fps: 3, scale: 0.5, bitrate: '120k', maxrate: '150k', bufsize: '150k' }
})

/**
 * Los argumentos de ffmpeg para ese rectángulo.
 * @param {{ x: number, y: number, w: number, h: number }} r @param {string} display
 * @param {keyof typeof PROFILES} [profile]
 */
export function ffmpegArgs (r, display, profile = 'direct') {
  const p = PROFILES[profile]
  // Reducir deja los lados pares (H.264 con 4:2:0 los quiere así).
  const filters = p.scale < 1 ? `mpdecimate,scale=trunc(iw*${p.scale}/2)*2:trunc(ih*${p.scale}/2)*2` : 'mpdecimate'
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'x11grab', '-framerate', String(p.fps), '-video_size', `${r.w}x${r.h}`, '-i', `${display}+${r.x},${r.y}`,
    // SOLO LO QUE CAMBIA (dueño, 2026-11-16): mpdecimate tira los cuadros iguales al anterior
    // ANTES de codificar, y con vfr no se rellenan. Una pantalla quieta no manda nada.
    '-vf', filters, '-fps_mode', 'vfr',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'baseline',
    '-pix_fmt', 'yuv420p', '-g', String(p.fps * 2), '-bf', '0', '-x264-params', 'aud=1',
    '-b:v', p.bitrate, '-maxrate', p.maxrate, '-bufsize', p.bufsize,
    '-f', 'h264', '-'
  ]
}

/**
 * Un emisor de vídeo: UN rectángulo a la vez. `start` con otro rectángulo rehace la captura (la
 * ventana se movió, o se mira otra), y el primer cuadro de cada captura es completo.
 *
 * @param {{ log?: (m: string) => void, spawn?: typeof nodeSpawn, session?: string, display?: string }} [o]
 */
export function makeVideo ({ log = () => {}, spawn = nodeSpawn, session = process.env.XDG_SESSION_TYPE || '', display = process.env.DISPLAY || ':0' } = {}) {
  /** @type {import('node:child_process').ChildProcess | null} */
  let proc = null
  let current = ''

  function stop () {
    current = ''
    if (proc) { try { proc.kill('SIGKILL') } catch (_) {} proc = null }
  }

  /**
   * @param {{ x: number, y: number, w: number, h: number }} r  ya par y dentro de la pantalla (evenRect)
   * @param {(f: { key: boolean, data: Uint8Array }) => void} onFrame
   * @param {(e: Error & { code: string }) => void} onError
   * @param {keyof typeof PROFILES} [profile]
   */
  function start (r, onFrame, onError, profile = 'direct') {
    if (session === 'wayland') { onError(fail('no-video', 'video of a window is X11 only for now')); return }
    const key = `${r.x},${r.y},${r.w},${r.h},${profile}`
    if (proc && key === current) return
    stop()
    current = key
    const p = spawn('ffmpeg', ffmpegArgs(r, display, profile), { stdio: ['ignore', 'pipe', 'pipe'] })
    proc = p
    let pending = new Uint8Array(0)
    let errText = ''
    /** @type {ReturnType<typeof setTimeout> | null} */
    let idle = null
    // Un cuadro se da por terminado cuando empieza el siguiente... y con la pantalla quieta no
    // hay siguiente: el último se quedaba sin salir (también el primero). ffmpeg escribe cada
    // cuadro de una vez, así que si en IDLE_MS no llega nada más, lo pendiente es un cuadro entero.
    const flush = () => {
      idle = null
      if (pending.length > AUD.length && AUD.every((b, i) => pending[i] === b)) onFrame({ key: isKey(pending), data: pending })
      pending = new Uint8Array(0)
    }
    p.stdout?.on('data', (/** @type {Buffer} */ chunk) => {
      if (idle) { clearTimeout(idle); idle = null }
      const joined = new Uint8Array(pending.length + chunk.length)
      joined.set(pending); joined.set(chunk, pending.length)
      const { frames, rest } = splitFrames(joined)
      pending = rest.slice()
      for (const f of frames) onFrame({ key: isKey(f), data: f.slice() })
      if (proc === p) idle = setTimeout(flush, IDLE_MS)
    })
    p.stderr?.on('data', (/** @type {Buffer} */ d) => { errText = (errText + d.toString()).slice(-500) })
    p.on('error', (e) => {
      if (proc !== p) return
      proc = null; current = ''
      const err = /** @type {NodeJS.ErrnoException} */ (e)
      onError(err.code === 'ENOENT' ? fail('no-video', 'ffmpeg is not installed on this machine') : fail('video-failed', err.message))
    })
    p.on('exit', (code) => {
      if (proc !== p) return
      proc = null; current = ''
      if (code) { log(`video: ffmpeg exited ${code}: ${errText.trim()}`); onError(fail('video-failed', `ffmpeg exited with ${code}`)) }
    })
  }

  return { start, stop, get running () { return !!proc } }
}

