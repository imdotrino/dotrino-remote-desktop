#!/usr/bin/env node
/**
 * dotrino-remote-desktop-agent — el agente de Dotrino Remote Desktop.
 *
 *   dotrino-remote-desktop-agent [--name <n>]          enlaza (si falta) y CORRE el agente
 *   dotrino-remote-desktop-agent enroll [--name <n>]   re-enlaza (sobrescribe) y lo corre
 *   dotrino-remote-desktop-agent list                  los agentes enlazados en esta máquina
 *   dotrino-remote-desktop-agent info [--name <n>]     qué aparato es: su ID, su bóveda, sus permisos
 *   dotrino-remote-desktop-agent update [--name <n>] [--approval on|off] [--notify on|off]
 *                                                      cómo se actualiza (CONVENCIONES §15)
 *
 * Tiene que correr DENTRO de la sesión gráfica del usuario (necesita su bus de sesión y el de
 * accesibilidad): un servicio de usuario de systemd o el arranque automático del escritorio,
 * no un servicio del sistema.
 */
import { createRequire } from 'node:module'
import { startAgent } from '../index.js'
import { loadLink, dataDir, LABEL } from '../link.js'
import { enrollInteractive } from '@dotrino/remote-agent/link'
import { listInstances, lockInstance, instancesRoot } from '@dotrino/remote-agent/instances'
import { deviceInfo, formatDeviceInfo } from '@dotrino/vault/device-info'
import { updatePrefsCommand, updateStatusText } from '@dotrino/update/npm'
import { startSelfUpdate } from '@dotrino/remote-agent/update'

/** @type {{ version: string }} */
const { version: VERSION } = createRequire(import.meta.url)('../package.json')
const args = process.argv.slice(2)
const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'run'
/** @param {string} name */
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

if (args.includes('-h') || args.includes('--help')) {
  console.log(`uso:
  dotrino-remote-desktop-agent [--name <n>]          enlaza este agente (si falta) y lo corre
  dotrino-remote-desktop-agent enroll [--name <n>]   re-enlaza (sobrescribe el enlace) y lo corre
  dotrino-remote-desktop-agent list                  los agentes enlazados en esta máquina
  dotrino-remote-desktop-agent info [--name <n>]     qué aparato es: su ID (el de «dotrino-vault members»),
                                                     su bóveda y sus permisos. Sin red. [--json]
  dotrino-remote-desktop-agent update [--name <n>]   cómo se actualiza. Por defecto lo hace solo y avisa:
                                                       --approval on|off  pedir antes aprobación a tu bóveda
                                                       --notify on|off    avisar cuando se actualiza
  opciones: [--name <n>] [--proxy <wss://…>] [--dir <ruta>]
           [--no-a11y]  no encender la accesibilidad del escritorio al mirar

Corre dentro de tu sesión gráfica (Linux, X11 o Wayland).
enlaces en ${instancesRoot(LABEL)}/<nombre> (--dir o DOTRINO_REMOTE_DESKTOP_DIR fuerzan una carpeta)`)
  process.exit(0)
}

/** @param {unknown} e @returns {never} */
function die (e) { console.error('error:', /** @type {Error} */ (e).message); process.exit(1) }

if (cmd === 'list') {
  const names = listInstances(LABEL)
  if (!names.length) console.log('No hay ningún agente de escritorio remoto enlazado en esta máquina.')
  for (const n of names) console.log(`  ${n}   ${instancesRoot(LABEL)}/${n}`)
  process.exit(0)
}

// `update`: los dos ajustes de ESTE agente (`@dotrino/update/npm`). Sin banderas, los enseña.
if (cmd === 'update') {
  let r
  try {
    const dir = opt('--dir') || dataDir(opt('--name'))
    const own = args.slice(1).filter((a, i, all) => !['--name', '--dir'].includes(a) && !['--name', '--dir'].includes(all[i - 1]))
    r = updatePrefsCommand(own, { dir, lang: 'es' })
  } catch (e) { die(e) }
  if (!r.handled) { console.error('uso: dotrino-remote-desktop-agent update [--name <n>] [--approval on|off] [--notify on|off]'); process.exit(2) }
  ;(r.ok ? console.log : console.error)(r.text)
  process.exit(r.ok ? 0 : 2)
}

if (cmd === 'info') {
  try {
    const dir = opt('--dir') || dataDir(opt('--name'))
    const link = loadLink(dir)
    if (!link) { console.error(`Este agente no está enlazado (${dir}). Enlázalo con: dotrino-remote-desktop-agent`); process.exit(1) }
    const info = await deviceInfo(link, { kind: LABEL, name: opt('--dir') ? null : dir.split(/[\\/]/).pop(), version: VERSION, dir })
    const pending = updateStatusText({ dir, current: VERSION, lang: 'es' })
    if (args.includes('--json')) console.log(JSON.stringify(pending ? { ...info, update: pending } : info, null, 2))
    else console.log(formatDeviceInfo(info) + (pending ? '\n' + pending : ''))
  } catch (e) { die(e) }
  process.exit(0)
}

if (cmd !== 'run' && cmd !== 'enroll') { console.error(`comando desconocido: ${cmd} (mira --help)`); process.exit(2) }

try {
  const dir = opt('--dir') || dataDir(opt('--name'))
  // Antes de nada, también de enlazar: dos procesos con el mismo enlace son la misma llave.
  process.on('exit', lockInstance(dir))
  if (cmd === 'enroll' || !loadLink(dir)) {
    if (cmd === 'enroll' && loadLink(dir)) console.log('Re-enlazando esta máquina (sobrescribe el enlace actual).\n')
    await enrollInteractive({ dir, label: LABEL })
    console.log('  Levantando el agente…\n')
  }
  const agent = await startAgent({
    dir,
    proxyUrl: opt('--proxy'),
    ...(args.includes('--no-a11y') ? { a11y: false } : {}),
    onRevoked: () => { console.log('  Esta máquina se quitó de tu bóveda. Para volver a usarla, enlázala otra vez.\n'); process.exit(0) },
    onRemote: (r) => console.log(`  máquina ${r.machineId}: tus otros aparatos ya pueden usar este escritorio.\n`)
  })
  console.log('\n  Dotrino Remote Desktop — agente activo')
  console.log('  versión:', VERSION)
  // §15: se actualiza solo (mira al arrancar y una vez al día). Solo se reinicia cuando nadie
  // está mirando el escritorio.
  const stopUpdates = startSelfUpdate({
    pkg: '@dotrino/remote-desktop-agent', repo: 'imdotrino/dotrino-remote-desktop', tag: (v) => `agent-v${v}`,
    label: LABEL, dir, version: VERSION, busy: () => agent.desktop.watching, close: () => agent.close()
  })
  // El socket del proxio va `unref`'d: sin esto el proceso saldría al arrancar como servicio.
  const keepAlive = setInterval(() => {}, 1 << 30)
  const bye = () => { clearInterval(keepAlive); stopUpdates(); agent.close().finally(() => process.exit(0)) }
  process.on('SIGINT', bye); process.on('SIGTERM', bye)
} catch (e) { die(e) }
