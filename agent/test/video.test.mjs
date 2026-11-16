// video.js: separar cuadros H.264 por sus AUD, reconocer los completos y ajustar el rectángulo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitFrames, isKey, evenRect, ffmpegArgs, makeVideo } from '../video.js'

const AUD = [0, 0, 0, 1, 9, 0xf0]
const IDR = [0, 0, 1, 0x65, 1, 2, 3]
const P = [0, 0, 1, 0x41, 4, 5]

test('splitFrames: un cuadro por AUD, y el último se guarda hasta que llegue el siguiente', () => {
  const buf = Uint8Array.from([...AUD, ...IDR, ...AUD, ...P, ...AUD, 7])
  const { frames, rest } = splitFrames(buf)
  assert.equal(frames.length, 2)
  assert.ok(isKey(frames[0]))
  assert.ok(!isKey(frames[1]))
  assert.deepEqual([...rest], [...AUD, 7])
})

test('splitFrames: sin AUD no hay cuadro todavía', () => {
  const { frames, rest } = splitFrames(Uint8Array.from([1, 2, 3]))
  assert.equal(frames.length, 0)
  assert.equal(rest.length, 3)
})

test('evenRect: lados pares, dentro de la pantalla, y nada diminuto', () => {
  assert.deepEqual(evenRect({ x: 10.4, y: 5, w: 301, h: 201 }, { w: 1920, h: 1080 }), { x: 10, y: 5, w: 300, h: 200 })
  assert.deepEqual(evenRect({ x: 1800, y: 0, w: 400, h: 100 }, { w: 1920, h: 1080 }), { x: 1800, y: 0, w: 120, h: 100 })
  assert.equal(evenRect({ x: 0, y: 0, w: 20, h: 500 }, { w: 1920, h: 1080 }), null)
})

test('ffmpegArgs: captura ese rectángulo, baseline sin cuadros B y con AUD', () => {
  const a = ffmpegArgs({ x: 4, y: 6, w: 100, h: 50 }, ':0').join(' ')
  assert.match(a, /-video_size 100x50 -i :0\+4,6/)
  assert.match(a, /-profile:v baseline/)
  assert.match(a, /-bf 0/)
  assert.match(a, /aud=1/)
})

test('Wayland: no-video, sin lanzar nada', () => {
  let spawned = 0
  const v = makeVideo({ session: 'wayland', spawn: /** @type {any} */ (() => { spawned++ }) })
  let err = null
  v.start({ x: 0, y: 0, w: 100, h: 100 }, () => {}, (e) => { err = e })
  assert.equal(err?.code, 'no-video')
  assert.equal(spawned, 0)
})
