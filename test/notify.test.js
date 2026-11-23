import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createECDH, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { Notifier, matchesPrefs, DEFAULT_PREFS } from '../server/notify.js';

function fakeState(data) {
  return { data: { subs: {}, seen: { ids: [], seededAt: null }, sent: {}, manual: [], ...data }, touch() {} };
}
const ev = (id, extra = {}) => ({ id, title: `活動 ${id}`, source: 'moc', category: '表演', district: '中壢區', start: '2026-12-20T14:00:00+08:00', ...extra });

test('第一次執行只記錄、不通知；之後只通知新的', async () => {
  const sent = [];
  const state = fakeState({ subs: { a: { subscription: {}, prefs: DEFAULT_PREFS, starred: [] } } });
  const n = new Notifier(state, { send: async (_s, p) => sent.push(p) });
  const r1 = await n.notifyNew([ev('1'), ev('2')]);
  assert.equal(r1.seeded, true);
  assert.equal(sent.length, 0);
  const r2 = await n.notifyNew([ev('1'), ev('2'), ev('3')]);
  assert.equal(r2.fresh, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /活動 3/);
  await n.notifyNew([ev('1'), ev('2'), ev('3')]);
  assert.equal(sent.length, 1, '同一個活動不會通知兩次');
});

test('一次超過 3 個新活動合併成一則', async () => {
  const sent = [];
  const state = fakeState({ seen: { ids: [], seededAt: 'x' }, subs: { a: { subscription: {}, prefs: DEFAULT_PREFS, starred: [] } } });
  const n = new Notifier(state, { send: async (_s, p) => sent.push(p) });
  await n.notifyNew(['1', '2', '3', '4', '5'].map((i) => ev(i)));
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /5 個新活動/);
});

test('篩選：類別、行政區、關鍵字、親子館預設不通知', () => {
  assert.equal(matchesPrefs(ev('1'), { ...DEFAULT_PREFS, categories: ['展覽'] }), false);
  assert.equal(matchesPrefs(ev('1', { city: '桃園市' }), { ...DEFAULT_PREFS, cities: ['臺北市'] }), false);
  assert.equal(matchesPrefs(ev('1', { city: '桃園市' }), { ...DEFAULT_PREFS, cities: ['桃園市'] }), true);
  assert.equal(matchesPrefs(ev('1', { categories: ['免費', '表演'] }), { ...DEFAULT_PREFS, categories: ['免費'] }), true, '多類別任一符合');
  assert.equal(matchesPrefs(ev('1', { title: '大溪市集' }), { ...DEFAULT_PREFS, categories: ['展覽'], keywords: ['市集'] }), true);
  assert.equal(matchesPrefs(ev('1', { category: '親子館' }), DEFAULT_PREFS), false);
  assert.equal(matchesPrefs(ev('1', { category: '親子館' }), { ...DEFAULT_PREFS, includeBabycare: true }), true);
  assert.equal(matchesPrefs(ev('1'), { ...DEFAULT_PREFS, notifyNew: false }), false);
});

test('收藏活動：開放報名前 1 天、30 分、5 分、開放當下各提醒一次，不重複', async () => {
  const sent = [];
  const reg = Date.parse('2026-12-15T10:00:00+08:00');
  const e = ev('w', { regStart: '2026-12-15T10:00:00+08:00', start: '2027-01-05T10:00:00+08:00' });
  const state = fakeState({ subs: { a: { subscription: {}, prefs: DEFAULT_PREFS, starred: ['w'] } } });
  const n = new Notifier(state, { send: async (_s, p) => sent.push(p.title) });
  for (const minutesBefore of [1440, 30, 5, 0]) {
    await n.remind([e], reg - minutesBefore * 60000 + 30000);
    await n.remind([e], reg - minutesBefore * 60000 + 90000); // 下一分鐘不重複
  }
  assert.deepEqual(sent, ['⏰ 1 天後開放報名', '⏰ 30 分鐘後開放報名', '⏰ 5 分鐘後開放報名', '🔔 現在開放報名了！']);
});

test('只有日期的開放報名：前一天晚上 8 點、當天早上 8 點', async () => {
  const sent = [];
  const e = ev('h', { regStart: '2026-12-05', start: '2027-01-06T19:00:00+08:00' });
  const state = fakeState({ subs: { a: { subscription: {}, prefs: { ...DEFAULT_PREFS, remindEventDayBefore: false }, starred: ['h'] } } });
  const n = new Notifier(state, { send: async (_s, p) => sent.push(p.title) });
  await n.remind([e], Date.parse('2026-12-04T20:05:00+08:00'));
  await n.remind([e], Date.parse('2026-12-05T08:05:00+08:00'));
  assert.deepEqual(sent, ['⏰ 明天開放報名', '🔔 今天開放報名']);
});

test('活動前一天早上 9 點提醒', async () => {
  const sent = [];
  const e = ev('d', { start: '2026-12-20T14:00:00+08:00' });
  const state = fakeState({ subs: { a: { subscription: {}, prefs: DEFAULT_PREFS, starred: ['d'] } } });
  const n = new Notifier(state, { send: async (_s, p) => sent.push(p.title) });
  await n.remind([e], Date.parse('2026-12-19T08:59:00+08:00'));
  assert.equal(sent.length, 0);
  await n.remind([e], Date.parse('2026-12-19T09:01:00+08:00'));
  assert.deepEqual(sent, ['明天的活動']);
});

test('訂閱失效（410）會被移除', async () => {
  const state = fakeState({ subs: { a: { subscription: {}, prefs: DEFAULT_PREFS, starred: [] } } });
  const n = new Notifier(state, { send: async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); } });
  assert.equal(await n.push('a', { title: 't' }), false);
  assert.equal(state.data.subs.a, undefined);
});

test('真的用 web-push 加密送到推播端點（假的推播服務）', async () => {
  const got = [];
  const server = createServer((req, res) => {
    let size = 0;
    req.on('data', (c) => (size += c.length));
    req.on('end', () => {
      got.push({ headers: req.headers, size });
      res.writeHead(201).end();
    });
  });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const keys = webpush.generateVAPIDKeys();
  webpush.setVapidDetails('mailto:test@example.com', keys.publicKey, keys.privateKey);
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const subscription = {
    endpoint: `http://127.0.0.1:${port}/push/abc`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
  // web-push 的送出只走 https，所以這裡用它產生「真的加密後的請求」，再用 fetch 送到本機假服務
  const send = async (sub, payload) => {
    const d = webpush.generateRequestDetails(sub, JSON.stringify(payload), { TTL: 60 });
    const res = await fetch(d.endpoint, { method: d.method, headers: d.headers, body: d.body });
    if (res.status !== 201) throw Object.assign(new Error('push failed'), { statusCode: res.status });
  };
  const state = fakeState({ subs: { a: { subscription, prefs: DEFAULT_PREFS, starred: [] } } });
  const n = new Notifier(state, { send });
  const ok = await n.push('a', { title: '測試', body: '內容' });
  server.close();
  assert.equal(ok, true);
  assert.equal(got.length, 1);
  assert.equal(got[0].headers['content-encoding'], 'aes128gcm');
  assert.match(got[0].headers.authorization, /^vapid t=/);
  assert.ok(got[0].size > 50, '有加密內容');
});
