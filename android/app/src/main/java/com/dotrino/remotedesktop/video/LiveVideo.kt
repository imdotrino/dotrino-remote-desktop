package com.dotrino.remotedesktop.video

import android.content.Context
import android.graphics.Bitmap
import android.graphics.SurfaceTexture
import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log
import android.view.Surface
import android.view.TextureView
import com.dotrino.remotedesktop.scene.Rect
import java.nio.ByteBuffer

/**
 * The LIVE video of one hole (`agent/video.js`): H.264 baseline, Annex B, decoded by MediaCodec
 * straight onto a [TextureView] that sits over the hole's place in the scene. The view has the
 * hole's size in the MACHINE's pixels; the stage moves and scales it with the rest of the view
 * (translation and scale, no relayout), so it zooms and pans with the scene for free.
 *
 * Only one hole gets live video at a time. When it stops, [snapshot] keeps its last picture: the
 * stage draws that frozen in its place (the PWA does the same).
 *
 * Decoding runs on its own thread; [frame] may be called from any thread.
 */
class LiveVideo(context: Context, private val onError: (Exception) -> Unit) {
    val view = TextureView(context).apply { isOpaque = false; alpha = 0f }
    /** The hole receiving live video, and where it is (machine pixels). */
    @Volatile var liveId: Int? = null; private set
    @Volatile var rect: Rect? = null; private set
    /** The first picture of the current stream reached the screen (main thread). */
    var onRendered: () -> Unit = {}

    private val thread = HandlerThread("remote-desktop-video").apply { start() }
    private val worker = Handler(thread.looper)
    private val main = Handler(Looper.getMainLooper())
    private var surface: Surface? = null
    private var codec: MediaCodec? = null
    private var codecSize = 0 to 0
    private var params: Pair<ByteArray, ByteArray>? = null
    private var pts = 0L
    @Volatile private var shown = false

    init {
        view.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
            override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) {
                val s = Surface(st)
                worker.post { surface = s }
            }
            override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {}
            override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
                worker.post { release(); surface?.release(); surface = null }
                return true
            }
            override fun onSurfaceTextureUpdated(st: SurfaceTexture) {
                if (!shown && liveId != null) { shown = true; view.alpha = 1f; onRendered() }
            }
        }
    }

    /** A frame of hole [id] (already in order: [FrameOrder] decided). Starts a new stream if the hole changed. */
    fun frame(id: Int, key: Boolean, r: Rect, data: ByteArray) {
        if (id != liveId) { liveId = id; shown = false; main.post { view.alpha = 0f } }
        rect = r
        worker.post { decode(key, r, data) }
    }

    /** Stop the live video (the last picture should be taken first, with [snapshot]). */
    fun stop() {
        liveId = null; shown = false
        view.alpha = 0f
        worker.post { release() }
    }

    /** The last picture on screen, to keep it frozen in its place. Main thread. */
    fun snapshot(): Bitmap? = if (shown) runCatching { view.bitmap }.getOrNull() else null

    fun shutdown() { worker.post { release() }; thread.quitSafely() }

    // ---------- decoder thread ----------

    private fun decode(key: Boolean, r: Rect, data: ByteArray) {
        val s = surface ?: return
        try {
            if (key) {
                val ps = H264.paramSets(data)
                val p = params
                if (ps != null && (codec == null || codecSize != r.w to r.h || p == null || !p.first.contentEquals(ps.first) || !p.second.contentEquals(ps.second))) {
                    start(s, r.w, r.h, ps)
                }
            }
            val c = codec ?: return
            val idx = c.dequeueInputBuffer(20_000)
            if (idx < 0) { Log.w(TAG, "decoder busy: frame dropped"); return }
            val buf: ByteBuffer = c.getInputBuffer(idx) ?: return
            buf.clear()
            if (buf.capacity() < data.size) { c.queueInputBuffer(idx, 0, 0, pts, 0); Log.w(TAG, "frame bigger than the decoder's buffer"); return }
            buf.put(data)
            c.queueInputBuffer(idx, 0, data.size, pts, if (key) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
            pts += 66_666
            drain(c)
        } catch (e: Exception) {
            Log.w(TAG, "decode failed: ${e.message}")
            release()
            main.post { onError(e) }
        }
    }

    private fun start(s: Surface, w: Int, h: Int, ps: Pair<ByteArray, ByteArray>) {
        release()
        main.post { view.surfaceTexture?.setDefaultBufferSize(w, h) }
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
            setByteBuffer("csd-0", ByteBuffer.wrap(ps.first))
            setByteBuffer("csd-1", ByteBuffer.wrap(ps.second))
            setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, maxOf(w * h, 256 * 1024))
        }
        val c = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        c.configure(format, s, null, 0)
        c.start()
        codec = c; codecSize = w to h; params = ps
    }

    private fun drain(c: MediaCodec) {
        val info = MediaCodec.BufferInfo()
        while (true) {
            val out = c.dequeueOutputBuffer(info, 5_000)
            when {
                out >= 0 -> c.releaseOutputBuffer(out, true)
                out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> continue
                else -> return
            }
        }
    }

    private fun release() {
        val c = codec ?: return
        codec = null; params = null
        runCatching { c.stop() }
        runCatching { c.release() }
    }

    private companion object { const val TAG = "remote-desktop" }
}
