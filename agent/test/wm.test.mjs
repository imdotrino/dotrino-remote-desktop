import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseClientList, parseProps, showsInTaskbar, makeClientWindows } from '../wm.js'

test('parseClientList gives the ids in decimal', () => {
  assert.deepEqual(parseClientList('_NET_CLIENT_LIST(WINDOW): window id # 0x1e00003, 0x8c00004\n'), ['31457283', '146800644'])
  assert.deepEqual(parseClientList('_NET_CLIENT_LIST:  not found.\n'), [])
})

test('parseProps and showsInTaskbar: panels, the desktop and minimised windows stay out', () => {
  const normal = parseProps('_NET_WM_PID(CARDINAL) = 417335\n_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL\n_NET_WM_STATE(ATOM) = \n')
  assert.equal(normal.pid, 417335)
  assert.equal(showsInTaskbar(normal), true)
  const dock = parseProps('_NET_WM_PID(CARDINAL) = 9809\n_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_DOCK\n_NET_WM_STATE(ATOM) = _NET_WM_STATE_STICKY, _NET_WM_STATE_SKIP_TASKBAR\n')
  assert.equal(showsInTaskbar(dock), false)
  assert.equal(showsInTaskbar({ types: [], states: ['_NET_WM_STATE_HIDDEN'] }), false)
  assert.equal(showsInTaskbar({ types: [], states: [] }), true)
})

test('list: only the windows of processes accessibility does not know', async () => {
  const props = {
    100: '_NET_WM_PID(CARDINAL) = 7\n_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL\n_NET_WM_STATE(ATOM) = \n',
    200: '_NET_WM_PID(CARDINAL) = 8\n_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL\n_NET_WM_STATE(ATOM) = \n',
    300: '_NET_WM_PID(CARDINAL) = 9\n_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_DOCK\n_NET_WM_STATE(ATOM) = \n'
  }
  const exec = async (cmd, args) => {
    if (cmd === 'xprop' && args[0] === '-root') return '_NET_CLIENT_LIST(WINDOW): window id # 0x64, 0xc8, 0x12c\n'
    if (cmd === 'xprop') return props[args[1]]
    if (cmd === 'xdotool') return 'Consola\nX=1\nY=2\nWIDTH=300\nHEIGHT=200\n'
    throw new Error('unexpected ' + cmd)
  }
  const got = await makeClientWindows({ session: 'x11', exec }).list(new Set([8]))
  assert.deepEqual(got, [{ window: '100', pid: 7, title: 'Consola', x: 1, y: 2, w: 300, h: 200 }])
})

test('list on Wayland: null, accessibility alone', async () => {
  assert.equal(await makeClientWindows({ session: 'wayland', exec: async () => '' }).list(new Set()), null)
})
