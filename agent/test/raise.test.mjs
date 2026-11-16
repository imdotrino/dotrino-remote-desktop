// raiseWindow (raise.js): busca la ventana del proceso por su título y la activa; lo que no se
// puede se dice con su code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { raiseWindow } from '../raise.js'

const fake = (wins) => {
  const calls = []
  const exec = async (cmd, args) => {
    calls.push(args.join(' '))
    if (args[0] === 'search') return Object.keys(wins).join('\n')
    if (args[0] === 'getwindowname') return wins[args[1]] + '\n'
    return ''
  }
  return { calls, exec }
}

test('activa la ventana del proceso con ese título', async () => {
  const f = fake({ 11: 'Otra', 22: 'Documentos — Archivos' })
  const r = await raiseWindow({ pid: 5, title: 'Documentos — Archivos', session: 'x11', exec: f.exec })
  assert.deepEqual(r, { window: '22' })
  assert.equal(f.calls.at(-1), 'windowactivate 22')
})

test('sin esa ventana: window-not-found', async () => {
  const f = fake({ 11: 'Otra' })
  await assert.rejects(() => raiseWindow({ pid: 5, title: 'Nada', session: 'x11', exec: f.exec }), { code: 'window-not-found' })
})

test('Wayland: no-raise, sin intentar nada', async () => {
  const f = fake({})
  await assert.rejects(() => raiseWindow({ pid: 5, title: 'x', session: 'wayland', exec: f.exec }), { code: 'no-raise' })
  assert.equal(f.calls.length, 0)
})

test('sin xdotool: no-raise', async () => {
  const exec = async () => { throw Object.assign(new Error('spawn xdotool ENOENT'), { code: 'ENOENT' }) }
  await assert.rejects(() => raiseWindow({ pid: 5, title: 'x', session: 'x11', exec }), { code: 'no-raise' })
})
