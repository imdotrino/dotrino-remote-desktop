import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { parseIcons, pickIcon, toRgba, encodePng, makeIcons } from '../icon.js'

const RED = 0xffff0000 >>> 0
const CLEAR = 0

test('parseIcons reads every size xprop gives', () => {
  const out = `_NET_WM_ICON = 2, 1, ${RED}, ${RED}, 1, 1, ${CLEAR}\n`
  const icons = parseIcons(out)
  assert.equal(icons.length, 2)
  assert.deepEqual([icons[0].w, icons[0].h, icons[0].argb.length], [2, 1, 2])
  assert.deepEqual([icons[1].w, icons[1].h], [1, 1])
})

test('parseIcons: a window without an icon gives nothing', () => {
  assert.deepEqual(parseIcons('_NET_WM_ICON:  not found.\n'), [])
})

test('pickIcon: the smallest that reaches the size, else the biggest', () => {
  const mk = (w) => ({ w, h: w, argb: [] })
  assert.equal(pickIcon([mk(16), mk(64), mk(128)], 48)?.w, 64)
  assert.equal(pickIcon([mk(16), mk(32)], 48)?.w, 32)
  assert.equal(pickIcon([], 48), null)
})

test('toRgba averages by alpha: a transparent border does not darken the colour', () => {
  const px = toRgba({ w: 2, h: 1, argb: [RED, CLEAR] }, 1, 1)
  assert.deepEqual([...px], [255, 0, 0, 128])
})

test('encodePng writes a PNG with the pixels inside', () => {
  const png = encodePng(1, 1, new Uint8Array([1, 2, 3, 4]))
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.readUInt32BE(16), 1)
  const idatAt = png.indexOf('IDAT')
  const len = png.readUInt32BE(idatAt - 4)
  assert.deepEqual([...inflateSync(png.subarray(idatAt + 4, idatAt + 4 + len))], [0, 1, 2, 3, 4])
})

/** Un xdotool/xprop de mentira: dos ventanas del proceso, solo la segunda casa con el título. */
const fakeExec = (calls) => async (cmd, args) => {
  calls.push(cmd)
  if (cmd === 'xdotool' && args[0] === 'search') return '11\n22\n'
  if (cmd === 'xdotool') return (args[1] === '11' ? 'Otra\n' : 'Notas\n') + 'X=0\nY=0\nWIDTH=10\nHEIGHT=10\n'
  if (cmd === 'xprop') return args[1] === '22' ? `_NET_WM_ICON = 1, 1, ${RED}\n` : '_NET_WM_ICON:  not found.\n'
  throw new Error('unexpected ' + cmd)
}

test('iconOf: the icon of the window that matches, cached', async () => {
  const calls = []
  const icons = makeIcons({ session: 'x11', exec: fakeExec(calls) })
  const png = await icons.iconOf({ pid: 7, title: 'Notas' })
  assert.ok(png && Buffer.from(png, 'base64').subarray(1, 4).toString() === 'PNG')
  await icons.iconOf({ pid: 7, title: 'Notas' })
  assert.equal(calls.filter((c) => c === 'xprop').length, 1)
})

test('iconOf: a window without an icon is null, not an error', async () => {
  const icons = makeIcons({ session: 'x11', exec: fakeExec([]) })
  assert.equal(await icons.iconOf({ pid: 7, title: 'Otra' }), null)
})

test('iconOf on Wayland says so with its code', async () => {
  const icons = makeIcons({ session: 'wayland', exec: fakeExec([]) })
  await assert.rejects(icons.iconOf({ pid: 7, title: 'Notas' }), { code: 'no-icon' })
})
