/**
 * render.js — dibuja la escena (los nodos de accesibilidad del agente) en SVG.
 *
 * No es una foto de la pantalla: es un ESQUEMA funcional. Cada nodo es una caja en su sitio con
 * su texto; el aspecto lo pone el tema del ecosistema (`--dt-*`), no la app de la máquina. Un
 * HUECO (lo que es píxeles: un lienzo, un vídeo, una app sin accesibilidad) sale rayado con su
 * nombre, para que se vea que ahí hay algo.
 *
 * Mantiene un elemento por nodo y solo toca los que cambian: un parche de un texto no repinta
 * la pantalla.
 */

/** @typedef {import('../agent/atspi.js').Node} Node */
/** @typedef {import('../agent/scene.js').Scene} Scene */

const NS = 'http://www.w3.org/2000/svg'

/** Roles que se dibujan como caja pulsable. */
const BUTTONS = new Set(['push button', 'button', 'toggle button', 'menu item', 'check menu item',
  'radio menu item', 'page tab', 'combo box', 'link', 'spin button', 'tool bar item'])
/** Roles que se dibujan como campo donde se escribe. */
const FIELDS = new Set(['entry', 'text', 'password text', 'terminal', 'document text', 'spin button'])
/** Bandas de fondo. */
const BANDS = new Set(['menu bar', 'tool bar', 'status bar', 'page tab list', 'header', 'title bar'])
/** Ventanas. */
const WINDOWS = new Set(['frame', 'window', 'dialog', 'alert', 'file chooser', 'menu', 'popup menu', 'tool tip'])
/** Contenedores que no se pintan: su contenido ya se pinta. */
const SILENT = new Set(['panel', 'filler', 'section', 'scroll pane', 'viewport', 'layered pane',
  'split pane', 'grouping', 'form', 'table', 'tree table', 'list', 'tree', 'document web',
  'document frame', 'redundant object', 'unknown', 'application', 'internal frame', 'desktop frame'])

/** @param {string} tag @param {Record<string, string | number>} [attrs] */
function make (tag, attrs = {}) {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  return e
}

/**
 * Corta un texto a lo que cabe en `w` px con letra de `fs` px (una estimación: el SVG no mide
 * texto sin pintarlo, y medir cada nodo costaría más que el resto del dibujo).
 * @param {string} s @param {number} w @param {number} fs
 */
export function fit (s, w, fs) {
  const max = Math.max(0, Math.floor(w / (fs * 0.56)))
  if (s.length <= max) return s
  return max > 1 ? s.slice(0, max - 1) + '…' : ''
}

/** El texto que enseña un nodo: el de dentro si lo tiene, si no su nombre. @param {Node} n */
export function labelOf (n) {
  return String((n.t ?? n.n) || '').replace(/\s+/g, ' ').trim()
}

/** La clase CSS de un nodo: lo que decide su aspecto. @param {Node} n */
export function kindOf (n) {
  if (n.hole) return 'hole'
  if (WINDOWS.has(n.r)) return 'win'
  if (FIELDS.has(n.r) && (n.s || '').includes('e')) return 'field'
  if (n.r === 'check box' || n.r === 'radio button') return 'check'
  if (BUTTONS.has(n.r)) return 'btn'
  if (BANDS.has(n.r)) return 'band'
  if (n.r === 'table cell' || n.r === 'list item' || n.r === 'tree item' || n.r === 'table row') return 'cell'
  if (n.r === 'heading') return 'heading'
  if (SILENT.has(n.r)) return 'silent'
  return 'text'
}

/**
 * Lo que se pinta de UN nodo, como un `<g>` nuevo.
 * @param {Node} n
 * @param {{ noView: string }} words  los textos de la interfaz que van dentro (un hueco)
 */
export function drawNode (n, words) {
  const kind = kindOf(n)
  const s = n.s || ''
  const g = make('g', { class: `n ${kind}${s.includes('f') ? ' focused' : ''}${s.includes('s') ? ' selected' : ''}${s.includes('d') ? '' : ' off'}`, 'data-id': n.id })
  if (kind === 'silent') return g
  const { x, y, w, h } = n
  if (kind !== 'text' && kind !== 'heading') {
    g.appendChild(make('rect', { x, y, width: w, height: h, rx: kind === 'win' ? 8 : kind === 'btn' || kind === 'field' ? 4 : 0 }))
  }
  if (kind === 'check') {
    const b = Math.min(h - 4, 14)
    g.appendChild(make('rect', { class: 'box', x: x + 2, y: y + (h - b) / 2, width: b, height: b, rx: n.r === 'radio button' ? b / 2 : 3 }))
    if (s.includes('c')) g.appendChild(make('rect', { class: 'mark', x: x + 5, y: y + (h - b) / 2 + 3, width: b - 6, height: b - 6, rx: n.r === 'radio button' ? b / 2 : 2 }))
  }
  let label = labelOf(n)
  if (kind === 'hole') label = label ? `${label} · ${words.noView}` : words.noView
  if (!label || h < 8) return g
  const fs = kind === 'win' ? 12 : kind === 'heading' ? Math.max(10, Math.min(18, h - 4)) : Math.max(8, Math.min(13, h - 4))
  const pad = kind === 'check' ? Math.min(h, 18) + 4 : 4
  // Un texto de varias líneas (un párrafo, un campo grande, una terminal) va en líneas.
  const multi = (s.includes('m') || n.r === 'paragraph' || n.r === 'terminal') && h > fs * 2.4 && n.t
  const t = make('text', { x: x + pad, 'font-size': fs })
  if (multi && n.t) {
    const lines = n.t.split('\n').slice(0, Math.floor((h - 4) / (fs * 1.25)))
    lines.forEach((line, i) => {
      const span = make('tspan', { x: x + pad, y: y + 2 + fs * (i + 1) * 1.15 })
      span.textContent = fit(line, w - pad * 2, fs)
      t.appendChild(span)
    })
  } else {
    // La barra de título de una ventana: arriba. El resto: centrado en vertical.
    t.setAttribute('y', String(kind === 'win' ? y + fs + 4 : y + h / 2 + fs / 3))
    t.textContent = fit(label, w - pad * 2, fs)
  }
  g.appendChild(t)
  return g
}

/**
 * La vista: un `<svg>` que se mantiene al día con la escena.
 * @param {SVGSVGElement} svg
 * @param {{ noView: string }} words
 */
export function makeView (svg, words) {
  /** @type {Map<number, { g: SVGGElement, n: Node }>} */
  const els = new Map()
  const layer = make('g', { class: 'scene' })
  // Encima de la escena: el vídeo de los huecos (video.js).
  const overlay = /** @type {SVGGElement} */ (make('g', { class: 'overlay' }))
  svg.replaceChildren(layer, overlay)
  /** @type {{ x: number, y: number, w: number, h: number } | null} lo que se está mirando */
  let focus = null
  /** @type {number | null} la única ventana que se dibuja (null = todas) */
  let only = null
  /** @type {Map<number, number>} nodo → la ventana a la que pertenece */
  let owner = new Map()
  /** Enseña solo los nodos de `only` (o todos). Con todas dibujadas, lo que está delante de la
   *  ventana elegida le pintaba encima sus botones (dueño, 2026-11-16). */
  const applyOnly = () => {
    for (const [id, e] of els) e.g.style.display = only == null || owner.get(id) === only ? '' : 'none'
  }
  let screen = { w: 1, h: 1 }

  const viewBox = () => {
    const v = focus || { x: 0, y: 0, w: screen.w, h: screen.h }
    svg.setAttribute('viewBox', `${v.x} ${v.y} ${Math.max(1, v.w)} ${Math.max(1, v.h)}`)
  }

  /**
   * Pinta la escena. Solo crea o rehace los nodos que cambiaron (`changed`); el orden se
   * rehace si cambió. Sin `changed`, todo (una escena nueva).
   * @param {Scene} scene
   * @param {Set<number> | null} [changed]
   * @param {boolean} [reordered]
   */
  function show (scene, changed = null, reordered = true) {
    screen = scene.screen
    // De qué ventana es cada nodo: se sube por los padres hasta una de la lista de ventanas.
    const wins = new Set(scene.wins.map((w) => w.id))
    const parent = new Map(scene.nodes.map((n) => [n.id, n.p]))
    owner = new Map()
    for (const n of scene.nodes) {
      let id = n.id; let hops = 0
      while (!wins.has(id) && parent.has(id) && hops++ < 80) id = /** @type {number} */ (parent.get(id))
      owner.set(n.id, wins.has(id) ? id : -1)
    }
    const alive = new Set(scene.nodes.map((n) => n.id))
    for (const [id, e] of els) if (!alive.has(id)) { e.g.remove(); els.delete(id) }
    for (const n of scene.nodes) {
      const had = els.get(n.id)
      if (had && changed && !changed.has(n.id)) continue
      const g = /** @type {SVGGElement} */ (drawNode(n, words))
      if (had) had.g.replaceWith(g)
      els.set(n.id, { g, n })
    }
    // Orden de pintado: el de la escena. `append` mueve sin recrear.
    if (reordered || !changed) for (const n of scene.nodes) layer.appendChild(/** @type {{ g: SVGGElement }} */ (els.get(n.id)).g)
    else for (const n of scene.nodes) { const e = els.get(n.id); if (e && !e.g.parentNode) layer.appendChild(e.g) }
    applyOnly()
    viewBox()
  }

  /**
   * Mirar solo una parte del escritorio (una ventana) o, con `null`, todo.
   * @param {{ x: number, y: number, w: number, h: number } | null} rect
   * @param {number | null} [win]  dibujar solo esa ventana (null = todas)
   */
  function look (rect, win = null) { focus = rect; only = win; applyOnly(); viewBox() }

  /**
   * De un punto del navegador al punto de la pantalla de la máquina.
   * @param {number} clientX @param {number} clientY
   */
  function toScreen (clientX, clientY) {
    const m = svg.getScreenCTM()
    if (!m) return null
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse())
    return { x: Math.round(p.x), y: Math.round(p.y) }
  }

  /** La ventana a la que pertenece un nodo (o -1). @param {number} id */
  const ownerOf = (id) => owner.get(id) ?? -1

  return { show, look, toScreen, ownerOf, overlay, get focus () { return focus } }
}
