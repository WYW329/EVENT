// 驗證自己寫的 Web Push 加密：用 web-push 套件裡獨立的 http_ece 解密回來，並驗證 VAPID 簽章。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes, createPublicKey, verify } from 'node:crypto';
import ece from 'http_ece';
import webpush from 'web-push';
import { encryptPayload, vapidAuth, sendPush, b64urlDecode } from '../src/push.js';

function makeSubscriber() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, subscription: { endpoint: 'https://push.example.com/send/abc', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } };
}

test('加密後可以被 http_ece（web-push 用的實作）解密回原文', async () => {
  const s = makeSubscriber();
  const msg = JSON.stringify({ title: '測試 ✅', body: '中文內容' });
  const body = await encryptPayload(s.subscription, msg);
  const plain = ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: s.ecdh, authSecret: s.auth });
  assert.equal(plain.toString('utf8'), msg);
});

test('VAPID 簽章可以用公鑰驗證，aud 是推播服務的網域', async () => {
  const keys = webpush.generateVAPIDKeys();
  const header = await vapidAuth('https://fcm.googleapis.com/fcm/send/xyz', { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:a@b.c' });
  const m = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m, header);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.ok(claims.exp > Date.now() / 1000);
  const pub = b64urlDecode(keys.publicKey);
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(pub.slice(1, 33)).toString('base64url'), y: Buffer.from(pub.slice(33)).toString('base64url') }, format: 'jwk' });
  const ok = verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'));
  assert.equal(ok, true);
  assert.equal(m[4], keys.publicKey);
});

test('sendPush 送出的請求格式正確', async () => {
  const s = makeSubscriber();
  const keys = webpush.generateVAPIDKeys();
  let captured;
  const status = await sendPush(s.subscription, { title: 'hi' }, { publicKey: keys.publicKey, privateKey: keys.privateKey }, {
    fetchImpl: async (url, init) => { captured = { url, init }; return { status: 201 }; },
  });
  assert.equal(status, 201);
  assert.equal(captured.url, s.subscription.endpoint);
  assert.equal(captured.init.headers['Content-Encoding'], 'aes128gcm');
  assert.match(captured.init.headers.Authorization, /^vapid t=/);
  const plain = ece.decrypt(Buffer.from(captured.init.body), { version: 'aes128gcm', privateKey: s.ecdh, authSecret: s.auth });
  assert.deepEqual(JSON.parse(plain.toString()), { title: 'hi' });
});
