/**
 * raise.js — traer una ventana al frente, con el foco, en la pantalla de la máquina.
 *
 * Elegir una ventana en la tableta es decir «quiero trabajar en esta» (dueño, 2026-11-16): si
 * otra la tapa en la máquina, un toque caería en la de encima. Así lo que se ve y lo que se toca
 * coinciden.
 *
 * La accesibilidad no lo sabe hacer (`GrabFocus` sobre una ventana devuelve `false`, probado en
 * XFCE), así que se le pide al gestor de ventanas con `xdotool`, que en X11 manda el
 * `_NET_ACTIVE_WINDOW` de siempre. Solo X11: en Wayland ningún programa puede traer ventanas al
 * frente, por diseño. Cuando no se puede se dice con su `code` (`no-raise`), y la tableta lo
 * enseña: la vista se centra igual.
 */
import { execFile } from 'node:child_process'

/** @param {string} cmd @param {string[]} args @returns {Promise<string>} */
const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 3000 }, (err, stdout) => { if (err) reject(err); else resolve(String(stdout)) })
})

/** @type {(code: string, message: string) => Error & { code: string }} */
const fail = (code, message) => Object.assign(new Error(message), { code })

/**
 * Trae al frente la ventana de ese proceso que se llama así.
 * @param {{ pid: number, title: string, session?: string, exec?: typeof run }} o
 */
export async function raiseWindow ({ pid, title, session = process.env.XDG_SESSION_TYPE || '', exec = run }) {
  if (session === 'wayland') throw fail('no-raise', 'Wayland does not let a program bring windows to the front')
  /** @type {string[]} */
  let ids
  try {
    ids = (await exec('xdotool', ['search', '--pid', String(pid)])).split('\n').map((s) => s.trim()).filter(Boolean)
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException & { code?: string | number }} */ (e)
    if (err.code === 'ENOENT') throw fail('no-raise', 'xdotool is not installed on this machine')
    // `search` sale con 1 cuando no encuentra nada: no hay ventana de ese proceso.
    throw fail('window-not-found', `no window of process ${pid}`)
  }
  // De las ventanas del proceso, la que tiene ese título (un proceso puede tener varias).
  for (const id of ids) {
    let name = ''
    try { name = (await exec('xdotool', ['getwindowname', id])).trim() } catch (_) { continue }
    if (name === title) {
      await exec('xdotool', ['windowactivate', id])
      return { window: id }
    }
  }
  throw fail('window-not-found', `no window titled "${title.slice(0, 60)}" in process ${pid}`)
}

/**
 * La ventana activa DE VERDAD, según el gestor de ventanas: `{ pid, title, window, x, y, w, h }`,
 * o `null` si no se puede saber (Wayland, sin xdotool). La accesibilidad la informa mal: una app
 * de Electron se queda «activa» para siempre (visto el 2026-11-16 con dos ventanas activas a la
 * vez), y una app sin accesibilidad (la terminal de Dotrino, hecha con iced) ni siquiera sale.
 * Con la posición, el agente puede enseñar esa ventana como un hueco con vídeo.
 * @param {{ session?: string, exec?: typeof run }} [o]
 * @returns {Promise<{ pid: number, title: string, window: string, x: number, y: number, w: number, h: number } | null>}
 */
export async function activeWindow ({ session = process.env.XDG_SESSION_TYPE || '', exec = run } = {}) {
  if (session === 'wayland') return null
  let out
  try {
    out = await exec('xdotool', ['getactivewindow', 'getwindowname', 'getwindowpid', 'getwindowgeometry', '--shell'])
  } catch (_) {
    // Sin xdotool, o sin ventana activa (el escritorio): no se sabe, y se usa la accesibilidad.
    return null
  }
  return parseActive(out)
}

/**
 * Lee lo que contesta `xdotool getactivewindow getwindowname getwindowpid getwindowgeometry --shell`.
 * @param {string} out
 */
export function parseActive (out) {
  const lines = out.split('\n')
  const title = (lines[0] || '').trim()
  const pid = Number((lines[1] || '').trim())
  /** @type {Record<string, string>} */
  const kv = {}
  for (const l of lines.slice(2)) { const m = /^([A-Z]+)=(.*)$/.exec(l.trim()); if (m) kv[m[1]] = m[2] }
  if (!pid || !kv.WINDOW) return null
  return { pid, title, window: kv.WINDOW, x: Number(kv.X), y: Number(kv.Y), w: Number(kv.WIDTH), h: Number(kv.HEIGHT) }
}
