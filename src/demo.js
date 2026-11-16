/**
 * demo.js — una escena de muestra, para `?demo`: la pantalla sin red, sin perfil y sin máquina.
 * Sirve para ver cómo se dibuja y para las pruebas de la interfaz. Inventada a mano: nada de lo
 * que sale aquí es de nadie.
 */

/** @typedef {import('../agent/scene.js').Scene} Scene */

/** @returns {Scene} */
export function demoScene () {
  let id = 0
  /** @type {import('../agent/atspi.js').Node[]} */
  const nodes = []
  /** @param {number} p @param {string} r @param {number[]} box @param {Partial<import('../agent/atspi.js').Node>} [o] */
  const add = (p, r, [x, y, w, h], o = {}) => { const n = { id: ++id, p, r, x, y, w, h, s: 'd', ...o }; nodes.push(n); return n.id }

  const files = add(0, 'frame', [40, 40, 760, 520], { n: 'Documentos — Archivos' })
  const bar = add(files, 'menu bar', [40, 70, 760, 26])
  ;['Archivo', 'Editar', 'Ver', 'Ayuda'].forEach((n, i) => add(bar, 'menu item', [48 + i * 70, 72, 64, 22], { n, a: ['click'] }))
  const tools = add(files, 'tool bar', [40, 98, 760, 34])
  ;['Atrás', 'Adelante', 'Inicio'].forEach((n, i) => add(tools, 'push button', [48 + i * 84, 102, 78, 26], { n, a: ['click'] }))
  add(tools, 'entry', [310, 102, 380, 26], { n: 'Ubicación', t: '/home/ana/Documentos', s: 'de' })
  const side = add(files, 'list', [40, 134, 170, 426])
  ;['Inicio', 'Documentos', 'Descargas', 'Imágenes', 'Música'].forEach((n, i) => add(side, 'list item', [44, 140 + i * 26, 162, 24], { n, s: i === 1 ? 'ds' : 'd' }))
  const table = add(files, 'table', [214, 134, 584, 400])
  ;[['Presupuesto 2026.ods', '18 KB', 'Hoja de cálculo'], ['Carta al banco.odt', '9 KB', 'Documento'], ['Recibos', '', 'Carpeta'], ['Viaje.pdf', '1,2 MB', 'PDF']].forEach((row, i) => {
    row.forEach((t, j) => add(table, 'table cell', [218 + [0, 300, 400][j], 140 + i * 28, [296, 96, 180][j], 26], { t, s: i === 0 ? 'ds' : 'd' }))
  })
  add(files, 'status bar', [40, 536, 760, 24], { n: '4 elementos' })

  const photo = add(0, 'frame', [840, 40, 520, 420], { n: 'Visor de imágenes' })
  add(photo, 'drawing area', [850, 80, 500, 330], { n: 'Atardecer.jpg', hole: 1 })
  add(photo, 'push button', [850, 420, 90, 28], { n: 'Anterior', a: ['click'] })
  add(photo, 'push button', [1260, 420, 90, 28], { n: 'Siguiente', a: ['click'] })

  const dlg = add(0, 'dialog', [420, 300, 380, 190], { n: 'Guardar cambios', s: 'da' })
  add(dlg, 'label', [440, 340, 340, 40], { t: '¿Guardar los cambios del documento antes de cerrar?' })
  add(dlg, 'check box', [440, 390, 240, 24], { n: 'No volver a preguntar' })
  add(dlg, 'push button', [560, 440, 100, 32], { n: 'Cancelar', a: ['click'] })
  add(dlg, 'push button', [680, 440, 100, 32], { n: 'Guardar', a: ['click'], s: 'df' })

  return {
    seq: 1,
    screen: { w: 1400, h: 600 },
    wins: [
      { id: files, app: 'Archivos', name: 'Documentos — Archivos', active: false },
      { id: photo, app: 'Visor', name: 'Visor de imágenes', active: false },
      { id: dlg, app: 'Editor', name: 'Guardar cambios', active: true }
    ],
    nodes
  }
}
