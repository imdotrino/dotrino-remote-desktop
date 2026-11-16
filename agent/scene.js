/**
 * scene.js — la ESCENA: qué hay en pantalla, como nodos, y qué cambió desde la última vez.
 *
 * Sin dependencias ni red (funciones puras): la misma lógica de diferencias la usa el cliente
 * para aplicar lo que llega (`applyPatch`), y se prueba sin escritorio.
 *
 * El cable:
 *   agente → cliente
 *     { type:'scene', seq, screen:{w,h}, wins:[{id,app,name,active}], nodes:[Node…] }   entera
 *     { type:'patch', seq, base, screen?, wins?, order?, put:[Node…], del:[id…] }      lo que cambió
 *   `base` es el `seq` sobre el que se aplica: si el cliente no lo tiene, pide la escena
 *   entera (`{ type:'scene' }`) en vez de pintar algo a medias.
 *   `order` (la lista de ids en orden de pintado) solo viaja si cambió el orden: lo normal
 *   es que cambie un texto o una posición, y eso no lo toca.
 */

/** @typedef {import('./atspi.js').Node} Node */
/** @typedef {{ id: number, app: string, name: string, active: boolean }} Win */
/** @typedef {{ seq: number, screen: { w: number, h: number }, wins: Win[], nodes: Node[] }} Scene */
/**
 * @typedef {{ seq: number, base: number, screen?: { w: number, h: number }, wins?: Win[],
 *   order?: number[], put: Node[], del: number[] }} Patch
 */

/** Dos nodos iguales, campo a campo (los que viajan). @param {Node} a @param {Node} b */
export function sameNode (a, b) {
  if (a.p !== b.p || a.r !== b.r || a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h) return false
  if (a.n !== b.n || a.t !== b.t || a.s !== b.s || a.hole !== b.hole) return false
  const aa = a.a || []; const ba = b.a || []
  return aa.length === ba.length && aa.every((v, i) => v === ba[i])
}

/** @param {{ w: number, h: number }} a @param {{ w: number, h: number }} b */
const sameScreen = (a, b) => a.w === b.w && a.h === b.h
/** @param {Win[]} a @param {Win[]} b */
const sameWins = (a, b) => a.length === b.length && a.every((w, i) => w.id === b[i].id && w.app === b[i].app && w.name === b[i].name && w.active === b[i].active)

/**
 * Lo que cambió de `prev` a `next`. `null` si no cambió nada (no se manda nada: una pantalla
 * quieta no gasta red).
 * @param {Scene} prev @param {Scene} next
 * @returns {Patch | null}
 */
export function diff (prev, next) {
  /** @type {Map<number, Node>} */
  const before = new Map(prev.nodes.map((n) => [n.id, n]))
  /** @type {Node[]} */
  const put = []
  const nextIds = new Set()
  for (const n of next.nodes) {
    nextIds.add(n.id)
    const o = before.get(n.id)
    if (!o || !sameNode(o, n)) put.push(n)
  }
  /** @type {number[]} */
  const del = []
  for (const id of before.keys()) if (!nextIds.has(id)) del.push(id)
  // El orden cambió si, quitando los borrados y los nuevos, los que siguen no van igual.
  const kept = prev.nodes.filter((n) => nextIds.has(n.id)).map((n) => n.id)
  const keptNext = next.nodes.filter((n) => before.has(n.id)).map((n) => n.id)
  const added = next.nodes.some((n) => !before.has(n.id))
  const reordered = added || kept.length !== keptNext.length || kept.some((id, i) => id !== keptNext[i])
  const screenChanged = !sameScreen(prev.screen, next.screen)
  const winsChanged = !sameWins(prev.wins, next.wins)
  if (!put.length && !del.length && !reordered && !screenChanged && !winsChanged) return null
  /** @type {Patch} */
  const patch = { seq: next.seq, base: prev.seq, put, del }
  if (reordered) patch.order = next.nodes.map((n) => n.id)
  if (screenChanged) patch.screen = next.screen
  if (winsChanged) patch.wins = next.wins
  return patch
}

/**
 * Aplica un parche a una escena. Lanza `stale` si el parche no es para esta escena: pintarlo
 * dejaría la pantalla a medias sin que nadie se entere. Quien lo recibe pide la entera.
 * @param {Scene} scene @param {Patch} patch
 * @returns {Scene}
 */
export function applyPatch (scene, patch) {
  if (patch.base !== scene.seq) throw Object.assign(new Error(`patch for ${patch.base}, scene is ${scene.seq}`), { code: 'stale' })
  /** @type {Map<number, Node>} */
  const byId = new Map(scene.nodes.map((n) => [n.id, n]))
  for (const id of patch.del) byId.delete(id)
  for (const n of patch.put) byId.set(n.id, n)
  /** @type {Node[]} */
  let nodes
  if (patch.order) {
    nodes = []
    for (const id of patch.order) {
      const n = byId.get(id)
      if (!n) throw Object.assign(new Error(`order names node ${id}, which the patch does not carry`), { code: 'bad-patch' })
      nodes.push(n)
    }
  } else {
    nodes = scene.nodes.filter((n) => byId.has(n.id)).map((n) => /** @type {Node} */ (byId.get(n.id)))
  }
  return { seq: patch.seq, screen: patch.screen || scene.screen, wins: patch.wins || scene.wins, nodes }
}

/**
 * El tamaño del escritorio: lo que abarcan las ventanas. AT-SPI no da el tamaño de la
 * pantalla; el fondo de escritorio (una ventana a pantalla completa) suele darlo de hecho.
 * @param {Array<{ ext: number[] }>} wins
 */
export function screenOf (wins) {
  let w = 0; let h = 0
  for (const { ext } of wins) { w = Math.max(w, ext[0] + ext[2]); h = Math.max(h, ext[1] + ext[3]) }
  return { w, h }
}

/**
 * El nodo que hay bajo un punto: el último en orden de pintado que lo contiene (el de más
 * arriba). Lo usa el cliente para decidir a qué se le hizo clic.
 * @param {Node[]} nodes @param {number} x @param {number} y
 * @returns {Node | null}
 */
export function hit (nodes, x, y) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    if (x >= n.x && y >= n.y && x < n.x + n.w && y < n.y + n.h) return n
  }
  return null
}

