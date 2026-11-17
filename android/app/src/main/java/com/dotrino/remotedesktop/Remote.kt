package com.dotrino.remotedesktop

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.dotrino.sdk.Delegation
import com.dotrino.sdk.DotrinoNetwork
import com.dotrino.sdk.PhoneIdentity
import com.dotrino.sdk.Profile
import com.dotrino.sdk.ProxyConnection
import com.dotrino.sdk.RemoteAgent
import com.dotrino.sdk.webrtc.WebRtcDirect
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** A machine of the account running the remote desktop agent, as the list shows it. */
data class Machine(val pubkey: String, val label: String) {
    /** `AB12-CD34`: the id `dotrino-vault members` shows for it. */
    val id: String get() = Delegation.keyLabel(pubkey)
}

/**
 * The phone's side of the ecosystem, ALL through dotrino-native (CONVENCIONES §16.2): the
 * profile (from the identity app), one connection to the proxy identified as the profile (direct
 * road first, TURN, the proxy last), the account's machines, and remote-agent sessions with them.
 * Nothing of the protocol or the crypto lives in this app. The same shape as Terminal's `Consoles`.
 */
object Remote {
    /** What the agent answers when asked what it is (`agent/link.js` LABEL). */
    const val KIND = "remote-desktop-agent"
    private const val DEFAULT_PROXY = "wss://proxy.dotrino.com"

    class BootError(message: String, val code: String) : Exception(message)

    @Volatile var profile: Profile? = null; private set
    private var identity: PhoneIdentity? = null
    private var conn: ProxyConnection? = null
    private val connLock = Mutex()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val ui = Handler(Looper.getMainLooper())
    @Volatile private var appContext: Context? = null

    /** The connection to the proxy: `online`, `connecting`, `offline`. */
    @Volatile var link = "connecting"; private set
    /** The connection changed state (main thread). */
    var onLink: () -> Unit = {}
    /** The connection dropped: every session over it is gone (main thread). Whoever had one opens another. */
    var onLost: () -> Unit = {}

    private fun linkChanged() = ui.post { onLink() }

    /** The phone's profile. Throws [BootError]: `no-identity-app`, `no-profile`, `no-profile-keys`, `no-vault`. */
    suspend fun boot(context: Context): Profile {
        appContext = context.applicationContext
        profile?.let { return it }
        val id = identity ?: PhoneIdentity(context.applicationContext).also { identity = it }
        val p = try { id.profile() } catch (e: Profile.ProfileError) { throw BootError(e.message ?: e.code, e.code) }
        // Without a vault there is no record that names other machines: nothing to connect to.
        if (p.vault == null) throw BootError("this profile is not linked to a vault", "no-vault")
        profile = p
        return p
    }

    /** Start over (the profile changed in the identity app). */
    fun forget() {
        profile = null
        conn?.close(); conn = null
    }

    /** The connection, identified as the profile. One at a time: two callers must not open two. */
    suspend fun connection(): ProxyConnection = connLock.withLock {
        conn?.let { return it }
        val p = profile ?: throw BootError("no profile", "no-profile")
        link = "connecting"; linkChanged()
        val c = ProxyConnection(p.vault?.proxy ?: DEFAULT_PROXY, "remote-desktop")
        // The most direct road first (CLAUDE.md, 2026-09-03): the session goes by WebRTC (direct,
        // or through TURN) as soon as the channel opens; the proxy is the last resort. The agent
        // sends the picture of a window at full quality only over a direct road.
        appContext?.let { c.useDirect(WebRtcDirect(it)) }
        try {
            c.connect()
            c.identifyAs(p.publickey) { p.signData(it) }
        } catch (e: Exception) { c.close(); link = "offline"; linkChanged(); throw e }
        c.enableTurn(p.publickey) { p.signData(it) }
        conn = c; link = "online"; linkChanged()
        // The topbar's network stats see this connection.
        DotrinoNetwork.register(c.statsSource)
        scope.launch {
            c.awaitClosed()
            DotrinoNetwork.unregister(c.statsSource)
            connLock.withLock { if (conn === c) conn = null }
            link = "offline"; linkChanged()
            ui.post { onLost() }
        }
        c
    }

    /** Drop the connection (the app came back from the background and it did not answer). */
    suspend fun dropConnection() { connLock.withLock { conn }?.close() }

    /** Reconnect with back-off while [wanted] says so. */
    suspend fun reconnect(wanted: () -> Boolean): ProxyConnection? {
        var wait = 1_000L
        while (profile != null && wanted()) {
            try { return connection() } catch (_: Exception) { delay(wait); wait = minOf(wait * 2, 30_000) }
        }
        return null
    }

    /** The account's machines that are ON and run the remote desktop agent (asked what they are). */
    suspend fun machines(): List<Machine> {
        val p = profile ?: throw BootError("no profile", "no-profile")
        val candidates = RemoteAgent.candidates(p)
        val found = RemoteAgent.probe(connection(), candidates.map { it.first })
        return candidates.filter { found[it.first] == KIND }
            .map { (pub, label) -> Machine(pub, label?.takeIf { it.isNotBlank() } ?: Delegation.keyLabel(pub)) }
            .sortedBy { it.label.lowercase() }
    }

    /**
     * A session with [machine]. If its paper names a record newer than the phone's (the vault
     * changed it), the phone catches up from the vault once and keeps the new record.
     */
    suspend fun open(machine: Machine): RemoteAgent.Session {
        val p = profile ?: throw BootError("no profile", "no-profile")
        val c = connection()
        return RemoteAgent.open(p, c, machine.pubkey, catchUp = {
            val id = identity ?: throw BootError("no identity", "no-identity-app")
            id.catchUp(p, c).also { profile = it }
        })
    }
}
