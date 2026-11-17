package com.dotrino.remotedesktop.scene

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put

/**
 * The SCENE: what is on the machine's screen, as accessibility nodes, and what changed since the
 * last time. A port of `agent/scene.js` (pure functions, no network), tested against the same cases
 * as `agent/test/scene.test.mjs`. The wire:
 *
 *   { type:'scene', seq, screen:{w,h}, wins:[{id,app,name,active}], nodes:[Node…] }   whole
 *   { type:'patch', seq, base, screen?, wins?, order?, put:[Node…], del:[id…] }      what changed
 */

/** One node as it travels (`agent/atspi.js`): role [r], name [n], text [t], rect, states [s], actions [a]. */
data class Node(
    val id: Int, val p: Int, val r: String,
    val x: Int, val y: Int, val w: Int, val h: Int,
    val n: String? = null, val t: String? = null, val s: String? = null,
    val a: List<String>? = null, val hole: Int? = null,
) {
    val isHole: Boolean get() = hole != null && hole != 0
    fun contains(px: Int, py: Int) = px >= x && py >= y && px < x + w && py < y + h
}

data class Win(val id: Int, val app: String, val name: String, val active: Boolean)
data class Screen(val w: Int, val h: Int)
data class Scene(val seq: Long, val screen: Screen, val wins: List<Win>, val nodes: List<Node>)
data class Patch(
    val seq: Long, val base: Long, val put: List<Node>, val del: List<Int>,
    val screen: Screen? = null, val wins: List<Win>? = null, val order: List<Int>? = null,
)

/** A patch that does not fit this scene: `stale` (another base) or `bad-patch` (the order names a missing node). */
class SceneError(message: String, val code: String) : Exception(message)

/** Two equal nodes, field by field (the ones that travel). `a` missing and empty are the same. */
fun sameNode(a: Node, b: Node): Boolean {
    if (a.p != b.p || a.r != b.r || a.x != b.x || a.y != b.y || a.w != b.w || a.h != b.h) return false
    if (a.n != b.n || a.t != b.t || a.s != b.s || a.hole != b.hole) return false
    return (a.a ?: emptyList<String>()) == (b.a ?: emptyList<String>())
}

/** What changed from [prev] to [next]; null when nothing did (a still screen sends nothing). */
fun diff(prev: Scene, next: Scene): Patch? {
    val before = prev.nodes.associateBy { it.id }
    val put = ArrayList<Node>()
    val nextIds = HashSet<Int>()
    for (n in next.nodes) {
        nextIds.add(n.id)
        val o = before[n.id]
        if (o == null || !sameNode(o, n)) put.add(n)
    }
    val del = before.keys.filter { it !in nextIds }
    val kept = prev.nodes.filter { it.id in nextIds }.map { it.id }
    val keptNext = next.nodes.filter { it.id in before }.map { it.id }
    val added = next.nodes.any { it.id !in before }
    val reordered = added || kept != keptNext
    val screenChanged = prev.screen != next.screen
    val winsChanged = prev.wins != next.wins
    if (put.isEmpty() && del.isEmpty() && !reordered && !screenChanged && !winsChanged) return null
    return Patch(
        seq = next.seq, base = prev.seq, put = put, del = del,
        screen = if (screenChanged) next.screen else null,
        wins = if (winsChanged) next.wins else null,
        order = if (reordered) next.nodes.map { it.id } else null,
    )
}

/** Applies a patch. Throws `stale` if it is not for this scene: painting it would leave the screen half done. */
fun applyPatch(scene: Scene, patch: Patch): Scene {
    if (patch.base != scene.seq) throw SceneError("patch for ${patch.base}, scene is ${scene.seq}", "stale")
    val byId = LinkedHashMap<Int, Node>(scene.nodes.size * 2)
    for (n in scene.nodes) byId[n.id] = n
    for (id in patch.del) byId.remove(id)
    for (n in patch.put) byId[n.id] = n
    val nodes = if (patch.order != null) {
        patch.order.map { id -> byId[id] ?: throw SceneError("order names node $id, which the patch does not carry", "bad-patch") }
    } else {
        scene.nodes.mapNotNull { byId[it.id] }
    }
    return Scene(patch.seq, patch.screen ?: scene.screen, patch.wins ?: scene.wins, nodes)
}

/** The desktop's size: what the windows span (`ext` = x, y, w, h). */
fun screenOf(exts: List<IntArray>): Screen {
    var w = 0; var h = 0
    for (e in exts) { w = maxOf(w, e[0] + e[2]); h = maxOf(h, e[1] + e[3]) }
    return Screen(w, h)
}

/** The node under a point: the last one in paint order that holds it (the topmost). */
fun hit(nodes: List<Node>, x: Int, y: Int): Node? {
    for (i in nodes.indices.reversed()) if (nodes[i].contains(x, y)) return nodes[i]
    return null
}

// ---------- the wire (JSON) ----------

private fun JsonElement?.num(): Double? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
private fun JsonElement?.int(): Int? = num()?.let { Math.round(it).toInt() }
private fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
private fun JsonElement?.bool(): Boolean = (this as? JsonPrimitive)?.content == "true"

/** One node from the wire; null if it lacks what it needs (an id and a rect). */
fun nodeOf(o: JsonObject): Node? {
    val id = o["id"].int() ?: return null
    return Node(
        id = id, p = o["p"].int() ?: 0, r = o["r"].str() ?: "unknown",
        x = o["x"].int() ?: return null, y = o["y"].int() ?: return null,
        w = o["w"].int() ?: return null, h = o["h"].int() ?: return null,
        n = o["n"].str(), t = o["t"].str(), s = o["s"].str(),
        a = (o["a"] as? JsonArray)?.mapNotNull { it.str() },
        hole = o["hole"].int(),
    )
}

private fun screenOf(o: JsonElement?): Screen? = (o as? JsonObject)?.let { Screen(it["w"].int() ?: 0, it["h"].int() ?: 0) }
private fun winsOf(o: JsonElement?): List<Win>? = (o as? JsonArray)?.mapNotNull { e ->
    val w = e as? JsonObject ?: return@mapNotNull null
    Win(w["id"].int() ?: return@mapNotNull null, w["app"].str().orEmpty(), w["name"].str().orEmpty(), w["active"].bool())
}
private fun nodesOf(o: JsonElement?): List<Node> = (o as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.let(::nodeOf) }

/** A whole scene from the agent (`type: 'scene'`). */
fun sceneOf(o: JsonObject): Scene? {
    val seq = o["seq"].num()?.toLong() ?: return null
    return Scene(seq, screenOf(o["screen"]) ?: Screen(0, 0), winsOf(o["wins"]).orEmpty(), nodesOf(o["nodes"]))
}

/** A patch from the agent (`type: 'patch'`). */
fun patchOf(o: JsonObject): Patch? {
    val seq = o["seq"].num()?.toLong() ?: return null
    val base = o["base"].num()?.toLong() ?: return null
    return Patch(
        seq = seq, base = base, put = nodesOf(o["put"]),
        del = (o["del"] as? JsonArray).orEmpty().mapNotNull { it.int() },
        screen = screenOf(o["screen"]), wins = winsOf(o["wins"]),
        order = (o["order"] as? JsonArray)?.mapNotNull { it.int() },
    )
}

/** A node back to JSON (for the tests' round trip). */
fun Node.toJson(): JsonObject = buildJsonObject {
    put("id", id); put("p", p); put("r", r); put("x", x); put("y", y); put("w", w); put("h", h)
    n?.let { put("n", it) }; t?.let { put("t", it) }; s?.let { put("s", it) }
    a?.let { list -> put("a", buildJsonArray { list.forEach { add(JsonPrimitive(it)) } }) }
    hole?.let { put("hole", it) }
}
