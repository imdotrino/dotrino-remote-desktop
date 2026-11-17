/**
 * @dotrino/remote-desktop-agent — el escritorio de esta máquina, para los aparatos de tu cuenta.
 *
 * No manda píxeles: manda el ÁRBOL DE ACCESIBILIDAD del escritorio (ventanas, botones, menús,
 * textos, con su posición) y después solo lo que cambia. El cliente lo dibuja en SVG. Es ligero
 * (una ventana de explorador de archivos entera son ~4 KB comprimidos) y el texto llega exacto.
 * Lo que no se puede dibujar así (un lienzo, un vídeo, una app que no publica nada) va como
 * HUECO con su tamaño; la fase 2 lo rellena con vídeo de ese rectángulo.
 *
 * Lo común (enrolarse con la bóveda, el saludo contra el ACTA, el canal cifrado por sesión, la
 * revocación, la renovación del papel, la bitácora y trocear lo grande) lo hace
 * `@dotrino/remote-agent`. Aquí solo hay escritorio.
 *
 * Payloads de dominio (cifrados dentro de la sesión; el proxio no los ve):
 *   cliente → agente:
 *     { type:'scene' }                    la escena entera, y a partir de ahí cada parche
 *     { type:'leave' }                    dejar de recibir parches
 *     { type:'click', x, y, button?, double? }   clic de verdad en la pantalla (button 1–3)
 *     { type:'press', x, y, button? } · { type:'release', x, y, button? }   arrastrar
 *     { type:'move', x, y }               mover el ratón
 *     { type:'wheel', x, y, dy }          rueda (dy < 0 arriba)
 *     { type:'action', id, index? }       la acción de un nodo (pulsar un botón sin apuntar)
 *     { type:'focus', id }                poner el foco en un nodo
 *     { type:'text', text }               escribir un texto
 *     { type:'key', keysym }              una tecla especial, por su keysym de X (Intro, flechas…)
 *     { type:'raise', id }                traer al frente esa ventana (id de su nodo), con el foco
 *     { type:'video', id }                vídeo de ese nodo (un hueco o una ventana sin contenido);
 *                                         `id: null` lo para. Sigue al nodo si se mueve.
 *   agente → cliente:
 *     { type:'scene', seq, screen, wins, nodes } · { type:'patch', seq, base, … } (scene.js)
 *     { type:'vframe', id, seq, key, rect, q, data }   un cuadro H.264 (Annex B, base64) de ese rectángulo;
 *                                         `q`: 'direct' (calidad completa) o 'relay' (reducido, por el proxio)
 *     { type:'fail', code, message }
 *
 * Quién puede: un aparato de tu cuenta con `desktop` en el acta (lo juzga `remote-agent` en el
 * saludo; sin él, `unauthorized` con `reason: 'missing-cap'`). Instalar este agente en una
 * máquina es decir que su escritorio se puede usar desde tus otros aparatos.
 *
 * LAS VENTANAS DE ESTA MÁQUINA (la app de escritorio, desktop/) le hablan al agente por un
 * socket local (`remote-desktop.sock` en la carpeta del enlace, `@dotrino/remote-agent/local`),
 * en JSON por líneas, con el mismo protocolo. Además de lo de arriba, ahí hay (`serveLocal`):
 *   ventana → agente:
 *     { type:'machines' }                 las otras máquinas con el escritorio remoto encendido
 *     { type:'via', machine }             a partir de aquí todo va a ESA máquina y vuelve (far.js)
 *   agente → ventana:
 *     { type:'hello', product, version }  lo primero que llega: quién atiende (§14)
 *     { type:'machines', list:[{sub,id,name}] }
 *     { type:'via', machine:{sub,id,name} }   el tubo está puesto
 *     { type:'resumed' }                  la sesión con la otra máquina se rehízo: pedir la escena otra vez
 *   Sin `via`, la ventana usa el escritorio de ESTA máquina, sin clave: quien abre el socket es el
 *   mismo usuario que ya está sentado delante.
 */
import { createRequire } from 'node:module'
import { startRemoteAgent } from '@dotrino/remote-agent/agent'
import { makeGate, makeLock } from '@dotrino/remote-agent/access'
import { dataDir, loadLink, LABEL } from './link.js'
import { makeDesktop } from './desktop.js'
import { raiseWindow } from './raise.js'
import { makeIcons } from './icon.js'
import { makeVideo, evenRect } from './video.js'
import { listenLocal } from '@dotrino/remote-agent/local'
import { makeFar } from './far.js'

/** @typedef {Awaited<ReturnType<typeof startRemoteAgent>>} RemoteAgent */

const require = createRequire(import.meta.url)
/** @type {{ version: string }} */
const { version: VERSION } = require('./package.json')

export { LABEL, VERSION }

/** El nombre del socket local (`<carpeta del enlace>/remote-desktop.sock`): lo busca desktop/. */
export const LOCAL_SOCKET = 'remote-desktop'

/** Cuánto dura sin mensajes una sesión: una pantalla quieta no manda nada. */
export const SESSION_IDLE_MS = 60 * 60_000
/** Cada cuánto se reintenta la parte remota cuando no pudo arrancar (sin red, proxio caído). */
const REMOTE_RETRY_MS = 15_000

/** Los botones que se aceptan, y lo que se manda para cada uno (AT-SPI: `b<n><p|r|c|d>`). */
const BUTTONS = new Set([1, 2, 3])
/** Lo más largo que se escribe de una vez: pegar un libro no puede colgar el escritorio. */
const MAX_TYPED = 10_000

/**
 * @typedef {{ device?: string|null, send: (p: object) => unknown, on: (ev: 'message'|'close', cb: (msg?: unknown) => void) => unknown }} SessionLike
 */

/** @param {unknown} v @returns {v is number} */
const num = (v) => typeof v === 'number' && Number.isFinite(v)
/** @param {unknown} v @returns {v is number} */
const int = (v) => Number.isInteger(v)

// LOS ICONOS de las ventanas, para la barra de tareas: uno para todo el agente, con su caché.
const icons = makeIcons()

/**
 * Atiende una sesión de otro aparato. Exportada para las pruebas.
 * @param {SessionLike} session
 * @param {ReturnType<typeof makeDesktop>} desktop
 * @param {{ log?: (m: string) => void, route?: () => Promise<string>, gate?: ReturnType<typeof makeGate> | null }} [opts]
 *   `route`: por dónde va esta sesión ahora (`routeTo` del pilar). El vídeo solo sale por un
 *   camino que no es la red de Dotrino.
 *   `gate`: la clave de la máquina (`@dotrino/remote-agent/access`), si tiene. Hasta escribirla
 *   no se ve ni se toca nada.
 */
export function serveSession (session, desktop, { log = () => {}, route = async () => 'direct', gate = null } = {}) {
  const lock = makeLock({ gate, device: /** @type {{ device?: string }} */ (session).device || null, send: (m) => session.send(m) })
  /** @type {(() => void) | null} */
  let unwatch = null
  /** @type {(code: string, message: string) => void} */
  const fail = (code, message) => { session.send({ type: 'fail', code, message }) }
  /** @param {unknown} err */
  const failWith = (err) => {
    const e = /** @type {{ code?: string, message?: string } | null | undefined} */ (err)
    fail(e?.code || 'desktop-error', e?.message || String(err))
  }

  // EL VÍDEO DE UN HUECO (video.js): uno por sesión, el del nodo que pidió el cliente.
  const video = makeVideo({ log })
  /** @type {number | null} */
  let videoId = null
  let vseq = 0
  // EL VÍDEO SEGÚN EL CAMINO: directo (sin nadie en medio) va a calidad completa; por el proxio o
  // el TURN de Dotrino va MUY conservador (dueño, 2026-11-16, que matiza la regla del 2026-11-01:
  // «la imagen sí debe ir por proxy, pero mucho más conservador que directa»). Se mira cada poco
  // por dónde va la sesión, y si cambia, la captura se rehace con el otro perfil.
  const DIRECT_ROUTES = new Set(['direct', 'socket', 'bluetooth'])
  /** @type {string | null} */
  let videoRoute = null
  /** @type {ReturnType<typeof setInterval> | null} */
  let routeTimer = null
  /** @returns {'direct' | 'relay'} */
  const profile = () => (videoRoute && DIRECT_ROUTES.has(videoRoute) ? 'direct' : 'relay')
  const checkRoute = async () => {
    let r = 'proxy'
    try { r = await route() } catch (_) {}
    if (r === videoRoute) return
    videoRoute = r
    if (videoId != null) syncVideo()
  }
  const watchRoute = (/** @type {boolean} */ on) => {
    if (on && !routeTimer) { routeTimer = setInterval(() => { checkRoute() }, 3000); routeTimer.unref?.() }
    if (!on && routeTimer) { clearInterval(routeTimer); routeTimer = null; videoRoute = null }
  }

  /** Arranca (o rehace, si el nodo se movió) la captura del nodo pedido. */
  const syncVideo = () => {
    if (videoId == null) { video.stop(); return }
    if (!videoRoute) return
    const scene = desktop.scene
    const n = scene.nodes.find((x) => x.id === videoId)
    const r = n ? evenRect(n, scene.screen) : null
    if (!r) { video.stop(); return }
    const id = videoId
    const q = profile()
    video.start(r,
      ({ key, data }) => { session.send({ type: 'vframe', id, seq: vseq++, key, rect: r, q, data: Buffer.from(data).toString('base64') }) },
      (e) => { videoId = null; failWith(e) }, q)
  }

  /** El lector, o un fallo dicho: sin nadie mirando no hay a quién mandarle el clic. */
  const reader = () => {
    const r = desktop.reader
    if (!r) throw Object.assign(new Error('ask for the scene first'), { code: 'not-watching' })
    return r
  }

  session.on('message', async (raw) => {
    if (!raw || typeof raw !== 'object') return
    // La clave de la máquina, antes que nada: sin ella no se ve la pantalla ni se toca.
    if (lock.handle(raw)) return
    if (!lock.mayPass()) return
    // Lo que llega es JSON de otro aparato: cada campo se comprueba antes de usarlo.
    const msg = /** @type {Record<string, unknown>} */ (raw)
    const { x, y, dy, id, index, text, keysym, double } = msg
    const button = msg.button ?? 1
    try {
      switch (msg.type) {
        case 'scene': {
          unwatch?.()
          const w = await desktop.watch((patch) => { session.send({ type: 'patch', ...patch }); if (videoId != null) syncVideo() })
          unwatch = w.unwatch
          session.send({ type: 'scene', ...w.scene })
          return
        }
        case 'leave': unwatch?.(); unwatch = null; videoId = null; video.stop(); watchRoute(false); return
        case 'video':
          if (id !== null && !int(id)) return fail('bad-input', 'video needs a node id, or null to stop')
          videoId = id
          // Pedirlo otra vez REHACE la captura: empieza con un cuadro completo. Con la ventana quieta
          // solo sale ese, y si se perdió, el cliente no tenía con qué pintar hasta el próximo cambio.
          video.stop()
          if (videoId == null) { watchRoute(false); return }
          watchRoute(true)
          videoRoute = null
          await checkRoute()
          return
        case 'click': {
          if (!num(x) || !num(y)) return fail('bad-input', 'click needs x and y')
          if (!int(button) || !BUTTONS.has(button)) return fail('bad-input', 'button must be 1, 2 or 3')
          await reader().mouse(x, y, 'abs')
          await reader().mouse(x, y, `b${button}${double ? 'd' : 'c'}`)
          return
        }
        case 'press': case 'release': {
          if (!num(x) || !num(y)) return fail('bad-input', `${msg.type} needs x and y`)
          if (!int(button) || !BUTTONS.has(button)) return fail('bad-input', 'button must be 1, 2 or 3')
          await reader().mouse(x, y, 'abs')
          await reader().mouse(x, y, `b${button}${msg.type === 'press' ? 'p' : 'r'}`)
          return
        }
        case 'move':
          if (!num(x) || !num(y)) return fail('bad-input', 'move needs x and y')
          await reader().mouse(x, y, 'abs')
          return
        case 'wheel': {
          if (!num(x) || !num(y) || !num(dy)) return fail('bad-input', 'wheel needs x, y and dy')
          await reader().mouse(x, y, 'abs')
          const steps = Math.min(10, Math.max(1, Math.round(Math.abs(dy))))
          for (let i = 0; i < steps; i++) await reader().mouse(x, y, dy < 0 ? 'b4c' : 'b5c')
          return
        }
        case 'action':
          if (!int(id)) return fail('bad-input', 'action needs a node id')
          await reader().doAction(id, int(index) ? index : 0)
          return
        case 'focus':
          if (!int(id)) return fail('bad-input', 'focus needs a node id')
          await reader().focus(id)
          return
        case 'text':
          if (typeof text !== 'string' || !text) return fail('bad-input', 'text needs some text')
          if (text.length > MAX_TYPED) return fail('too-long', `at most ${MAX_TYPED} characters at a time`)
          await reader().key({ text })
          return
        case 'raise': {
          if (!int(id)) return fail('bad-input', 'raise needs a window id')
          const win = desktop.scene.wins.find((w) => w.id === id)
          if (!win) return fail('window-not-found', `no window ${id} in the scene`)
          const node = desktop.scene.nodes.find((n) => n.id === id)
          await raiseWindow({ pid: await desktop.pidOf(id), title: win.name, rect: node ? { x: node.x, y: node.y, w: node.w, h: node.h } : null })
          return
        }
        case 'icon': {
          // El icono de la app de una ventana, para la barra de tareas. Que no tenga es normal
          // (`png: null`); lo que no se pudo mirar va con su `code`, sin cortar nada más.
          if (!int(id)) return fail('bad-input', 'icon needs a window id')
          const win = desktop.scene.wins.find((w) => w.id === id)
          if (!win) return fail('window-not-found', `no window ${id} in the scene`)
          const node = desktop.scene.nodes.find((n) => n.id === id)
          try {
            const png = await icons.iconOf({ pid: await desktop.pidOf(id), title: win.name, rect: node ? { x: node.x, y: node.y, w: node.w, h: node.h } : null })
            session.send({ type: 'icon', id, png })
          } catch (e) {
            const err = /** @type {{ code?: string, message?: string }} */ (e)
            session.send({ type: 'icon', id, png: null, code: err.code || 'icon-failed', message: err.message || String(e) })
          }
          return
        }
        case 'key':
          if (!int(keysym) || keysym <= 0) return fail('bad-input', 'key needs a keysym')
          await reader().key({ keysym })
          return
        default:
          return fail('unknown-type', `unknown message type: ${String(msg.type).slice(0, 32)}`)
      }
    } catch (e) {
      log(`session: ${/** @type {Error} */ (e).message}`)
      failWith(e)
    }
  })
  session.on('close', () => { unwatch?.(); unwatch = null; videoId = null; video.stop(); watchRoute(false) })
}

/**
 * Atiende una ventana de ESTA máquina (el socket local). `machines` y `via` son suyos; lo demás
 * es el protocolo de siempre, contra el escritorio de esta máquina (`serveSession`, sin clave),
 * hasta que pide `via`: desde ahí todo va a la otra máquina (far.js) y esta ya no atiende nada.
 * Exportada para las pruebas.
 * @param {SessionLike} session
 * @param {ReturnType<typeof makeDesktop>} desktop
 * @param {Pick<ReturnType<typeof makeFar>, 'list' | 'via'>} far
 * @param {{ log?: (m: string) => void }} [opts]
 */
export function serveLocal (session, desktop, far, { log = () => {} } = {}) {
  /** @type {'local' | 'far' | null} */
  let mode = null
  /** @type {Record<'message' | 'close', ((msg?: any) => void)[]>} */
  const inner = { message: [], close: [] }
  /** @param {'message' | 'close'} ev @param {any} [msg] */
  const emit = (ev, msg) => { for (const cb of inner[ev]) { try { cb(msg) } catch (_) {} } }
  /** La sesión que ven `serveSession` o `far.via`: solo lo que no es de este nivel. */
  /** @type {SessionLike} */
  const view = { device: null, send: (p) => session.send(p), on (ev, cb) { inner[ev].push(cb); return view } }
  /** @param {unknown} e */
  const failed = (e) => {
    const err = /** @type {{ code?: string, message?: string }} */ (e)
    session.send({ type: 'fail', code: err?.code || 'local-error', message: err?.message || String(e) })
  }
  session.send({ type: 'hello', product: LABEL, version: VERSION })
  session.on('message', (raw) => {
    if (!raw || typeof raw !== 'object') return
    const msg = /** @type {Record<string, unknown>} */ (raw)
    if (mode !== 'far' && msg.type === 'machines') { far.list().then((list) => session.send({ type: 'machines', list })).catch(failed); return }
    if (mode === null && msg.type === 'via') {
      mode = 'far'
      far.via(view, msg.machine).catch((e) => { log(`local: via failed: ${/** @type {Error} */ (e).message}`); failed(e) })
      return
    }
    if (mode === 'local' && msg.type === 'via') return failed(Object.assign(new Error('this window already uses this machine: open another connection'), { code: 'bad-input' }))
    if (mode === null) { mode = 'local'; serveSession(view, desktop, { log, gate: null, route: async () => 'socket' }) }
    emit('message', msg)
  })
  session.on('close', () => emit('close'))
}

/**
 * Arranca el agente: el escritorio (perezoso: no lee nada hasta que alguien mira) y la parte
 * remota. Sin enlace no arranca: este agente no tiene ventanas locales a las que atender, así
 * que sin bóveda no sirve para nada, y se dice.
 *
 * @param {object} [opts]
 * @param {string} [opts.dir]       dónde vive el enlace (default dataDir()).
 * @param {string} [opts.proxyUrl]  override del proxio del enlace.
 * @param {boolean} [opts.quiet]
 * @param {boolean} [opts.a11y]     encender la accesibilidad mientras alguien mira (default sí).
 * @param {() => void} [opts.onRevoked]
 * @param {(e: Error) => void} [opts.onRemoteError]  la parte remota no arrancó (se reintenta).
 * @param {(r: RemoteAgent) => void} [opts.onRemote]  arrancó.
 */
export async function startAgent (opts = {}) {
  const dir = opts.dir || dataDir()
  if (!loadLink(dir)) throw Object.assign(new Error(`this machine is not linked (${dir})`), { code: 'not-linked' })
  const log = (/** @type {string} */ m) => { if (!opts.quiet) console.error(`[remote-desktop-agent] ${m}`) }
  const desktop = makeDesktop({ log, ...(opts.a11y === false ? { a11y: false } : {}) })
  /** @type {RemoteAgent | null} */
  let remote = null
  let stopped = false
  // TRES CLAVES MAL SEGUIDAS DE UN MISMO APARATO: se reporta a la bóveda, que se lo pone a quien
  // aprueba (bloquear o ignorar). El freno local ya está puesto; esto es el aviso.
  const gate = makeGate(dir, {
    onIncident: ({ device, tries }) => {
      if (!remote?.reportIncident) return
      remote.reportIncident({ kind: 'bad-code', about: device, tries })
        .then(() => log(`incident reported: ${tries} wrong codes`))
        .catch((e) => log(`could not report the incident: ${e.message}`))
    }
  })
  // Las ventanas de esta máquina: el socket local, y por él las otras máquinas (far.js).
  const far = makeFar({ dir, loadLink: () => loadLink(dir), kind: LABEL, log })
  const local = await listenLocal({ dir, name: LOCAL_SOCKET, serve: (session) => serveLocal(session, desktop, far, { log }) })
  const startRemote = () => startRemoteAgent({
    label: LABEL,
    // Solo quien tenga `desktop` en el acta usa el escritorio (auditoría del 2026-11-16): con
    // `sign` bastaba, y cualquier aparato de la cuenta —un bot, un navegador prestado— entraba.
    needs: ['desktop'],
    product: LABEL,
    version: VERSION,
    dir,
    proxyUrl: opts.proxyUrl,
    quiet: opts.quiet,
    sessionTtlMs: SESSION_IDLE_MS,
    onRevoked: () => { desktop.stop().catch(() => {}); opts.onRevoked?.() },
    onSession: (session) => serveSession(session, desktop, {
      log,
      gate,
      route: async () => {
        const c = /** @type {{ routeTo?: (t: string) => Promise<string> } | undefined} */ (remote?.client)
        const from = /** @type {{ from?: string }} */ (session).from
        return c?.routeTo && from ? c.routeTo(from) : 'proxy'
      }
    })
  })
  /** @type {ReturnType<typeof setInterval> | null} */
  let retry = null
  try {
    remote = await startRemote()
    opts.onRemote?.(remote)
  } catch (e) {
    // Sin red al arrancar: se reintenta por detrás. Lo que no hay es acceso, y se dice.
    log(`the remote side did not start (${/** @type {Error} */ (e).message}); retrying every ${REMOTE_RETRY_MS / 1000} s`)
    opts.onRemoteError?.(/** @type {Error} */ (e))
    let trying = false
    retry = setInterval(() => {
      if (trying) return
      trying = true
      startRemote().then((r) => {
        if (stopped) { r.close(); return }
        if (retry) clearInterval(retry)
        retry = null
        remote = r
        opts.onRemote?.(r)
      }).catch(() => {}).finally(() => { trying = false })
    }, REMOTE_RETRY_MS)
    retry.unref()
  }
  return {
    get remote () { return remote },
    get machineId () { return remote?.machineId || null },
    desktop,
    localPath: local.path,
    close: async () => { stopped = true; if (retry) clearInterval(retry); far.close(); local.close(); remote?.close(); await desktop.stop() }
  }
}

export default { startAgent, LABEL }
