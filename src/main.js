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
import { makeVideoLayer, canDecode } from './video.js'
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
    reconnecting: (n) => `No llega nada de ${n}: conectando otra vez…`,
    all_screen: 'Todo el escritorio',
    active_win: 'Ventana activa',
    active_short: 'Activa',
    screen: 'Pantalla',
    screen_n: (n) => `Pantalla ${n}`,
    all_short: 'Todo',
    taskbar: 'Ventanas abiertas',
    taskbar_opts: 'Cómo se ve la barra',
    keybar: 'Teclas especiales',
    tb_both: 'Icono y nombre',
    tb_icon: 'Solo icono',
    tb_label: 'Solo nombre',
    hscroll: 'Desplazar a los lados',
    touch_mode: 'Cómo responde el toque',
    mode_pan: 'Mover',
    mode_mouse: 'Ratón',
    keyboard: 'Teclado',
    no_view: 'sin vista',
    disconnect: 'Desconectar',
    demo_note: 'Ejemplo: no está conectado a ninguna máquina.',
    err_unauthorized: (r) => `No autorizado: ${r}`,
    err_blocked: 'Un aprobador bloqueó este aparato; se desbloquea en la bóveda.',
    err_missing_cap: (c) => `Este aparato no tiene el permiso «${c}». Dáselo en tu bóveda: dotrino-vault caps <ID> +${c}`,
    code_needed: (n) => `${n} pide su clave.`,
    code_label: 'Clave de la máquina',
    code_send: 'Entrar',
    code_bad: 'Clave incorrecta.',
    code_wait: (s) => `Demasiados intentos: espera ${s} s.`,
    err_no_desktop: 'Esa máquina no tiene una sesión de escritorio abierta.',
    err_no_a11y: 'Esa máquina no tiene el servicio de accesibilidad del escritorio (at-spi2-core).',
    err_no_raise: 'Esa máquina no deja traer ventanas al frente desde aquí: la ves, pero puede estar tapada por otra.',
    err_window_gone: 'Esa ventana ya no está abierta.',
    err_no_video: 'Esa máquina no puede enviar la imagen de esta ventana (le falta ffmpeg, o usa Wayland).',
    err_old_agent: 'Esa máquina tiene una versión anterior del escritorio remoto: actualízala para ver la imagen de las ventanas, sus iconos y traerlas al frente.',
    video_wait: 'La imagen de esta ventana solo viaja por conexión directa entre tus aparatos. Esperando a que se abra…',
    video_loading: 'Cargando imagen…',
    video_low: 'Imagen reducida: tus aparatos no están conectados directamente, y así gasta menos.',
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
    reconnecting: (n) => `Nothing is arriving from ${n}: connecting again…`,
    all_screen: 'Whole desktop',
    active_win: 'Active window',
    active_short: 'Active',
    screen: 'Screen',
    screen_n: (n) => `Screen ${n}`,
    all_short: 'All',
    taskbar: 'Open windows',
    taskbar_opts: 'How the bar looks',
    keybar: 'Special keys',
    tb_both: 'Icon and name',
    tb_icon: 'Icon only',
    tb_label: 'Name only',
    hscroll: 'Scroll sideways',
    touch_mode: 'How touch behaves',
    mode_pan: 'Pan',
    mode_mouse: 'Mouse',
    keyboard: 'Keyboard',
    no_view: 'no view',
    disconnect: 'Disconnect',
    demo_note: 'Example: not connected to any machine.',
    err_unauthorized: (r) => `Not authorized: ${r}`,
    err_blocked: 'An approver blocked this device; unblock it in the vault.',
    err_missing_cap: (c) => `This device lacks the «${c}» permission. Grant it in your vault: dotrino-vault caps <ID> +${c}`,
    code_needed: (n) => `${n} asks for its code.`,
    code_label: 'Machine code',
    code_send: 'Enter',
    code_bad: 'Wrong code.',
    code_wait: (s) => `Too many tries: wait ${s} s.`,
    err_no_desktop: 'That machine has no desktop session open.',
    err_no_a11y: 'That machine has no desktop accessibility service (at-spi2-core).',
    err_no_raise: 'That machine does not let windows be brought to the front from here: you see it, but another may cover it.',
    err_window_gone: 'That window is no longer open.',
    err_no_video: 'That machine cannot send the picture of this window (it lacks ffmpeg, or uses Wayland).',
    err_old_agent: 'That machine runs an older version of the remote desktop: update it to see the picture of windows, their icons, and bring them to the front.',
    video_wait: 'The picture of this window only travels over a direct connection between your devices. Waiting for it to open…',
    video_loading: 'Loading picture…',
    video_low: 'Reduced picture: your devices are not connected directly, so it uses less data.',
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
  // Le falta el permiso del producto (`desktop`): se dice cuál y cómo se da.
  if (e?.code === 'unauthorized' && e.reason === 'missing-cap') return t('err_missing_cap', 'desktop')
  if (e?.code === 'unauthorized') return t('err_unauthorized', e.reason || '?')
  if (e?.code === 'bad-code') return t('code_bad')
  if (e?.code === 'wait') return t('code_wait', Math.ceil((Number(/** @type {{ retryMs?: number }} */ (e).retryMs) || 0) / 1000))
  if (e?.code === 'blocked') return t('err_blocked')
  if (e?.code === 'no-session-bus') return t('err_no_desktop')
  if (e?.code === 'no-a11y-bus') return t('err_no_a11y')
  if (e?.code === 'no-raise') return t('err_no_raise')
  if (e?.code === 'no-video') return t('err_no_video')
  // Un agente de antes no conoce lo nuevo (el vídeo, traer al frente): §14, la incompatibilidad
  // se dice con palabras, no como el error crudo del agente.
  if (e?.code === 'unknown-type') return t('err_old_agent')
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
 * LA BARRA DE TECLAS sobre el teclado: las mismas teclas y en el mismo orden que la de Terminal
 * (dueño, 2026-11-17). Shift, Ctrl y Alt se quedan encendidas hasta que la siguiente tecla las usa.
 */
const KEYBAR = ['esc', 'tab', 'shift', 'ctrl', 'alt', 'up', 'down', 'left', 'right', 'home', 'end', 'pgup', 'pgdn', '-', '/', '|', '~']
const MODS = ['shift', 'ctrl', 'alt']
/** @type {Record<string, string>} */
const KEY_LABELS = { esc: 'Esc', tab: 'Tab', shift: 'Shift', ctrl: 'Ctrl', alt: 'Alt', up: '↑', down: '↓', left: '←', right: '→', home: 'Home', end: 'End', pgup: 'PgUp', pgdn: 'PgDn' }
/** @type {Record<string, string>} la tecla de la barra → su nombre en KEYSYMS */
const KEYBAR_SYM = { esc: 'Escape', tab: 'Tab', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', home: 'Home', end: 'End', pgup: 'PageUp', pgdn: 'PageDown' }
/** El keysym de X de un carácter: Latin-1 es su código; el resto, 0x01000000 + el código. @param {string} ch */
const keysymOf = (ch) => { const cp = /** @type {number} */ (ch.codePointAt(0)); return cp < 0x100 ? cp : 0x01000000 + cp }

/**
 * La pantalla de UN escritorio. `sub === 'demo'` enseña la escena de muestra, sin red.
 * @param {DesktopLink | null} link @param {string} sub @param {string} [name]
 */
function desktopScreen (link, sub, name = '') {
  const demo = sub === 'demo'
  const node = el(`<section class="desktop" data-testid="desktop">
    <div class="dbar">
      <span class="dbar-fill"></span>
      <span class="seg" role="group" aria-label="${t('touch_mode')}"><button class="btn" data-mode="pan" data-testid="mode-pan">✋ ${t('mode_pan')}</button><button class="btn" data-mode="mouse" data-testid="mode-mouse">🖱 ${t('mode_mouse')}</button></span>
      <button class="btn" data-testid="keyboard">${t('keyboard')}</button>
      ${demo ? '' : `<button class="btn" data-testid="disconnect">${t('disconnect')}</button>`}
    </div>
    <p class="status" data-testid="desktop-status">${demo ? t('demo_note') : t('connecting', esc(name))}</p>
    <form class="unlock" data-testid="unlock" hidden><input type="password" autocomplete="off" data-testid="unlock-code" aria-label="${t('code_label')}" placeholder="${t('code_label')}"><button class="btn" data-testid="unlock-send">${t('code_send')}</button></form>
    <div class="stage"><svg class="screen" data-testid="screen" preserveAspectRatio="xMidYMin meet"></svg></div>
    <input class="hscroll" type="range" min="0" max="1000" value="0" data-testid="hscroll" aria-label="${t('hscroll')}" hidden>
    <div class="tbwrap">
      <button class="tbopts" data-testid="taskbar-opts" aria-haspopup="true" aria-expanded="false" aria-label="${t('taskbar_opts')}" title="${t('taskbar_opts')}">⋯</button>
      <div class="tbmenu" role="menu" data-testid="taskbar-menu" hidden>
        ${['both', 'icon', 'label'].map((m) => `<button role="menuitemradio" data-tb="${m}" data-testid="tb-${m}">${t('tb_' + m)}</button>`).join('')}
      </div>
      <nav class="taskbar" data-testid="taskbar" aria-label="${t('taskbar')}"></nav>
    </div>
    <div class="keybar" data-testid="keybar" role="toolbar" aria-label="${t('keybar')}" hidden>${KEYBAR.map((k) => `<button class="kb${MODS.includes(k) ? ' mod' : ''}" data-k="${esc(k)}" data-testid="key-${esc(k)}">${esc(KEY_LABELS[k] || k)}</button>`).join('')}</div>
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
  // LAS PANTALLAS: el fondo de escritorio de cada monitor es una ventana más (en XFCE, la de
  // `xfdesktop`), del tamaño del monitor y sin nada por dentro. Elegirla como ventana enseñaba un
  // fondo vacío (dueño, 2026-11-16). Se tratan como pantallas: encuadran el monitor y se ve todo
  // lo que hay en él.
  const DESKTOP_APPS = new Set(['xfdesktop', 'nautilus-desktop', 'pcmanfm', 'plasmashell', 'caja', 'nemo-desktop'])
  /** ¿Es el fondo de un monitor? @param {{ app: string, name: string }} w */
  const isMonitorWin = (w) => DESKTOP_APPS.has(w.app) || /^(Desktop|Escritorio)$/i.test(w.name)
  /** Los monitores, de izquierda a derecha. */
  const monitors = () => scene
    ? scene.wins.filter(isMonitorWin).map((w) => ({ id: w.id, r: rectOf(w.id) })).filter((m) => m.r).sort((a, b) => (/** @type {Rect} */ (a.r)).x - (/** @type {Rect} */ (b.r)).x || (/** @type {Rect} */ (a.r)).y - (/** @type {Rect} */ (b.r)).y)
    : []
  /** @param {number | null | undefined} id */
  const isMonitor = (id) => id != null && monitors().some((m) => m.id === id)

  /** La ventana que se mira ahora (o null = todo el escritorio). */
  const targetId = () => {
    if (!scene || watch === 'all') return null
    if (watch === 'active') return scene.wins.find((w) => w.active)?.id ?? null
    return watch
  }
  let lastLook = ''
  /** @type {number | null | undefined} la ventana que se encuadró la última vez */
  let lastFit
  const follow = () => {
    const id = targetId()
    const r = rectOf(id ?? undefined)
    // Una pantalla se encuadra entera y se ve todo lo que hay en ella, en el orden de la máquina.
    const mon = isMonitor(id)
    const top = r && !mon ? id : null
    const key = JSON.stringify([r, id, mon])
    if (key !== lastLook) { lastLook = key; view.look(r, top) }
    // El encuadre solo al CAMBIAR de ventana: después, el zoom y el desplazamiento son de la
    // persona (si se reencuadrara con cada cambio, pelearía con su dedo).
    const fitId = r ? id : null
    if (fitId !== lastFit) { lastFit = fitId; requestAnimationFrame(() => fitTo(r)) }
    chooseVideo(top)
    // Las imágenes guardadas van por encima de todo: con una ventana a la vista, solo las suyas.
    // Si no, la imagen congelada de otra que está en el mismo sitio la tapaba (pasó con Slack
    // encima de la terminal, dueño 2026-11-16).
    const only = top
    videoLayer.sync((x) => rectOf(x), (x) => only == null || view.ownerOf(x) === only)
  }

  // ---------- el vídeo de los huecos (agent/video.js, src/video.js) ----------
  // De la ventana que se mira: ella entera si no publica nada (Chrome, VS Code), o su hueco más
  // grande (una foto). Con «Todo el escritorio», ninguno: el vídeo es caro y ahí no se lee nada.
  const videoLayer = makeVideoLayer(view.overlay, (e) => { status.textContent = errorText(e) })
  /** @type {number | null} */
  let videoId = null
  /** @param {number | null} win */
  function chooseVideo (win) {
    let want = null
    if (win != null && scene && canDecode()) {
      const w = scene.nodes.find((n) => n.id === win)
      if (w?.hole) want = win
      else {
        let best = 0
        for (const n of scene.nodes) {
          if (!n.hole || view.ownerOf(n.id) !== win) continue
          const area = n.w * n.h
          if (area > best && n.w >= 64 && n.h >= 64) { best = area; want = n.id }
        }
      }
    }
    if (want === videoId) return
    videoId = want
    // La imagen que ya llegó de un hueco se queda (congelada) al dejar de mirarlo.
    videoLayer.stopLive()
    requestVideo(0)
  }
  // Si en VIDEO_RETRY_MS no llega ningún cuadro, se vuelve a pedir (el agente rehace la captura y
  // manda un cuadro completo). Con la ventana quieta solo sale uno, y perderlo dejaba el hueco vacío.
  const VIDEO_RETRY_MS = 3000
  let videoGot = false
  /** @type {ReturnType<typeof setTimeout> | null} */
  let videoRetry = null
  // MIENTRAS LLEGA: un círculo que gira en el centro del hueco, hasta el primer cuadro (dueño,
  // 2026-11-16: «si no carga la imagen, algo que indique que pronto llegará»).
  const spinner = /** @type {SVGGElement} */ (document.createElementNS('http://www.w3.org/2000/svg', 'g'))
  spinner.setAttribute('class', 'vspin')
  spinner.innerHTML = '<g class="vspin-turn"><circle r="40" fill="none" stroke-width="8" pathLength="100" stroke-dasharray="70 30"/></g><text y="80" text-anchor="middle"></text>'
  spinner.style.display = 'none'
  svg.appendChild(spinner)
  /** @param {number | null} id */
  const showSpinner = (id) => {
    const r = id != null ? rectOf(id) : null
    // Con una imagen guardada de esa ventana, se enseña esa (sale al momento) y no el círculo.
    if (!r || demo || (id != null && videoLayer.has(id))) { spinner.style.display = 'none'; return }
    // Del tamaño del hueco, para que se vea con cualquier zoom.
    const k = Math.max(0.3, Math.min(r.w, r.h) / 400)
    spinner.setAttribute('transform', `translate(${r.x + r.w / 2} ${r.y + r.h / 2}) scale(${k})`)
    const tx = spinner.querySelector('text'); if (tx) tx.textContent = t('video_loading')
    spinner.style.display = ''
  }
  /** @param {number} tries */
  function requestVideo (tries) {
    if (videoRetry) { clearTimeout(videoRetry); videoRetry = null }
    if (demo) return
    videoGot = false
    showSpinner(videoId)
    send({ type: 'video', id: videoId })
    if (videoId == null || tries >= 3) return
    const id = videoId
    videoRetry = setTimeout(() => { if (!videoGot && videoId === id) requestVideo(tries + 1) }, VIDEO_RETRY_MS)
  }

  /**
   * QUÉ VER: la BARRA DE TAREAS de abajo, un botón por ventana, más «Activa» y «Todo» (dueño,
   * 2026-11-16: «como un taskbar virtual, abajo, sin nada que moleste»). Una fila fina que se
   * desliza de lado; el botón de lo que se mira, resaltado. Sustituye al desplegable de arriba.
   */
  const taskbar = $(node, '.taskbar')
  // CÓMO SE VE: icono y nombre, solo icono o solo nombre (dueño, 2026-11-17). Es preferencia de
  // este aparato y se recuerda en él.
  const TASKBAR_KEY = 'dotrino-remote-desktop:taskbar'
  /** @type {'both' | 'icon' | 'label'} */
  let tbMode = 'both'
  try { const v = localStorage.getItem(TASKBAR_KEY); if (v === 'icon' || v === 'label') tbMode = v } catch {}
  const tbOpts = /** @type {HTMLButtonElement} */ ($(node, '.tbopts'))
  const tbMenu = /** @type {HTMLElement} */ ($(node, '.tbmenu'))
  const showMenu = (/** @type {boolean} */ open) => {
    tbMenu.hidden = !open
    tbOpts.setAttribute('aria-expanded', String(open))
    for (const b of tbMenu.querySelectorAll('[data-tb]')) b.setAttribute('aria-checked', String(/** @type {HTMLElement} */ (b).dataset.tb === tbMode))
  }
  tbOpts.addEventListener('click', (e) => { e.stopPropagation(); showMenu(tbMenu.hidden) })
  tbMenu.addEventListener('click', (e) => {
    const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-tb]'))
    if (!b) return
    tbMode = /** @type {'both' | 'icon' | 'label'} */ (b.dataset.tb)
    try { localStorage.setItem(TASKBAR_KEY, tbMode) } catch {}
    showMenu(false)
    showWins()
  })
  node.addEventListener('click', (e) => { if (!tbMenu.hidden && !tbMenu.contains(/** @type {Node} */ (e.target))) showMenu(false) })

  // LOS ICONOS de las apps (agent/icon.js): se piden una vez por ventana y se guardan aquí.
  // `null` = esa ventana no tiene icono (o no se pudo mirar): sale la inicial de su nombre.
  /** @type {Map<number, string | null>} */
  const icons = new Map()
  /** @param {number} id @param {string} name */
  const iconHtml = (id, name) => {
    const src = icons.get(id)
    if (src) return `<img class="ticon" src="${src}" alt="">`
    return `<span class="ticon tletter" aria-hidden="true">${esc((name.trim()[0] || '?').toUpperCase())}</span>`
  }
  /** @param {'active' | 'all' | number} what */
  const pick = (what) => {
    watch = what
    follow()
    showWins()
    // Cambiar de ventana o de pantalla lleva el ratón a su centro (dueño, 2026-11-17).
    mouseToCenter()
    // Elegir una ventana es querer trabajar en ella: se trae al frente, con el foco, en la máquina.
    if (typeof watch === 'number' && !isMonitor(watch)) send({ type: 'raise', id: watch })
  }
  // ORDEN FIJO: el agente da las ventanas en orden de apilado (la activa, la última), así que
  // traer una al frente la movía de sitio en la barra. Aquí cada una conserva el suyo desde que
  // aparece; las nuevas van al final y las que se cierran se quitan.
  /** @type {number[]} */
  let taskOrder = []
  function showWins () {
    if (!scene) return
    const activeId = scene.wins.find((w) => w.active)?.id
    const alive = scene.wins.filter((w) => w.name && rectOf(w.id))
    const ids = new Set(alive.map((w) => w.id))
    taskOrder = taskOrder.filter((id) => ids.has(id))
    for (const w of alive) if (!taskOrder.includes(w.id)) taskOrder.push(w.id)
    const byId = new Map(alive.map((w) => [w.id, w]))
    // Resaltado = lo que se MIRA en la tableta. El punto = la ventana con el foco en la máquina.
    /** @param {string} label @param {'active' | 'all' | number} what @param {string} [cls] @param {boolean} [app] una ventana (lleva icono) */
    const btn = (label, what, cls = '', app = false) => {
      const focus = typeof what === 'number' && what === activeId
      const ic = app && tbMode !== 'label' && typeof what === 'number' ? iconHtml(what, label) : ''
      const tx = !app || tbMode !== 'icon' ? `<span class="tlabel">${esc(label)}</span>` : ''
      const b = el(`<button class="task${watch === what ? ' on' : ''}${focus ? ' focus' : ''}${cls}" data-testid="task" title="${esc(label)}" aria-label="${esc(label)}">${ic}${tx}</button>`)
      b.addEventListener('click', () => pick(what))
      return b
    }
    const items = [btn(t('active_short'), 'active', ' fixed')]
    const mons = monitors()
    // LAS PANTALLAS, DIBUJADAS (dueño, 2026-11-17): «Todo» es un rectángulo con la forma del
    // escritorio entero, y cada monitor un rectángulo unido a los otros como están en la máquina.
    // Con un solo monitor, «Todo» y la pantalla son lo mismo: un rectángulo y nada más.
    const H = 20
    const rects = /** @type {Rect[]} */ (mons.map((m) => m.r))
    const minX = Math.min(...rects.map((r) => r.x)); const minY = Math.min(...rects.map((r) => r.y))
    const bw = rects.length ? Math.max(...rects.map((r) => r.x + r.w)) - minX : (scene?.screen.w || 16)
    const bh = rects.length ? Math.max(...rects.map((r) => r.y + r.h)) - minY : (scene?.screen.h || 9)
    const k = H / Math.max(1, bh)
    const px = (/** @type {number} */ v) => `${Math.max(2, Math.round(v * k))}px`
    /** @param {string} label @param {'all' | number} what @param {string} style */
    const shape = (label, what, style) => {
      const b = el(`<button class="scr${watch === what ? ' on' : ''}" data-testid="task-screen" title="${esc(label)}" aria-label="${esc(label)}" style="${style}"></button>`)
      b.addEventListener('click', () => pick(what))
      return b
    }
    items.push(shape(t('all_short'), 'all', `width:${px(bw)};height:${px(bh)}`))
    if (mons.length > 1) {
      // Cada monitor se agranda 1 px por lado: los bordes que se tocan quedan en uno solo.
      const group = el(`<span class="scrs" style="width:${Math.round(bw * k) + 2}px;height:${Math.round(bh * k) + 2}px"></span>`)
      mons.forEach((m, i) => {
        const r = /** @type {Rect} */ (m.r)
        group.appendChild(shape(t('screen_n', i + 1), m.id, `position:absolute;left:${Math.round((r.x - minX) * k)}px;top:${Math.round((r.y - minY) * k)}px;width:${Math.round(r.w * k) + 2}px;height:${Math.round(r.h * k) + 2}px`))
      })
      items.push(group)
    }
    const monIds = new Set(mons.map((m) => m.id))
    for (const id of taskOrder) {
      const w = byId.get(id)
      if (!w || monIds.has(id)) continue
      items.push(btn(w.name, id, '', true))
      if (!demo && tbMode !== 'label' && !icons.has(id)) { icons.set(id, null); send({ type: 'icon', id }) }
    }
    taskbar.replaceChildren(...items)
  }

  // LA VISTA: el lienzo (el escritorio entero) se mueve y se escala DENTRO del escenario con un
  // movimiento propio, no con el scroll del navegador. El scroll no deja mover algo más chico que
  // el área, y entonces la imagen se quedaba pegada arriba (dueño, 2026-11-16: «debo poder moverla
  // para abajo; lo que no puedo es que se salga»). La regla es una: el lienzo nunca sale del área.
  // Si es más chico, se mueve dentro de ella; si es más grande, siempre la cubre.
  const ZOOM_MAX = 12
  let zoom = 1
  let tx = 0; let ty = 0
  const stage = /** @type {HTMLElement} */ ($(node, '.stage'))
  const hscroll = /** @type {HTMLInputElement} */ ($(node, '.hscroll'))
  /** El tamaño del lienzo en el aparato, con el zoom de ahora. */
  const canvasSize = () => {
    const W = stage.clientWidth
    const cw = W * zoom
    const ch = scene ? cw * scene.screen.h / Math.max(1, scene.screen.w) : cw
    return { W, H: stage.clientHeight, cw, ch }
  }
  /** Lo que se puede mover en un eje: dentro del área si cabe, cubriéndola si no. */
  /** @param {number} t @param {number} view @param {number} size */
  const clampAxis = (t, view, size) => size <= view ? Math.min(view - size, Math.max(0, t)) : Math.min(0, Math.max(view - size, t))
  // LA BARRA DE ABAJO, GRUESA (dueño, 2026-11-16): un control propio, que en las tabletas la del
  // navegador se esconde. Mueve el lienzo de lado; sale solo si es más ancho que el área.
  const syncBar = () => {
    const { W, cw } = canvasSize()
    const room = cw - W
    hscroll.hidden = room <= 1
    if (room > 1) hscroll.value = String(Math.round(-tx / room * 1000))
  }
  /** Pone el lienzo donde dicen `zoom`, `tx` y `ty`, con el tope. */
  function applyView () {
    const { W, H, cw, ch } = canvasSize()
    tx = clampAxis(tx, W, cw); ty = clampAxis(ty, H, ch)
    svg.style.width = `${cw}px`
    svg.style.transform = `translate(${tx}px, ${ty}px)`
    syncBar()
    placeCursor()
  }
  hscroll.addEventListener('input', () => { const { W, cw } = canvasSize(); tx = -Number(hscroll.value) / 1000 * (cw - W); applyView() })
  // Girar la tableta (o cambiar el tamaño de la ventana): se vuelve a encuadrar lo que se mira.
  let lastW = 0
  new ResizeObserver(() => {
    const w = stage.clientWidth
    if (lastW && Math.abs(w - lastW) > 40) fitTo(rectOf(targetId() ?? undefined))
    else applyView()
    lastW = w
  }).observe(stage)
  /**
   * Cambia el zoom dejando quieto, bajo el dedo, el punto `cx,cy` (coordenadas del navegador):
   * lo que se pellizca se queda donde estaba, en vez de irse a la esquina.
   * @param {number} nz @param {number} [cx] @param {number} [cy]
   */
  const setZoom = (nz, cx, cy) => {
    nz = Math.min(ZOOM_MAX, Math.max(1, nz))
    const box = stage.getBoundingClientRect()
    const ax = (cx ?? box.left + box.width / 2) - box.left
    const ay = (cy ?? box.top + box.height / 2) - box.top
    const k = nz / zoom
    tx = ax - (ax - tx) * k; ty = ay - (ay - ty) * k
    zoom = nz
    applyView()
  }

  /**
   * Encuadra una ventana: el zoom justo para que entre entera en la pantalla, centrada. El lienzo
   * sigue siendo el escritorio entero: con el dedo se sale de la ventana. `null`: todo, sin zoom.
   * @param {Rect | null} r
   */
  function fitTo (r) {
    if (!scene) return
    const W = stage.clientWidth; const H = stage.clientHeight
    const s1 = W / Math.max(1, scene.screen.w)
    zoom = r ? Math.min(ZOOM_MAX, Math.max(1, Math.min(scene.screen.w / r.w, H / (r.h * s1)))) : 1
    tx = r ? W / 2 - (r.x + r.w / 2) * s1 * zoom : 0
    ty = r ? H / 2 - (r.y + r.h / 2) * s1 * zoom : 0
    applyView()
  }

  // MODO MOVER: un dedo arrastra el lienzo, dos hacen zoom alrededor del punto medio. Un toque que
  // fue parte de un arrastre o de un pellizco no es un clic (eso lo decide el `pointerup` del SVG).
  /** @type {{ d0: number, z0: number, mx: number, my: number } | null} */
  let pinch = null
  let pinched = false
  /** @type {{ x: number, y: number } | null} */
  let drag = null
  /** @param {TouchList} t */
  const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
  /** @param {TouchList} t */
  const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 })
  /**
   * Un paso del pellizco: zoom alrededor del punto medio Y desplazamiento con él (dueño,
   * 2026-11-16: «el pinch no tiene pan»). Mover los dos dedos juntos lleva la imagen, como en un mapa.
   * @param {{ d0: number, z0: number, mx: number, my: number }} g @param {TouchList} t
   */
  const pinchMove = (g, t) => {
    const m = mid(t)
    tx += m.x - g.mx; ty += m.y - g.my
    g.mx = m.x; g.my = m.y
    setZoom(g.z0 * spread(t) / g.d0, m.x, m.y)
  }
  stage.addEventListener('touchstart', (e) => {
    if (touchMode !== 'pan') return
    if (e.touches.length === 1) drag = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    if (e.touches.length === 2) { drag = null; const m = mid(e.touches); pinch = { d0: spread(e.touches), z0: zoom, mx: m.x, my: m.y }; pinched = true }
  }, { passive: true })
  stage.addEventListener('touchmove', (e) => {
    if (touchMode !== 'pan') return
    e.preventDefault()
    const t = e.touches
    if (pinch && t.length === 2) { pinchMove(pinch, t); return }
    if (drag && t.length === 1) {
      tx += t[0].clientX - drag.x; ty += t[0].clientY - drag.y
      drag = { x: t[0].clientX, y: t[0].clientY }
      applyView()
    }
  }, { passive: false })
  stage.addEventListener('touchcancel', () => { pinch = null; drag = null }, { passive: true })
  stage.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinch = null
    if (e.touches.length === 1) drag = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    if (e.touches.length === 0) { drag = null; setTimeout(() => { pinched = false }, 0) }
  }, { passive: true })

  // ---------- MODO RATÓN (dueño, 2026-11-16): el toque como un touchpad ----------
  // Un dedo mueve el puntero (por desplazamiento, no hace falta tocar encima) y la vista lo
  // sigue; un toque corto de ese dedo, o tocar con un segundo dedo, es clic donde está el puntero,
  // y dejar apoyado el segundo mantiene el botón pulsado para arrastrar. Separar los dos dedos
  // sigue siendo zoom.
  const TOUCH_KEY = 'dotrino-remote-desktop:touch'
  /** @type {'pan' | 'mouse'} */
  let touchMode = 'pan'
  try { if (localStorage.getItem(TOUCH_KEY) === 'mouse') touchMode = 'mouse' } catch {}
  /** Lo que el dedo mueve el puntero, por píxel de pantalla del aparato. */
  const GAIN = 1.6
  const HOLD_MS = 350
  const cursor = { x: 0, y: 0, placed: false }
  const cursorG = /** @type {SVGGElement} */ (document.createElementNS('http://www.w3.org/2000/svg', 'g'))
  cursorG.setAttribute('class', 'cursor')
  cursorG.innerHTML = '<path d="M0 0 L0 22 L6 16 L10 26 L14 24 L10 14 L18 14 Z"/>'
  svg.appendChild(cursorG)
  /** Píxeles del aparato por píxel de la pantalla de la máquina. */
  const scaleNow = () => scene ? (stage.clientWidth / Math.max(1, scene.screen.w)) * zoom : 1
  function placeCursor () {
    cursorG.setAttribute('transform', `translate(${cursor.x} ${cursor.y}) scale(${1 / scaleNow()})`)
  }
  /** La vista sigue al puntero: si se acerca al borde, se desplaza. */
  const keepVisible = () => {
    const k = scaleNow(); const m = 60
    // Dónde cae el puntero en el área (píxeles del aparato), y se mueve el lienzo si se acerca al borde.
    const cx = cursor.x * k + tx; const cy = cursor.y * k + ty
    if (cx < m) tx += m - cx
    else if (cx > stage.clientWidth - m) tx -= cx - (stage.clientWidth - m)
    if (cy < m) ty += m - cy
    else if (cy > stage.clientHeight - m) ty -= cy - (stage.clientHeight - m)
    applyView()
  }
  let lastMoveAt = 0
  /** @type {ReturnType<typeof setTimeout> | null} */
  let moveTimer = null
  /** Mover el ratón de la máquina, como mucho ~30 veces por segundo (y siempre el último sitio). */
  const sendMove = () => {
    const now = Date.now()
    const go = () => { lastMoveAt = Date.now(); moveTimer = null; send({ type: 'move', x: Math.round(cursor.x), y: Math.round(cursor.y) }) }
    if (now - lastMoveAt >= 33) go()
    else if (!moveTimer) moveTimer = setTimeout(go, 33 - (now - lastMoveAt))
  }
  /** El puntero, al entrar en este modo, en el centro de lo que se ve. */
  const centerCursor = () => {
    if (!scene) return
    const k = scaleNow()
    cursor.x = Math.max(0, Math.min(scene.screen.w - 1, (stage.clientWidth / 2 - tx) / k))
    cursor.y = Math.max(0, Math.min(scene.screen.h - 1, (stage.clientHeight / 2 - ty) / k))
    cursor.placed = true
  }
  /** El ratón (el puntero de aquí y el de la máquina) al centro de lo que se mira. */
  function mouseToCenter () {
    if (!scene) return
    const r = rectOf(targetId() ?? undefined) || { x: 0, y: 0, w: scene.screen.w, h: scene.screen.h }
    cursor.x = Math.max(0, Math.min(scene.screen.w - 1, r.x + r.w / 2))
    cursor.y = Math.max(0, Math.min(scene.screen.h - 1, r.y + r.h / 2))
    cursor.placed = true
    placeCursor()
    sendMove()
  }
  function applyTouchMode () {
    cursorG.style.display = touchMode === 'mouse' ? '' : 'none'
    for (const b of node.querySelectorAll('[data-mode]')) {
      const on = /** @type {HTMLElement} */ (b).dataset.mode === touchMode
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on))
    }
    if (touchMode === 'mouse') { if (!cursor.placed) centerCursor(); placeCursor() }
  }
  for (const b of node.querySelectorAll('[data-mode]')) {
    b.addEventListener('click', () => {
      touchMode = /** @type {HTMLElement} */ (b).dataset.mode === 'mouse' ? 'mouse' : 'pan'
      try { localStorage.setItem(TOUCH_KEY, touchMode) } catch {}
      applyTouchMode()
    })
  }
  /** @type {{ id: number, x: number, y: number, at: number, moved: number, solo: boolean } | null} el dedo que mueve */
  let finger = null
  /** Un toque corto de un dedo sin moverse es clic, como en un touchpad (dueño, 2026-11-16). */
  const TAP_MS = 250
  const TAP_PX = 10
  /** @type {{ id: number, at: number, d0: number, z0: number, mx: number, my: number, zooming: boolean, holding: boolean, timer: ReturnType<typeof setTimeout> | null } | null} el segundo dedo */
  let second = null
  /** @param {TouchList} list @param {number} id */
  const touchById = (list, id) => { for (const t of list) if (t.identifier === id) return t; return null }
  stage.addEventListener('touchstart', (e) => {
    if (touchMode !== 'mouse') return
    e.preventDefault()
    if (!cursor.placed) centerCursor()
    if (!finger && e.touches.length >= 1) { const t = e.touches[0]; finger = { id: t.identifier, x: t.clientX, y: t.clientY, at: Date.now(), moved: 0, solo: e.touches.length === 1 } }
    if (finger && e.touches.length > 1) finger.solo = false
    if (e.touches.length === 2 && !second) {
      const t2 = [...e.touches].find((t) => t.identifier !== finger?.id)
      if (!t2) return
      const m0 = mid(e.touches)
      const s2 = { id: t2.identifier, at: Date.now(), d0: spread(e.touches), z0: zoom, mx: m0.x, my: m0.y, zooming: false, holding: false, timer: /** @type {ReturnType<typeof setTimeout> | null} */ (null) }
      s2.timer = setTimeout(() => {
        if (second !== s2 || s2.zooming) return
        s2.holding = true
        send({ type: 'press', x: Math.round(cursor.x), y: Math.round(cursor.y), button: 1 })
      }, HOLD_MS)
      second = s2
    }
  }, { passive: false })
  stage.addEventListener('touchmove', (e) => {
    if (touchMode !== 'mouse') return
    e.preventDefault()
    // Dos dedos que se separan o se juntan: zoom, como en el otro modo.
    if (second && e.touches.length === 2 && !second.holding) {
      const d = spread(e.touches)
      const m = mid(e.touches)
      if (second.zooming || Math.abs(d - second.d0) > 24 || Math.hypot(m.x - second.mx, m.y - second.my) > 24) {
        second.zooming = true
        pinchMove(second, e.touches)
        return
      }
    }
    if (!finger || !scene) return
    const t = touchById(e.touches, finger.id)
    if (!t) return
    const k = scaleNow()
    cursor.x = Math.max(0, Math.min(scene.screen.w - 1, cursor.x + (t.clientX - finger.x) * GAIN / k))
    cursor.y = Math.max(0, Math.min(scene.screen.h - 1, cursor.y + (t.clientY - finger.y) * GAIN / k))
    finger.moved += Math.abs(t.clientX - finger.x) + Math.abs(t.clientY - finger.y)
    finger.x = t.clientX; finger.y = t.clientY
    placeCursor(); keepVisible(); sendMove()
  }, { passive: false })
  stage.addEventListener('touchend', (e) => {
    if (touchMode !== 'mouse') return
    e.preventDefault()
    const at = { x: Math.round(cursor.x), y: Math.round(cursor.y) }
    if (second && !touchById(e.touches, second.id)) {
      if (second.timer) clearTimeout(second.timer)
      if (second.holding) send({ type: 'release', ...at, button: 1 })
      else if (!second.zooming && Date.now() - second.at < HOLD_MS) send({ type: 'click', ...at, button: 1 })
      second = null
    }
    if (finger && !touchById(e.touches, finger.id)) {
      // Un toque corto, de un solo dedo y sin moverse: clic donde está el puntero.
      if (finger.solo && finger.moved < TAP_PX && Date.now() - finger.at < TAP_MS && e.touches.length === 0) send({ type: 'click', ...at, button: 1 })
      // El dedo que movía se levantó: el que quede (si queda) pasa a mover.
      const t = e.touches[0]
      finger = t ? { id: t.identifier, x: t.clientX, y: t.clientY, at: Date.now(), moved: TAP_PX, solo: false } : null
      if (t && second && second.id === t.identifier) { if (second.timer) clearTimeout(second.timer); if (second.holding) send({ type: 'release', ...at, button: 1 }); second = null }
    }
  }, { passive: false })
  applyTouchMode()

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
    else if (!moved && !pinched && touchMode === 'pan') send({ type: 'click', ...p, button: 1 })
    down = null
    // Con ratón, el teclado físico escribe en la máquina sin más. En pantalla táctil, enfocar abriría
    // el teclado del teléfono en cada toque (y al abrirse, la página se desplazaba): ahí se abre solo
    // con el botón «Teclado».
    if (e.pointerType === 'mouse') keys.focus({ preventScroll: true })
  })
  // Sin `dblclick` propio: dos pulsaciones seguidas ya son un doble clic para la máquina.
  svg.addEventListener('contextmenu', (e) => { e.preventDefault(); const p = view.toScreen(e.clientX, e.clientY); if (p) send({ type: 'click', ...p, button: 3 }) })
  svg.addEventListener('wheel', (e) => {
    if (!e.deltaY) return
    e.preventDefault()
    // Ctrl + rueda: zoom de la vista, como en el navegador (sin pantalla táctil no hay pellizco).
    if (e.ctrlKey) { setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY); return }
    const p = view.toScreen(e.clientX, e.clientY)
    if (p) send({ type: 'wheel', ...p, dy: Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 60)) })
  }, { passive: false })
  // Los modificadores de la barra: encendidos hasta que la siguiente tecla los usa.
  const keybar = /** @type {HTMLElement} */ ($(node, '.keybar'))
  /** @type {Set<string>} */
  const lit = new Set()
  const showMods = () => { for (const b of keybar.querySelectorAll('.mod')) b.classList.toggle('on', lit.has(/** @type {HTMLElement} */ (b).dataset.k || '')) }
  /** Manda una tecla con los modificadores encendidos (y los físicos) y los apaga. @param {number} keysym @param {string[]} [also] */
  const sendKey = (keysym, also = []) => {
    const mods = [...new Set([...lit, ...also])]
    send(mods.length ? { type: 'key', keysym, mods } : { type: 'key', keysym })
    if (lit.size) { lit.clear(); showMods() }
  }
  // Teclado: lo que es texto se escribe tal cual (también el del teclado del teléfono, que no
  // manda teclas sino texto); lo demás va por su keysym. Con un modificador (de la barra o del
  // teclado físico) un carácter va como tecla: Ctrl+C no es escribir una «c».
  keys.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    const phys = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.metaKey && 'super', e.shiftKey && 'shift'].filter(Boolean)
    const sym = KEYSYMS[e.key]
    if (sym) { e.preventDefault(); sendKey(sym, /** @type {string[]} */ (phys)); return }
    if (e.key.length === 1 && (e.ctrlKey || e.altKey || e.metaKey)) { e.preventDefault(); sendKey(keysymOf(e.key.toLowerCase()), /** @type {string[]} */ (phys)) }
  })
  keys.addEventListener('input', () => {
    const v = keys.value
    keys.value = ''
    if (!v) return
    if (lit.size && [...v].length === 1) sendKey(keysymOf(lit.has('ctrl') || lit.has('alt') ? v.toLowerCase() : v))
    else send({ type: 'text', text: v })
  })
  // Tocar la barra no le quita el foco al campo: si no, el teclado del teléfono se cerraría.
  keybar.addEventListener('pointerdown', (e) => e.preventDefault())
  keybar.addEventListener('click', (e) => {
    const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-k]'))
    const k = b?.dataset.k
    if (!k) return
    if (MODS.includes(k)) { if (lit.has(k)) lit.delete(k); else lit.add(k); showMods(); return }
    const named = KEYBAR_SYM[k]
    if (named) { sendKey(KEYSYMS[named]); return }
    if (lit.size) sendKey(keysymOf(k))
    else send({ type: 'text', text: k })
  })
  // El botón «Teclado» abre el teclado con su barra y lo vuelve a cerrar.
  const kbBtn = $(node, '[data-testid=keyboard]')
  kbBtn.addEventListener('pointerdown', (e) => e.preventDefault())
  kbBtn.addEventListener('click', () => {
    const open = keybar.hidden
    keybar.hidden = !open
    kbBtn.classList.toggle('primary', open)
    if (open) keys.focus(); else { keys.blur(); lit.clear(); showMods() }
  })

  // ---------- conexión ----------
  if (demo) {
    paint(demoScene())
    return node
  }
  let closed = false
  /** @type {ReturnType<typeof setTimeout> | null} */
  let sceneWatch = null
  teardown = () => { closed = true; if (sceneWatch) clearTimeout(sceneWatch); rc?.close().catch(() => {}) }
  node.querySelector('[data-testid=disconnect]')?.addEventListener('click', () => { teardown?.(); teardown = null; render() })
  // SI LA ESCENA NO LLEGA, SE VUELVE A CONECTAR: un canal directo puede quedar abierto pero
  // muerto (acepta lo que se le manda y lo pierde) y nadie se entera; la tableta se quedaba en
  // «Conectando…» para siempre (2026-11-16). Una sesión nueva negocia un canal nuevo.
  const SCENE_WAIT_MS = 8000
  const MAX_TRIES = 3
  let gotScene = false
  // LA CLAVE DE LA MÁQUINA (si tiene): se pide aquí y se guarda solo en memoria, para volver a
  // escribirla sola si la sesión se rehace. Nunca va al almacén.
  const unlockForm = /** @type {HTMLFormElement} */ ($(node, '.unlock'))
  const unlockInput = /** @type {HTMLInputElement} */ ($(node, '[data-testid=unlock-code]'))
  /** @type {string | null} */
  let machineCode = null
  const askCode = () => { unlockForm.hidden = false; unlockInput.value = ''; unlockInput.focus() }
  unlockForm.addEventListener('submit', (ev) => {
    ev.preventDefault()
    machineCode = unlockInput.value
    send({ type: 'unlock', code: machineCode })
  })
  /** @param {number} attempt */
  async function connectOnce (attempt) {
    try {
      if (!link) throw Object.assign(new Error('no link to the vault'), { code: 'not-linked' })
      gotScene = false
      const client = rc = new RemoteAgentClient(link, { agentPubkey: sub })
      client.on('message', (/** @type {AgentMessage | null} */ p) => {
        if (client !== rc || !p || typeof p !== 'object') return
        if (p.type === 'icon') {
          // Sin icono es normal; si no se pudo mirar, se apunta en la consola y queda la inicial.
          if (p.code) console.warn(`icon of window ${p.id}: ${p.code}: ${p.message}`)
          icons.set(p.id, p.png ? `data:image/png;base64,${p.png}` : null)
          showWins()
          return
        }
        if (p.type === 'scene') { icons.clear(); gotScene = true; if (sceneWatch) clearTimeout(sceneWatch); status.textContent = ''; paint(p); return }
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
        if (p.type === 'vframe') {
          if (p.id !== videoId) return
          if (!videoGot) spinner.style.display = 'none'
          videoGot = true
          // Por el proxio la imagen va reducida (un cuarto de los píxeles, 3 por segundo): se dice.
          const msg = p.q === 'relay' ? t('video_low') : ''
          if (status.textContent !== msg) status.textContent = msg
          videoLayer.frame(p)
          return
        }
        if (p.type === 'vwait') { if (p.id === videoId) { videoLayer.stopLive(); status.textContent = t('video_wait') } return }
        if (p.type === 'unlocked') { unlockForm.hidden = true; status.textContent = t('connecting', name); send({ type: 'scene' }); if (videoId != null) requestVideo(0); return }
        if (p.type === 'fail' && (p.code === 'locked' || p.code === 'bad-code' || p.code === 'wait')) {
          // Mientras se pide la clave no llega la escena, y eso no es un canal muerto.
          if (sceneWatch) { clearTimeout(sceneWatch); sceneWatch = null }
          if (p.code === 'locked' && machineCode != null) { send({ type: 'unlock', code: machineCode }); return }
          if (p.code !== 'locked') machineCode = null
          status.textContent = p.code === 'locked' ? t('code_needed', name) : errorText(p)
          askCode()
          return
        }
        if (p.type === 'fail') status.textContent = errorText(p)
      })
      client.on('error', (/** @type {unknown} */ e) => { if (client === rc) status.textContent = errorText(e) })
      // La máquina se reinició y la sesión se rehízo sola: se vuelve a pedir la escena.
      client.on('resumed', () => { send({ type: 'scene' }); if (videoId != null) requestVideo(0) })
      await client.connect()
      if (closed) { client.close().catch(() => {}); return }
      send({ type: 'scene' })
      if (videoId != null) requestVideo(0)
      sceneWatch = setTimeout(() => {
        if (closed || gotScene || client !== rc) return
        client.close().catch(() => {})
        if (attempt + 1 >= MAX_TRIES) { status.textContent = t('conn_fail', name); return }
        status.textContent = t('reconnecting', name)
        connectOnce(attempt + 1)
      }, SCENE_WAIT_MS)
    } catch (e) {
      status.textContent = `${t('conn_fail', name)} ${errorText(e)}`
    }
  }
  connectOnce(0)
  return node
}

// TEMPORAL (dueño, 2026-11-16): recargar de verdad en el móvil mientras se prueba. Borra las
// cachés y el service worker, y vuelve a pedir la página saltándose la caché. Quitar al
// estabilizar (está en PENDIENTES.md).
{
  const b = document.getElementById('hard-reload')
  const commit = document.querySelector('meta[name=commit]')?.getAttribute('content') || 'dev'
  if (b) {
    b.title = `Recargar sin caché · ${commit}`
    b.addEventListener('click', async () => {
      try { for (const r of await navigator.serviceWorker?.getRegistrations?.() || []) await r.unregister() } catch {}
      try { for (const k of await caches.keys()) await caches.delete(k) } catch {}
      const u = new URL(location.href)
      u.searchParams.set('r', String(Date.now()))
      location.replace(u.toString())
    })
  }
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
