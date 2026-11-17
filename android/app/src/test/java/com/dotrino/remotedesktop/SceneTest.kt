package com.dotrino.remotedesktop

import com.dotrino.remotedesktop.scene.Node
import com.dotrino.remotedesktop.scene.Patch
import com.dotrino.remotedesktop.scene.Scene
import com.dotrino.remotedesktop.scene.SceneError
import com.dotrino.remotedesktop.scene.SceneSync
import com.dotrino.remotedesktop.scene.Screen
import com.dotrino.remotedesktop.scene.Win
import com.dotrino.remotedesktop.scene.applyPatch
import com.dotrino.remotedesktop.scene.diff
import com.dotrino.remotedesktop.scene.hit
import com.dotrino.remotedesktop.scene.nodeOf
import com.dotrino.remotedesktop.scene.patchOf
import com.dotrino.remotedesktop.scene.sceneOf
import com.dotrino.remotedesktop.scene.screenOf
import com.dotrino.remotedesktop.scene.toJson
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** The same cases as `agent/test/scene.test.mjs`: what the agent computes and the phone applies must give the same screen. */
class SceneTest {
    private fun n(id: Int, r: String = "button", x: Int = id * 10, y: Int = 0, w: Int = 10, h: Int = 10, name: String? = null, t: String? = null) =
        Node(id = id, p = 0, r = r, x = x, y = y, w = w, h = h, n = name, t = t)
    private fun s(seq: Long, nodes: List<Node>, wins: List<Win> = emptyList()) = Scene(seq, Screen(100, 100), wins, nodes)

    @Test fun noChangesNoPatch() {
        assertNull(diff(s(1, listOf(n(1), n(2))), s(2, listOf(n(1), n(2)))))
    }

    @Test fun aTextChangesOnlyThatNodeTravelsWithoutOrder() {
        val p = diff(s(1, listOf(n(1), n(2))), s(2, listOf(n(1), n(2, t = "hola"))))!!
        assertEquals(listOf(2), p.put.map { it.id })
        assertEquals(emptyList<Int>(), p.del)
        assertNull(p.order)
    }

    @Test fun deleteAddReorderApplyingGivesTheNewScene() {
        val a = s(1, listOf(n(1), n(2), n(3)))
        val b = s(2, listOf(n(3), n(4), n(1, name = "x")), listOf(Win(9, "a", "w", true)))
        val p = diff(a, b)!!
        assertEquals(listOf(2), p.del)
        assertEquals(listOf(3, 4, 1), p.order)
        assertEquals(b, applyPatch(a, p))
    }

    @Test fun aPatchForAnotherSceneIsStale() {
        val p = diff(s(1, listOf(n(1))), s(2, listOf(n(1, t = "y"))))!!
        val e = assertThrows(SceneError::class.java) { applyPatch(s(5, listOf(n(1))), p) }
        assertEquals("stale", e.code)
    }

    @Test fun anOrderNamingAMissingNodeIsBad() {
        val e = assertThrows(SceneError::class.java) { applyPatch(s(1, listOf(n(1))), Patch(2, 1, emptyList(), emptyList(), order = listOf(1, 7))) }
        assertEquals("bad-patch", e.code)
    }

    @Test fun hitTheTopmostUnderThePoint() {
        val nodes = listOf(n(0, r = "frame", x = 0, y = 0, w = 100, h = 100), n(1, x = 10, y = 10, w = 20, h = 20))
        assertEquals(1, hit(nodes, 15, 15)!!.id)
        assertEquals(0, hit(nodes, 80, 80)!!.id)
        assertNull(hit(nodes, 200, 200))
    }

    @Test fun screenOfWhatTheWindowsSpan() {
        assertEquals(Screen(1920, 1080), screenOf(listOf(intArrayOf(0, 0, 1920, 1080), intArrayOf(100, 50, 400, 300))))
    }

    @Test fun theWireRoundTrips() {
        val node = Node(5, 1, "push button", 10, 20, 30, 40, n = "OK", s = "df", a = listOf("click"), hole = 1)
        assertEquals(node, nodeOf(node.toJson()))
        val msg = Json.parseToJsonElement("""{"type":"scene","seq":3,"screen":{"w":1400,"h":600},"wins":[{"id":1,"app":"A","name":"W","active":true}],"nodes":[{"id":1,"p":0,"r":"frame","x":0,"y":0,"w":100,"h":50.4,"n":"W"}]}""").jsonObject
        val sc = sceneOf(msg)!!
        assertEquals(3L, sc.seq); assertEquals(Screen(1400, 600), sc.screen); assertEquals(50, sc.nodes[0].h); assertTrue(sc.wins[0].active)
        val p = patchOf(Json.parseToJsonElement("""{"type":"patch","seq":4,"base":3,"put":[],"del":[1],"order":[]}""").jsonObject)!!
        assertEquals(listOf(1), p.del); assertEquals(emptyList<Int>(), p.order); assertNull(p.screen)
    }

    // ---------- out of order (the big one goes round by the proxy) ----------

    @Test fun aPatchThatComesEarlyWaitsForTheOneBefore() {
        val a = s(1, listOf(n(1), n(2)))
        val b = s(2, listOf(n(1, t = "b"), n(2)))
        val c = s(3, listOf(n(1, t = "b"), n(2, t = "c")))
        val sync = SceneSync()
        sync.onScene(a)
        assertNull(sync.onPatch(diff(b, c)!!))            // base 2: not yet
        assertTrue(sync.gap)
        val u = sync.onPatch(diff(a, b)!!)!!              // base 1: applies, and the waiting one after it
        assertEquals(c, u.scene)
        assertEquals(setOf(1, 2), u.changed)
        assertTrue(!sync.gap)
    }

    @Test fun patchesBeforeTheSceneWaitForIt() {
        val a = s(1, listOf(n(1)))
        val b = s(2, listOf(n(1, t = "b")))
        val sync = SceneSync()
        assertNull(sync.onPatch(diff(a, b)!!))
        assertEquals(b, sync.onScene(a)!!.scene)
    }

    @Test fun aLatePatchOrAnOlderSceneIsDropped() {
        val a = s(1, listOf(n(1)))
        val b = s(2, listOf(n(1, t = "b")))
        val sync = SceneSync()
        sync.onScene(b)
        assertNull(sync.onPatch(diff(a, b)!!))
        assertNull(sync.onScene(a))
        assertEquals(b, sync.scene)
    }
}
