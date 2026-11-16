/**
 * atspi.js — lee el escritorio por su ÁRBOL DE ACCESIBILIDAD (AT-SPI), no por sus píxeles.
 *
 * AT-SPI es lo que usan los lectores de pantalla en Linux: cada app publica sus ventanas,
 * botones, menús, celdas y textos, con su posición en pantalla. Va por D-Bus, en un bus
 * propio (el de accesibilidad), y funciona igual en X11 y en Wayland. El cliente D-Bus es
 * el del pilar (`@dotrino/proxy-client/dbus`): no se escribe otro.
 *
 * Lo que sale de aquí es una lista de NODOS planos, en orden de pintado (padres antes que
 * hijos, ventanas de abajo antes que la activa), con un id corto y estable mientras el
 * objeto viva. Quien lo manda (scene.js) solo compara listas.
 *
 * Dos trampas que se pagaron al probarlo (2026-11-16):
 *  - El nodo raíz de cada app NO está «visible» (no tiene SHOWING): si se corta ahí por no
 *    visible, no sale nada de ninguna app.
 *  - Chrome, VS Code, Slack y demás Electron solo publican su árbol si la accesibilidad está
 *    encendida AL ARRANCAR. Encenderla en caliente no les llega: hay que reiniciarlas una vez.
 *    Las apps GTK la publican siempre.
 */
import { openSessionBus, openBus, DBusError } from '@dotrino/proxy-client/dbus'

const ROOT_DEST = 'org.a11y.atspi.Registry'
const ROOT_PATH = '/org/a11y/atspi/accessible/root'
const DEC_PATH = '/org/a11y/atspi/registry/deviceeventcontroller'
const I_ACC = 'org.a11y.atspi.Accessible'
const I_COMP = 'org.a11y.atspi.Component'
const I_TEXT = 'org.a11y.atspi.Text'
const I_ACTION = 'org.a11y.atspi.Action'
const I_PROPS = 'org.freedesktop.DBus.Properties'

/** Bits de estado de AT-SPI (AtspiStateType) que importan para dibujar y actuar. */
export const STATE = {
  ACTIVE: 1, CHECKED: 4, DEFUNCT: 6, EDITABLE: 7, ENABLED: 8, EXPANDABLE: 9, EXPANDED: 10,
  FOCUSABLE: 11, FOCUSED: 12, ICONIFIED: 15, MODAL: 16, MULTI_LINE: 17, PRESSED: 20,
  SELECTED: 23, SENSITIVE: 24, SHOWING: 25, VISIBLE: 30, INDETERMINATE: 32
}

/** Los estados que viajan al cliente, como letras: corto y legible en una traza. */
const WIRE_STATES = /** @type {const} */ ([
  ['a', STATE.ACTIVE], ['c', STATE.CHECKED], ['e', STATE.EDITABLE], ['x', STATE.EXPANDED],
  ['f', STATE.FOCUSED], ['s', STATE.SELECTED], ['p', STATE.PRESSED], ['d', STATE.SENSITIVE],
  ['m', STATE.MULTI_LINE], ['i', STATE.INDETERMINATE]
])

/** Tope de nodos por ventana: una tabla de 50.000 filas no puede colgar al agente. */
export const MAX_NODES_PER_WINDOW = 4000
/** Tope de profundidad: hay árboles que se muerden la cola. */
const MAX_DEPTH = 60
/** Tope de hijos que se miran de un nodo (una lista enorme: lo que se ve cabe de sobra). */
const MAX_CHILDREN = 1500
/** Lo que se lee de un texto: lo que cabe en pantalla, no un documento entero. */
export const MAX_TEXT = 2000

/** Roles cuyo contenido es el TEXTO que tienen dentro (no solo su nombre). */
const TEXT_ROLES = new Set(['text', 'entry', 'password text', 'paragraph', 'label', 'static',
  'heading', 'table cell', 'link', 'terminal', 'document text', 'caption', 'list item', 'spin button'])

/**
 * Roles que no se pueden dibujar desde la accesibilidad: lo de dentro son píxeles (un lienzo,
 * un vídeo, una imagen). Salen como HUECO con su tamaño; en la fase 2 se rellenan con vídeo.
 */
const HOLE_ROLES = new Set(['canvas', 'drawing area', 'image', 'video', 'animation', 'embedded'])

/**
 * Un nodo tal como viaja.
 * @typedef {{
 *   id: number, p: number, r: string, n?: string, t?: string,
 *   x: number, y: number, w: number, h: number, s?: string, a?: string[], hole?: 1
 * }} Node
 */

/** Un objeto de AT-SPI: el nombre de su app en el bus y su ruta. */
/** @typedef {[string, string]} Ref */

/**
 * Abre el bus de accesibilidad de esta sesión gráfica.
 * Lanza `no-session-bus` (no hay escritorio: un servidor) o `no-a11y-bus` (el escritorio no
 * trae AT-SPI). Son errores con código, para decirle a la persona cuál de las dos cosas pasa.
 */
export async function openA11yBus () {
  const session = await openSessionBus()
  if (!session) throw Object.assign(new Error('no session bus: this machine has no desktop session'), { code: 'no-session-bus' })
  try {
    const [addr] = await session.call({ destination: 'org.a11y.Bus', path: '/org/a11y/bus', iface: 'org.a11y.Bus', member: 'GetAddress' })
    const bus = await openBus(addr)
    if (!bus) throw Object.assign(new Error(`the accessibility bus is not reachable at ${addr}`), { code: 'no-a11y-bus' })
    return { session, bus }
  } catch (e) {
    session.close()
    if (e instanceof DBusError) throw Object.assign(new Error('the desktop has no accessibility service (at-spi2-core)'), { code: 'no-a11y-bus' })
    throw e
  }
}

/**
 * Enciende la accesibilidad del escritorio (las apps GTK publican más, y las que se abran desde
 * ahora también las de Chromium). Devuelve cómo estaba, para dejarla igual al irse.
 *
 * @param {import('@dotrino/proxy-client/dbus').DBusConnection} session
 * @param {boolean} on
 * @returns {Promise<{ IsEnabled: boolean, ScreenReaderEnabled: boolean }>}
 */
export async function setA11y (session, on) {
  const { variant } = await import('@dotrino/proxy-client/dbus')
  /** @type {{ IsEnabled: boolean, ScreenReaderEnabled: boolean }} */
  const before = { IsEnabled: false, ScreenReaderEnabled: false }
  for (const prop of /** @type {const} */ (['IsEnabled', 'ScreenReaderEnabled'])) {
    const [v] = await session.call({ destination: 'org.a11y.Bus', path: '/org/a11y/bus', iface: I_PROPS, member: 'Get', signature: 'ss', body: ['org.a11y.Status', prop] })
    before[prop] = !!v.value
    await session.call({ destination: 'org.a11y.Bus', path: '/org/a11y/bus', iface: I_PROPS, member: 'Set', signature: 'ssv', body: ['org.a11y.Status', prop, variant('b', on)] })
  }
  return before
}

/**
 * Deja la accesibilidad como estaba antes de `setA11y`.
 * @param {import('@dotrino/proxy-client/dbus').DBusConnection} session
 * @param {{ IsEnabled: boolean, ScreenReaderEnabled: boolean }} before
 */
export async function restoreA11y (session, before) {
  const { variant } = await import('@dotrino/proxy-client/dbus')
  for (const prop of /** @type {const} */ (['IsEnabled', 'ScreenReaderEnabled'])) {
    await session.call({ destination: 'org.a11y.Bus', path: '/org/a11y/bus', iface: I_PROPS, member: 'Set', signature: 'ssv', body: ['org.a11y.Status', prop, variant('b', before[prop])] })
  }
}

/** ¿Tiene ese bit el conjunto de estados (`au`, dos palabras de 32 bits)? */
/** @param {number[]} words @param {number} bit */
export const hasState = (words, bit) => !!((words[bit >> 5] >>> (bit & 31)) & 1)

/** Los estados que viajan, en letras. @param {number[]} words */
export function wireStates (words) {
  let s = ''
  for (const [ch, bit] of WIRE_STATES) if (hasState(words, bit)) s += ch
  return s
}

/**
 * El lector: sabe recorrer el árbol, actuar sobre un nodo y generar ratón y teclado.
 * @param {import('@dotrino/proxy-client/dbus').DBusConnection} bus  el de accesibilidad
 */
export function makeReader (bus) {
  /** @type {Map<string, number>} "bus path" → id corto */
  const ids = new Map()
  /** @type {Map<number, Ref>} id corto → objeto */
  const refs = new Map()
  let nextId = 1

  /** @param {Ref} ref */
  const idOf = (ref) => {
    const k = ref[0] + ' ' + ref[1]
    let id = ids.get(k)
    if (!id) { id = nextId++; ids.set(k, id); refs.set(id, ref) }
    return id
  }

  /**
   * @param {Ref} ref @param {string} iface @param {string} member
   * @param {string} [signature] @param {any[]} [body]
   */
  const call = (ref, iface, member, signature = '', body = []) =>
    bus.call({ destination: ref[0], path: ref[1], iface, member, signature, body })

  /** @param {Ref} ref @param {string} iface @param {string} prop */
  const prop = async (ref, iface, prop) => (await call(ref, I_PROPS, 'Get', 'ss', [iface, prop]))[0].value

  /** Las apps que publican algo. @returns {Promise<Ref[]>} */
  async function apps () {
    const [kids] = await call([ROOT_DEST, ROOT_PATH], I_ACC, 'GetChildren')
    return kids
  }

  /**
   * Lo que se sabe de un objeto sin mirar a sus hijos. `null` si ya no existe o no se ve.
   * @param {Ref} ref
   * @param {boolean} isApp  el nodo raíz de una app nunca tiene SHOWING (ver arriba)
   */
  async function describe (ref, isApp) {
    try {
      const [[role], [states], [ifaces]] = await Promise.all([
        call(ref, I_ACC, 'GetRoleName'), call(ref, I_ACC, 'GetState'), call(ref, I_ACC, 'GetInterfaces')
      ])
      if (!isApp && (!hasState(states, STATE.SHOWING) || hasState(states, STATE.DEFUNCT))) return null
      const has = new Set(ifaces)
      const [name, ext, count, actions] = await Promise.all([
        prop(ref, I_ACC, 'Name'),
        has.has(I_COMP) ? call(ref, I_COMP, 'GetExtents', 'u', [0]).then((r) => r[0]) : null,
        prop(ref, I_ACC, 'ChildCount'),
        has.has(I_ACTION) ? call(ref, I_ACTION, 'GetActions').then((r) => r[0].map((/** @type {any[]} */ a) => a[0])).catch(() => []) : []
      ])
      let text = ''
      if (has.has(I_TEXT) && TEXT_ROLES.has(role)) {
        try {
          const n = Math.min(await prop(ref, I_TEXT, 'CharacterCount'), MAX_TEXT)
          if (n > 0) text = (await call(ref, I_TEXT, 'GetText', 'ii', [0, n]))[0]
        } catch (_) { /* un texto que no se deja leer se dibuja con su nombre */ }
      }
      return { role, states, name: String(name || ''), ext, count: Number(count) || 0, actions, text }
    } catch (e) {
      // El objeto se fue entre que se listó y se le preguntó: es lo normal en un escritorio vivo.
      if (e instanceof DBusError) return null
      throw e
    }
  }

  /**
   * Recorre UNA ventana entera y devuelve sus nodos visibles en orden de pintado.
   * Los hijos de un nivel se piden a la vez: el bus está en esta máquina, y en serie una
   * ventana de mil nodos tardaba lo que tardan miles de idas y vueltas.
   *
   * @param {Ref} win
   * @returns {Promise<Node[]>}
   */
  async function walkWindow (win) {
    let budget = MAX_NODES_PER_WINDOW
    /**
     * Un nodo y lo que cuelga de él, en orden de pintado. Cada rama devuelve SU lista y el
     * padre las junta en el orden de sus hijos: así ir en paralelo no cambia el orden.
     * @param {Ref} ref @param {number} parent @param {number} depth
     * @returns {Promise<Node[]>}
     */
    async function visit (ref, parent, depth) {
      if (budget <= 0 || depth > MAX_DEPTH) return []
      const d = await describe(ref, false)
      if (!d || !d.ext) return []
      const [x, y, w, h] = d.ext
      if (w <= 0 || h <= 0) return []
      budget--
      const id = idOf(ref)
      /** @type {Node} */
      const node = { id, p: parent, r: d.role, x, y, w, h }
      if (d.name) node.n = d.name
      if (d.text && d.text !== d.name) node.t = d.text
      const s = wireStates(d.states)
      if (s) node.s = s
      if (d.actions.length) node.a = d.actions
      if (HOLE_ROLES.has(d.role)) node.hole = 1
      if (!d.count || node.hole) return [node]
      /** @type {Ref[]} */
      let kids = []
      try { kids = (await call(ref, I_ACC, 'GetChildren'))[0] } catch (e) { if (!(e instanceof DBusError)) throw e }
      const parts = await Promise.all(kids.slice(0, MAX_CHILDREN).map((k) => visit(k, id, depth + 1)))
      return [node, ...parts.flat()]
    }
    return visit(win, 0, 0)
  }

  /**
   * Las ventanas que se ven ahora, de abajo arriba: la ACTIVA, la última (es la que está
   * encima). AT-SPI no da el orden real de apilado en X11; esto es lo honesto que se sabe.
   *
   * @returns {Promise<Array<{ ref: Ref, id: number, app: string, name: string, active: boolean, ext: number[] }>>}
   */
  async function windows () {
    /** @type {Array<{ ref: Ref, id: number, app: string, name: string, active: boolean, ext: number[] }>} */
    const list = []
    const appRefs = await apps()
    await Promise.all(appRefs.map(async (appRef) => {
      let appName = ''
      /** @type {Ref[]} */
      let kids = []
      try {
        appName = String(await prop(appRef, I_ACC, 'Name') || '')
        kids = (await call(appRef, I_ACC, 'GetChildren'))[0]
      } catch (e) { if (e instanceof DBusError) return; throw e }
      await Promise.all(kids.map(async (w) => {
        const d = await describe(w, false)
        if (!d || !d.ext || d.ext[2] <= 0 || d.ext[3] <= 0) return
        if (hasState(d.states, STATE.ICONIFIED)) return
        list.push({ ref: w, id: idOf(w), app: appName, name: d.name, active: hasState(d.states, STATE.ACTIVE), ext: d.ext })
      }))
    }))
    // Primero las grandes que no están activas (el fondo de escritorio, el panel suele ser
    // pequeño y va arriba del fondo), al final la activa.
    // Desempate por id: se leen en paralelo y llegan en cualquier orden; sin él, dos ventanas del
    // mismo tamaño cambiaban de sitio en cada lectura y salía un parche sin cambios.
    list.sort((a, b) => (Number(a.active) - Number(b.active)) || (b.ext[2] * b.ext[3] - a.ext[2] * a.ext[3]) || (a.id - b.id))
    return list
  }

  /**
   * Ejecuta la acción `index` de un nodo (la «pulsación» de un botón, abrir un menú…).
   * @param {number} id @param {number} [index]
   */
  async function doAction (id, index = 0) {
    const ref = refs.get(id)
    if (!ref) throw Object.assign(new Error(`unknown node ${id}`), { code: 'no-node' })
    const [ok] = await call(ref, I_ACTION, 'DoAction', 'i', [index])
    return !!ok
  }

  /** Pone el foco en un nodo (un campo antes de escribir en él). @param {number} id */
  async function focus (id) {
    const ref = refs.get(id)
    if (!ref) throw Object.assign(new Error(`unknown node ${id}`), { code: 'no-node' })
    const [ok] = await call(ref, I_COMP, 'GrabFocus')
    return !!ok
  }

  /**
   * Ratón de verdad, en coordenadas de pantalla. `event` es el de AT-SPI: `b<n>c` (clic con el
   * botón n), `b<n>p`/`b<n>r` (bajar/soltar), `b<n>d` (doble clic), `abs` (solo mover); la
   * rueda son los botones 4 (arriba) y 5 (abajo).
   * @param {number} x @param {number} y @param {string} event
   */
  async function mouse (x, y, event) {
    await bus.call({ destination: ROOT_DEST, path: DEC_PATH, iface: 'org.a11y.atspi.DeviceEventController', member: 'GenerateMouseEvent', signature: 'iis', body: [Math.round(x), Math.round(y), event] })
  }

  /**
   * Teclado de verdad. Un texto se escribe tal cual (`KEY_STRING`); una tecla especial va por
   * su keysym de X (`KEY_SYM`), con su pulsar y soltar si se mantiene un modificador.
   * @param {{ text?: string, keysym?: number, press?: 'down'|'up' }} k
   */
  async function key (k) {
    /** @param {number} code @param {string} str @param {number} type */
    const gen = (code, str, type) => bus.call({ destination: ROOT_DEST, path: DEC_PATH, iface: 'org.a11y.atspi.DeviceEventController', member: 'GenerateKeyboardEvent', signature: 'isu', body: [code, str, type] })
    if (typeof k.text === 'string' && k.text) return gen(0, k.text, 4)
    if (typeof k.keysym === 'number') {
      // KEY_SYM pulsa y suelta. Para mantener (Ctrl mientras se pulsa otra) hace falta el
      // keycode, que AT-SPI no da desde un keysym: los modificadores van en `combo` (scene.js).
      return gen(k.keysym, '', 3)
    }
    throw Object.assign(new Error('nothing to type'), { code: 'bad-key' })
  }

  /** El objeto de un id, para quien lo necesite (las pruebas). @param {number} id */
  const refOf = (id) => refs.get(id) || null

  return { apps, windows, walkWindow, doAction, focus, mouse, key, refOf, idOf }
}
