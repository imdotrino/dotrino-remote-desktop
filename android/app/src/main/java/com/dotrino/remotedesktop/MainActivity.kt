package com.dotrino.remotedesktop

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.dotrino.sdk.ui.DotrinoLocale
import com.dotrino.sdk.ui.DotrinoTopbar
import com.dotrino.sdk.ui.DotrinoWebActivity
import com.dotrino.sdk.ui.IdentityRequired
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The app: your desktops (the machines of your account running the remote desktop agent) and,
 * from there, one desktop on screen. «Back» from a desktop returns to the list; from the list,
 * leaves. Plain native views (CONVENCIONES §16.2). The PWA is `remote-desktop.dotrino.com/desktops`.
 */
class MainActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var content: FrameLayout? = null
    private var status: TextView? = null
    private var desktop: DesktopScreen? = null
    private var machines: List<Machine>? = null
    private var problem: String? = null
    private var poll: Job? = null
    private var booted = false

    override fun attachBaseContext(base: Context) = super.attachBaseContext(DotrinoLocale.wrap(base))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setDecorFitsSystemWindows(false)
        setContentView(shell())
        Remote.onLink = { if (desktop == null) refreshStatus() }
        Remote.onLost = { desktop?.connectionLost() }
        boot()
    }

    override fun onResume() {
        super.onResume()
        window.decorView.requestApplyInsets()
        if (Remote.profile == null && !booted) boot()
    }

    private var wasStopped = false
    override fun onStop() { super.onStop(); wasStopped = true }
    override fun onStart() { super.onStart(); if (wasStopped) { wasStopped = false; desktop?.wake() } }

    override fun onDestroy() {
        desktop?.close(); desktop = null
        scope.cancel()
        super.onDestroy()
    }

    @Deprecated("Activity without AndroidX: the back button still comes here")
    override fun onBackPressed() {
        if (desktop != null) { leaveDesktop(); return }
        @Suppress("DEPRECATION") super.onBackPressed()
    }

    // ---------- the frame ----------

    private fun shell(): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundColor(col(R.color.rd_bg))
        // The system's margins (bars, cutout, keyboard) as padding of the whole screen.
        setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() or android.view.WindowInsets.Type.displayCutout())
            val ime = insets.getInsets(android.view.WindowInsets.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            android.view.WindowInsets.CONSUMED
        }
        addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) { v.requestApplyInsets() }
            override fun onViewDetachedFromWindow(v: View) {}
        })
        addView(DotrinoTopbar(this@MainActivity, repo = "imdotrino/dotrino-remote-desktop",
            brand = DotrinoTopbar.Brand(getString(R.string.brand), R.drawable.rd_brand),
            profile = Remote.profile?.topbar(),
        ) { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(DotrinoTopbar.HOME))) }.view)
        // The status FLOATS over the content: as a row it would push the desktop down each time.
        status = label("", 13f).apply {
            tag = "status"; setPadding(px(14), px(7), px(14), px(7)); visibility = View.GONE; gravity = Gravity.CENTER
            background = rounded(col(R.color.rd_surface2), px(14), px(1), col(R.color.rd_line)); elevation = px(6).toFloat()
        }
        content = FrameLayout(this@MainActivity)
        addView(FrameLayout(this@MainActivity).apply {
            addView(content, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            addView(status, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = px(56); marginStart = px(24); marginEnd = px(24) })
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    }

    private fun say(msg: String?) {
        status?.apply { if (msg.isNullOrEmpty()) visibility = View.GONE else { visibility = View.VISIBLE; text = msg } }
    }

    private fun refreshStatus() = say(when (Remote.link) {
        "online" -> null
        "connecting" -> getString(R.string.link_connecting)
        else -> getString(R.string.link_offline)
    })

    private fun boot() {
        if (!IdentityRequired.check(this)) { showProblem(getString(R.string.boot_no_identity_app)); return }
        booted = true
        scope.launch {
            try {
                Remote.boot(this@MainActivity)
                setContentView(shell())                              // the bar again, now with the profile
                loadMachines()
            } catch (e: Remote.BootError) {
                booted = false
                when (e.code) {
                    "no-identity-app" -> { IdentityRequired.show(this@MainActivity); showProblem(getString(R.string.boot_no_identity_app)) }
                    "no-profile", "no-profile-keys" -> showProblem(getString(R.string.boot_no_profile), profileActions = true)
                    "no-vault" -> showProblem(getString(R.string.boot_no_vault), vaultAction = true)
                    else -> showProblem(e.message ?: e.code)
                }
            } catch (e: Exception) { booted = false; showProblem(e.message ?: e.toString()) }
        }
    }

    private fun showProblem(msg: String, profileActions: Boolean = false, vaultAction: Boolean = false) {
        val c = content ?: return
        c.removeAllViews()
        c.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(px(32), px(32), px(32), px(32))
            add(label(msg, 16f, col(R.color.rd_text_dim)).apply { gravity = Gravity.CENTER })
            val wrap = ViewGroup.LayoutParams.WRAP_CONTENT
            if (profileActions) {
                add(pill(getString(R.string.boot_create), filled = true) { DotrinoWebActivity.open(this@MainActivity, DotrinoTopbar.CREATE_URL) }.apply { tag = "create-profile" }, top = 20, width = wrap)
                add(pill(getString(R.string.boot_adopt)) { DotrinoWebActivity.open(this@MainActivity, DotrinoTopbar.ADOPT_URL) }.apply { tag = "adopt-profile" }, top = 12, width = wrap)
            }
            if (vaultAction) add(pill(getString(R.string.boot_connect_vault), filled = true) { DotrinoWebActivity.open(this@MainActivity, DotrinoTopbar.ADOPT_URL) }.apply { tag = "connect-vault" }, top = 20, width = wrap)
            add(pill(getString(R.string.boot_retry), filled = !profileActions && !vaultAction) { Remote.forget(); boot() }.apply { tag = "retry" }, top = 20, width = wrap)
        }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    // ---------- your desktops ----------

    private fun loadMachines() {
        machines = null; problem = null
        renderMachines()
        poll?.cancel()
        // The list is asked again every 30 s while on screen, as in the PWA: a machine that turns on shows up.
        poll = scope.launch {
            while (true) {
                try { machines = Remote.machines(); problem = null }
                catch (e: Exception) { if (machines == null) machines = emptyList(); problem = getString(R.string.machines_err, e.message ?: "") }
                if (desktop == null) renderMachines()
                delay(30_000)
            }
        }
    }

    private fun renderMachines() {
        val c = content ?: return
        if (desktop != null) return
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(px(16), px(16), px(16), px(24)) }
        body.add(label(getString(R.string.machines_title), 20f, bold = true))
        val list = machines
        when {
            list == null -> body.add(label(getString(R.string.machines_loading), 15f, col(R.color.rd_text_dim)), top = 12)
            list.isEmpty() -> {
                body.add(label(problem ?: getString(R.string.machines_none), 15f, col(R.color.rd_text_dim)).apply { tag = "machines-status" }, top = 12)
                if (problem == null) body.add(pill(getString(R.string.machines_howto)) { openWiki() }.apply { tag = "howto" }, top = 16, width = ViewGroup.LayoutParams.WRAP_CONTENT)
            }
            else -> for (m in list) body.add(machineRow(m), top = 12)
        }
        if (list != null) body.add(pill(getString(R.string.machines_refresh)) { loadMachines() }.apply { tag = "refresh" }, top = 20, width = ViewGroup.LayoutParams.WRAP_CONTENT)
        c.removeAllViews()
        c.addView(ScrollView(this).apply { addView(body) })
    }

    private fun machineRow(m: Machine): View = card().apply {
        tag = "machine-item"; contentDescription = m.label
        isClickable = true; isFocusable = true
        addView(LinearLayout(context).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(View(context).apply { background = rounded(col(R.color.rd_ok), px(5)); contentDescription = getString(R.string.machine_online) }, LinearLayout.LayoutParams(px(10), px(10)).apply { marginEnd = px(12) })
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                addView(label(m.label, 17f, bold = true))
                addView(label(m.id, 13f, col(R.color.rd_text_faint)).apply { typeface = android.graphics.Typeface.MONOSPACE })
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(label("›", 24f, col(R.color.rd_text_dim)))
        })
        setOnClickListener { enter(m) }
    }

    private fun openWiki() {
        val lang = if (DotrinoLocale.current(this) == "en") "/en" else ""
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://wiki.dotrino.com$lang/herramientas/escritorio-remoto/")))
    }

    // ---------- a desktop ----------

    private fun enter(m: Machine) {
        val c = content ?: return
        poll?.cancel()
        val d = DesktopScreen(this, scope, m, status = { say(it) }, onLeave = { leaveDesktop(closeIt = false) })
        desktop = d
        c.removeAllViews()
        c.addView(d.view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    private fun leaveDesktop(closeIt: Boolean = true) {
        if (closeIt) desktop?.close()
        desktop = null
        say(null)
        loadMachines()
    }
}
