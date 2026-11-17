package com.dotrino.remotedesktop.scene

/**
 * The rules of the desktop screen that do not need Android: what each role looks like, which
 * window owns each node, which windows are monitors, which hole gets video, the taskbar's order
 * and the view's limits. The same rules as the PWA (`src/render.js`, `src/main.js`), kept apart
 * so they can be tested on the JVM.
 */

/** How a node is drawn (render.js `kindOf`). */
enum class Kind { HOLE, WIN, FIELD, CHECK, BTN, BAND, CELL, HEADING, SILENT, TEXT }

private val BUTTONS = setOf("push button", "button", "toggle button", "menu item", "check menu item",
    "radio menu item", "page tab", "combo box", "link", "spin button", "tool bar item")
private val FIELDS = setOf("entry", "text", "password text", "terminal", "document text", "spin button")
private val BANDS = setOf("menu bar", "tool bar", "status bar", "page tab list", "header", "title bar")
private val WINDOWS = setOf("frame", "window", "dialog", "alert", "file chooser", "menu", "popup menu", "tool tip")
private val SILENT = setOf("panel", "filler", "section", "scroll pane", "viewport", "layered pane",
    "split pane", "grouping", "form", "table", "tree table", "list", "tree", "document web",
    "document frame", "redundant object", "unknown", "application", "internal frame", "desktop frame")

fun kindOf(n: Node): Kind = when {
    n.isHole -> Kind.HOLE
    n.r in WINDOWS -> Kind.WIN
    n.r in FIELDS && (n.s ?: "").contains('e') -> Kind.FIELD
    n.r == "check box" || n.r == "radio button" -> Kind.CHECK
    n.r in BUTTONS -> Kind.BTN
    n.r in BANDS -> Kind.BAND
    n.r == "table cell" || n.r == "list item" || n.r == "tree item" || n.r == "table row" -> Kind.CELL
    n.r == "heading" -> Kind.HEADING
    n.r in SILENT -> Kind.SILENT
    else -> Kind.TEXT
}

/** The text a node shows: its inner text if it has one, else its name. */
fun labelOf(n: Node): String = ((n.t ?: n.n) ?: "").replace(Regex("\\s+"), " ").trim()

/** A text has several lines (a paragraph, a big field, a terminal) when it fits them. */
fun isMultiline(n: Node, fs: Float): Boolean =
    ((n.s ?: "").contains('m') || n.r == "paragraph" || n.r == "terminal") && n.h > fs * 2.4f && !n.t.isNullOrEmpty()

/** Font size in machine pixels for a node of [kind] (render.js). */
fun fontSizeOf(n: Node, kind: Kind): Float = when (kind) {
    Kind.WIN -> 12f
    Kind.HEADING -> (n.h - 4).toFloat().coerceIn(10f, 18f)
    else -> (n.h - 4).toFloat().coerceIn(8f, 13f)
}

/** Node → the window it belongs to (up through its parents to one of the list), or -1. */
fun owners(scene: Scene): Map<Int, Int> {
    val wins = scene.wins.mapTo(HashSet()) { it.id }
    val parent = HashMap<Int, Int>(scene.nodes.size * 2)
    for (n in scene.nodes) parent[n.id] = n.p
    val out = HashMap<Int, Int>(scene.nodes.size * 2)
    for (n in scene.nodes) {
        var id = n.id; var hops = 0
        while (id !in wins && parent.containsKey(id) && hops++ < 80) id = parent.getValue(id)
        out[n.id] = if (id in wins) id else -1
    }
    return out
}

/** Paint order: the scene's, with the chosen window ([top]) on top of every other one. */
fun paintOrder(scene: Scene, owner: Map<Int, Int>, top: Int?): List<Node> {
    if (top == null) return scene.nodes
    val (mine, rest) = scene.nodes.partition { owner[it.id] == top }
    return rest + mine
}

/** The rect of a node of the scene, or null when it is gone. */
fun rectOf(scene: Scene?, id: Int?): Rect? {
    if (scene == null || id == null) return null
    val n = scene.nodes.firstOrNull { it.id == id } ?: return null
    return Rect(n.x, n.y, n.w, n.h)
}

data class Rect(val x: Int, val y: Int, val w: Int, val h: Int)

// THE MONITORS: each one's desktop background is one more window (in XFCE, `xfdesktop`'s), the
// monitor's size and with nothing inside. They are offered as «Screen N» and frame the monitor.
private val DESKTOP_APPS = setOf("xfdesktop", "nautilus-desktop", "pcmanfm", "plasmashell", "caja", "nemo-desktop")
private val DESKTOP_NAME = Regex("^(Desktop|Escritorio)$", RegexOption.IGNORE_CASE)

fun isMonitorWin(w: Win) = w.app in DESKTOP_APPS || DESKTOP_NAME.matches(w.name)

/** The monitors, left to right. */
fun monitors(scene: Scene?): List<Pair<Int, Rect>> {
    if (scene == null) return emptyList()
    return scene.wins.filter(::isMonitorWin).mapNotNull { w -> rectOf(scene, w.id)?.let { w.id to it } }
        .sortedWith(compareBy({ it.second.x }, { it.second.y }))
}

/** What is being looked at: the active window, the whole desktop, or a chosen window. */
sealed class Watch {
    object Active : Watch()
    object All : Watch()
    data class Window(val id: Int) : Watch()
}

fun targetId(scene: Scene?, watch: Watch): Int? = when {
    scene == null -> null
    watch is Watch.All -> null
    watch is Watch.Active -> scene.wins.firstOrNull { it.active }?.id
    else -> (watch as Watch.Window).id
}

/**
 * Which node gets live video while [win] is looked at: the window itself if it publishes nothing
 * (Chrome, VS Code), or its biggest hole (a photo) of at least 64×64. None with the whole desktop.
 */
fun videoTarget(scene: Scene?, owner: Map<Int, Int>, win: Int?): Int? {
    if (win == null || scene == null) return null
    val w = scene.nodes.firstOrNull { it.id == win } ?: return null
    if (w.isHole) return win
    var best = 0L; var want: Int? = null
    for (n in scene.nodes) {
        if (!n.isHole || owner[n.id] != win) continue
        val area = n.w.toLong() * n.h
        if (area > best && n.w >= 64 && n.h >= 64) { best = area; want = n.id }
    }
    return want
}

/**
 * The taskbar's FIXED order: each window keeps its place from when it appeared (the agent lists
 * them in stacking order, so raising one moved it); new ones at the end, closed ones go.
 */
fun taskOrder(prev: List<Int>, scene: Scene): List<Int> {
    val alive = scene.wins.filter { it.name.isNotEmpty() && rectOf(scene, it.id) != null }.map { it.id }
    val ids = alive.toHashSet()
    val out = prev.filterTo(ArrayList()) { it in ids }
    for (id in alive) if (id !in out) out.add(id)
    return out
}

/**
 * The view: the canvas (the whole desktop) moves and scales INSIDE the stage. It never leaves the
 * stage: smaller, it moves within it; bigger, it always covers it (main.js `clampAxis`).
 */
fun clampAxis(t: Float, view: Float, size: Float): Float =
    if (size <= view) minOf(view - size, maxOf(0f, t)) else minOf(0f, maxOf(view - size, t))

const val ZOOM_MAX = 12f

/** The framing of a rect: zoom so it fits whole, centred. Null rect: everything, no zoom. Returns zoom, tx, ty. */
fun fitTo(screen: Screen, stageW: Float, stageH: Float, r: Rect?): Triple<Float, Float, Float> {
    val s1 = stageW / maxOf(1, screen.w)
    if (r == null) return Triple(1f, 0f, 0f)
    val zoom = minOf(ZOOM_MAX, maxOf(1f, minOf(screen.w.toFloat() / maxOf(1, r.w), stageH / (maxOf(1, r.h) * s1))))
    return Triple(zoom, stageW / 2 - (r.x + r.w / 2f) * s1 * zoom, stageH / 2 - (r.y + r.h / 2f) * s1 * zoom)
}

/** X keysyms of the keys that are not text (what the agent understands, main.js `KEYSYMS`). */
object Keysyms {
    const val ENTER = 0xff0d; const val BACKSPACE = 0xff08; const val TAB = 0xff09; const val ESCAPE = 0xff1b
    const val DELETE = 0xffff; const val LEFT = 0xff51; const val UP = 0xff52; const val RIGHT = 0xff53
    const val DOWN = 0xff54; const val HOME = 0xff50; const val END = 0xff57; const val PAGE_UP = 0xff55
    const val PAGE_DOWN = 0xff56
    /** F1…F12 */
    fun f(n: Int) = 0xffbe + (n - 1)
}
