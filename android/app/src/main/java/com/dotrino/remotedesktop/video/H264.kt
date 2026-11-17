package com.dotrino.remotedesktop.video

/**
 * What the app needs to know of the agent's H.264 stream (`agent/video.js`): baseline, Annex B,
 * an AUD before each frame, and SPS/PPS inside every full frame. No decoding here: that is
 * MediaCodec's. Pure functions, tested on the JVM.
 */
object H264 {
    const val NAL_SPS = 7
    const val NAL_PPS = 8

    /** Where each NAL unit's payload starts and ends (after its 3- or 4-byte start code). */
    fun nalUnits(b: ByteArray): List<IntRange> {
        val starts = ArrayList<Int>()      // index of the first payload byte
        val codes = ArrayList<Int>()       // index of the start code
        var i = 0
        while (i + 2 < b.size) {
            if (b[i].toInt() == 0 && b[i + 1].toInt() == 0 && b[i + 2].toInt() == 1) {
                codes.add(if (i > 0 && b[i - 1].toInt() == 0) i - 1 else i)
                starts.add(i + 3); i += 3
            } else i++
        }
        return starts.indices.map { k -> starts[k] until (if (k + 1 < starts.size) codes[k + 1] else b.size) }
    }

    fun nalType(b: ByteArray, r: IntRange): Int = if (r.isEmpty()) -1 else b[r.first].toInt() and 0x1f

    /** SPS and PPS of a full frame, each with a 4-byte start code (MediaCodec's csd-0 / csd-1); null if missing. */
    fun paramSets(b: ByteArray): Pair<ByteArray, ByteArray>? {
        var sps: ByteArray? = null; var pps: ByteArray? = null
        for (r in nalUnits(b)) {
            when (nalType(b, r)) {
                NAL_SPS -> if (sps == null) sps = START + b.copyOfRange(r.first, r.last + 1)
                NAL_PPS -> if (pps == null) pps = START + b.copyOfRange(r.first, r.last + 1)
            }
        }
        return if (sps != null && pps != null) sps to pps else null
    }

    private val START = byteArrayOf(0, 0, 0, 1)
}

/**
 * Frames in order. The agent numbers every frame it sends in a session (`seq`), and each capture
 * starts with a full one. On the phone a full frame (~60 KB) is too big for the direct channel and
 * goes round through the proxy, so the small ones behind it can arrive first. A frame is decoded
 * only if it follows the last one decoded, or if it is a newer full frame; an older one is
 * dropped; a gap after decoding means the picture is broken until the next full frame, and is said
 * ([Verdict.BROKEN]) so the capture can be asked again.
 */
class FrameOrder {
    enum class Verdict { DECODE, DROP, BROKEN }
    private var last = -1L
    private var waitingKey = true

    fun accept(seq: Long, key: Boolean): Verdict {
        if (seq <= last) return Verdict.DROP
        if (key) { last = seq; waitingKey = false; return Verdict.DECODE }
        if (waitingKey) return Verdict.DROP
        if (seq != last + 1) { waitingKey = true; return Verdict.BROKEN }
        last = seq
        return Verdict.DECODE
    }

    /** A new stream (another hole, the capture asked again): wait for its full frame. */
    fun reset() { waitingKey = true }

    /** A new session: the agent numbers from zero again. */
    fun restart() { waitingKey = true; last = -1 }
}
