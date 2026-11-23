// 網站伺服器：提供網頁 App、活動資料、推播訂閱、收藏、手動加入、行事曆檔，並且每分鐘檢查要不要發通知。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { State, makeBackend } from './store.js';
import { Notifier, DEFAULT_PREFS, subId, setupWebPush } from './notify.js';
import { parseManualText } from './parse.js';
import { makeEvent, findDistrict, guessCategory, toMs, dateOf, todayTaipei } from '../scraper/util.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 8787);
const EVENTS_URL = process.env.EVENTS_URL; // 例如 https://raw.githubusercontent.com/<帳號>/<repo>/main/data/events.json
const STATUS_URL = process.env.STATUS_URL || (EVENTS_URL ? EVENTS_URL.replace(/events\.json$/, 'status.json') : null);
const MANUAL_KEY = process.env.MANUAL_KEY || '';
const TICK_MS = Number(process.env.TICK_MS ?? 60000);

const pushReady = setupWebPush();
const state = await new State(makeBackend()).init();
const notifier = new Notifier(state);

// ---------- 活動資料（抓取結果每 5 分鐘重新讀一次，再加上手動加入的） ----------
let cache = { at: 0, data: { updatedAt: null, events: [] }, status: null };

async function loadJson(url, file) {
  if (url) {
    const res = await fetch(`${url}?t=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  return JSON.parse(await readFile(join(ROOT, 'data', file), 'utf8'));
}

async function scraped(force = false) {
  if (!force && Date.now() - cache.at < 5 * 60000) return cache;
  try {
    const [data, status] = await Promise.all([loadJson(EVENTS_URL, 'events.json'), loadJson(STATUS_URL, 'status.json').catch(() => null)]);
    cache = { at: Date.now(), data, status };
  } catch (err) {
    console.error('[events]', err.message);
    cache.at = Date.now() - 4 * 60000; // 1 分鐘後再試
  }
  return cache;
}

async function allEvents(force) {
  const { data } = await scraped(force);
  const today = todayTaipei();
  const manual = state.data.manual.filter((e) => (dateOf(e.end ?? e.start) ?? today) >= today || (e.regStart && toMs(e.regStart) > Date.now()));
  return [...manual, ...data.events];
}

// ---------- 小工具 ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 200_000) throw Object.assign(new Error('內容太大'), { status: 413 });
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function cleanPrefs(p = {}) {
  const out = { ...DEFAULT_PREFS };
  if (typeof p.notifyNew === 'boolean') out.notifyNew = p.notifyNew;
  if (typeof p.includeBabycare === 'boolean') out.includeBabycare = p.includeBabycare;
  if (typeof p.remindEventDayBefore === 'boolean') out.remindEventDayBefore = p.remindEventDayBefore;
  for (const k of ['categories', 'districts', 'keywords']) if (Array.isArray(p[k])) out[k] = p[k].map(String).map((s) => s.trim()).filter(Boolean).slice(0, 30);
  if (Array.isArray(p.remindMinutes)) out.remindMinutes = [...new Set(p.remindMinutes.map(Number).filter((n) => n > 0 && n <= 10080))].slice(0, 5);
  return out;
}

// ---------- 行事曆檔（.ics），內建提醒 ----------
function icsTime(iso) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return `;VALUE=DATE:${iso.replace(/-/g, '')}`;
  return `:${new Date(toMs(iso)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
}
const icsEscape = (s) => String(s ?? '').replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
function nextDay(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function buildIcs(e, kind) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//taoyuan-events//ZH', 'CALSCALE:GREGORIAN'];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const desc = [e.summary, e.url ? `報名／詳情：${e.url}` : null].filter(Boolean).join('\n\n');
  const add = (uid, title, start, end, alarms) => {
    lines.push('BEGIN:VEVENT', `UID:${uid}@taoyuan-events`, `DTSTAMP:${stamp}`, `SUMMARY:${icsEscape(title)}`, `DTSTART${icsTime(start)}`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(start)) lines.push(`DTEND;VALUE=DATE:${nextDay(end && /^\d{4}-\d{2}-\d{2}$/.test(end) ? end : start).replace(/-/g, '')}`);
    else lines.push(`DTEND${icsTime(end && end !== start ? end : new Date(toMs(start) + 30 * 60000).toISOString())}`);
    if (e.venue || e.address) lines.push(`LOCATION:${icsEscape(e.address || e.venue)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
    for (const a of alarms) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(title)}`, `TRIGGER:${a}`, 'END:VALARM');
    lines.push('END:VEVENT');
  };
  if (kind !== 'event' && e.regStart) add(`reg-${e.id}`, `開放報名：${e.title}`, e.regStart, e.regStart, ['-P1D', '-PT30M', '-PT5M', 'PT0M']);
  if (kind !== 'reg' && e.start) add(`ev-${e.id}`, e.title, e.start, e.end, ['-P1D']);
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// ---------- 定時檢查 ----------
let lastTick = null;
let ticking = false;
async function tick() {
  if (ticking) return lastTick;
  ticking = true;
  try {
    const events = await allEvents();
    const a = await notifier.notifyNew(events);
    const b = await notifier.remind(events);
    lastTick = { at: new Date().toISOString(), events: events.length, subs: Object.keys(state.data.subs).length, ...a, remindersSent: b.sent };
  } catch (err) {
    lastTick = { at: new Date().toISOString(), error: err.message };
  } finally {
    ticking = false;
  }
  return lastTick;
}

// ---------- 路由 ----------
async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/events' && m === 'GET') {
    const events = await allEvents();
    const { data, status } = await scraped();
    return send(res, 200, { updatedAt: data.updatedAt, events, status, manualNeedsKey: Boolean(MANUAL_KEY) });
  }
  if (p === '/api/vapid' && m === 'GET') return send(res, 200, { publicKey: process.env.VAPID_PUBLIC_KEY ?? null, ready: pushReady });

  if (p === '/api/subscribe' && m === 'POST') {
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh) return send(res, 400, { error: '訂閱資料不完整' });
    const id = subId(sub.endpoint);
    const prev = state.data.subs[id];
    state.data.subs[id] = {
      subscription: sub,
      prefs: cleanPrefs(body.prefs ?? prev?.prefs),
      starred: [...new Set([...(prev?.starred ?? []), ...(Array.isArray(body.starred) ? body.starred.map(String) : [])])].slice(0, 500),
      ua: String(req.headers['user-agent'] ?? '').slice(0, 120),
      createdAt: prev?.createdAt ?? new Date().toISOString(),
    };
    state.touch();
    return send(res, 200, { id, prefs: state.data.subs[id].prefs, starred: state.data.subs[id].starred });
  }

  const subOf = (id) => state.data.subs[String(id ?? '')];

  if (p === '/api/me' && m === 'GET') {
    const s = subOf(url.searchParams.get('id'));
    if (!s) return send(res, 404, { error: '找不到訂閱' });
    return send(res, 200, { prefs: s.prefs, starred: s.starred });
  }
  if (p === '/api/prefs' && m === 'POST') {
    const body = await readBody(req);
    const s = subOf(body.id);
    if (!s) return send(res, 404, { error: '找不到訂閱' });
    s.prefs = cleanPrefs(body.prefs);
    state.touch();
    return send(res, 200, { prefs: s.prefs });
  }
  if (p === '/api/star' && m === 'POST') {
    const body = await readBody(req);
    const s = subOf(body.id);
    if (!s) return send(res, 404, { error: '找不到訂閱' });
    const set = new Set(s.starred ?? []);
    if (body.on) set.add(String(body.eventId));
    else set.delete(String(body.eventId));
    s.starred = [...set].slice(-500);
    state.touch();
    return send(res, 200, { starred: s.starred });
  }
  if (p === '/api/unsubscribe' && m === 'POST') {
    const body = await readBody(req);
    delete state.data.subs[String(body.id)];
    state.touch();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/test-push' && m === 'POST') {
    const body = await readBody(req);
    if (!pushReady) return send(res, 503, { error: '伺服器還沒設定推播金鑰' });
    if (!subOf(body.id)) return send(res, 404, { error: '找不到訂閱' });
    const ok = await notifier.push(String(body.id), { title: '測試通知 ✅', body: '收到這則就代表通知設定成功了！', url: '/', tag: 'test' });
    return send(res, ok ? 200 : 502, { ok });
  }

  if (p === '/api/parse' && m === 'POST') {
    const body = await readBody(req);
    const draft = parseManualText(`${body.text ?? ''}\n${body.url ?? ''}`);
    if (body.url && !draft.url) draft.url = body.url;
    draft.category = guessCategory(`${draft.title} ${body.text ?? ''}`.slice(0, 200));
    return send(res, 200, draft);
  }
  if (p === '/api/manual' && m === 'POST') {
    const body = await readBody(req);
    if (MANUAL_KEY && body.key !== MANUAL_KEY) return send(res, 403, { error: '手動加入密碼不對' });
    if (!body.title || !(body.start || body.regStart)) return send(res, 400, { error: '至少要有標題，以及活動時間或報名時間' });
    const e = makeEvent({ id: 'manual', name: '手動加入' }, randomUUID().slice(0, 8), {
      title: body.title,
      start: body.start || body.regStart,
      end: body.end || null,
      regStart: body.regStart || null,
      regEnd: body.regEnd || null,
      venue: body.venue || null,
      district: body.district || findDistrict(body.venue),
      category: body.category || guessCategory(body.title),
      free: body.free ?? null,
      url: body.url || null,
      summary: body.note || null,
    });
    e.firstSeen = new Date().toISOString();
    state.data.manual.unshift(e);
    state.touch();
    return send(res, 200, e);
  }
  const del = p.match(/^\/api\/manual\/([^/]+)$/);
  if (del && m === 'DELETE') {
    const key = url.searchParams.get('key') ?? '';
    if (MANUAL_KEY && key !== MANUAL_KEY) return send(res, 403, { error: '手動加入密碼不對' });
    const id = decodeURIComponent(del[1]);
    state.data.manual = state.data.manual.filter((e) => e.id !== id);
    state.touch();
    return send(res, 200, { ok: true });
  }

  const ics = p.match(/^\/api\/ics\/(.+)\.ics$/);
  if (ics && m === 'GET') {
    const id = decodeURIComponent(ics[1]);
    const e = (await allEvents()).find((x) => x.id === id);
    if (!e) return send(res, 404, '找不到這個活動');
    return send(res, 200, buildIcs(e, url.searchParams.get('kind')), { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `inline; filename="event.ics"` });
  }

  // 外部排程（cron-job.org）每分鐘打這裡，讓免費主機不要睡著；真正的檢查在伺服器內部每分鐘跑
  if (p === '/api/tick') {
    const result = url.searchParams.get('run') ? await tick() : lastTick;
    return send(res, 200, { ok: true, lastTick: result, store: state.backend.kind, pushReady });
  }
  if (p === '/api/health') return send(res, 200, { ok: true });

  return send(res, 404, { error: 'not found' });
}

async function serveStatic(req, res, url) {
  let path = decodeURIComponent(url.pathname);
  if (path === '/') path = '/index.html';
  const file = normalize(join(PUBLIC, path));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not file');
    const body = await readFile(file);
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    const cache = /\.(png|svg|ico)$/.test(file) ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
    return res.end(body);
  } catch {
    const body = await readFile(join(PUBLIC, 'index.html'));
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
    return res.end(body);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return await serveStatic(req, res, url);
  } catch (err) {
    console.error('[http]', req.method, url.pathname, err);
    return send(res, err.status ?? 500, { error: err.status ? err.message : '伺服器錯誤' });
  }
});

server.listen(PORT, () => {
  console.log(`桃園活動雷達 http://localhost:${PORT}（狀態存放：${state.backend.kind}，推播：${pushReady ? '已設定' : '未設定 VAPID 金鑰'}）`);
});

setTimeout(tick, 3000);
setInterval(tick, TICK_MS);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await state.flush();
    process.exit(0);
  });
}
