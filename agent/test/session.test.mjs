// serveSession (index.js) con un escritorio de mentira: la escena se manda al pedirla, los
// parches siguen, lo que llega mal se contesta con su code y los clics llegan al lector.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { serveSession } from '../index.js'
import { makeGate, setAccessCode } from '@dotrino/remote-agent/access'

function fakes (gate = null) {
  const calls = []
  let onPatch = null
  let watching = false
  const reader = {
    mouse: async (x, y, ev) => calls.push(['mouse', x, y, ev]),
    key: async (k) => calls.push(['key', k]),
    doAction: async (id, i) => calls.push(['action', id, i]),
    focus: async (id) => calls.push(['focus', id])
  }
  const desktop = {
    async watch (fn) { onPatch = fn; watching = true; return { scene: { seq: 1, screen: { w: 10, h: 10 }, wins: [], nodes: [] }, unwatch: () => { watching = false } } },
    get reader () { return watching ? reader : null }
  }
  const h = { message: [], close: [] }
  const sent = []
  const session = { send: (p) => sent.push(p), on: (ev, cb) => h[ev].push(cb) }
  serveSession(session, /** @type {any} */ (desktop), { gate })
  const say = async (m) => { await h.message[0](m) }
  return { calls, sent, say, patch: (p) => onPatch(p), close: () => h.close[0](), isWatching: () => watching }
}

test('pedir la escena la manda y los parches siguen', async () => {
  const f = fakes()
  await f.say({ type: 'scene' })
  assert.equal(f.sent[0].type, 'scene')
  f.patch({ seq: 2, base: 1, put: [], del: [3] })
  assert.deepEqual(f.sent[1], { type: 'patch', seq: 2, base: 1, put: [], del: [3] })
})

test('sin escena pedida, un clic se contesta con not-watching', async () => {
  const f = fakes()
  await f.say({ type: 'click', x: 1, y: 2 })
  assert.equal(f.sent[0].code, 'not-watching')
})

test('clic, doble clic, rueda, texto y tecla llegan al lector', async () => {
  const f = fakes()
  await f.say({ type: 'scene' })
  await f.say({ type: 'click', x: 5, y: 6, button: 3 })
  await f.say({ type: 'click', x: 5, y: 6, double: true })
  await f.say({ type: 'wheel', x: 1, y: 1, dy: -2 })
  await f.say({ type: 'text', text: 'hola' })
  await f.say({ type: 'key', keysym: 0xff0d })
  await f.say({ type: 'key', keysym: 0x63, mods: ['ctrl'] })
  await f.say({ type: 'action', id: 7 })
  assert.deepEqual(f.calls, [
    ['mouse', 5, 6, 'abs'], ['mouse', 5, 6, 'b3c'],
    ['mouse', 5, 6, 'abs'], ['mouse', 5, 6, 'b1d'],
    ['mouse', 1, 1, 'abs'], ['mouse', 1, 1, 'b4c'], ['mouse', 1, 1, 'b4c'],
    ['key', { text: 'hola' }], ['key', { keysym: 0xff0d, mods: [] }], ['key', { keysym: 0x63, mods: ['ctrl'] }], ['action', 7, 0]
  ])
})

test('lo que llega mal se dice con su code, y nada llega al lector', async () => {
  const f = fakes()
  await f.say({ type: 'scene' })
  await f.say({ type: 'click', x: 'a', y: 1 })
  await f.say({ type: 'click', x: 1, y: 1, button: 9 })
  await f.say({ type: 'text', text: 'x'.repeat(10_001) })
  await f.say({ type: 'key', keysym: 0x63, mods: ['hyper'] })
  await f.say({ type: 'nope' })
  assert.deepEqual(f.sent.slice(1).map((p) => p.code), ['bad-input', 'bad-input', 'too-long', 'bad-input', 'unknown-type'])
  assert.equal(f.calls.length, 0)
})

test('al cerrarse la sesión deja de mirar', async () => {
  const f = fakes()
  await f.say({ type: 'scene' })
  f.close()
  assert.equal(f.isWatching(), false)
})

test('con clave en la máquina, nada se ve ni se toca hasta escribirla', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-lock-'))
  setAccessCode(dir, '4821')
  const f = fakes(makeGate(dir))
  await f.say({ type: 'scene' })
  assert.equal(f.sent.at(-1).code, 'locked')
  assert.equal(f.isWatching(), false, 'no se empezó a mirar el escritorio')
  await f.say({ type: 'click', x: 1, y: 2 })
  assert.equal(f.calls.length, 0)
  await f.say({ type: 'unlock', code: 'nope' })
  assert.equal(f.sent.at(-1).code, 'bad-code')
  await f.say({ type: 'unlock', code: '4821' })
  assert.equal(f.sent.at(-1).type, 'unlocked')
  await f.say({ type: 'scene' })
  assert.equal(f.sent.at(-1).type, 'scene')
  fs.rmSync(dir, { recursive: true, force: true })
})
