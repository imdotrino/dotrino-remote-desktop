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
    if (args[0] === 'getwindowname') return wins[args[1]] + '\nWINDOW=' + args[1] + '\nX=0\nY=0\nWIDTH=10\nHEIGHT=10\n'
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

test('parseActive: título, proceso y sitio de la ventana activa', async () => {
  const { parseActive } = await import('../raise.js')
  assert.deepEqual(parseActive('Mi ventana\n417335\nWINDOW=146800644\nX=27\nY=73\nWIDTH=945\nHEIGHT=482\nSCREEN=0\n'),
    { pid: 417335, title: 'Mi ventana', window: '146800644', x: 27, y: 73, w: 945, h: 482 })
  assert.equal(parseActive('sin nada\n'), null)
})

test('pickWindow: Chrome con el perfil añadido en accesibilidad, por sitio y por parecido', async () => {
  const { pickWindow } = await import('../raise.js')
  const cands = [
    { id: '1', name: 'google-chrome-stable', x: 0, y: 0, w: 10, h: 10 },
    { id: '2', name: 'Inbox - Zoho Mail (dev@x.ec) - Google Chrome', x: 100, y: 50, w: 800, h: 600 },
    { id: '3', name: 'Gmail - Google Chrome', x: 900, y: 50, w: 800, h: 600 }
  ]
  const a11y = 'Inbox - Zoho Mail (dev@x.ec) - High memory usage - 1.2 GB - Google Chrome - Developer'
  assert.equal(pickWindow(cands, a11y, { x: 110, y: 60, w: 790, h: 590 }), '2')
  assert.equal(pickWindow(cands, a11y, null), '2')
  assert.equal(pickWindow(cands, 'Nada que ver', null), null)
})
