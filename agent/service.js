/**
 * service.js — el agente como servicio del usuario (`@dotrino/remote-agent/service`).
 *
 * En Linux va por el INICIO AUTOMÁTICO DEL ESCRITORIO (`~/.config/autostart`), no por systemd:
 * el agente necesita la sesión gráfica (DISPLAY, el bus de sesión, la accesibilidad), y una
 * unidad que arranca al encender no la tiene. Un supervisor lo vuelve a levantar si sale.
 */
import { makeService } from '@dotrino/remote-agent/service'

export const service = makeService({
  id: 'remote-desktop-agent',
  title: 'Dotrino Remote Desktop agent',
  runPrefix: 'DotrinoRemoteDesktopAgent',
  agentArgs: (name) => ['--name', name],
  linux: 'autostart'
})
