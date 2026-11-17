package com.dotrino.remotedesktop

import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import com.dotrino.remotedesktop.scene.Node
import com.dotrino.remotedesktop.scene.Scene
import com.dotrino.remotedesktop.scene.Screen
import com.dotrino.remotedesktop.scene.Win
import com.dotrino.sdk.ui.DotrinoLocale
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel

/** DEBUG only: the desktop screen with the PWA's sample scene (`src/demo.js`), no profile nor network. */
class DemoActivity : Activity() {
    private val scope = MainScope()
    private var screen: DesktopScreen? = null

    override fun attachBaseContext(base: Context) = super.attachBaseContext(DotrinoLocale.wrap(base))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val status = label("", 13f)
        val d = DesktopScreen(this, scope, Machine("demo", "demo"), status = { status.text = it ?: "" }, onLeave = { finish() }, demo = demoScene())
        screen = d
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(col(R.color.rd_bg))
            fitsSystemWindows = true
            addView(status)
            addView(d.view, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        })
    }

    override fun onDestroy() { screen?.close(); scope.cancel(); super.onDestroy() }

    /** The same invented scene as the PWA's `?demo`: nothing in it is anybody's. */
    private fun demoScene(): Scene {
        var id = 0
        val nodes = ArrayList<Node>()
        fun add(p: Int, r: String, b: IntArray, n: String? = null, t: String? = null, s: String = "d", hole: Int? = null): Int {
            nodes.add(Node(++id, p, r, b[0], b[1], b[2], b[3], n = n, t = t, s = s, hole = hole)); return id
        }
        val files = add(0, "frame", intArrayOf(40, 40, 760, 520), n = "Documentos — Archivos")
        val bar = add(files, "menu bar", intArrayOf(40, 70, 760, 26))
        listOf("Archivo", "Editar", "Ver", "Ayuda").forEachIndexed { i, n -> add(bar, "menu item", intArrayOf(48 + i * 70, 72, 64, 22), n = n) }
        val tools = add(files, "tool bar", intArrayOf(40, 98, 760, 34))
        listOf("Atrás", "Adelante", "Inicio").forEachIndexed { i, n -> add(tools, "push button", intArrayOf(48 + i * 84, 102, 78, 26), n = n) }
        add(tools, "entry", intArrayOf(310, 102, 380, 26), n = "Ubicación", t = "/home/ana/Documentos", s = "de")
        val side = add(files, "list", intArrayOf(40, 134, 170, 426))
        listOf("Inicio", "Documentos", "Descargas", "Imágenes", "Música").forEachIndexed { i, n -> add(side, "list item", intArrayOf(44, 140 + i * 26, 162, 24), n = n, s = if (i == 1) "ds" else "d") }
        val table = add(files, "table", intArrayOf(214, 134, 584, 400))
        listOf(listOf("Presupuesto 2026.ods", "18 KB", "Hoja de cálculo"), listOf("Carta al banco.odt", "9 KB", "Documento"), listOf("Recibos", "", "Carpeta"), listOf("Viaje.pdf", "1,2 MB", "PDF"))
            .forEachIndexed { i, row -> row.forEachIndexed { j, t -> add(table, "table cell", intArrayOf(218 + listOf(0, 300, 400)[j], 140 + i * 28, listOf(296, 96, 180)[j], 26), t = t, s = if (i == 0) "ds" else "d") } }
        add(files, "status bar", intArrayOf(40, 536, 760, 24), n = "4 elementos")
        val photo = add(0, "frame", intArrayOf(840, 40, 520, 420), n = "Visor de imágenes")
        add(photo, "drawing area", intArrayOf(850, 80, 500, 330), n = "Atardecer.jpg", hole = 1)
        add(photo, "push button", intArrayOf(850, 420, 90, 28), n = "Anterior")
        add(photo, "push button", intArrayOf(1260, 420, 90, 28), n = "Siguiente")
        val dlg = add(0, "dialog", intArrayOf(420, 300, 380, 190), n = "Guardar cambios", s = "da")
        add(dlg, "label", intArrayOf(440, 340, 340, 40), t = "¿Guardar los cambios del documento antes de cerrar?")
        add(dlg, "check box", intArrayOf(440, 390, 240, 24), n = "No volver a preguntar")
        add(dlg, "push button", intArrayOf(560, 440, 100, 32), n = "Cancelar")
        add(dlg, "push button", intArrayOf(680, 440, 100, 32), n = "Guardar", s = "df")
        return Scene(1, Screen(1400, 600), listOf(
            Win(files, "Archivos", "Documentos — Archivos", false),
            Win(photo, "Visor", "Visor de imágenes", false),
            Win(dlg, "Editor", "Guardar cambios", true),
        ), nodes)
    }
}
