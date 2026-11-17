package com.dotrino.remotedesktop

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.RenderNode
import android.graphics.Typeface
import android.os.SystemClock
import android.text.InputType
import android.text.Selection
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import com.dotrino.remotedesktop.scene.Kind
import com.dotrino.remotedesktop.scene.Keysyms
import com.dotrino.remotedesktop.scene.Node
import com.dotrino.remotedesktop.scene.Rect
import com.dotrino.remotedesktop.scene.Scene
import com.dotrino.remotedesktop.scene.ZOOM_MAX
import com.dotrino.remotedesktop.scene.clampAxis
import com.dotrino.remotedesktop.scene.fontSizeOf
import com.dotrino.remotedesktop.scene.isMultiline
import com.dotrino.remotedesktop.scene.kindOf
import com.dotrino.remotedesktop.scene.labelOf
import com.dotrino.remotedesktop.scene.owners
import com.dotrino.remotedesktop.scene.paintOrder
import com.dotrino.remotedesktop.video.LiveVideo
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * THE DESKTOP on screen: the scene (accessibility nodes) drawn with a Canvas, the video of the
 * holes over it, and the touch that goes back to the machine as a real mouse and keyboard. The
 * native twin of the PWA's `src/render.js` + the view/touch half of `src/main.js`.
 *
 * Not a photo of the screen: a functional SKETCH. Each node is a box in its place with its text;
 * the look is the ecosystem's theme, not the machine's app. The scene is recorded once per change
 * into a [RenderNode] (machine coordinates) and drawn with the view's zoom and offset, so panning
 * and pinching do not redraw it.
 *
 * The canvas is ALWAYS the whole desktop; looking at a window is zooming and moving to it. It never
 * leaves the stage: smaller, it moves within it; bigger, it always covers it.
 *
 * Two touch modes, as in the PWA: PAN (one finger moves, two zoom, a tap clicks where touched) and
 * MOUSE (a touchpad: one finger moves the pointer, the view follows; a short tap or a second
 * finger's tap clicks where the pointer is; holding the second finger drags).
 */
@SuppressLint("ViewConstructor")
class DesktopStage(context: Context, private val noView: String, private val loading: String) : FrameLayout(context) {
    /** What goes to the agent (`click`, `press`, `move`, `wheel`, `text`, `key`). */
    var onSend: (Map<String, Any?>) -> Unit = {}
    /** The view moved or zoomed (the side bar follows). */
    var onViewChanged: () -> Unit = {}

    enum class Mode { PAN, MOUSE }
    var mode = Mode.PAN
        set(v) { field = v; if (v == Mode.MOUSE && !cursorPlaced) centerCursor(); invalidate() }

    private val dp = resources.displayMetrics.density
    private fun px(v: Float) = v * dp
    private fun col(id: Int) = context.getColor(id)
    // The theme's colours (values / values-night), read once.
    private val cAccent = col(R.color.rd_accent)
    private val cAccentSoft = col(R.color.rd_accent_soft)
    private val cAccentSoftInk = col(R.color.rd_accent_soft_ink)
    private val cBg = col(R.color.rd_bg)
    private val cBg2 = col(R.color.rd_bg2)
    private val cLine = col(R.color.rd_line)
    private val cSurface = col(R.color.rd_surface)
    private val cSurface2 = col(R.color.rd_surface2)
    private val cSurface3 = col(R.color.rd_surface3)
    private val cText = col(R.color.rd_text)
    private val cTextDim = col(R.color.rd_text_dim)
    private val cTextFaint = col(R.color.rd_text_faint)

    // ---------- the scene ----------

    var scene: Scene? = null; private set
    private var owner: Map<Int, Int> = emptyMap()
    /** The window drawn ON TOP of the others (null = the machine's order). */
    private var top: Int? = null
    private val node = RenderNode("scene")
    private var dirty = true

    /** The window a node belongs to (or -1). */
    fun ownerOf(id: Int): Int = owner[id] ?: -1
    val owners: Map<Int, Int> get() = owner

    /** A new scene (or a patched one). Everything is recorded again: cheap next to sending it. */
    fun show(s: Scene) {
        scene = s
        owner = owners(s)
        dirty = true
        applyView()
    }

    /** What is looked at: a window goes on top of the others; null = the machine's order. */
    fun look(win: Int?) { if (win != top) { top = win; dirty = true; invalidate() } }

    // ---------- the view: zoom and offset ----------

    var zoom = 1f; private set
    private var tx = 0f
    private var ty = 0f

    private fun screenW() = max(1, scene?.screen?.w ?: 1).toFloat()
    private fun screenH() = max(1, scene?.screen?.h ?: 1).toFloat()
    /** Device pixels per machine pixel, with the zoom of now. */
    fun scaleNow(): Float = width / screenW() * zoom
    private fun canvasW() = width * zoom
    private fun canvasH() = canvasW() * screenH() / screenW()

    /** How much the canvas is wider than the stage (0 = it fits): for the side bar. */
    fun room(): Float = max(0f, canvasW() - width)
    /** Where the side bar is, 0..1. */
    fun scrollFraction(): Float = if (room() <= 1f) 0f else -tx / room()
    fun scrollTo(f: Float) { tx = -f * room(); applyView() }

    /** Puts the canvas where zoom, tx and ty say, within the limits. */
    fun applyView() {
        if (width == 0) return
        tx = clampAxis(tx, width.toFloat(), canvasW()); ty = clampAxis(ty, height.toFloat(), canvasH())
        placeVideo()
        invalidate()
        onViewChanged()
    }

    /** Zoom keeping the point [cx],[cy] (view pixels) still under the finger. */
    fun setZoom(nz0: Float, cx: Float = width / 2f, cy: Float = height / 2f) {
        val nz = nz0.coerceIn(1f, ZOOM_MAX)
        val k = nz / zoom
        tx = cx - (cx - tx) * k; ty = cy - (cy - ty) * k
        zoom = nz
        applyView()
    }

    /** Frames a rect (zoom, tx, ty from [com.dotrino.remotedesktop.scene.fitTo]). */
    fun setFrame(z: Float, x: Float, y: Float) { zoom = z; tx = x; ty = y; applyView() }

    /** From a point of the view to the machine's screen. */
    fun toScreen(vx: Float, vy: Float): Pair<Int, Int> {
        val k = scaleNow()
        return Math.round((vx - tx) / k) to Math.round((vy - ty) / k)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        onResized(w, oldw)
    }
    /** The stage changed size (the phone turned, the keyboard): the owner frames again if it was a big change. */
    var onResized: (Int, Int) -> Unit = { _, _ -> applyView() }

    // ---------- drawing ----------

    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1f }
    private val dash = DashPathEffect(floatArrayOf(6f, 4f), 0f)
    private val text = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG).apply { isLinearText = true }
    private val box = RectF()

    init {
        setWillNotDraw(false)
        setBackgroundColor(cBg2)
        clipChildren = true
        isFocusable = true; isFocusableInTouchMode = true
    }

    override fun onDraw(canvas: Canvas) {
        val s = scene ?: return
        val k = scaleNow()
        canvas.save()
        canvas.translate(tx, ty)
        canvas.scale(k, k)
        if (canvas.isHardwareAccelerated) {
            if (dirty || !node.hasDisplayList()) record(s)
            canvas.drawRenderNode(node)
        } else drawScene(canvas, s)
        drawFrozen(canvas)
        canvas.restore()
    }

    private fun record(s: Scene) {
        node.setPosition(0, 0, s.screen.w.coerceAtLeast(1), s.screen.h.coerceAtLeast(1))
        val c = node.beginRecording()
        try { drawScene(c, s) } finally { node.endRecording() }
        dirty = false
    }

    private fun drawScene(c: Canvas, s: Scene) {
        for (n in paintOrder(s, owner, top)) drawNode(c, n)
    }

    /** One node (render.js `drawNode`). */
    private fun drawNode(c: Canvas, n: Node) {
        val kind = kindOf(n)
        if (kind == Kind.SILENT) return
        val st = n.s ?: ""
        val focused = st.contains('f'); val selected = st.contains('s'); val off = !st.contains('d')
        val x = n.x.toFloat(); val y = n.y.toFloat(); val w = n.w.toFloat(); val h = n.h.toFloat()
        if (kind != Kind.TEXT && kind != Kind.HEADING) {
            val r = when (kind) { Kind.WIN -> 8f; Kind.BTN, Kind.FIELD -> 4f; else -> 0f }
            box.set(x, y, x + w, y + h)
            val bg = when {
                selected && kind != Kind.CHECK -> cAccentSoft
                kind == Kind.WIN -> cSurface
                kind == Kind.BAND -> cSurface2
                kind == Kind.BTN -> cSurface3
                kind == Kind.FIELD -> cBg
                kind == Kind.HOLE -> cBg2
                else -> 0
            }
            if (bg != 0) { fill.color = bg; c.drawRoundRect(box, r, r, fill) }
            val line = when {
                focused -> cAccent
                kind == Kind.WIN || kind == Kind.BTN -> cLine
                kind == Kind.FIELD -> cAccent
                kind == Kind.HOLE -> cTextFaint
                else -> 0
            }
            if (line != 0) {
                stroke.color = line; stroke.strokeWidth = if (focused) 2f else 1f
                stroke.pathEffect = if (kind == Kind.HOLE) dash else null
                c.drawRoundRect(box, r, r, stroke)
                stroke.pathEffect = null
            }
        }
        if (kind == Kind.CHECK) {
            val b = min(h - 4, 14f)
            val radio = n.r == "radio button"
            box.set(x + 2, y + (h - b) / 2, x + 2 + b, y + (h - b) / 2 + b)
            fill.color = cBg; c.drawRoundRect(box, if (radio) b / 2 else 3f, if (radio) b / 2 else 3f, fill)
            stroke.color = cTextDim; stroke.strokeWidth = 1f
            c.drawRoundRect(box, if (radio) b / 2 else 3f, if (radio) b / 2 else 3f, stroke)
            if (st.contains('c')) {
                box.set(x + 5, y + (h - b) / 2 + 3, x + 5 + b - 6, y + (h - b) / 2 + 3 + b - 6)
                fill.color = cAccent; c.drawRoundRect(box, if (radio) b / 2 else 2f, if (radio) b / 2 else 2f, fill)
            }
        }
        var label = labelOf(n)
        if (kind == Kind.HOLE) label = if (label.isNotEmpty()) "$label · $noView" else noView
        if (label.isEmpty() || h < 8) return
        val fs = fontSizeOf(n, kind)
        val pad = if (kind == Kind.CHECK) min(h, 18f) + 4 else 4f
        text.textSize = fs
        text.typeface = when (kind) {
            Kind.WIN, Kind.HEADING -> Typeface.DEFAULT_BOLD
            Kind.HOLE -> Typeface.defaultFromStyle(Typeface.ITALIC)
            else -> Typeface.DEFAULT
        }
        text.color = when {
            kind == Kind.HOLE -> cTextFaint
            kind == Kind.WIN -> cTextDim
            selected -> cAccentSoftInk
            else -> cText
        }
        text.alpha = if (off) 128 else 255
        val room = w - pad * 2
        if (isMultiline(n, fs)) {
            val lines = n.t!!.split('\n').take(((h - 4) / (fs * 1.25f)).toInt())
            lines.forEachIndexed { i, l -> c.drawText(fit(l, room), x + pad, y + 2 + fs * (i + 1) * 1.15f, text) }
        } else {
            c.drawText(fit(label, room), x + pad, if (kind == Kind.WIN) y + fs + 4 else y + h / 2 + fs / 3, text)
        }
    }

    /** A text cut to what fits in [w] machine pixels, with «…». Measured, not guessed. */
    private fun fit(s: String, w: Float): String {
        if (w <= 0) return ""
        if (text.measureText(s) <= w) return s
        val n = text.breakText(s, true, w - text.measureText("…"), null)
        return if (n > 0) s.substring(0, n) + "…" else ""
    }

    // ---------- video of the holes ----------

    /** The live video, over its hole. The owner hands it in once. */
    var video: LiveVideo? = null
        set(v) {
            field?.let { removeView(it.view) }
            field = v
            v?.let { addView(it.view, LayoutParams(1, 1, Gravity.TOP or Gravity.START)) }
        }

    /** The last picture of each hole that already had video: shown frozen in its place. */
    private val frozen = HashMap<Int, Bitmap>()
    /** Show only the frozen pictures of these windows' holes (null = all). */
    private var frozenOnly: Int? = null

    /** Keep the live hole's last picture before stopping it. */
    fun freezeLive() {
        val v = video ?: return
        val id = v.liveId ?: return
        v.snapshot()?.let { frozen.put(id, it)?.recycle() }
    }

    fun hasPicture(id: Int) = frozen.containsKey(id)

    /** Drop the pictures of holes that are gone; show only those of [only]'s window when one is looked at. */
    fun syncFrozen(only: Int?) {
        val s = scene
        val alive = s?.nodes?.mapTo(HashSet()) { it.id } ?: emptySet()
        frozen.keys.filter { it !in alive }.forEach { frozen.remove(it)?.recycle() }
        frozenOnly = only
        invalidate()
    }

    fun clearPictures() { frozen.values.forEach { it.recycle() }; frozen.clear(); invalidate() }

    private fun drawFrozen(c: Canvas) {
        val s = scene ?: return
        if (frozen.isEmpty()) return
        val live = video?.liveId
        for ((id, bmp) in frozen) {
            if (id == live && video?.view?.alpha == 1f) continue
            if (frozenOnly != null && ownerOf(id) != frozenOnly) continue
            val n = s.nodes.firstOrNull { it.id == id } ?: continue
            box.set(n.x.toFloat(), n.y.toFloat(), (n.x + n.w).toFloat(), (n.y + n.h).toFloat())
            c.drawBitmap(bmp, null, box, null)
        }
    }

    /** Puts the live video's view over its hole, with the view's zoom and offset (no relayout). */
    fun placeVideo() {
        val v = video ?: return
        val r = v.rect ?: return
        val lp = v.view.layoutParams
        if (lp.width != r.w || lp.height != r.h) { lp.width = r.w; lp.height = r.h; v.view.layoutParams = lp }
        val k = scaleNow()
        v.view.pivotX = 0f; v.view.pivotY = 0f
        v.view.scaleX = k; v.view.scaleY = k
        v.view.translationX = tx + r.x * k
        v.view.translationY = ty + r.y * k
        v.view.visibility = if (frozenOnly == null || ownerOf(v.liveId ?: -1) == frozenOnly) VISIBLE else INVISIBLE
    }

    // ---------- the spinner while the picture comes ----------

    private var spinFor: Rect? = null
    private val spinPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val spinText = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER }

    /** A turning circle in the middle of the hole, until its first picture. Null hides it. */
    fun spinner(r: Rect?) { spinFor = r; invalidate() }

    // ---------- the pointer of mouse mode ----------

    private var cursorX = 0f
    private var cursorY = 0f
    private var cursorPlaced = false
    private val cursorPath = Path().apply {
        moveTo(0f, 0f); lineTo(0f, 22f); lineTo(6f, 16f); lineTo(10f, 26f); lineTo(14f, 24f); lineTo(10f, 14f); lineTo(18f, 14f); close()
    }
    private val cursorFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt(); style = Paint.Style.FILL }
    private val cursorLine = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF000000.toInt(); style = Paint.Style.STROKE; strokeWidth = 1.5f; strokeJoin = Paint.Join.ROUND }

    override fun dispatchDraw(canvas: Canvas) {
        super.dispatchDraw(canvas)
        val k = scaleNow()
        spinFor?.let { r ->
            val cx = tx + (r.x + r.w / 2f) * k; val cy = ty + (r.y + r.h / 2f) * k
            val rad = px(20f)
            spinPaint.color = cAccent; spinPaint.strokeWidth = px(4f)
            val a = (SystemClock.uptimeMillis() % 900) / 900f * 360f
            canvas.drawArc(cx - rad, cy - rad, cx + rad, cy + rad, a, 250f, false, spinPaint)
            spinText.color = cTextDim; spinText.textSize = px(13f)
            canvas.drawText(loading, cx, cy + rad + px(20f), spinText)
            postInvalidateOnAnimation()
        }
        if (mode == Mode.MOUSE && scene != null) {
            canvas.save()
            canvas.translate(tx + cursorX * k, ty + cursorY * k)
            canvas.scale(dp, dp)
            canvas.drawPath(cursorPath, cursorFill); canvas.drawPath(cursorPath, cursorLine)
            canvas.restore()
        }
    }

    private fun centerCursor() {
        val s = scene ?: return
        val k = scaleNow()
        cursorX = ((width / 2f - tx) / k).coerceIn(0f, s.screen.w - 1f)
        cursorY = ((height / 2f - ty) / k).coerceIn(0f, s.screen.h - 1f)
        cursorPlaced = true
    }

    /** The view follows the pointer: near an edge, it moves. */
    private fun keepVisible() {
        val k = scaleNow(); val m = px(60f)
        val cx = cursorX * k + tx; val cy = cursorY * k + ty
        if (cx < m) tx += m - cx else if (cx > width - m) tx -= cx - (width - m)
        if (cy < m) ty += m - cy else if (cy > height - m) ty -= cy - (height - m)
        applyView()
    }

    private var lastMoveAt = 0L
    private var movePending = false
    /** Move the machine's mouse at most ~30 times a second (and always to the last place). */
    private fun sendMove() {
        val now = SystemClock.uptimeMillis()
        if (now - lastMoveAt >= 33) { lastMoveAt = now; send("move", cursorX, cursorY) }
        else if (!movePending) {
            movePending = true
            postDelayed({ movePending = false; lastMoveAt = SystemClock.uptimeMillis(); send("move", cursorX, cursorY) }, 33 - (now - lastMoveAt))
        }
    }

    private fun send(type: String, x: Float, y: Float, extra: Map<String, Any?> = emptyMap()) =
        onSend(mapOf("type" to type, "x" to Math.round(x), "y" to Math.round(y)) + extra)

    // ---------- touch ----------

    private class Pinch(var d0: Float, var z0: Float, var mx: Float, var my: Float)
    private var pinch: Pinch? = null
    private var pinched = false
    private var dragX = 0f
    private var dragY = 0f
    private var downX = 0f
    private var downY = 0f
    private var moved = 0f

    private fun spread(e: MotionEvent) = hypot(e.getX(0) - e.getX(1), e.getY(0) - e.getY(1))
    private fun midX(e: MotionEvent) = (e.getX(0) + e.getX(1)) / 2
    private fun midY(e: MotionEvent) = (e.getY(0) + e.getY(1)) / 2

    /** One step of the pinch: zoom around the middle AND move with it, as on a map. */
    private fun pinchMove(g: Pinch, e: MotionEvent) {
        val mx = midX(e); val my = midY(e)
        tx += mx - g.mx; ty += my - g.my
        g.mx = mx; g.my = my
        setZoom(g.z0 * spread(e) / max(1f, g.d0), mx, my)
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        if (scene == null) return true
        if (e.isFromSource(android.view.InputDevice.SOURCE_MOUSE)) return mouseEvent(e)
        return if (mode == Mode.PAN) panTouch(e) else mouseTouch(e)
    }

    private fun panTouch(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> { dragX = e.x; dragY = e.y; downX = e.x; downY = e.y; moved = 0f; pinched = false; pinch = null }
            MotionEvent.ACTION_POINTER_DOWN -> if (e.pointerCount == 2) { pinch = Pinch(spread(e), zoom, midX(e), midY(e)); pinched = true }
            MotionEvent.ACTION_MOVE -> {
                val g = pinch
                if (g != null && e.pointerCount >= 2) pinchMove(g, e)
                else if (e.pointerCount == 1) {
                    moved += abs(e.x - dragX) + abs(e.y - dragY)
                    tx += e.x - dragX; ty += e.y - dragY
                    dragX = e.x; dragY = e.y
                    applyView()
                }
            }
            MotionEvent.ACTION_POINTER_UP -> {
                if (e.pointerCount - 1 < 2) pinch = null
                val keep = if (e.actionIndex == 0) 1 else 0
                dragX = e.getX(keep); dragY = e.getY(keep)
            }
            MotionEvent.ACTION_UP -> {
                // A tap is a click where touched; a drag or a pinch only moved the view.
                if (!pinched && moved < px(10f)) {
                    val (x, y) = toScreen(e.x, e.y)
                    onSend(mapOf("type" to "click", "x" to x, "y" to y, "button" to 1))
                }
                pinch = null
            }
            MotionEvent.ACTION_CANCEL -> { pinch = null }
        }
        return true
    }

    // MOUSE MODE (owner, 2026-11-16): touch as a touchpad.
    private class Finger(val id: Int, var x: Float, var y: Float, val at: Long, var moved: Float, var solo: Boolean)
    private class Second(val id: Int, val at: Long, val g: Pinch, var zooming: Boolean = false, var holding: Boolean = false, var hold: Runnable? = null)
    private var finger: Finger? = null
    private var second: Second? = null

    private fun mouseTouch(e: MotionEvent): Boolean {
        val s = scene ?: return true
        val now = SystemClock.uptimeMillis()
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                if (!cursorPlaced) centerCursor()
                if (finger == null) {
                    val i = e.actionIndex
                    finger = Finger(e.getPointerId(i), e.getX(i), e.getY(i), now, 0f, e.pointerCount == 1)
                }
                if (e.pointerCount > 1) finger?.solo = false
                if (e.pointerCount == 2 && second == null) {
                    val i = e.actionIndex
                    val id = e.getPointerId(i)
                    if (id == finger?.id) return true
                    val s2 = Second(id, now, Pinch(spread(e), zoom, midX(e), midY(e)))
                    s2.hold = Runnable {
                        if (second !== s2 || s2.zooming) return@Runnable
                        s2.holding = true
                        send("press", cursorX, cursorY, mapOf("button" to 1))
                    }
                    postDelayed(s2.hold, HOLD_MS)
                    second = s2
                }
            }
            MotionEvent.ACTION_MOVE -> {
                val s2 = second
                // Two fingers that spread or close: zoom, as in the other mode.
                if (s2 != null && e.pointerCount == 2 && !s2.holding) {
                    val d = spread(e)
                    if (s2.zooming || abs(d - s2.g.d0) > px(24f) || hypot(midX(e) - s2.g.mx, midY(e) - s2.g.my) > px(24f)) {
                        s2.zooming = true
                        pinchMove(s2.g, e)
                        return true
                    }
                }
                val f = finger ?: return true
                val i = e.findPointerIndex(f.id)
                if (i < 0) return true
                val k = scaleNow()
                val dx = e.getX(i) - f.x; val dy = e.getY(i) - f.y
                cursorX = (cursorX + dx * GAIN / k).coerceIn(0f, s.screen.w - 1f)
                cursorY = (cursorY + dy * GAIN / k).coerceIn(0f, s.screen.h - 1f)
                f.moved += abs(dx) + abs(dy)
                f.x = e.getX(i); f.y = e.getY(i)
                keepVisible(); sendMove()
            }
            MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                val lifted = e.getPointerId(e.actionIndex)
                val cancel = e.actionMasked == MotionEvent.ACTION_CANCEL
                val s2 = second
                if (s2 != null && (lifted == s2.id || cancel)) {
                    removeCallbacks(s2.hold)
                    if (s2.holding) send("release", cursorX, cursorY, mapOf("button" to 1))
                    else if (!cancel && !s2.zooming && now - s2.at < HOLD_MS) send("click", cursorX, cursorY, mapOf("button" to 1))
                    second = null
                }
                val f = finger
                if (f != null && (lifted == f.id || cancel)) {
                    // A short tap of one finger, without moving: click where the pointer is.
                    if (!cancel && f.solo && f.moved < px(TAP_DP) && now - f.at < TAP_MS && e.actionMasked == MotionEvent.ACTION_UP) {
                        send("click", cursorX, cursorY, mapOf("button" to 1))
                    }
                    // The finger that moved went up: the one left (if any) moves now.
                    finger = null
                    if (!cancel && e.actionMasked == MotionEvent.ACTION_POINTER_UP) {
                        for (i in 0 until e.pointerCount) {
                            if (i == e.actionIndex) continue
                            val id = e.getPointerId(i)
                            finger = Finger(id, e.getX(i), e.getY(i), now, px(TAP_DP), false)
                            val other = second
                            if (other != null && other.id == id) {
                                removeCallbacks(other.hold)
                                if (other.holding) send("release", cursorX, cursorY, mapOf("button" to 1))
                                second = null
                            }
                            break
                        }
                    }
                }
            }
        }
        return true
    }

    /** A real mouse (a tablet with one): press, release, right click and drag, at the point under it. */
    private fun mouseEvent(e: MotionEvent): Boolean {
        val (x, y) = toScreen(e.x, e.y)
        when (e.actionMasked) {
            MotionEvent.ACTION_BUTTON_PRESS -> when (e.actionButton) {
                MotionEvent.BUTTON_PRIMARY -> onSend(mapOf("type" to "press", "x" to x, "y" to y, "button" to 1))
                MotionEvent.BUTTON_SECONDARY -> onSend(mapOf("type" to "click", "x" to x, "y" to y, "button" to 3))
                MotionEvent.BUTTON_TERTIARY -> onSend(mapOf("type" to "click", "x" to x, "y" to y, "button" to 2))
            }
            MotionEvent.ACTION_BUTTON_RELEASE -> if (e.actionButton == MotionEvent.BUTTON_PRIMARY) onSend(mapOf("type" to "release", "x" to x, "y" to y, "button" to 1))
            MotionEvent.ACTION_MOVE -> moveTo(x, y)
        }
        requestFocus()
        return true
    }

    private var hoverAt = 0L
    private fun moveTo(x: Int, y: Int) {
        val now = SystemClock.uptimeMillis()
        if (now - hoverAt < 33) return
        hoverAt = now
        onSend(mapOf("type" to "move", "x" to x, "y" to y))
    }

    override fun onGenericMotionEvent(e: MotionEvent): Boolean {
        if (scene == null) return false
        if (e.actionMasked == MotionEvent.ACTION_HOVER_MOVE) { val (x, y) = toScreen(e.x, e.y); moveTo(x, y); return true }
        if (e.actionMasked == MotionEvent.ACTION_SCROLL) {
            val v = e.getAxisValue(MotionEvent.AXIS_VSCROLL)
            if (v == 0f) return false
            // Ctrl + wheel: zoom of the view, as in the browser.
            if (e.metaState and KeyEvent.META_CTRL_ON != 0) { setZoom(zoom * if (v > 0) 1.15f else 1 / 1.15f, e.x, e.y); return true }
            val (x, y) = toScreen(e.x, e.y)
            val dy = if (v > 0) -1 else 1
            onSend(mapOf("type" to "wheel", "x" to x, "y" to y, "dy" to dy * max(1, Math.round(abs(v)))))
            return true
        }
        return super.onGenericMotionEvent(e)
    }

    // ---------- keyboard ----------

    fun showKeyboard() {
        requestFocus()
        (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(this, 0)
    }

    override fun onCheckIsTextEditor() = true

    private var ime: BaseInputConnection? = null
    /** What of the keyboard's text is already on the machine. */
    private var sent = ""

    /**
     * The phone's keyboard sends TEXT, not keys, and reads back what it wrote to correct a word. The
     * connection keeps everything it wrote since the last reset; [flush] makes the machine say the
     * same: Backspace over what changed, then the rest (the same mirror as Terminal's).
     */
    override fun onCreateInputConnection(out: EditorInfo): InputConnection {
        out.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        out.imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN or EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_ACTION_NONE
        sent = ""
        return object : BaseInputConnection(this, true) {
            override fun setComposingText(text: CharSequence?, newCursorPosition: Int) = super.setComposingText(text, newCursorPosition).also { flush() }
            override fun commitText(text: CharSequence?, newCursorPosition: Int) = super.commitText(text, newCursorPosition).also { flush() }
            override fun finishComposingText() = super.finishComposingText().also { flush() }
            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                val before = editable?.let { Selection.getSelectionStart(it) }?.coerceAtLeast(0) ?: 0
                val beyond = if (beforeLength == 0 && afterLength == 0 && before == 0) 1 else max(0, beforeLength - before)
                super.deleteSurroundingText(min(beforeLength, before), 0)
                flush()
                repeat(beyond) { key(Keysyms.BACKSPACE) }
                return true
            }
            override fun sendKeyEvent(event: KeyEvent): Boolean {
                if (event.action != KeyEvent.ACTION_DOWN) return true
                val e = editable
                if (event.keyCode == KeyEvent.KEYCODE_DEL && e != null && e.isNotEmpty()) {
                    val end = Selection.getSelectionEnd(e).takeIf { it > 0 } ?: e.length
                    e.delete(Character.offsetByCodePoints(e, end, -1), end)
                    flush()
                    return true
                }
                onKeyDown(event.keyCode, event)
                return true
            }
        }.also { ime = it }
    }

    private fun flush() {
        val e = ime?.editable ?: return
        val now = e.toString()
        val keep = sent.commonPrefixWith(now).length
        repeat(sent.codePointCount(keep, sent.length)) { key(Keysyms.BACKSPACE) }
        if (now.length > keep) {
            val add = now.substring(keep)
            for ((i, part) in add.split('\n').withIndex()) {
                if (i > 0) key(Keysyms.ENTER)
                if (part.isNotEmpty()) onSend(mapOf("type" to "text", "text" to part))
            }
        }
        sent = now
        if (now.contains('\n')) resetIme()
    }

    private fun resetIme() {
        val e = ime?.editable
        if (sent.isEmpty() && (e == null || e.isEmpty())) return
        sent = ""
        e?.clear()
        e?.let { BaseInputConnection.removeComposingSpans(it) }
        (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).updateSelection(this, 0, 0, -1, -1)
    }

    private fun key(sym: Int) = onSend(mapOf("type" to "key", "keysym" to sym))

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val sym = when (keyCode) {
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> Keysyms.ENTER
            KeyEvent.KEYCODE_DEL -> Keysyms.BACKSPACE
            KeyEvent.KEYCODE_FORWARD_DEL -> Keysyms.DELETE
            KeyEvent.KEYCODE_TAB -> Keysyms.TAB
            KeyEvent.KEYCODE_ESCAPE -> Keysyms.ESCAPE
            KeyEvent.KEYCODE_DPAD_LEFT -> Keysyms.LEFT; KeyEvent.KEYCODE_DPAD_RIGHT -> Keysyms.RIGHT
            KeyEvent.KEYCODE_DPAD_UP -> Keysyms.UP; KeyEvent.KEYCODE_DPAD_DOWN -> Keysyms.DOWN
            KeyEvent.KEYCODE_MOVE_HOME -> Keysyms.HOME; KeyEvent.KEYCODE_MOVE_END -> Keysyms.END
            KeyEvent.KEYCODE_PAGE_UP -> Keysyms.PAGE_UP; KeyEvent.KEYCODE_PAGE_DOWN -> Keysyms.PAGE_DOWN
            in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12 -> Keysyms.f(keyCode - KeyEvent.KEYCODE_F1 + 1)
            KeyEvent.KEYCODE_BACK -> return super.onKeyDown(keyCode, event)
            else -> null
        }
        if (sym != null) { resetIme(); key(sym); return true }
        // A real keyboard: what is text goes as text.
        val ch = event.unicodeChar
        if (ch != 0 && !Character.isISOControl(ch)) { onSend(mapOf("type" to "text", "text" to String(Character.toChars(ch)))); return true }
        return super.onKeyDown(keyCode, event)
    }

    private companion object {
        /** How far a finger moves the pointer, per device pixel (the same as the PWA's per CSS pixel). */
        const val GAIN = 1.6f
        const val HOLD_MS = 350L
        const val TAP_MS = 250L
        const val TAP_DP = 10f
    }
}
