/**
 * link.js — dónde vive el enlace de esta máquina con la bóveda. Enlazar, cargar y renovar lo
 * hace `@dotrino/remote-agent/link`; la carpeta la decide el estándar
 * `@dotrino/remote-agent/instances`: `~/.dotrino/agent/remote-desktop-agent/<nombre>/`.
 */
import { loadLink as raLoad } from '@dotrino/remote-agent/link'
import { resolveInstance } from '@dotrino/remote-agent/instances'

/** El tipo de este agente: lo contesta al ping y da nombre a la carpeta de sus enlaces. */
export const LABEL = 'remote-desktop-agent'

/**
 * La carpeta del enlace. `DOTRINO_REMOTE_DESKTOP_DIR` fuerza una concreta (un contenedor); si
 * no, la de la instancia `name` (sin nombre se busca y solo se exige con empate).
 * @param {string | null} [name]
 * @returns {string}
 */
export function dataDir (name) {
  if (process.env.DOTRINO_REMOTE_DESKTOP_DIR) return process.env.DOTRINO_REMOTE_DESKTOP_DIR
  return resolveInstance(LABEL, name).dir
}

export const loadLink = (dir = dataDir()) => raLoad(dir)
