/**
 * far.js — los escritorios de las OTRAS máquinas de la cuenta, para las ventanas de esta.
 *
 * La ventana de escritorio (desktop/, Rust) no habla con la red: le habla al agente de su
 * máquina por el socket local (`@dotrino/remote-agent/local`), y el agente hace de CLIENTE de
 * los agentes de las otras máquinas con su propio enlace (`@dotrino/remote-agent/far`). Así la
 * identidad, el transporte y el cifrado siguen en los pilares y la ventana no reimplementa nada.
 *
 * Dos cosas:
 *   · `list()` — qué máquinas tienen el escritorio remoto encendido. Se guarda y se refresca por
 *     detrás: quien pregunta no espera a la red más que la primera vez.
 *   · `via(session, machine)` — la ventana pasa a hablar con la OTRA máquina. Es un tubo: el
 *     protocolo es el mismo (`serveSession` de index.js), en las dos direcciones. Lo único que
 *     se añade es `{ type:'resumed' }` cuando la sesión con la otra máquina se rehízo sola:
 *     la ventana vuelve a pedir la escena, igual que la PWA con el evento `resumed`.
 *
 * La clave de una máquina (`unlock`) pasa por el tubo como cualquier mensaje: la recuerda la
 * ventana, en memoria, como la PWA. Aquí no se guarda.
 */
import { discoverAgents, connectAgent, failureLog } from '@dotrino/remote-agent/far'

/** Cada cuánto se vuelve a mirar QUÉ máquinas hay (el acta y quién contesta). */
export const DISCOVER_MS = 30_000
/** Sin que nadie pregunte durante este rato, se suelta la conexión con la que se pregunta. */
export const IDLE_MS = 60_000

/** @typedef {import('@dotrino/remote-agent/far').FoundAgent} FoundAgent */
/** @typedef {import('@dotrino/remote-agent/far').DiscoverState} DiscoverState */
/** @typedef {import('@dotrino/remote-agent/client').RemoteAgentClient} RemoteAgentClient */
/** @typedef {{ device?: string | null, send: (p: object) => unknown, on: (ev: 'message' | 'close', cb: (msg?: any) => void) => unknown }} SessionLike */
/** @typedef {NodeJS.ErrnoException & { reason?: string }} Thrown */

/** @type {(code: string, message: string) => Error & { code: string }} */
const fail = (code, message) => Object.assign(new Error(message), { code })

/** Un fallo, como lo entiende la ventana: con su `code` y, si lo trae, su `reason` (`missing-cap`). @param {unknown} err */
export function failOf (err) {
  const e = /** @type {Thrown | null | undefined} */ (err)
  return { type: 'fail', code: e?.code || 'unreachable', message: e?.message || String(err), ...(e?.reason ? { reason: e.reason } : {}) }
}

/**
 * @param {object} opts
 * @param {string} opts.dir                         la carpeta del enlace de este agente.
 * @param {() => any} opts.loadLink                 el enlace, leído cada vez.
 * @param {string} opts.kind                        el tipo de agente que se busca (`remote-desktop-agent`).
 * @param {typeof discoverAgents} [opts.discover]   para las pruebas.
 * @param {typeof connectAgent} [opts.connect]      para las pruebas.
 * @param {number} [opts.discoverMs]
 * @param {number} [opts.idleMs]
 * @param {(line: string) => void} [opts.log]
 */
export function makeFar ({ dir, loadLink, kind, discover = discoverAgents, connect = connectAgent, discoverMs = DISCOVER_MS, idleMs = IDLE_MS, log = (line) => console.error(line) }) {
  /** @type {FoundAgent[] | null} */
  let found = null
  let foundAt = 0
  /** @type {Promise<FoundAgent[]> | null} */
  let looking = null
  /** @type {DiscoverState} */
  const state = { probe: null }
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let idle
  let closed = false
  const report = failureLog(log)

  const link = () => {
    const l = loadLink()
    if (!l) throw fail('not-linked', 'this machine is not linked to a vault, so it cannot see your other machines')
    return l
  }

  function release () {
    try { state.probe?.close() } catch (_) {}
    state.probe = null
    found = null; foundAt = 0
  }
  function touch () {
    clearTimeout(idle)
    idle = setTimeout(release, idleMs)
    idle.unref?.()
  }

  function look () {
    if (!looking) {
      const t0 = Date.now()
      looking = discover({ link: link(), dir, kind, state })
        .then((f) => { report('vault (list of machines)', null, Date.now() - t0); found = f; foundAt = Date.now(); return f },
          (e) => { report('vault (list of machines)', e, Date.now() - t0); throw e })
        .finally(() => { looking = null })
    }
    return looking
  }

  /** Las máquinas con el escritorio remoto encendido. La primera vez espera a la red. */
  async function list () {
    if (closed) throw fail('closed', 'the agent is stopping')
    link()
    touch()
    if (!found) return look()
    if (Date.now() - foundAt >= discoverMs) look().catch(() => {})
    return found
  }

  /**
   * La máquina que se nombró: por su llave, por su id (`AB12-CD34`) o por su nombre.
   * @param {unknown} ref
   * @returns {Promise<FoundAgent>}
   */
  async function resolve (ref) {
    const want = String(ref || '').trim()
    if (!want) throw fail('no-machine', 'which machine?')
    const low = want.toLowerCase()
    /** @param {FoundAgent[]} all */
    const find = (all) => {
      const hits = all.filter((m) => m.sub === want || m.id.toLowerCase() === low || m.id.replace('-', '').toLowerCase() === low.replace('-', '') || (m.name && m.name.toLowerCase() === low))
      if (hits.length > 1) throw fail('ambiguous-machine', `more than one machine is called "${want}": use its id`)
      return hits[0] || null
    }
    touch()
    const m = find(found || []) || find(await look())
    if (!m) throw fail('no-machine', `no machine "${want}" is on with a remote desktop agent`)
    return m
  }

  /**
   * La ventana pasa a hablar con otra máquina: lo que mande va allí y lo que venga vuelve, tal
   * cual. Contesta `{ type:'via', machine }` cuando el tubo está puesto.
   * @param {SessionLike} session
   * @param {unknown} ref
   */
  async function via (session, ref) {
    /** @type {object[]} */
    const queue = []
    /** @type {RemoteAgentClient | null} */
    let rc = null
    let gone = false
    // La ventana se cerró: se deja de mirar allí (para el vídeo y los parches) antes de cortar.
    session.on('close', () => {
      gone = true
      const conn = rc
      if (!conn) return
      const end = () => { conn.close().catch(() => {}) }
      conn.send({ type: 'leave' }).then(end, end)
    })
    /** @param {object} msg */
    const forward = (msg) => {
      if (!rc) throw new Error('far: forwarding before the connection is up')
      rc.send(msg).catch((/** @type {unknown} */ e) => session.send(failOf(e)))
    }
    session.on('message', (msg) => { if (!msg || typeof msg !== 'object') return; if (rc) forward(msg); else queue.push(msg) })
    /** @type {FoundAgent} */
    let m
    try {
      m = await resolve(ref)
      rc = await connect({ link: link(), dir, sub: m.sub, loadLink })
    } catch (e) {
      report(`machine ${String(ref)}`, e)
      session.send(failOf(e))
      return
    }
    report(`machine ${m.id}`, null)
    const conn = rc
    if (gone) { conn.close().catch(() => {}); return }
    conn.on('message', (p) => { session.send(p) })
    conn.on('error', (e) => { session.send(failOf(e)) })
    // La sesión con la otra máquina se rehízo (se reinició, o venció): la ventana vuelve a pedir.
    conn.on('resumed', () => { session.send({ type: 'resumed' }) })
    session.send({ type: 'via', machine: { sub: m.sub, id: m.id, name: m.name } })
    for (const msg of queue.splice(0)) forward(msg)
  }

  return {
    list, via,
    close: () => { closed = true; clearTimeout(idle); release() }
  }
}

export default { makeFar }
