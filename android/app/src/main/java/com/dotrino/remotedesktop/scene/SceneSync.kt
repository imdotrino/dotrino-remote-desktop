package com.dotrino.remotedesktop.scene

/**
 * Keeps the scene in step with what arrives, IN THE ORDER IT WAS MEANT.
 *
 * On the phone, what is bigger than one message of the direct channel (64 KiB: a whole scene, a
 * patch with many nodes) goes around through the proxy, and the small patches that follow can
 * overtake it (dotrino-native does not reassemble the pillar's `parts` yet). The PWA, which does,
 * asks for the whole scene as soon as a patch does not fit. Here a patch that comes EARLY (its
 * base is ahead of the scene) waits a moment for the ones before it; one that comes LATE (its
 * base is behind) is dropped, its content is already in the scene. Only a real gap asks for the
 * whole scene again — [gap] says when, the caller decides how long to wait.
 */
class SceneSync {
    var scene: Scene? = null; private set
    private val early = sortedMapOf<Long, Patch>()

    /** What changed on screen: [changed] = the nodes to redraw (null = all), [reordered] = the paint order. */
    data class Update(val scene: Scene, val changed: Set<Int>?, val reordered: Boolean)

    /** There are patches waiting for one that has not arrived. */
    val gap: Boolean get() = early.isNotEmpty()

    /** A whole scene. An older one than what is shown (it went the long way round) is dropped. */
    fun onScene(s: Scene): Update? {
        val cur = scene
        if (cur != null && s.seq < cur.seq) return null
        scene = s
        drain()
        return Update(scene ?: s, null, true)
    }

    /**
     * A patch. Returns what to redraw, or null when nothing changes yet (it waits, or it was old).
     * Throws [SceneError] `bad-patch` when it names nodes it does not carry: then the whole scene.
     */
    fun onPatch(p: Patch): Update? {
        val cur = scene
        if (cur == null || p.base > cur.seq) { early[p.base] = p; trim(); return null }
        if (p.base < cur.seq) return null
        val first = apply(cur, p)
        val more = drain()
        return if (more == null) first else Update(more.scene, union(first.changed, more.changed), first.reordered || more.reordered)
    }

    /** Forget what waits (the whole scene was asked for again). */
    fun dropEarly() = early.clear()

    /** Start over (another machine, a new session). */
    fun reset() { scene = null; early.clear() }

    private fun apply(cur: Scene, p: Patch): Update {
        val next = applyPatch(cur, p)
        scene = next
        return Update(next, p.put.mapTo(HashSet()) { it.id }, p.order != null)
    }

    private fun drain(): Update? {
        var acc: Update? = null
        while (true) {
            val cur = scene ?: return acc
            early.headMap(cur.seq).clear()
            val p = early.remove(cur.seq) ?: return acc
            val u = apply(cur, p)
            acc = if (acc == null) u else Update(u.scene, union(acc.changed, u.changed), acc.reordered || u.reordered)
        }
    }

    /** Nothing waits for ever: past a few, the oldest goes (the whole scene will be asked for). */
    private fun trim() { while (early.size > MAX_EARLY) early.remove(early.firstKey()) }

    private fun union(a: Set<Int>?, b: Set<Int>?): Set<Int>? = if (a == null || b == null) null else a + b

    companion object { const val MAX_EARLY = 32 }
}
