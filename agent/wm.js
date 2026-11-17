/**
 * wm.js — las ventanas que solo conoce el GESTOR DE VENTANAS: las de las apps que no publican
 * accesibilidad (la Terminal de Dotrino, hecha con iced; un juego). AT-SPI no las ve, así que no
 * salían en la barra de tareas de la tableta salvo cuando eran la activa (dueño, 2026-11-17: «en
 * la lista de aplicaciones no están las terminales de dotrino»).
 *
 * Se leen de `_NET_CLIENT_LIST` (la lista que usa cualquier barra de tareas) y se quedan las de
 * los procesos que no tienen NINGUNA ventana en la accesibilidad: así una app que sí la publica no
 * sale dos veces aunque su título difiera. Se descartan las que una barra de tareas tampoco enseña
 * (paneles, el fondo del escritorio, `SKIP_TASKBAR`) y las minimizadas, como hace AT-SPI.
 *
 * Coste: una llamada por segundo para la lista; el proceso y el tipo de cada ventana se leen una
 * vez (no cambian), y el título, el sitio y el estado solo de las que quedan, que suelen ser pocas.
 * Solo X11.
 */
import { execFile } from 'node:child_process'

/** @param {string} cmd @param {string[]} args @returns {Promise<string>} */
const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 3000 }, (err, stdout) => { if (err) reject(err); else resolve(String(stdout)) })
})

/** Los tipos de ventana que enseña una barra de tareas. */
const SHOWN_TYPES = new Set(['_NET_WM_WINDOW_TYPE_NORMAL', '_NET_WM_WINDOW_TYPE_DIALOG'])

/**
 * Los ids (en decimal, como los da xdotool) de `xprop -root _NET_CLIENT_LIST`.
 * @param {string} out
 */
export function parseClientList (out) {
  const i = out.indexOf('#')
  if (i < 0) return []
  return out.slice(i + 1).split(',').map((s) => s.trim()).filter(Boolean).map((h) => String(parseInt(h, 16))).filter((d) => d !== 'NaN')
}

/**
 * Lo que dice `xprop -id W _NET_WM_PID _NET_WM_WINDOW_TYPE _NET_WM_STATE`.
 * @param {string} out
 * @returns {{ pid: number, types: string[], states: string[] }}
 */
export function parseProps (out) {
  /** @param {string} name */
  const line = (name) => out.split('\n').find((l) => l.startsWith(name + '(')) || ''
  /** @param {string} l */
  const atoms = (l) => (l.includes('=') ? l.slice(l.indexOf('=') + 1).split(',').map((s) => s.trim()).filter(Boolean) : [])
  const pid = Number((line('_NET_WM_PID').split('=')[1] || '').trim()) || 0
  return { pid, types: atoms(line('_NET_WM_WINDOW_TYPE')), states: atoms(line('_NET_WM_STATE')) }
}

/**
 * ¿La enseñaría una barra de tareas? Sin tipo cuenta como normal (lo dice la especificación).
 * @param {{ types: string[], states: string[] }} p
 */
export const showsInTaskbar = (p) =>
  (!p.types.length || p.types.some((t) => SHOWN_TYPES.has(t))) &&
  !p.states.includes('_NET_WM_STATE_SKIP_TASKBAR') && !p.states.includes('_NET_WM_STATE_HIDDEN')

/**
 * @param {{ session?: string, exec?: typeof run }} [o]
 */
export function makeClientWindows ({ session = process.env.XDG_SESSION_TYPE || '', exec = run } = {}) {
  /** @type {Map<string, { pid: number, types: string[] }>} lo que no cambia de cada ventana */
  const fixed = new Map()

  /**
   * Las ventanas de la barra de tareas cuyos procesos no están en `covered`.
   * `null` si no se puede saber (Wayland, sin xprop): entonces solo cuenta la accesibilidad.
   * @param {Set<number>} covered  los procesos que ya tienen ventanas en la accesibilidad
   * @returns {Promise<Array<{ window: string, pid: number, title: string, x: number, y: number, w: number, h: number }> | null>}
   */
  async function list (covered) {
    if (session === 'wayland') return null
    let ids
    try { ids = parseClientList(await exec('xprop', ['-root', '_NET_CLIENT_LIST'])) } catch (_) { return null }
    const alive = new Set(ids)
    for (const id of fixed.keys()) if (!alive.has(id)) fixed.delete(id)
    /** @type {Array<{ window: string, pid: number, title: string, x: number, y: number, w: number, h: number }>} */
    const out = []
    for (const id of ids) {
      try {
        let f = fixed.get(id)
        /** @type {string[] | null} */
        let states = null
        if (!f) {
          const p = parseProps(await exec('xprop', ['-id', id, '_NET_WM_PID', '_NET_WM_WINDOW_TYPE', '_NET_WM_STATE']))
          f = { pid: p.pid, types: p.types }
          fixed.set(id, f)
          states = p.states
        }
        if (!f.pid || covered.has(f.pid)) continue
        if (f.types.length && !f.types.some((t) => SHOWN_TYPES.has(t))) continue
        // El estado sí cambia (minimizar): se lee cada vez, pero solo de las que quedan.
        states ||= parseProps(await exec('xprop', ['-id', id, '_NET_WM_STATE'])).states
        if (!showsInTaskbar({ types: f.types, states })) continue
        const g = await exec('xdotool', ['getwindowname', id, 'getwindowgeometry', '--shell', id])
        const [title = '', ...rest] = g.split('\n')
        /** @type {Record<string, number>} */
        const kv = {}
        for (const l of rest) { const m = /^([A-Z]+)=(-?\d+)$/.exec(l.trim()); if (m) kv[m[1]] = Number(m[2]) }
        if (!(kv.WIDTH > 0 && kv.HEIGHT > 0)) continue
        out.push({ window: id, pid: f.pid, title: title.trim(), x: kv.X, y: kv.Y, w: kv.WIDTH, h: kv.HEIGHT })
      } catch (_) { /* una ventana que se cerró mientras se miraba */ }
    }
    return out
  }

  return { list }
}
