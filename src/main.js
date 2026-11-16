/**
 * main.js — Dotrino Remote Desktop (remote-desktop.dotrino.com).
 *
 * Dos rutas (§5.1: una pantalla es informativa o administrativa, nunca las dos):
 *  · `/`          la portada: qué es y cómo empezar. No toca la bóveda.
 *  · `/desktops`  tus escritorios: tus máquinas y la que estás usando.
 *
 * El escritorio llega del agente como nodos de accesibilidad (agent/index.js) y se dibuja en
 * SVG (render.js). Lo que se toca aquí vuelve al agente como ratón y teclado de verdad.
 */
import '@dotrino/theme/theme.css'
import './style.css'
import '@dotrino/topbar'
import '@dotrino/install'
import { createVaultReputation } from '@dotrino/reputation'
import { Store } from '@dotrino/store'
import { RemoteAgentClient } from '@dotrino/remote-agent/client'
import { listAgentsByLabel, probeAgents } from '@dotrino/remote-agent/discover'
import { keyLabel } from '@dotrino/identity/capabilities'
import { applyPatch } from '../agent/scene.js'
import { makeView } from './render.js'
import { demoScene } from './demo.js'
import { identity, getLink } from './vault.js'

/** @typedef {import('../agent/scene.js').Scene} Scene */
/** @typedef {import('./types').AgentError} AgentError */
/** @typedef {import('./types').DesktopLink} DesktopLink */
/** @typedef {import('./types').Rect} Rect */
/** @typedef {import('./types').AgentMessage} AgentMessage */

/** Lo que contesta el agente cuando se le pregunta qué es (agent/link.js). */
const AGENT_KIND = 'remote-desktop-agent'

// ---------- i18n (§9) ----------
/** @typedef {string | ((...a: (string | number)[]) => string)} Msg */
/** @type {Record<'es' | 'en', Record<string, Msg>>} */
const M = {
  es: {
    home_title: 'Tu escritorio, desde cualquier aparato',
    home_lead: 'Usa las ventanas de tu computadora desde el navegador de tu teléfono u otro aparato tuyo. Se ve nítido y gasta muy pocos datos.',
    home_open: 'Abrir mis escritorios',
    home_how: 'Cómo ponerlo en marcha',
    home_demo: 'Ver un ejemplo',
    home_p1: 'Nítido y ligero',
    home_p1_d: 'No se envía una foto de la pantalla: se envía lo que hay en ella, botones y textos, y tu aparato lo dibuja. El texto se lee perfecto y funciona con una conexión lenta.',
    home_p2: 'Solo entran tus aparatos',
    home_p2_d: 'Solo puede entrar un aparato que tú enlazaste, y lo que ves y tocas viaja cifrado de punta a punta.',
    home_p3: 'Para lo que es imagen, un aviso',
    home_p3_d: 'Una foto, un video o un juego se marcan en su sitio. Poder verlos llegará más adelante.',
    no_link: 'Este aparato todavía no está enlazado a tu bóveda.',
    link_here: 'Enlázalo en',
    recheck: 'Ya lo enlacé',
    machines_title: 'Tus escritorios',
    machines_none: 'Ninguna de tus máquinas tiene el escritorio remoto encendido.',
    machines_err: 'No se pudo consultar tu bóveda (¿está encendida?).',
    machine_online: 'En línea',
    machine_offline: 'Desconectada',
    connecting: (n) => `Conectando con ${n}…`,
    conn_fail: (n) => `No se pudo conectar con ${n}.`,
    all_screen: 'Todo el escritorio',
    active_win: 'Ventana activa',
    view: 'Ver',
    zoom_in: 'Acercar',
    zoom_out: 'Alejar',
    hscroll: 'Desplazar a los lados',
    keyboard: 'Teclado',
    no_view: 'sin vista',
    disconnect: 'Desconectar',
    demo_note: 'Ejemplo: no está conectado a ninguna máquina.',
    err_unauthorized: (r) => `No autorizado: ${r}`,
    err_blocked: 'Un aprobador bloqueó este aparato; se desbloquea en la bóveda.',
    err_no_desktop: 'Esa máquina no tiene una sesión de escritorio abierta.',
    err_no_a11y: 'Esa máquina no tiene el servicio de accesibilidad del escritorio (at-spi2-core).',
    err_no_raise: 'Esa máquina no deja traer ventanas al frente desde aquí: la ves, pero puede estar tapada por otra.',
    err_window_gone: 'Esa ventana ya no está abierta.',
    error: 'Error: '
  },
  en: {
    home_title: 'Your desktop, from any device',
    home_lead: 'Use your computer’s windows from the browser on your phone or another device of yours. Sharp, and it uses very little data.',
    home_open: 'Open my desktops',
    home_how: 'How to set it up',
    home_demo: 'See an example',
    home_p1: 'Sharp and light',
    home_p1_d: 'It doesn’t send a picture of the screen: it sends what is on it, buttons and text, and your device draws it. Text reads perfectly and it works on a slow connection.',
    home_p2: 'Only your devices get in',
    home_p2_d: 'Only a device you linked can get in, and what you see and touch is encrypted end to end.',
    home_p3: 'Pictures are marked',
    home_p3_d: 'A photo, a video or a game is marked in its place. Seeing them will come later.',
    no_link: 'This device is not linked to your vault yet.',
    link_here: 'Link it at',
    recheck: 'I linked it',
    machines_title: 'Your desktops',
    machines_none: 'None of your machines has the remote desktop running.',
    machines_err: 'Could not reach your vault (is it on?).',
    machine_online: 'Online',
    machine_offline: 'Offline',
    connecting: (n) => `Connecting to ${n}…`,
    conn_fail: (n) => `Could not connect to ${n}.`,
    all_screen: 'Whole desktop',
    active_win: 'Active window',
    view: 'View',
    zoom_in: 'Zoom in',
    zoom_out: 'Zoom out',
    hscroll: 'Scroll sideways',
    keyboard: 'Keyboard',
    no_view: 'no view',
    disconnect: 'Disconnect',
    demo_note: 'Example: not connected to any machine.',
    err_unauthorized: (r) => `Not authorized: ${r}`,
    err_blocked: 'An approver blocked this device; unblock it in the vault.',
    err_no_desktop: 'That machine has no desktop session open.',
    err_no_a11y: 'That machine has no desktop accessibility service (at-spi2-core).',
    err_no_raise: 'That machine does not let windows be brought to the front from here: you see it, but another may cover it.',
    err_window_gone: 'That window is no longer open.',
    error: 'Error: '
  }
}

/** @param {string} what @returns {never} */
function missing (what) { throw new Error(`index.html has no ${what}`) }
const topbar = /** @type {import('@dotrino/topbar').DotrinoTopbar} */ (document.getElementById('topbar') ?? missing('#topbar'))
const app = document.getElementById('app') ?? missing('#app')

/** @type {'es' | 'en'} */
let lang = 'es'
try { lang = (localStorage.getItem('dotrino.lang') || (navigator.language || 'es').slice(0, 2)) === 'en' ? 'en' : 'es' } catch {}
/** @param {string} k @param {...(string | number)} a @returns {string} */
const t = (k, ...a) => { const v = M[lang][k]; return typeof v === 'function' ? v(...a) : v }
topbar.addEventListener('dotrino-lang', (/** @type {CustomEvent} */ e) => { lang = e.detail.lang; render() })

/** @type {Record<string, string>} */
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
/** @param {unknown} s */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c])
/** @param {string} html @returns {HTMLElement} */
function el (html) {
  const tpl = document.createElement('template'); tpl.innerHTML = html.trim()
  const node = tpl.content.firstElementChild
  if (!(node instanceof HTMLElement)) throw new Error('el: the html has no element')
  return node
}
/** @template {Element} T @param {ParentNode} root @param {string} sel @returns {T} */
function $ (root, sel) {
  const found = root.querySelector(sel)
  if (!found) throw new Error(`missing ${sel}`)
  return /** @type {T} */ (found)
}

/** Un error del agente, en palabras de la persona: por su `code`. @param {unknown} err */
function errorText (err) {
  const e = /** @type {AgentError | null | undefined} */ (err)
  if (e?.code === 'unauthorized') return t('err_unauthorized', e.reason || '?')
  if (e?.code === 'blocked') return t('err_blocked')
  if (e?.code === 'no-session-bus') return t('err_no_desktop')
  if (e?.code === 'no-a11y-bus') return t('err_no_a11y')
  if (e?.code === 'no-raise') return t('err_no_raise')
  if (e?.code === 'window-not-found') return t('err_window_gone')
  return t('error') + (e?.message || String(e))
}

// ---------- perfil y almacén (§6.1, §4) ----------
;(async () => {
  try {
    const id = await identity()
    topbar.identity = id
    try { topbar.reputation = createVaultReputation(id) } catch {}
    topbar.store = await Store.connect({ identity: id })
  } catch {}
})()

const onDesktops = /\/desktops\/?$/.test(location.pathname)
if (!onDesktops) topbar.setAttribute('no-back', '')
const WIKI = () => `https://wiki.dotrino.com${lang === 'en' ? '/en' : ''}/herramientas/escritorio-remoto/`

function homeScreen () {
  const points = [1, 2, 3].map((i) => `<div class="point"><b>${t('home_p' + i)}</b><span>${t('home_p' + i + '_d')}</span></div>`).join('')
  return el(`<section class="home" data-testid="home">
    <h1>${t('home_title')}</h1>
    <p class="lead">${t('home_lead')}</p>
    <div class="home-cta">
      <a class="btn primary" href="/desktops" data-testid="home-open">${t('home_open')}</a>
      <a class="btn" href="/desktops?demo" data-testid="home-demo">${t('home_demo')}</a>
    </div>
    <p class="home-how"><a href="${WIKI()}" target="_blank" rel="noopener" data-testid="home-how">${t('home_how')}</a></p>
    <div class="home-points">${points}</div>
  </section>`)
}

/** @type {(() => void) | null} lo que hay que cerrar al cambiar de pantalla */
let teardown = null

async function render () {
  teardown?.(); teardown = null
  if (!onDesktops) { app.replaceChildren(homeScreen()); return }
  if (new URLSearchParams(location.search).has('demo')) { app.replaceChildren(desktopScreen(null, 'demo')); return }
  const link = await getLink().catch(() => ({ paired: false }))
  if (!link.paired) {
    const node = el(`<section class="card"><p>${t('no_link')} ${t('link_here')} <a href="https://profile.dotrino.com/vault" target="_blank" rel="noopener">profile.dotrino.com</a></p>
      <button class="btn primary" data-testid="recheck">${t('recheck')}</button></section>`)
    $(node, 'button').addEventListener('click', () => render())
    app.replaceChildren(node)
    return
  }
  app.replaceChildren(machinesScreen(/** @type {DesktopLink} */ (link)))
}

/**
 * La lista de máquinas con el agente de escritorio encendido (se les pregunta qué son).
 * @param {DesktopLink} link
 */
function machinesScreen (link) {
  const node = el(`<section class="machines" data-testid="machines"><span class="mlabel">${t('machines_title')}</span><div class="machine-list"></div><p class="status" data-testid="machines-status"></p></section>`)
  const list = $(node, '.machine-list')
  const status = $(node, '.status')
  /** @type {import('@dotrino/proxy-client').WebSocketProxyClient | null} */
  let probe = null
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null
  teardown = () => { if (timer) clearInterval(timer); try { probe?.close() } catch {} }
  ;(async () => {
    /** @type {{ sub: string, label?: string }[]} */
    let members
    try {
      const { WebSocketProxyClient } = await import('@dotrino/proxy-client')
      members = await listAgentsByLabel(link.id)
      probe = new WebSocketProxyClient({ url: link.proxy || 'wss://proxy.dotrino.com', enableWebRTC: false, autoReconnect: true })
      await probe.connect()
    } catch { status.textContent = t('machines_err'); return }
    /** @type {Map<string, HTMLElement>} */
    const seen = new Map()
    const update = async () => {
      const found = await probeAgents(probe, members.map((m) => m.sub))
      for (const m of members) {
        if (found.get(m.sub)?.kind !== AGENT_KIND || seen.has(m.sub)) continue
        const deviceId = await keyLabel(m.sub)
        const name = m.label || deviceId
        const row = el(`<button class="machine" data-testid="machine-item" data-sub="${esc(m.sub)}"><span class="mdot"></span>${esc(name)} <small>${esc(deviceId)}</small></button>`)
        row.addEventListener('click', () => { teardown?.(); teardown = null; app.replaceChildren(desktopScreen(link, m.sub, name)) })
        list.appendChild(row)
        seen.set(m.sub, row)
      }
      for (const [sub, row] of seen) {
        const on = found.has(sub)
        const dot = /** @type {HTMLElement} */ ($(row, '.mdot'))
        dot.className = 'mdot ' + (on ? 'on' : 'off')
        dot.title = on ? t('machine_online') : t('machine_offline')
      }
      status.textContent = seen.size ? '' : t('machines_none')
    }
    await update().catch(() => { status.textContent = t('machines_err') })
    timer = setInterval(() => { update().catch(() => {}) }, 30_000)
  })()
  return node
}

/** Teclas que no son texto, por su keysym de X (lo que entiende el agente). */
/** @type {Record<string, number>} */
const KEYSYMS = {
  Enter: 0xff0d, Backspace: 0xff08, Tab: 0xff09, Escape: 0xff1b, Delete: 0xffff,
  ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
  Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56,
  F1: 0xffbe, F2: 0xffbf, F3: 0xffc0, F4: 0xffc1, F5: 0xffc2, F10: 0xffc7, F11: 0xffc8
}

/**
 * La pantalla de UN escritorio. `sub === 'demo'` enseña la escena de muestra, sin red.
 * @param {DesktopLink | null} link @param {string} sub @param {string} [name]
 */
function desktopScreen (link, sub, name = '') {
  const demo = sub === 'demo'
  const node = el(`<section class="desktop" data-testid="desktop">
    <div class="dbar">
      <label class="pick"><span>${t('view')}</span><select data-testid="view-picker"></select></label>
      <span class="zoom"><button class="btn" data-testid="zoom-out" aria-label="${t('zoom_out')}">−</button><span data-testid="zoom-level">1×</span><button class="btn" data-testid="zoom-in" aria-label="${t('zoom_in')}">+</button></span>
      <button class="btn" data-testid="keyboard">${t('keyboard')}</button>
      ${demo ? '' : `<button class="btn" data-testid="disconnect">${t('disconnect')}</button>`}
    </div>
    <p class="status" data-testid="desktop-status">${demo ? t('demo_note') : t('connecting', esc(name))}</p>
    <div class="stage"><svg class="screen" data-testid="screen" preserveAspectRatio="xMidYMin meet"></svg></div>
    <input class="hscroll" type="range" min="0" max="1000" value="0" data-testid="hscroll" aria-label="${t('hscroll')}" hidden>
    <textarea class="keys" data-testid="keys" autocapitalize="off" autocomplete="off" spellcheck="false" aria-label="${t('keyboard')}"></textarea>
  </section>`)
  const svg = /** @type {SVGSVGElement} */ ($(node, 'svg'))
  const status = $(node, '.status')
  const keys = /** @type {HTMLTextAreaElement} */ ($(node, '.keys'))
  const view = makeView(svg, { noView: t('no_view') })
  /** @type {Scene | null} */
  let scene = null
  /** @type {RemoteAgentClient | null} */
  let rc = null
  /** @param {object} msg */
  const send = (msg) => { if (rc) rc.send(msg).catch((/** @type {unknown} */ e) => { status.textContent = errorText(e) }) }

  /**
   * QUÉ SE MIRA: la ventana activa (por defecto), todo el escritorio, o una ventana elegida.
   * Se guarda la ventana y no su rectángulo: si se mueve o cambia de tamaño, la vista la sigue.
   * Con dos monitores el escritorio mide 3840 px; encajado entero en una tableta, todo salía
   * diminuto (dueño, 2026-11-16). Por eso se empieza por la ventana activa.
   * @type {'active' | 'all' | number}
   */
  let watch = 'active'

  /** El rectángulo de una ventana de la escena, o null si ya no está. @param {number | undefined} id */
  const rectOf = (id) => {
    const n = scene && id != null ? scene.nodes.find((x) => x.id === id) : null
    return n ? { x: n.x, y: n.y, w: n.w, h: n.h } : null
  }
  /** La ventana que se mira ahora (o null = todo el escritorio). */
  const targetId = () => {
    if (!scene || watch === 'all') return null
    if (watch === 'active') return scene.wins.find((w) => w.active)?.id ?? null
    return watch
  }
  let lastLook = ''
  const follow = () => {
    const id = targetId()
    const r = rectOf(id ?? undefined)
    const key = JSON.stringify([r, id])
    if (key !== lastLook) { lastLook = key; view.look(r, r ? id : null) }
  }

  /**
   * QUÉ VER, en UN desplegable: la ventana activa, todo el escritorio o una ventana. Antes eran
   * botones, uno por ventana, y con 26 ventanas abiertas la fila no se entendía (dueño, 2026-11-16).
   */
  const picker = /** @type {HTMLSelectElement} */ ($(node, '[data-testid=view-picker]'))
  picker.addEventListener('change', () => {
    const v = picker.value
    watch = v === 'active' || v === 'all' ? v : Number(v)
    follow()
    // Elegir una ventana es querer trabajar en ella: se trae al frente, con el foco, en la máquina.
    if (typeof watch === 'number') send({ type: 'raise', id: watch })
  })
  function showWins () {
    if (!scene) return
    /** @param {string} value @param {string} label */
    const opt = (value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; return o }
    const opts = [opt('active', t('active_win')), opt('all', t('all_screen'))]
    for (const w of scene.wins) if (w.name && rectOf(w.id)) opts.push(opt(String(w.id), w.name))
    picker.replaceChildren(...opts)
    picker.value = String(watch)
  }

  // ZOOM: el SVG se hace más ancho que la pantalla y el escenario se desplaza con el dedo
  // (scroll nativo). Sin trucos de gestos: el navegador ya sabe desplazar.
  const ZOOMS = [1, 1.5, 2, 3, 4]
  let zoom = 0
  // LA BARRA DE ABAJO, GRUESA (dueño, 2026-11-16): un control propio y no la barra del navegador,
  // que en las tabletas se esconde y no se puede engrosar. Sale solo si hay qué desplazar.
  const stage = $(node, '.stage')
  const hscroll = /** @type {HTMLInputElement} */ ($(node, '.hscroll'))
  const syncBar = () => {
    const room = stage.scrollWidth - stage.clientWidth
    hscroll.hidden = room <= 1
    if (room > 1) hscroll.value = String(Math.round(stage.scrollLeft / room * 1000))
  }
  hscroll.addEventListener('input', () => { stage.scrollLeft = Number(hscroll.value) / 1000 * (stage.scrollWidth - stage.clientWidth) })
  stage.addEventListener('scroll', syncBar, { passive: true })
  new ResizeObserver(syncBar).observe(stage)
  const applyZoom = () => { svg.style.width = `${ZOOMS[zoom] * 100}%`; $(node, '[data-testid=zoom-level]').textContent = `${ZOOMS[zoom]}×`; requestAnimationFrame(syncBar) }
  $(node, '[data-testid=zoom-in]').addEventListener('click', () => { zoom = Math.min(ZOOMS.length - 1, zoom + 1); applyZoom() })
  $(node, '[data-testid=zoom-out]').addEventListener('click', () => { zoom = Math.max(0, zoom - 1); applyZoom() })

  /** @param {Scene} s @param {Set<number> | null} [changed] @param {boolean} [reordered] */
  function paint (s, changed = null, reordered = true) {
    const winsBefore = scene ? JSON.stringify(scene.wins) : ''
    scene = s
    view.show(s, changed, reordered)
    // Una ventana elegida que se cerró: se vuelve a la activa.
    if (typeof watch === 'number' && !rectOf(watch)) watch = 'active'
    follow()
    if (JSON.stringify(s.wins) !== winsBefore) showWins()
  }

  // ---------- entrada: el puntero y el teclado vuelven al agente ----------
  /** @type {{ x: number, y: number, at: number } | null} */
  let down = null
  svg.addEventListener('pointerdown', (e) => {
    const p = view.toScreen(e.clientX, e.clientY)
    if (!p) return
    down = { ...p, at: Date.now() }
    if (e.button === 0 && e.pointerType === 'mouse') send({ type: 'press', ...p, button: 1 })
  })
  svg.addEventListener('pointerup', (e) => {
    const p = view.toScreen(e.clientX, e.clientY)
    if (!p || !down) return
    const moved = Math.abs(p.x - down.x) + Math.abs(p.y - down.y) > 6
    if (e.pointerType === 'mouse') { if (e.button === 0) send({ type: 'release', ...p, button: 1 }) }
    // Táctil: un toque es un clic donde se tocó; arrastrar no hace nada (se desplaza la vista).
    else if (!moved) send({ type: 'click', ...p, button: 1 })
    down = null
    keys.focus({ preventScroll: true })
  })
  // Sin `dblclick` propio: dos pulsaciones seguidas ya son un doble clic para la máquina.
  svg.addEventListener('contextmenu', (e) => { e.preventDefault(); const p = view.toScreen(e.clientX, e.clientY); if (p) send({ type: 'click', ...p, button: 3 }) })
  svg.addEventListener('wheel', (e) => {
    if (!e.deltaY) return
    e.preventDefault()
    const p = view.toScreen(e.clientX, e.clientY)
    if (p) send({ type: 'wheel', ...p, dy: Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 60)) })
  }, { passive: false })
  // Teclado: lo que es texto se escribe tal cual (también el del teclado del teléfono, que no
  // manda teclas sino texto); lo demás va por su keysym.
  keys.addEventListener('keydown', (e) => {
    const sym = KEYSYMS[e.key]
    if (sym && !e.isComposing) { e.preventDefault(); send({ type: 'key', keysym: sym }) }
  })
  keys.addEventListener('input', () => {
    if (keys.value) { send({ type: 'text', text: keys.value }); keys.value = '' }
  })
  $(node, '[data-testid=keyboard]').addEventListener('click', () => keys.focus())

  // ---------- conexión ----------
  if (demo) {
    paint(demoScene())
    return node
  }
  let closed = false
  teardown = () => { closed = true; rc?.close().catch(() => {}) }
  node.querySelector('[data-testid=disconnect]')?.addEventListener('click', () => { teardown?.(); teardown = null; render() })
  ;(async () => {
    try {
      if (!link) throw Object.assign(new Error('no link to the vault'), { code: 'not-linked' })
      rc = new RemoteAgentClient(link, { agentPubkey: sub })
      rc.on('message', (/** @type {AgentMessage | null} */ p) => {
        if (!p || typeof p !== 'object') return
        if (p.type === 'scene') { status.textContent = ''; paint(p); return }
        if (p.type === 'patch') {
          if (!scene) return
          try {
            const next = applyPatch(scene, p)
            paint(next, new Set(p.put.map((/** @type {{ id: number }} */ n) => n.id)), !!p.order)
          } catch {
            // Un parche que no casa (se perdió uno): se pide la escena entera, no se pinta a medias.
            send({ type: 'scene' })
          }
          return
        }
        if (p.type === 'fail') status.textContent = errorText(p)
      })
      rc.on('error', (/** @type {unknown} */ e) => { status.textContent = errorText(e) })
      // La máquina se reinició y la sesión se rehízo sola: se vuelve a pedir la escena.
      rc.on('resumed', () => send({ type: 'scene' }))
      await rc.connect()
      if (closed) { rc.close().catch(() => {}); return }
      send({ type: 'scene' })
    } catch (e) {
      status.textContent = `${t('conn_fail', name)} ${errorText(e)}`
    }
  })()
  return node
}

document.documentElement.lang = lang
render()

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
      setInterval(() => reg.update(), 30 * 60 * 1000)
    }).catch(() => {})
  })
}
