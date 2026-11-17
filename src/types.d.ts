import type { Scene, Patch } from '../agent/scene.js'

/** Un error con `code` (del agente o del transporte): se decide por el código, no por la frase. */
export interface AgentError { code?: string, message?: string, reason?: string }

/** El enlace de este aparato con la bóveda (vault.js), tal como lo espera `RemoteAgentClient`. */
export type DesktopLink = { paired: true, id: import('@dotrino/identity').Identity, cert: object, iss: string, proxy?: string, mode?: string }

/** Un rectángulo del escritorio, en píxeles de la pantalla de la máquina. */
export interface Rect { x: number, y: number, w: number, h: number }

/** Lo que manda el agente (agent/index.js). */
export type AgentMessage =
  | ({ type: 'scene' } & Scene)
  | ({ type: 'patch' } & Patch)
  | { type: 'vframe', id: number, seq: number, key: boolean, rect: Rect, q?: 'direct' | 'relay', data: string }
  | { type: 'vwait', id: number, route: string }
  | { type: 'fail', code: string, message: string, retryMs?: number }
  | { type: 'unlocked' }
