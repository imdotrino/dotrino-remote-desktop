// Las ventanas de ESTA máquina (serveLocal en index.js, far.js): por el socket local de verdad,
// con un escritorio de mentira y otras máquinas de mentira. Lo que se prueba: el saludo con la
// versión, el escritorio de aquí sin clave, la lista de máquinas, el tubo `via` en las dos
// direcciones (también la clave de la otra máquina), el `missing-cap` que llega con su motivo,
// `resumed`, y que al cerrar la ventana se deja de mirar allí.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { serveLocal, LOCAL_SOCKET, VERSION } from '../index.js'
import { makeFar, failOf } from '../far.js'
import { listenLocal, connectLocal } from '@dotrino/remote-agent/local'

const until = async (cond, ms = 3000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function fakeDesktop () {
  const calls = []
  let watching = false
  const reader = { mouse: async (x, y, ev) => calls.push(['mouse', x, y, ev]), key: async (k) => calls.push(['key', k]) }
  return {
    calls,
    async watch () { watching = true; return { scene: { seq: 1, screen: { w: 10, h: 10 }, wins: [], nodes: [] }, unwatch: () => { watching = false } } },
    get reader () { return watching ? reader : null }
  }
}

/** Una conexión con otra máquina, de mentira: lo que se le manda y cómo contesta. */
function fakeRemote (answer = () => null) {
  const h = { message: [], error: [], resumed: [] }
  const sent = []
  let closed = false
  return {
    sent,
    get closed () { return closed },
    on (ev, cb) { h[ev].push(cb); return () => {} },
    async send (m) { sent.push(m); const r = answer(m); if (r) setTimeout(() => { for (const cb of h.message) cb(r) }, 0) },
    async close () { closed = true },
    emit (ev, v) { for (const cb of h[ev]) cb(v) }
  }
}

const MACHINES = [{ sub: 'PUB-A', id: 'AB12-CD34', name: 'oficina' }, { sub: 'PUB-B', id: 'EF56-GH78', name: '' }]

async function setup ({ connect, discover } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-local-'))
  const desktop = fakeDesktop()
  const far = makeFar({
    dir,
    kind: 'remote-desktop-agent',
    loadLink: () => ({ fake: true }),
    discover: discover || (async () => MACHINES),
    connect: connect || (async () => fakeRemote()),
    log: () => {}
  })
  const local = await listenLocal({ dir, name: LOCAL_SOCKET, serve: (s) => serveLocal(s, /** @type {any} */ (desktop), far) })
  const open = async () => {
    const c = await connectLocal(dir, { name: LOCAL_SOCKET })
    const got = []
    c.on('message', (m) => got.push(m))
    return { c, got }
  }
  return { dir, desktop, open, done: () => { far.close(); local.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

test('el socket se llama remote-desktop.sock, y lo primero que llega es quién atiende', async () => {
  const s = await setup()
  assert.ok(fs.existsSync(path.join(s.dir, 'remote-desktop.sock')))
  const w = await s.open()
  await until(() => w.got.length >= 1)
  assert.deepEqual(w.got[0], { type: 'hello', product: 'remote-desktop-agent', version: VERSION })
  w.c.close(); s.done()
})

test('sin via, la ventana usa el escritorio de esta máquina y sin clave', async () => {
  const s = await setup()
  const w = await s.open()
  w.c.send({ type: 'scene' })
  await until(() => w.got.some((m) => m.type === 'scene'))
  w.c.send({ type: 'click', x: 3, y: 4 })
  await until(() => s.desktop.calls.length === 2)
  assert.deepEqual(s.desktop.calls, [['mouse', 3, 4, 'abs'], ['mouse', 3, 4, 'b1c']])
  // Ya usa esta máquina: pasar a otra en la misma conexión se rechaza.
  w.c.send({ type: 'via', machine: 'oficina' })
  await until(() => w.got.some((m) => m.type === 'fail'))
  assert.equal(w.got.find((m) => m.type === 'fail').code, 'bad-input')
  w.c.close(); s.done()
})

test('machines lista las otras máquinas con el escritorio remoto encendido', async () => {
  const s = await setup()
  const w = await s.open()
  w.c.send({ type: 'machines' })
  await until(() => w.got.some((m) => m.type === 'machines'))
  assert.deepEqual(w.got.find((m) => m.type === 'machines').list, MACHINES)
  w.c.close(); s.done()
})

test('via: todo va a la otra máquina y todo vuelve, incluida la clave', async () => {
  let remote
  const s = await setup({
    connect: async ({ sub }) => {
      assert.equal(sub, 'PUB-A')
      remote = fakeRemote((m) => {
        if (m.type === 'scene') return { type: 'fail', code: 'locked', message: 'this machine asks for its code' }
        if (m.type === 'unlock') return m.code === '1234' ? { type: 'unlocked' } : { type: 'fail', code: 'bad-code', message: 'wrong' }
        return null
      })
      return remote
    }
  })
  const w = await s.open()
  // Lo que se manda antes de que el tubo esté puesto espera y sale en orden.
  w.c.send({ type: 'via', machine: 'ab12cd34' })
  w.c.send({ type: 'scene' })
  await until(() => w.got.some((m) => m.type === 'via'))
  assert.deepEqual(w.got.find((m) => m.type === 'via').machine, MACHINES[0])
  await until(() => w.got.some((m) => m.code === 'locked'))
  w.c.send({ type: 'unlock', code: '0000' })
  await until(() => w.got.some((m) => m.code === 'bad-code'))
  w.c.send({ type: 'unlock', code: '1234' })
  await until(() => w.got.some((m) => m.type === 'unlocked'))
  assert.deepEqual(remote.sent.map((m) => m.type), ['scene', 'unlock', 'unlock'])
  assert.equal(s.desktop.calls.length, 0, 'el escritorio de aquí no se tocó')
  // La sesión con la otra máquina se rehízo: la ventana se entera.
  remote.emit('resumed', {})
  await until(() => w.got.some((m) => m.type === 'resumed'))
  // Cerrar la ventana deja de mirar allí y suelta la conexión.
  w.c.close()
  await until(() => remote.closed)
  assert.equal(remote.sent.at(-1).type, 'leave')
  s.done()
})

test('via: sin el permiso desktop, el fallo llega con su motivo (missing-cap)', async () => {
  const s = await setup({
    connect: async () => { throw Object.assign(new Error('missing capability desktop'), { code: 'unauthorized', reason: 'missing-cap' }) }
  })
  const w = await s.open()
  w.c.send({ type: 'via', machine: 'oficina' })
  await until(() => w.got.some((m) => m.type === 'fail'))
  const f = w.got.find((m) => m.type === 'fail')
  assert.equal(f.code, 'unauthorized')
  assert.equal(f.reason, 'missing-cap')
  w.c.close(); s.done()
})

test('via: una máquina que no está se dice (no-machine), y un error de la sesión llega como fail', async () => {
  let remote
  const s = await setup({ connect: async () => { remote = fakeRemote(); return remote } })
  const w = await s.open()
  w.c.send({ type: 'via', machine: 'casa' })
  await until(() => w.got.some((m) => m.type === 'fail'))
  assert.equal(w.got.find((m) => m.type === 'fail').code, 'no-machine')
  const w2 = await s.open()
  w2.c.send({ type: 'via', machine: 'PUB-B' })
  await until(() => w2.got.some((m) => m.type === 'via'))
  remote.emit('error', Object.assign(new Error('blocked'), { code: 'blocked' }))
  await until(() => w2.got.some((m) => m.type === 'fail'))
  assert.equal(w2.got.find((m) => m.type === 'fail').code, 'blocked')
  w.c.close(); w2.c.close(); s.done()
})

test('sin enlace, machines contesta not-linked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-far-'))
  const far = makeFar({ dir, kind: 'remote-desktop-agent', loadLink: () => null, log: () => {} })
  await assert.rejects(far.list(), (e) => e.code === 'not-linked')
  far.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('la lista se guarda y la segunda vez no espera a la red', async () => {
  let calls = 0
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-far-'))
  const far = makeFar({ dir, kind: 'remote-desktop-agent', loadLink: () => ({}), discover: async () => { calls++; return MACHINES }, log: () => {} })
  await far.list(); await far.list()
  assert.equal(calls, 1)
  far.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('failOf deja el code y el reason', () => {
  assert.deepEqual(failOf(Object.assign(new Error('x'), { code: 'unauthorized', reason: 'missing-cap' })), { type: 'fail', code: 'unauthorized', message: 'x', reason: 'missing-cap' })
  assert.deepEqual(failOf(new Error('y')), { type: 'fail', code: 'unreachable', message: 'y' })
})
