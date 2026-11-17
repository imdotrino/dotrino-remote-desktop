package com.dotrino.remotedesktop

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import com.dotrino.remotedesktop.scene.Rect
import com.dotrino.remotedesktop.scene.SceneError
import com.dotrino.remotedesktop.scene.SceneSync
import com.dotrino.remotedesktop.scene.Watch
import com.dotrino.remotedesktop.scene.fitTo
import com.dotrino.remotedesktop.scene.monitors
import com.dotrino.remotedesktop.scene.patchOf
import com.dotrino.remotedesktop.scene.rectOf
import com.dotrino.remotedesktop.scene.sceneOf
import com.dotrino.remotedesktop.scene.targetId
import com.dotrino.remotedesktop.scene.taskOrder
import com.dotrino.remotedesktop.scene.videoTarget
import com.dotrino.remotedesktop.video.FrameOrder
import com.dotrino.remotedesktop.video.LiveVideo
import com.dotrino.sdk.RemoteAgent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put

/**
 * The screen of ONE desktop: the session with its agent, the scene, the taskbar at the bottom and
 * the view's controls. The native twin of `desktopScreen` in the PWA's `src/main.js`, with the
 * same rules: what is looked at (the active window by default, the whole desktop, a monitor or a
 * chosen window), the video of the hole of the window looked at, the spinner and the retries, and
 * a new session when the scene does not arrive.
 */
class DesktopScreen(
    private val activity: Activity,
    private val scope: CoroutineScope,
    private val machine: Machine,
    /** Says something in the floating status line (null hides it). */
    private val status: (String?) -> Unit,
    /** «Disconnect»: back to the list. */
    private val onLeave: () -> Unit,
    /** A sample scene to show instead of a machine (the PWA's `?demo`): no network. */
    private val demo: com.dotrino.remotedesktop.scene.Scene? = null,
) {
    private val ui = Handler(Looper.getMainLooper())
    private fun s(id: Int, vararg a: Any) = activity.getString(id, *a)
    private fun px(v: Int) = (v * activity.resources.displayMetrics.density).toInt()
    private fun col(id: Int) = activity.getColor(id)

    val stage = DesktopStage(activity, s(R.string.no_view), s(R.string.video_loading))
    private val sync = SceneSync()
    private val order = FrameOrder()
    private val video = LiveVideo(activity) { status(s(R.string.err_video_decode)) }
    private var session: RemoteAgent.Session? = null
    private var closed = false

    /** What is looked at. The window, not its rect: if it moves or resizes, the view follows it. */
    private var watch: Watch = Watch.Active
    private var taskIds: List<Int> = emptyList()
    private val taskbar = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(px(8), px(6), px(8), px(6)) }
    private val hscroll = SeekBar(activity).apply { max = 1000; visibility = View.GONE; contentDescription = s(R.string.hscroll) }
    private val modeButtons = HashMap<DesktopStage.Mode, TextView>()

    // THE MACHINE'S CODE (if it has one): asked here and kept ONLY in memory, to type it again by
    // itself when the session is redone. It never goes to the store.
    private var machineCode: String? = null
    /** The machine asked for its code and it has not been accepted on this session. */
    private var locked = false
    private val codeInput = android.widget.EditText(activity).apply {
        tag = "unlock-code"; hint = s(R.string.code_label); contentDescription = s(R.string.code_label)
        inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        isSingleLine = true; imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_GO
        setTextColor(col(R.color.rd_text)); setHintTextColor(col(R.color.rd_text_faint))
        setOnEditorActionListener { _, _, _ -> unlock(); true }
    }
    private val unlockRow: LinearLayout = LinearLayout(activity).apply {
        tag = "unlock"; gravity = Gravity.CENTER_VERTICAL; visibility = View.GONE
        setPadding(px(8), px(4), px(8), px(4))
        addView(codeInput, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        addView(chip(s(R.string.code_send), true) { unlock() }.apply { tag = "unlock-send" }, gap())
    }

    private fun unlock() {
        val code = codeInput.text.toString()
        if (code.isEmpty()) return
        machineCode = code
        send(mapOf("type" to "unlock", "code" to code))
    }

    private fun askCode() {
        unlockRow.visibility = View.VISIBLE
        codeInput.setText("")
        codeInput.requestFocus()
        (activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager).showSoftInput(codeInput, 0)
    }

    private fun hideCode() {
        unlockRow.visibility = View.GONE
        (activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager).hideSoftInputFromWindow(codeInput.windowToken, 0)
    }

    // ---------- the layout ----------

    val view: View = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        addView(bar())
        addView(unlockRow)
        addView(stage, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f).apply { setMargins(px(8), px(4), px(8), 0) })
        addView(hscroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, px(36)).apply { setMargins(px(8), px(4), px(8), 0) })
        addView(HorizontalScrollView(activity).apply {
            isHorizontalScrollBarEnabled = false; contentDescription = s(R.string.taskbar)
            addView(taskbar)
        })
    }

    private fun bar(): View = LinearLayout(activity).apply {
        gravity = Gravity.CENTER_VERTICAL or Gravity.END
        setPadding(px(8), px(6), px(8), px(2))
        val seg = LinearLayout(activity).apply {
            contentDescription = s(R.string.touch_mode)
            background = rounded(col(R.color.rd_surface), px(18), px(1), col(R.color.rd_line))
            for ((m, label) in listOf(DesktopStage.Mode.PAN to R.string.mode_pan, DesktopStage.Mode.MOUSE to R.string.mode_mouse)) {
                val b = chip(s(label), false) { setMode(m) }.apply { tag = if (m == DesktopStage.Mode.PAN) "mode-pan" else "mode-mouse" }
                modeButtons[m] = b
                addView(b)
            }
        }
        addView(seg)
        addView(chip(s(R.string.keyboard), false) { stage.showKeyboard() }.apply { tag = "keyboard" }, gap())
        addView(chip(s(R.string.disconnect), false) { close(); onLeave() }.apply { tag = "disconnect" }, gap())
    }

    private fun gap() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = px(8) }

    private fun chip(text: String, on: Boolean, fixed: Boolean = false, click: () -> Unit) = TextView(activity).apply {
        this.text = text; textSize = 13f; maxLines = 1; maxWidth = px(200)
        ellipsize = android.text.TextUtils.TruncateAt.END
        if (fixed) setTypeface(typeface, android.graphics.Typeface.BOLD)
        setPadding(px(12), px(6), px(12), px(6))
        paint(this, on)
        isClickable = true; isFocusable = true
        setOnClickListener { click() }
    }

    private fun paint(v: TextView, on: Boolean) {
        v.setTextColor(col(if (on) R.color.rd_accent_ink else R.color.rd_text))
        v.background = if (on) rounded(col(R.color.rd_accent), px(16)) else rounded(col(R.color.rd_surface), px(16), px(1), col(R.color.rd_line))
    }

    private fun setMode(m: DesktopStage.Mode) {
        stage.mode = m
        Prefs.touchMode(activity, m)
        for ((k, b) in modeButtons) paint(b, k == m)
    }

    init {
        setMode(Prefs.touchMode(activity))
        stage.video = video
        stage.onSend = { send(it) }
        stage.onViewChanged = {
            val room = stage.room()
            hscroll.visibility = if (room > 1) View.VISIBLE else View.GONE
            if (room > 1 && !dragging) hscroll.progress = (stage.scrollFraction() * 1000).toInt()
        }
        stage.onResized = { w, old -> if (old != 0 && kotlin.math.abs(w - old) > px(40)) frame(rectOf(sync.scene, targetId(sync.scene, watch))) else stage.applyView() }
        hscroll.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar, p: Int, fromUser: Boolean) { if (fromUser) stage.scrollTo(p / 1000f) }
            override fun onStartTrackingTouch(sb: SeekBar) { dragging = true }
            override fun onStopTrackingTouch(sb: SeekBar) { dragging = false }
        })
        video.onRendered = { stage.spinner(null); stage.invalidate() }
        if (demo != null) { closed = true; sync.onScene(demo)?.let { paint(it) } }
        else { status(s(R.string.connecting, machine.label)); connect(0) }
    }
    private var dragging = false

    // ---------- what is looked at ----------

    private var lastFit: Int? = -2
    private var lastTop: Int? = -2

    /** Follows what is looked at: on top, framed when it changes, its video, and the frozen pictures. */
    private fun follow() {
        val sc = sync.scene ?: return
        val id = targetId(sc, watch)
        val r = rectOf(sc, id)
        val mons = monitors(sc)
        // A monitor is framed whole and shows everything on it, in the machine's order.
        val mon = id != null && mons.any { it.first == id }
        val top = if (r != null && !mon) id else null
        if (top != lastTop) { lastTop = top; stage.look(top) }
        // The framing only when CHANGING window: after that, zoom and position are the person's.
        val fitId = if (r != null) id else null
        if (fitId != lastFit) { lastFit = fitId; stage.post { frame(r) } }
        chooseVideo(top)
        stage.syncFrozen(top)
        stage.placeVideo()
    }

    private fun frame(r: Rect?) {
        val sc = sync.scene ?: return
        if (stage.width == 0) return
        val (z, x, y) = fitTo(sc.screen, stage.width.toFloat(), stage.height.toFloat(), r)
        stage.setFrame(z, x, y)
    }

    private fun pick(w: Watch) {
        watch = w
        follow()
        showWins()
        // Choosing a window is wanting to work in it: it is raised, with the focus, on the machine.
        val sc = sync.scene
        if (w is Watch.Window && monitors(sc).none { it.first == w.id }) send(mapOf("type" to "raise", "id" to w.id))
    }

    /** The TASKBAR: Active, All, the monitors, and one button per window, in a fixed order. */
    private fun showWins() {
        val sc = sync.scene ?: return
        val activeId = sc.wins.firstOrNull { it.active }?.id
        taskIds = taskOrder(taskIds, sc)
        val byId = sc.wins.associateBy { it.id }
        taskbar.removeAllViews()
        fun add(label: String, w: Watch, fixed: Boolean) {
            val focus = w is Watch.Window && w.id == activeId
            val b = chip(if (focus) "● $label" else label, watch == w, fixed) { pick(w) }.apply { tag = "task"; contentDescription = label }
            taskbar.addView(b, gap())
        }
        add(s(R.string.active_short), Watch.Active, true)
        add(s(R.string.all_short), Watch.All, true)
        val mons = monitors(sc)
        mons.forEachIndexed { i, m -> add(if (mons.size > 1) s(R.string.screen_n, i + 1) else s(R.string.screen), Watch.Window(m.first), true) }
        val monIds = mons.mapTo(HashSet()) { it.first }
        for (id in taskIds) { val w = byId[id] ?: continue; if (id !in monIds) add(w.name, Watch.Window(id), false) }
    }

    private fun paint(update: SceneSync.Update) {
        val winsBefore = stage.scene?.wins
        stage.show(update.scene)
        val w = watch
        // A chosen window that closed: back to the active one.
        if (w is Watch.Window && rectOf(update.scene, w.id) == null) watch = Watch.Active
        follow()
        if (update.scene.wins != winsBefore) showWins()
    }

    // ---------- the video of the holes ----------

    private var videoId: Int? = null
    private var videoGot = false
    private var videoRetry: Runnable? = null
    private var lastAskAgain = 0L

    /** The video of the window looked at: itself if it publishes nothing, or its biggest hole. None with «All». */
    private fun chooseVideo(win: Int?) {
        val want = videoTarget(sync.scene, stage.owners, win)
        if (want == videoId) return
        videoId = want
        // The picture already received of a hole stays (frozen) when it is no longer looked at.
        stage.freezeLive()
        video.stop()
        requestVideo(0)
    }

    /** Asks for the video; if no frame comes in [VIDEO_RETRY_MS], asks again (up to 3 times). */
    private fun requestVideo(tries: Int) {
        videoRetry?.let { ui.removeCallbacks(it) }; videoRetry = null
        videoGot = false
        order.reset()
        val id = videoId
        stage.spinner(if (id != null && !stage.hasPicture(id)) rectOf(sync.scene, id) else null)
        send(mapOf("type" to "video", "id" to id))
        if (id == null || tries >= 3) return
        val r = Runnable { if (!videoGot && videoId == id) requestVideo(tries + 1) }
        videoRetry = r
        ui.postDelayed(r, VIDEO_RETRY_MS)
    }

    private fun onFrame(p: JsonObject) {
        val id = p.int("id") ?: return
        if (id != videoId) return
        val seq = (p["seq"] as? JsonPrimitive)?.doubleOrNull?.toLong() ?: return
        val key = (p["key"] as? JsonPrimitive)?.booleanOrNull == true
        val r = (p["rect"] as? JsonObject)?.let { Rect(it.int("x") ?: 0, it.int("y") ?: 0, it.int("w") ?: 0, it.int("h") ?: 0) } ?: return
        when (order.accept(seq, key)) {
            FrameOrder.Verdict.DROP -> return
            FrameOrder.Verdict.BROKEN -> {
                // A frame went missing (it went round by the proxy): ask for a new capture, which starts full.
                val now = System.currentTimeMillis()
                if (now - lastAskAgain > 1500) { lastAskAgain = now; send(mapOf("type" to "video", "id" to id)) }
                return
            }
            FrameOrder.Verdict.DECODE -> {}
        }
        videoGot = true
        // Over the proxy the picture is reduced (a quarter of the pixels, 3 a second): it is said.
        status(if ((p["q"] as? JsonPrimitive)?.content == "relay") s(R.string.video_low) else null)
        val data = try { Base64.decode((p["data"] as? JsonPrimitive)?.content ?: return, Base64.DEFAULT) } catch (_: Exception) { return }
        video.frame(id, key, r, data)
        ui.post { stage.placeVideo() }
    }

    // ---------- the connection ----------

    private var offMsg: (() -> Unit)? = null
    private var offErr: (() -> Unit)? = null
    private var sceneWatch: Job? = null
    private var gapCheck: Runnable? = null

    private fun send(msg: Map<String, Any?>) {
        val sess = session ?: return
        val json = buildJsonObject {
            for ((k, v) in msg) when (v) {
                null -> put(k, JsonNull)
                is Int -> put(k, v)
                is Long -> put(k, v)
                is Boolean -> put(k, v)
                else -> put(k, v.toString())
            }
        }
        try { sess.send(json) } catch (e: Exception) { status(errorText(null, e.message)) }
    }

    /**
     * Opens a session and asks for the scene. If the scene does not come in [SCENE_WAIT_MS], a new
     * session (a direct channel can stay open but dead and nobody knows; a new session negotiates a
     * new one), up to [MAX_TRIES] times.
     */
    private fun connect(attempt: Int) {
        if (closed) return
        scope.launch {
            try {
                val sess = Remote.open(machine)
                if (closed) { sess.close(); return@launch }
                bind(sess)
                sceneWatch?.cancel()
                sceneWatch = scope.launch {
                    delay(SCENE_WAIT_MS)
                    // While the code is asked for, no scene comes, and that is not a dead channel.
                    if (closed || locked || sync.scene != null || session !== sess) return@launch
                    unbind()
                    if (attempt + 1 >= MAX_TRIES) { status(s(R.string.conn_fail, machine.label)); return@launch }
                    status(s(R.string.reconnecting, machine.label))
                    connect(attempt + 1)
                }
            } catch (e: Exception) {
                val code = (e as? RemoteAgent.RemoteAgentError)?.code ?: (e as? Remote.BootError)?.code
                status(if (refusedFor(e) == "missing-cap") missingCap() else "${s(R.string.conn_fail, machine.label)} ${errorText(code, e.message)}")
            }
        }
    }

    /** A new session: the scene starts over, and the video of what was looked at is asked again. */
    private fun bind(sess: RemoteAgent.Session) {
        unbind()
        session = sess
        sync.reset()
        order.restart()
        locked = false
        offMsg = sess.onMessage { m -> ui.post { if (session === sess) onMessage(m) } }
        offErr = sess.onError { e -> ui.post { if (session === sess) onAgentError(e) } }
        send(mapOf("type" to "scene"))
        if (videoId != null) requestVideo(0)
    }

    private fun unbind() {
        offMsg?.invoke(); offErr?.invoke(); offMsg = null; offErr = null
        session?.close(); session = null
    }

    private fun onMessage(p: JsonObject) {
        when ((p["type"] as? JsonPrimitive)?.content) {
            "scene" -> {
                val sc = sceneOf(p) ?: return
                sceneWatch?.cancel()
                status(null)
                sync.dropEarly()
                sync.onScene(sc)?.let { paint(it) }
            }
            "patch" -> {
                val patch = patchOf(p) ?: return
                try { sync.onPatch(patch)?.let { paint(it) } }
                catch (_: SceneError) { askScene(); return }
                watchGap()
            }
            "vframe" -> onFrame(p)
            "vwait" -> if (p.int("id") == videoId) { stage.freezeLive(); video.stop(); status(s(R.string.video_wait)) }
            "unlocked" -> {
                locked = false
                hideCode()
                status(s(R.string.connecting, machine.label))
                askScene()
                if (videoId != null) requestVideo(0)
            }
            "fail" -> {
                val code = (p["code"] as? JsonPrimitive)?.content
                if (code == "locked" || code == "bad-code" || code == "wait") {
                    locked = true
                    sceneWatch?.cancel()
                    if (code == "locked" && machineCode != null) { send(mapOf("type" to "unlock", "code" to machineCode)); return }
                    if (code != "locked") machineCode = null
                    status(when (code) {
                        "locked" -> s(R.string.code_needed, machine.label)
                        "bad-code" -> s(R.string.code_bad)
                        else -> s(R.string.code_wait, Math.ceil(((p["retryMs"] as? JsonPrimitive)?.doubleOrNull ?: 0.0) / 1000).toInt())
                    })
                    askCode()
                    return
                }
                status(errorText(code, (p["message"] as? JsonPrimitive)?.content))
            }
        }
    }

    /** Patches waiting for one that has not come: give it a moment, then ask for the whole scene. */
    private fun watchGap() {
        gapCheck?.let { ui.removeCallbacks(it) }; gapCheck = null
        if (!sync.gap) return
        val r = Runnable { if (sync.gap) askScene() }
        gapCheck = r
        ui.postDelayed(r, GAP_WAIT_MS)
    }

    private fun askScene() { sync.dropEarly(); send(mapOf("type" to "scene")) }

    private fun onAgentError(e: RemoteAgent.RemoteAgentError) {
        // The agent restarted, or the session expired: a new one, on its own (the PWA's `resumed`).
        if (e.code == "unknown-session") { connect(0); return }
        status(errorText(e.code, e.message))
    }

    /** The connection to the proxy dropped: open again when it is back. */
    fun connectionLost() {
        if (closed) return
        unbind()
        status(s(R.string.link_offline))
        scope.launch {
            Remote.reconnect { !closed } ?: return@launch
            connect(0)
        }
    }

    /** The app came back to the front: if the session is deaf, a new one. */
    fun wake() {
        if (closed) return
        val sess = session
        if (sess == null) { connect(0); return }
        // The scene is asked again: it brings the screen up to date, and a session that never
        // answers (no scene yet after a while) is taken for dead.
        askScene()
        scope.launch {
            delay(WAKE_MS)
            if (!closed && session === sess && sync.scene == null) connect(0)
        }
    }

    private var shut = false

    fun close() {
        if (shut) return
        shut = true; closed = true
        sceneWatch?.cancel()
        videoRetry?.let { ui.removeCallbacks(it) }
        gapCheck?.let { ui.removeCallbacks(it) }
        // Stop the agent's work for this screen: the video and the patches.
        runCatching { send(mapOf("type" to "video", "id" to null)) }
        runCatching { send(mapOf("type" to "leave")) }
        unbind()
        video.stop(); video.shutdown()
        stage.clearPictures()
    }

    /**
     * Why the agent refused the handshake. dotrino-native's `RemoteAgent.open` turns the agent's
     * `{ type:'ra.error', code, reason, error }` into `RemoteAgentError(error, "refused")`: the
     * `code` and the `reason` are lost, only the `error` text travels. DECLARED STOPGAP until
     * dotrino-native carries `reason` (pending, said to the owner 2026-11-16): the agent's text is
     * `unauthorized: <reason>`, written by remote-agent (src/agent.js `judge`). Remove it then.
     */
    private fun refusedFor(e: Exception): String? {
        val err = e as? RemoteAgent.RemoteAgentError ?: return null
        if (err.code != "refused") return null
        return err.message?.removePrefix("unauthorized: ")?.takeIf { it != err.message }
    }

    /** The phone lacks the acta permission `desktop`: said with the command that grants it. */
    private fun missingCap(): String = s(R.string.err_missing_cap, Remote.profile?.publickey?.let { com.dotrino.sdk.Delegation.keyLabel(it) } ?: "<ID>")

    /** An agent error, in the person's words: by its code. */
    private fun errorText(code: String?, message: String?): String = when (code) {
        // The session-level error keeps `code` but not `reason` either (same stopgap as [refusedFor]).
        "unauthorized" -> if (message == "unauthorized: missing-cap") missingCap() else s(R.string.err_unauthorized, message?.removePrefix("unauthorized: ") ?: "?")
        "blocked" -> s(R.string.err_blocked)
        "no-session-bus" -> s(R.string.err_no_desktop)
        "no-a11y-bus" -> s(R.string.err_no_a11y)
        "no-raise" -> s(R.string.err_no_raise)
        "no-video" -> s(R.string.err_no_video)
        // An older agent does not know what is new (video, raise): §14, said in words.
        "unknown-type" -> s(R.string.err_old_agent)
        "window-not-found" -> s(R.string.err_window_gone)
        else -> s(R.string.error, message ?: code ?: "?").also { Log.w("remote-desktop", "agent error: $code $message") }
    }

    private fun JsonObject.int(k: String): Int? = (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.let { Math.round(it).toInt() }

    private companion object {
        const val SCENE_WAIT_MS = 8000L
        const val MAX_TRIES = 3
        const val VIDEO_RETRY_MS = 3000L
        /** How long early patches wait for the one before them (it may be going round by the proxy). */
        const val GAP_WAIT_MS = 1500L
        const val WAKE_MS = 4000L
    }
}
