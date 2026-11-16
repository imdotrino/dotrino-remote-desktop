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
 *   agente → cliente:
 *     { type:'scene', seq, screen, wins, nodes } · { type:'patch', seq, base, … } (scene.js)
 *     { type:'fail', code, message }
 *
 * Quién puede: cualquier aparato de tu cuenta con `sign` en el acta, igual que la terminal
 * (lo juzga `remote-agent` en el saludo). Instalar este agente en una máquina es decir que su
 * escritorio se puede usar desde tus otros aparatos.
 */
import { createRequire } from 'node:module'
import { startRemoteAgent } from '@dotrino/remote-agent/agent'
import { dataDir, loadLink, LABEL } from './link.js'
import { makeDesktop } from './desktop.js'

/** @typedef {Awaited<ReturnType<typeof startRemoteAgent>>} RemoteAgent */

const require = createRequire(import.meta.url)
/** @type {{ version: string }} */
const { version: VERSION } = require('./package.json')

export { LABEL, VERSION }

/** Cuánto dura sin mensajes una sesión: una pantalla quieta no manda nada. */
export const SESSION_IDLE_MS = 60 * 60_000
/** Cada cuánto se reintenta la parte remota cuando no pudo arrancar (sin red, proxio caído). */
const REMOTE_RETRY_MS = 15_000

/** Los botones que se aceptan, y lo que se manda para cada uno (AT-SPI: `b<n><p|r|c|d>`). */
const BUTTONS = new Set([1, 2, 3])
/** Lo más largo que se escribe de una vez: pegar un libro no puede colgar el escritorio. */
const MAX_TYPED = 10_000

/**
 * @typedef {{ device?: string|null, send: (p: object) => unknown, on: (ev: 'message'|'close', cb: (msg?: any) => void) => unknown }} SessionLike
 */

/** @param {unknown} v */
const num = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * Atiende una sesión de otro aparato. Exportada para las pruebas.
 * @param {SessionLike} session
 * @param {ReturnType<typeof makeDesktop>} desktop
 * @param {{ log?: (m: string) => void }} [opts]
 */
export function serveSession (session, desktop, { log = () => {} } = {}) {
  /** @type {(() => void) | null} */
  let unwatch = null
  /** @type {(code: string, message: string) => void} */
  const fail = (code, message) => { session.send({ type: 'fail', code, message }) }
  /** @param {any} e */
  const failWith = (e) => fail(e?.code || 'desktop-error', e?.message || String(e))

  /** El lector, o un fallo dicho: sin nadie mirando no hay a quién mandarle el clic. */
  const reader = () => {
    const r = desktop.reader
    if (!r) throw Object.assign(new Error('ask for the scene first'), { code: 'not-watching' })
    return r
  }

  session.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object') return
    try {
      switch (msg.type) {
        case 'scene': {
          unwatch?.()
          const w = await desktop.watch((patch) => { session.send({ type: 'patch', ...patch }) })
          unwatch = w.unwatch
          session.send({ type: 'scene', ...w.scene })
          return
        }
        case 'leave': unwatch?.(); unwatch = null; return
        case 'click': {
          if (!num(msg.x) || !num(msg.y)) return fail('bad-input', 'click needs x and y')
          const b = msg.button ?? 1
          if (!BUTTONS.has(b)) return fail('bad-input', 'button must be 1, 2 or 3')
          await reader().mouse(msg.x, msg.y, 'abs')
          await reader().mouse(msg.x, msg.y, `b${b}${msg.double ? 'd' : 'c'}`)
          return
        }
        case 'press': case 'release': {
          if (!num(msg.x) || !num(msg.y)) return fail('bad-input', `${msg.type} needs x and y`)
          const b = msg.button ?? 1
          if (!BUTTONS.has(b)) return fail('bad-input', 'button must be 1, 2 or 3')
          await reader().mouse(msg.x, msg.y, 'abs')
          await reader().mouse(msg.x, msg.y, `b${b}${msg.type === 'press' ? 'p' : 'r'}`)
          return
        }
        case 'move':
          if (!num(msg.x) || !num(msg.y)) return fail('bad-input', 'move needs x and y')
          await reader().mouse(msg.x, msg.y, 'abs')
          return
        case 'wheel': {
          if (!num(msg.x) || !num(msg.y) || !num(msg.dy)) return fail('bad-input', 'wheel needs x, y and dy')
          await reader().mouse(msg.x, msg.y, 'abs')
          const steps = Math.min(10, Math.max(1, Math.round(Math.abs(msg.dy))))
          for (let i = 0; i < steps; i++) await reader().mouse(msg.x, msg.y, msg.dy < 0 ? 'b4c' : 'b5c')
          return
        }
        case 'action':
          if (!Number.isInteger(msg.id)) return fail('bad-input', 'action needs a node id')
          await reader().doAction(msg.id, Number.isInteger(msg.index) ? msg.index : 0)
          return
        case 'focus':
          if (!Number.isInteger(msg.id)) return fail('bad-input', 'focus needs a node id')
          await reader().focus(msg.id)
          return
        case 'text':
          if (typeof msg.text !== 'string' || !msg.text) return fail('bad-input', 'text needs some text')
          if (msg.text.length > MAX_TYPED) return fail('too-long', `at most ${MAX_TYPED} characters at a time`)
          await reader().key({ text: msg.text })
          return
        case 'key':
          if (!Number.isInteger(msg.keysym) || msg.keysym <= 0) return fail('bad-input', 'key needs a keysym')
          await reader().key({ keysym: msg.keysym })
          return
        default:
          return fail('unknown-type', `unknown message type: ${String(msg.type).slice(0, 32)}`)
      }
    } catch (e) {
      log(`session: ${/** @type {Error} */ (e).message}`)
      failWith(e)
    }
  })
  session.on('close', () => { unwatch?.(); unwatch = null })
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
  const startRemote = () => startRemoteAgent({
    label: LABEL,
    product: LABEL,
    version: VERSION,
    dir,
    proxyUrl: opts.proxyUrl,
    quiet: opts.quiet,
    sessionTtlMs: SESSION_IDLE_MS,
    onRevoked: () => { desktop.stop().catch(() => {}); opts.onRevoked?.() },
    onSession: (session) => serveSession(session, desktop, { log })
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
    close: async () => { stopped = true; if (retry) clearInterval(retry); remote?.close(); await desktop.stop() }
  }
}

export default { startAgent, LABEL }
