/**
 * vault.js — la identidad del ecosistema (iframe id.dotrino.com) y el enlace de este aparato
 * con la bóveda. El enlace lo hace el pilar: esta app no guarda ningún enrolamiento propio.
 */
import { Identity } from '@dotrino/identity'
import { linkFromIdentity } from '@dotrino/remote-agent/browser-link'

/** @type {Identity | null} */
let _id = null

/**
 * La identidad, conectada una vez. En desarrollo (`localhost`) se puede apuntar a un iframe
 * local con `?vault=<url>`; fuera de localhost no, o un enlace podría llevar tu identidad a un
 * iframe ajeno.
 */
export async function identity () {
  if (!_id) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
    const url = local ? new URLSearchParams(location.search).get('vault') : null
    _id = await Identity.connect(url ? { vaultUrl: url } : {})
  }
  return _id
}

/** El enlace de ESTE aparato: `{ paired:false }` o `{ paired:true, id, cert, iss, proxy, … }`. */
export async function getLink () {
  return linkFromIdentity(await identity())
}
