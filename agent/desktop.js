/**
 * desktop.js — el escritorio VIVO: lee la escena, se entera de lo que cambia y avisa.
 *
 * Solo trabaja mientras alguien mira (`watch`): sin nadie no lee nada ni escucha eventos.
 *
 * Cómo se entera de los cambios, sin leer la pantalla entera a cada rato:
 *  - Los EVENTOS de accesibilidad (`object:*`: cambió un texto, un estado, los hijos…) marcan
 *    como sucias las ventanas de la app que los manda, y solo esas se vuelven a leer, juntando
 *    los eventos de `SETTLE_MS` (escribir una palabra no son diez lecturas).
 *  - MOVER una ventana no manda ningún evento, y mueve todo lo de dentro. Por eso la LISTA de
 *    ventanas (barata: 9 ms con 26) se mira cada `WINDOWS_MS`, y la que cambió de sitio o de
 *    tamaño se vuelve a leer entera.
 *  - Y por si una app no avisa de algo, cada `FULL_MS` se relee todo. Es la red de seguridad,
 *    no el mecanismo: si sin ella algo no se viera, el fallo está arriba.
 */
import { makeReader, openA11yBus, setA11y, restoreA11y } from './atspi.js'
import { diff, screenOf } from './scene.js'
import { activeWindow, sameTitle } from './raise.js'

export const SETTLE_MS = 120
export const WINDOWS_MS = 1000
export const FULL_MS = 5000

/** @typedef {import('./scene.js').Scene} Scene */
/** @typedef {import('./scene.js').Patch} Patch */
/** @typedef {import('./atspi.js').Node} Node */

/**
 * @param {{ log?: (msg: string) => void, a11y?: boolean }} [opts]
 *   `a11y`: encender la accesibilidad del escritorio mientras haya alguien mirando (por
 *   defecto sí). Se deja como estaba al irse el último.
 */
export function makeDesktop (opts = {}) {
  const log = opts.log || (() => {})
  /** @type {Awaited<ReturnType<typeof openA11yBus>> | null} */
  let conn = null
  /** @type {ReturnType<typeof makeReader> | null} */
  let reader = null
  /** @type {{ IsEnabled: boolean, ScreenReaderEnabled: boolean } | null} */
  let a11yBefore = null
  /** @type {Scene} */
  let scene = { seq: 0, screen: { w: 0, h: 0 }, wins: [], nodes: [] }
  /** @type {Map<number, { key: string, app: string, nodes: Node[] }>} lo leído de cada ventana */
  const perWin = new Map()
  /** @type {Set<(p: Patch) => void>} */
  const watchers = new Set()
  /** @type {Map<string, number>} el proceso de cada app, por su nombre en el bus */
  const pids = new Map()
  /** @type {Map<number, number>} el proceso de cada ventana sin accesibilidad (por su id de nodo) */
  const synthPids = new Map()
  /** @type {Set<string>} apps (su nombre en el bus) con algo nuevo */
  const dirtyApps = new Set()
  let fullDue = true
  /** @type {ReturnType<typeof setTimeout> | null} */
  let settle = null
  /** @type {ReturnType<typeof setInterval>[]} */
  let timers = []
  /** @type {Promise<void>} las lecturas van de una en una */
  let running = Promise.resolve()
  /** @type {Promise<void> | null} */
  let starting = null

  async function start () {
    conn = await openA11yBus()
    reader = makeReader(conn.bus)
    if (opts.a11y !== false) {
      try { a11yBefore = await setA11y(conn.session, true) } catch (e) { log(`could not turn accessibility on: ${/** @type {Error} */ (e).message}`) }
    }
    await listen(conn.bus)
    timers = [
      setInterval(() => schedule(false), WINDOWS_MS),
      setInterval(() => { fullDue = true; schedule(false) }, FULL_MS)
    ]
    for (const t of timers) t.unref?.()
    fullDue = true
    await refresh()
  }

  /**
   * Pide los eventos a las apps. AT-SPI solo los emite si alguien los pidió al registro; la
   * firma de `RegisterEvent` cambió (antes un argumento, desde at-spi2-core 2.34 tres): se
   * prueba la nueva y, si el registro no la conoce, la vieja. No es un repliegue que tape
   * nada: si ninguna entra, se dice, y la red de seguridad (`FULL_MS`) sigue leyendo.
   * @param {import('@dotrino/proxy-client/dbus').DBusConnection} bus
   */
  async function listen (bus) {
    const reg = { destination: 'org.a11y.atspi.Registry', path: '/org/a11y/atspi/registry', iface: 'org.a11y.atspi.Registry', member: 'RegisterEvent' }
    for (const ev of ['object:', 'window:']) {
      try { await bus.call({ ...reg, signature: 'sass', body: [ev, [], ''] }) } catch (_) {
        try { await bus.call({ ...reg, signature: 's', body: [ev] }) } catch (e) { log(`no accessibility events (${ev}): ${/** @type {Error} */ (e).message}; reading every ${FULL_MS / 1000} s`) }
      }
    }
    await bus.addMatch("type='signal',interface='org.a11y.atspi.Event.Object'")
    await bus.addMatch("type='signal',interface='org.a11y.atspi.Event.Window'")
    bus.onSignal((m) => {
      if (!m.sender || !m.iface?.startsWith('org.a11y.atspi.Event.')) return
      // Un cambio de ventana (crear, cerrar, activar) cambia la lista: lectura entera.
      if (m.iface === 'org.a11y.atspi.Event.Window') fullDue = true
      else dirtyApps.add(m.sender)
      if (!settle) settle = setTimeout(() => { settle = null; schedule(true) }, SETTLE_MS)
    })
  }

  /** @param {boolean} _fromEvent */
  function schedule (_fromEvent) {
    if (!watchers.size) return
    running = running.then(refresh).catch((e) => log(`could not read the desktop: ${e.message}`))
  }

  /** Lee lo que haga falta y avisa con el parche, si cambió algo. */
  async function refresh () {
    if (!reader) return
    const wins = await reader.windows()
    // Cuál está activa lo dice el gestor de ventanas si se le puede preguntar: la accesibilidad
    // la informa mal (una app de Electron se queda «activa» para siempre).
    const real = await activeWindow()
    /** @type {Node | null} la ventana activa cuando no publica accesibilidad */
    let synth = null
    if (real) {
      for (const w of wins) {
        let pid = pids.get(w.ref[0])
        if (pid == null) { try { pid = await reader.pidOf(w.id) } catch (_) { pid = -1 } pids.set(w.ref[0], pid) }
        w.active = pid === real.pid && sameTitle(real.title, w.name)
      }
      // Por si dos casan por el principio del título: la de título más largo que case, una sola.
      const act = wins.filter((w) => w.active)
      if (act.length > 1) { const best = act.reduce((a, b) => (b.name.length > a.name.length ? b : a)); for (const w of act) w.active = w === best }
      wins.sort((a, b) => Number(a.active) - Number(b.active))
      // UNA APP SIN ACCESIBILIDAD (la terminal de Dotrino, un juego) no sale en la lista: si es
      // la activa, se enseña igual, como un hueco entero con su sitio y su título. Lleva vídeo.
      if (!wins.some((w) => w.active) && real.w > 0 && real.h > 0) {
        const id = reader.idOf([':x11', `/window/${real.window}`])
        synthPids.set(id, real.pid)
        synth = { id, p: 0, r: 'frame', n: real.title, x: real.x, y: real.y, w: real.w, h: real.h, s: 'a', hole: 1 }
      }
    }
    const full = fullDue
    fullDue = false
    const dirty = new Set(dirtyApps)
    dirtyApps.clear()
    const alive = new Set(wins.map((w) => w.id))
    for (const id of perWin.keys()) if (!alive.has(id)) perWin.delete(id)
    await Promise.all(wins.map(async (w) => {
      const key = w.ext.join(',') + (w.active ? 'a' : '') + w.name
      const had = perWin.get(w.id)
      if (!full && had && had.key === key && !dirty.has(w.app) && !dirty.has(w.ref[0])) return
      const nodes = /** @type {ReturnType<typeof makeReader>} */ (reader).walkWindow(w.ref)
      const got = await nodes
      // Una ventana que no publica nada por dentro (Chrome arrancado sin accesibilidad, un
      // juego) es un HUECO entero: se ve que está, con su nombre, y en la fase 2 lleva vídeo.
      if (got.length === 1) got[0].hole = 1
      perWin.set(w.id, { key, app: w.ref[0], nodes: got })
    }))
    /** @type {Node[]} */
    const nodes = []
    for (const w of wins) { const p = perWin.get(w.id); if (p) nodes.push(...p.nodes) }
    if (synth) nodes.push(synth)
    /** @type {Scene} */
    const next = {
      seq: scene.seq + 1,
      screen: screenOf(wins),
      wins: [...wins.map((w) => ({ id: w.id, app: w.app, name: w.name, active: w.active })),
        ...(synth ? [{ id: synth.id, app: synth.n || '', name: synth.n || '', active: true }] : [])],
      nodes
    }
    const patch = diff(scene, next)
    if (!patch) return
    scene = next
    for (const fn of watchers) { try { fn(patch) } catch (_) {} }
  }

  async function stop () {
    for (const t of timers) clearInterval(t)
    timers = []
    if (settle) { clearTimeout(settle); settle = null }
    if (conn && a11yBefore) { try { await restoreA11y(conn.session, a11yBefore) } catch (_) {} }
    a11yBefore = null
    conn?.bus.close(); conn?.session.close()
    conn = null; reader = null; perWin.clear()
    scene = { seq: scene.seq, screen: { w: 0, h: 0 }, wins: [], nodes: [] }
  }

  return {
    /**
     * Empieza a mirar. Devuelve la escena de ahora y, después, cada parche llega a `onPatch`.
     * El primero que mira enciende la lectura; al irse el último se apaga (`unwatch`).
     * @param {(p: Patch) => void} onPatch
     * @returns {Promise<{ scene: Scene, unwatch: () => void }>}
     */
    async watch (onPatch) {
      if (!conn) { starting ||= start().finally(() => { starting = null }); await starting }
      await running
      watchers.add(onPatch)
      const unwatch = () => {
        watchers.delete(onPatch)
        if (!watchers.size) running = running.then(stop)
      }
      return { scene, unwatch }
    },
    /** Cuántos miran ahora: el agente no se reinicia para actualizarse mientras haya alguien. */
    get watching () { return watchers.size },
    /** La escena de ahora (la última leída). */
    get scene () { return scene },
    /**
     * El proceso de la app de un nodo: el de una ventana sin accesibilidad lo sabe el gestor de
     * ventanas; el resto, el bus de accesibilidad.
     * @param {number} id
     */
    async pidOf (id) {
      const p = synthPids.get(id)
      if (p != null) return p
      if (!reader) throw Object.assign(new Error('nobody is watching'), { code: 'not-watching' })
      return reader.pidOf(id)
    },
    /** El lector, para actuar (clic, teclas). `null` si nadie mira. */
    get reader () { return reader },
    stop
  }
}
