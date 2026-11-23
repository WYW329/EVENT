// Web Push（RFC 8291 aes128gcm 加密 + RFC 8292 VAPID 簽章），只用 Web Crypto，Cloudflare Workers 和 Node 都能跑。

const enc = new TextEncoder();

export function b64urlDecode(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlEncode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** 加密推播內容（aes128gcm，單一 record）。可以傳入固定的 salt／金鑰做測試。 */
export async function encryptPayload(subscription, payload, { salt, localKeys } = {}) {
  const uaPublic = b64urlDecode(subscription.keys.p256dh);
  const authSecret = b64urlDecode(subscription.keys.auth);
  const keys = localKeys ?? (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, keys.privateKey, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const saltBytes = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(saltBytes, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(saltBytes, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const plain = concat(typeof payload === 'string' ? enc.encode(payload) : payload, new Uint8Array([2])); // 0x02 = 最後一個 record
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plain));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(saltBytes, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

const jwtCache = new Map();

/** VAPID 簽章（同一個推播服務 12 小時內共用，省運算時間）。 */
export async function vapidAuth(endpoint, { publicKey, privateKey, subject }) {
  const aud = new URL(endpoint).origin;
  const cached = jwtCache.get(aud);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - now > 3600) return cached.header;
  const pub = b64urlDecode(publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', d: privateKey, x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const exp = now + 12 * 3600;
  const head = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64urlEncode(enc.encode(JSON.stringify({ aud, exp, sub: subject || 'mailto:admin@example.com' })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`)));
  const header = `vapid t=${head}.${body}.${b64urlEncode(sig)}, k=${publicKey}`;
  jwtCache.set(aud, { exp, header });
  return header;
}

/** 送出一則推播。回傳 HTTP 狀態碼（201/200 成功；404/410 代表訂閱已失效）。 */
export async function sendPush(subscription, payload, vapid, { ttl = 6 * 3600, urgency = 'high', fetchImpl = fetch } = {}) {
  const body = await encryptPayload(subscription, JSON.stringify(payload));
  const res = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuth(subscription.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
  });
  return res.status;
}
