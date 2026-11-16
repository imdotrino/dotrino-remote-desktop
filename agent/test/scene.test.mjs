// La escena y sus diferencias (scene.js): lo que el agente calcula y el cliente aplica tiene
// que dar la misma pantalla, y una pantalla quieta no manda nada.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diff, applyPatch, hit, screenOf } from '../scene.js'

/** @param {number} id @param {object} [o] */
const n = (id, o = {}) => ({ id, p: 0, r: 'button', x: id * 10, y: 0, w: 10, h: 10, ...o })
const S = (seq, nodes, extra = {}) => ({ seq, screen: { w: 100, h: 100 }, wins: [], nodes, ...extra })

test('sin cambios no hay parche', () => {
  assert.equal(diff(S(1, [n(1), n(2)]), S(2, [n(1), n(2)])), null)
})

test('un texto cambia: viaja solo ese nodo, sin orden', () => {
  const p = diff(S(1, [n(1), n(2)]), S(2, [n(1), n(2, { t: 'hola' })]))
  assert.deepEqual(p.put.map((x) => x.id), [2])
  assert.deepEqual(p.del, [])
  assert.equal(p.order, undefined)
})

test('borrar, añadir y reordenar: aplicar el parche da la escena nueva', () => {
  const a = S(1, [n(1), n(2), n(3)])
  const b = S(2, [n(3), n(4), n(1, { n: 'x' })], { wins: [{ id: 9, app: 'a', name: 'w', active: true }] })
  const p = diff(a, b)
  assert.deepEqual(p.del, [2])
  assert.deepEqual(p.order, [3, 4, 1])
  assert.deepEqual(applyPatch(a, p), b)
})

test('un parche para otra escena se rechaza con stale', () => {
  const p = diff(S(1, [n(1)]), S(2, [n(1, { t: 'y' })]))
  assert.throws(() => applyPatch(S(5, [n(1)]), p), { code: 'stale' })
})

test('hit: el de más arriba bajo el punto', () => {
  const nodes = [n(0, { x: 0, y: 0, w: 100, h: 100, r: 'frame' }), n(1, { x: 10, y: 10, w: 20, h: 20 })]
  assert.equal(hit(nodes, 15, 15).id, 1)
  assert.equal(hit(nodes, 80, 80).id, 0)
  assert.equal(hit(nodes, 200, 200), null)
})

test('screenOf: lo que abarcan las ventanas', () => {
  assert.deepEqual(screenOf([{ ext: [0, 0, 1920, 1080] }, { ext: [100, 50, 400, 300] }]), { w: 1920, h: 1080 })
})

