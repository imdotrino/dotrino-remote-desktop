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
 * ¿Es el mismo título? El de X11 y el de accesibilidad no siempre son iguales: Chrome le añade al
 * de accesibilidad el nombre del perfil («… - Google Chrome - Santiago»). Vale igual, o uno al
 * principio del otro (y no vacío).
 * @param {string} x11 @param {string} a11y
 */
export function sameTitle (x11, a11y) {
  if (!x11 || !a11y) return false
  return x11 === a11y || a11y.startsWith(x11) || x11.startsWith(a11y)
}

/**
 * Elige, de las ventanas X11 de un proceso, la que corresponde a la ventana de accesibilidad.
 * El título no siempre es el mismo: Chrome le añade en accesibilidad el nombre del perfil y avisos
 * («… - Google Chrome - Santiago», «High memory usage - 1.2 GB»). Por eso, en orden: el título
 * exacto; si no, la que está en el mismo sitio con el mismo tamaño; si no, la de título más
 * parecido (el de X11 suele ser el principio del de accesibilidad).
 * @param {Array<{ id: string, name: string, x?: number, y?: number, w?: number, h?: number }>} cands
 * @param {string} title
 * @param {{ x: number, y: number, w: number, h: number } | null} [rect]
 * @returns {string | null}
 */
export function pickWindow (cands, title, rect = null) {
  const exact = cands.find((c) => c.name === title)
  if (exact) return exact.id
  // El título de X11 al principio del de accesibilidad (Chrome añade « - <perfil>»): va ANTES
  // que el sitio, porque las ventanas maximizadas de un mismo programa están todas en el mismo
  // sitio con el mismo tamaño, y por sitio salía siempre la primera (dueño, 2026-11-17: elegir
  // una ventana de Chrome «loopea entre las otras»).
  let pre = null
  for (const c of cands) if (c.name && sameTitle(c.name, title) && (!pre || c.name.length > pre.name.length)) pre = c
  if (pre) return pre.id
  if (rect) {
    const near = (/** @type {number | undefined} */ a, /** @type {number} */ b) => a != null && Math.abs(a - b) <= 50
    const same = cands.filter((c) => near(c.x, rect.x) && near(c.y, rect.y) && near(c.w, rect.w) && near(c.h, rect.h))
    // Solo si es UNA: con varias en el mismo sitio, el sitio no dice cuál.
    if (same.length === 1) return same[0].id
  }
  let best = null; let bestLen = 9
  for (const c of cands) {
    let n = 0
    while (n < c.name.length && n < title.length && c.name[n] === title[n]) n++
    if (n > bestLen) { best = c.id; bestLen = n }
  }
  return best
}

/**
 * Trae al frente la ventana de ese proceso que corresponde a esa ventana de accesibilidad.
 * @param {{ pid: number, title: string, rect?: { x: number, y: number, w: number, h: number } | null, session?: string, exec?: typeof run }} o
 */
export async function raiseWindow ({ pid, title, rect = null, session = process.env.XDG_SESSION_TYPE || '', exec = run }) {
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
  /** @type {Array<{ id: string, name: string, x?: number, y?: number, w?: number, h?: number }>} */
  const cands = []
  for (const id of ids) {
    try {
      const out = await exec('xdotool', ['getwindowname', id, 'getwindowgeometry', '--shell', id])
      const [name = '', ...rest] = out.split('\n')
      /** @type {Record<string, number>} */
      const kv = {}
      for (const l of rest) { const m = /^([A-Z]+)=(-?\d+)$/.exec(l.trim()); if (m) kv[m[1]] = Number(m[2]) }
      cands.push({ id, name: name.trim(), x: kv.X, y: kv.Y, w: kv.WIDTH, h: kv.HEIGHT })
    } catch (_) { /* una ventana que se cerró mientras se miraba */ }
  }
  const win = pickWindow(cands, title, rect)
  if (!win) throw fail('window-not-found', `no window like "${title.slice(0, 60)}" in process ${pid}`)
  await exec('xdotool', ['windowactivate', win])
  return { window: win }
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
