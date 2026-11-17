import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DBusError } from '@dotrino/proxy-client/dbus'
import { timed } from '../atspi.js'

test('a D-Bus call that never answers fails with NoReply instead of waiting forever', async () => {
  const conn = timed({ call: () => new Promise(() => {}) }, 20)
  await assert.rejects(conn.call({ destination: 'org.example.Hung', path: '/', iface: 'x', member: 'GetChildren' }),
    (e) => e instanceof DBusError && e.dbusName === 'org.freedesktop.DBus.Error.NoReply')
})

test('an answer in time goes through as it is', async () => {
  const conn = timed({ call: async () => [42] }, 20)
  assert.deepEqual(await conn.call({ destination: 'd', path: '/', iface: 'x', member: 'm' }), [42])
})
