package com.dotrino.remotedesktop

import com.dotrino.remotedesktop.scene.Kind
import com.dotrino.remotedesktop.scene.Node
import com.dotrino.remotedesktop.scene.Rect
import com.dotrino.remotedesktop.scene.Scene
import com.dotrino.remotedesktop.scene.Screen
import com.dotrino.remotedesktop.scene.Watch
import com.dotrino.remotedesktop.scene.Win
import com.dotrino.remotedesktop.scene.clampAxis
import com.dotrino.remotedesktop.scene.fitTo
import com.dotrino.remotedesktop.scene.kindOf
import com.dotrino.remotedesktop.scene.labelOf
import com.dotrino.remotedesktop.scene.monitors
import com.dotrino.remotedesktop.scene.owners
import com.dotrino.remotedesktop.scene.paintOrder
import com.dotrino.remotedesktop.scene.targetId
import com.dotrino.remotedesktop.scene.taskOrder
import com.dotrino.remotedesktop.scene.videoTarget
import com.dotrino.remotedesktop.video.FrameOrder
import com.dotrino.remotedesktop.video.H264
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeskTest {
    private fun node(id: Int, p: Int, r: String, x: Int, y: Int, w: Int, h: Int, hole: Int? = null, s: String? = "d", n: String? = null) =
        Node(id, p, r, x, y, w, h, n = n, s = s, hole = hole)

    /** Two monitors, a file manager and a viewer with a photo (a hole). */
    private val scene = Scene(1, Screen(3840, 1080), listOf(
        Win(1, "xfdesktop", "Desktop", false), Win(2, "xfdesktop", "Desktop", false),
        Win(10, "Files", "Documents", false), Win(20, "Viewer", "Photo", true),
    ), listOf(
        node(1, 0, "frame", 1920, 0, 1920, 1080), node(2, 0, "frame", 0, 0, 1920, 1080),
        node(10, 0, "frame", 100, 100, 800, 600), node(11, 10, "push button", 110, 110, 80, 24, n = "Back"),
        node(20, 0, "frame", 300, 200, 600, 500), node(21, 20, "panel", 300, 230, 600, 470), node(22, 21, "drawing area", 310, 240, 500, 400, hole = 1),
        node(23, 21, "image", 310, 650, 20, 20, hole = 1),
    ))

    @Test fun kinds() {
        assertEquals(Kind.HOLE, kindOf(scene.nodes[6]))
        assertEquals(Kind.WIN, kindOf(scene.nodes[0]))
        assertEquals(Kind.BTN, kindOf(scene.nodes[3]))
        assertEquals(Kind.SILENT, kindOf(scene.nodes[5]))
        assertEquals(Kind.FIELD, kindOf(node(1, 0, "entry", 0, 0, 1, 1, s = "de")))
        assertEquals(Kind.TEXT, kindOf(node(1, 0, "entry", 0, 0, 1, 1, s = "d")))
        assertEquals("a b", labelOf(Node(1, 0, "label", 0, 0, 1, 1, n = "x", t = "  a \n b ")))
    }

    @Test fun ownersAndPaintOrder() {
        val o = owners(scene)
        assertEquals(20, o[22]); assertEquals(10, o[11]); assertEquals(1, o[1])
        assertEquals(listOf(20, 21, 22, 23), paintOrder(scene, o, 20).takeLast(4).map { it.id })
        assertEquals(scene.nodes, paintOrder(scene, o, null))
    }

    @Test fun monitorsLeftToRight() {
        assertEquals(listOf(2, 1), monitors(scene).map { it.first })
    }

    @Test fun whatIsLookedAt() {
        assertEquals(20, targetId(scene, Watch.Active))
        assertNull(targetId(scene, Watch.All))
        assertEquals(10, targetId(scene, Watch.Window(10)))
    }

    @Test fun theBiggestHoleGetsVideoNotTheTinyOne() {
        assertEquals(22, videoTarget(scene, owners(scene), 20))
        assertNull(videoTarget(scene, owners(scene), 10))
        assertNull(videoTarget(scene, owners(scene), null))
        // A window that publishes nothing is a hole whole: itself.
        val chrome = scene.copy(nodes = scene.nodes + node(30, 0, "frame", 0, 0, 500, 500, hole = 1), wins = scene.wins + Win(30, "chrome", "Chrome", false))
        assertEquals(30, videoTarget(chrome, owners(chrome), 30))
    }

    @Test fun theTaskbarKeepsItsOrder() {
        val first = taskOrder(emptyList(), scene)
        assertEquals(listOf(1, 2, 10, 20), first)
        // Raising 10 puts it last in the agent's list; the bar does not move it.
        val raised = scene.copy(wins = listOf(scene.wins[0], scene.wins[1], scene.wins[3], scene.wins[2]))
        assertEquals(first, taskOrder(first, raised))
        // A closed one goes.
        val closed = scene.copy(nodes = scene.nodes.filter { it.id != 10 })
        assertEquals(listOf(1, 2, 20), taskOrder(first, closed))
    }

    @Test fun theCanvasNeverLeavesTheStage() {
        assertEquals(0f, clampAxis(50f, 400f, 800f))     // bigger: covers
        assertEquals(-400f, clampAxis(-900f, 400f, 800f))
        assertEquals(100f, clampAxis(100f, 400f, 200f))  // smaller: moves inside
        assertEquals(200f, clampAxis(500f, 400f, 200f))
        assertEquals(0f, clampAxis(-5f, 400f, 200f))
    }

    @Test fun framingAWindow() {
        val (z, x, y) = fitTo(Screen(2000, 1000), 1000f, 1000f, Rect(0, 0, 1000, 500))
        assertEquals(2f, z)
        assertEquals(0f, x); assertEquals(250f, y)
        assertEquals(Triple(1f, 0f, 0f), fitTo(Screen(2000, 1000), 1000f, 1000f, null))
    }

    @Test fun paramSetsOfAFullFrame() {
        val aud = byteArrayOf(0, 0, 0, 1, 9, 0x10)
        val sps = byteArrayOf(0, 0, 0, 1, 0x67, 0x42, 0xC0.toByte(), 0x1F, 0x11)
        val pps = byteArrayOf(0, 0, 1, 0x68, 0x22, 0x33)
        val idr = byteArrayOf(0, 0, 0, 1, 0x65, 1, 2, 3)
        val (a, b) = H264.paramSets(aud + sps + pps + idr)!!
        assertArrayEquals(sps, a)
        assertArrayEquals(byteArrayOf(0, 0, 0, 1, 0x68, 0x22, 0x33), b)
        assertNull(H264.paramSets(aud + idr))
    }

    @Test fun framesInOrder() {
        val o = FrameOrder()
        assertEquals(FrameOrder.Verdict.DROP, o.accept(1, false))    // no full frame yet
        assertEquals(FrameOrder.Verdict.DECODE, o.accept(2, true))
        assertEquals(FrameOrder.Verdict.DECODE, o.accept(3, false))
        assertEquals(FrameOrder.Verdict.DROP, o.accept(1, false))    // late
        assertEquals(FrameOrder.Verdict.BROKEN, o.accept(5, false))  // 4 went missing
        assertEquals(FrameOrder.Verdict.DROP, o.accept(6, false))    // until the next full one
        assertEquals(FrameOrder.Verdict.DECODE, o.accept(7, true))
        o.restart()
        assertEquals(FrameOrder.Verdict.DECODE, o.accept(0, true))   // a new session numbers from zero
    }
}
