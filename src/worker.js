// 活動雷達：Cloudflare Worker。網頁（public/）由 Workers 靜態資源提供；這裡處理 /api/* 和每分鐘的排程。
// 活動資料由 GitHub Actions 抓好放在 repo，這裡從 GitHub 讀；訂閱、收藏存在 D1。
import { sendPush } from './push.js';
import { cleanPrefs, matchesPrefs, reminderJobs, dueJobs, newEventMessages, snapshot } from './logic.js';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });

async function subIdOf(endpoint) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(hash).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const vapidOf = (env) => ({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT });
const pushReady = (env) => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
const statusUrl = (env) => env.STATUS_URL || env.EVENTS_URL.replace(/events\.json$/, 'status.json');
// 推播判斷用的精簡版活動資料（只有標題、時間、地區這些欄位）
const notifyUrl = (env) => env.EVENTS_URL.replace(/events\.json$/, 'notify.json');

/** 從 GitHub 讀資料，用 Cloudflare 快取 2 分鐘，不解析 JSON（省運算時間）。 */
async function cachedText(url, ctx, ttl = 120) {
  const cache = caches.default;
  const key = new Request(url);
  const hit = await cache.match(key);
  if (hit) return hit.text();
  const res = await fetch(url, { cf: { cacheTtl: 60 } });
  if (!res.ok) throw new Error(`讀取 ${url} 失敗：HTTP ${res.status}`);
  const text = await res.text();
  ctx?.waitUntil?.(cache.put(key, new Response(text, { headers: { 'Cache-Control': `max-age=${ttl}`, 'Content-Type': 'application/json' } })));
  return text;
}

async function readBody(req) {
  const text = await req.text();
  if (text.length > 100_000) throw Object.assign(new Error('內容太大'), { status: 413 });
  return text ? JSON.parse(text) : {};
}

/**
 * 合併兩份同步資料：opened（看過）、deleted（從通知頁刪掉）取聯集；
 * starred（收藏）用「最後動作」決定：每個活動記 [是否收藏, 時間]，時間新的贏。
 */
export function mergeSync(a = {}, b = {}) {
  const set = (x, y, k) => [...new Set([...(x[k] ?? []), ...(y[k] ?? [])])].slice(-3000);
  const stars = { ...(a.stars ?? {}) };
  for (const [id, v] of Object.entries(b.stars ?? {})) {
    if (!Array.isArray(v)) continue;
    if (!stars[id] || (v[1] ?? 0) > (stars[id][1] ?? 0)) stars[id] = [Boolean(v[0]), Number(v[1]) || 0];
  }
  const baselines = [a.baseline, b.baseline].filter(Boolean).sort();
  return { opened: set(a, b, 'opened'), deleted: set(a, b, 'deleted'), stars, baseline: baselines[0] ?? null };
}

// ---------- 推播 ----------
async function pushTo(env, sub, payload) {
  const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
  try {
    const status = await sendPush(subscription, payload, vapidOf(env));
    if (status === 404 || status === 410) {
      // 訂閱失效（刪掉 App、關掉通知）
      await env.DB.batch([env.DB.prepare('DELETE FROM subs WHERE id = ?').bind(sub.id), env.DB.prepare('DELETE FROM stars WHERE sub_id = ?').bind(sub.id)]);
      return false;
    }
    if (status >= 400) console.error('push', sub.id, status);
    return status < 400;
  } catch (err) {
    console.error('push error', sub.id, err.message);
    return false;
  }
}

// ---------- 行事曆檔 ----------
const toMs = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00+08:00`) : Date.parse(v));
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
export function buildIcs(e, kind) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//event-radar//ZH', 'CALSCALE:GREGORIAN'];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const desc = [e.summary, e.url ? `報名／詳情：${e.url}` : null].filter(Boolean).join('\n\n');
  const add = (uid, title, start, end, alarms) => {
    lines.push('BEGIN:VEVENT', `UID:${uid}@event-radar`, `DTSTAMP:${stamp}`, `SUMMARY:${icsEscape(title)}`, `DTSTART${icsTime(start)}`);
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

// ---------- 每分鐘的排程 ----------
async function getMeta(env, k) {
  return (await env.DB.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first('v')) ?? null;
}
const setMeta = (env, k, v) => env.DB.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v);

/** 活動資料有更新時：找出新活動發通知，並更新收藏的活動快照。 */
async function checkNewEvents(env) {
  const etag = await getMeta(env, 'etag');
  let res = await fetch(notifyUrl(env), { headers: etag ? { 'If-None-Match': etag } : {}, cf: { cacheTtl: 0 } });
  if (res.status === 404) res = await fetch(env.EVENTS_URL, { headers: etag ? { 'If-None-Match': etag } : {}, cf: { cacheTtl: 0 } });
  if (res.status === 304) return { changed: false };
  if (!res.ok) throw new Error(`讀取活動失敗：HTTP ${res.status}`);
  const data = await res.json();
  const events = data.events ?? [];
  const byId = new Map(events.map((e) => [e.id, e]));
  const seenRaw = await getMeta(env, 'seen');
  const writes = [setMeta(env, 'etag', res.headers.get('ETag') ?? ''), setMeta(env, 'updatedAt', data.updatedAt ?? '')];
  let fresh = [];
  let sent = 0;
  if (!seenRaw) {
    // 第一次：只記錄，不通知
    writes.push(setMeta(env, 'seen', JSON.stringify(events.map((e) => e.id))));
  } else {
    const seen = new Set(JSON.parse(seenRaw));
    // firstSeen 是 2000 年的是新來源一開始就有的活動，不推播
    // 只推 6 小時內第一次出現的（來源暫時消失又出現的舊活動不再推）
    const recent = new Date(Date.now() - 6 * 3600000).toISOString();
    fresh = events.filter((e) => !seen.has(e.id) && !(e.firstSeen ?? '').startsWith('2000-') && (e.firstSeen ?? '') >= recent);
    if (fresh.length) {
      const subs = (await env.DB.prepare('SELECT id, endpoint, p256dh, auth, prefs FROM subs').all()).results;
      for (const sub of subs) {
        const mine = fresh.filter((e) => matchesPrefs(e, JSON.parse(sub.prefs)));
        for (const msg of newEventMessages(mine)) if (await pushTo(env, sub, msg)) sent++;
      }
    }
    // 只留目前還在的活動，避免越存越大
    writes.push(setMeta(env, 'seen', JSON.stringify(events.map((e) => e.id))));
  }
  // 收藏的活動如果改了時間，快照跟著更新
  const starredIds = (await env.DB.prepare('SELECT DISTINCT event_id FROM stars').all()).results.map((r) => r.event_id);
  for (const id of starredIds) {
    const e = byId.get(id);
    if (e) writes.push(env.DB.prepare('UPDATE stars SET ev = ? WHERE event_id = ?').bind(JSON.stringify(snapshot(e)), id));
  }
  await env.DB.batch(writes);
  return { changed: true, events: events.length, fresh: fresh.length, sent, seeded: !seenRaw };
}

/** 收藏活動的提醒。 */
async function sendReminders(env, now = Date.now()) {
  const rows = (await env.DB.prepare('SELECT s.sub_id, s.event_id, s.ev, u.endpoint, u.p256dh, u.auth, u.prefs FROM stars s JOIN subs u ON u.id = s.sub_id').all()).results;
  let sent = 0;
  for (const r of rows) {
    const due = dueJobs(reminderJobs(JSON.parse(r.ev), JSON.parse(r.prefs)), now);
    for (const job of due) {
      const key = `${r.sub_id}|${r.event_id}|${job.key}`;
      const done = await env.DB.prepare('SELECT 1 FROM sent WHERE key = ?').bind(key).first();
      if (done) continue;
      await env.DB.prepare('INSERT OR IGNORE INTO sent (key, at) VALUES (?, ?)').bind(key, now).run();
      if (await pushTo(env, { id: r.sub_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }, job.payload)) sent++;
    }
  }
  // 每天清一次舊紀錄
  if (new Date(now).getUTCMinutes() === 0 && new Date(now).getUTCHours() === 19) {
    await env.DB.prepare('DELETE FROM sent WHERE at < ?').bind(now - 40 * 86400000).run();
  }
  return { reminders: rows.length, sent };
}

/**
 * GitHub 的免費排程在新 repo 常常延後好幾小時，所以改由這裡每 30 分鐘叫 GitHub 執行抓取。
 * 需要 secret GH_TOKEN（只有 EVENT repo 的 Actions 讀寫權限）。
 */
async function triggerScrape(env, now = new Date()) {
  if (!env.GH_TOKEN || now.getUTCMinutes() % 30 !== 3) return null;
  const res = await fetch(`https://api.github.com/repos/${env.GH_REPO || 'WYW329/EVENT'}/actions/workflows/scrape.yml/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'event-radar', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main' }),
  });
  return res.status; // 204 = 成功
}

async function tick(env) {
  const out = { at: new Date().toISOString() };
  try {
    const s = await triggerScrape(env);
    if (s !== null) {
      out.scrapeTrigger = s;
      await env.DB.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind('lastScrapeTrigger', JSON.stringify({ at: out.at, status: s })).run();
    }
  } catch (err) {
    out.scrapeTriggerError = err.message;
  }
  try {
    Object.assign(out, await checkNewEvents(env));
  } catch (err) {
    out.eventsError = err.message;
  }
  try {
    Object.assign(out, { remind: await sendReminders(env) });
  } catch (err) {
    out.remindError = err.message;
  }
  await env.DB.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind('lastTick', JSON.stringify(out)).run();
  return out;
}

// ---------- API ----------
async function api(req, env, ctx, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/events' && m === 'GET') {
    // 直接把兩個 JSON 字串拼起來，不解析（Workers 免費方案每次運算時間很短）
    const [events, status] = await Promise.all([cachedText(env.EVENTS_URL, ctx), cachedText(statusUrl(env), ctx).catch(() => 'null')]);
    return new Response(`{"status":${status},"data":${events}}`, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  if (p === '/api/vapid') return json({ publicKey: env.VAPID_PUBLIC_KEY ?? null, ready: pushReady(env) });
  if (p === '/api/health') return json({ ok: true });
  if (p === '/api/tick') {
    const last = await getMeta(env, 'lastTick');
    const trig = await getMeta(env, 'lastScrapeTrigger');
    const subs = await env.DB.prepare('SELECT COUNT(*) AS n FROM subs').first('n');
    return json({ ok: true, lastTick: last ? JSON.parse(last) : null, lastScrapeTrigger: trig ? JSON.parse(trig) : null, scrapeTriggerReady: Boolean(env.GH_TOKEN), subs, pushReady: pushReady(env) });
  }

  if (p === '/api/subscribe' && m === 'POST') {
    const body = await readBody(req);
    const s = body.subscription;
    if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth) return json({ error: '訂閱資料不完整' }, 400);
    const id = await subIdOf(s.endpoint);
    const prev = await env.DB.prepare('SELECT prefs FROM subs WHERE id = ?').bind(id).first('prefs');
    const prefs = cleanPrefs(body.prefs ?? (prev ? JSON.parse(prev) : {}));
    const stmts = [
      env.DB.prepare('INSERT INTO subs (id, endpoint, p256dh, auth, prefs, ua, created) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth, prefs = excluded.prefs')
        .bind(id, s.endpoint, s.keys.p256dh, s.keys.auth, JSON.stringify(prefs), (req.headers.get('User-Agent') ?? '').slice(0, 120), new Date().toISOString()),
    ];
    for (const ev of (Array.isArray(body.starred) ? body.starred : []).slice(0, 300)) {
      if (ev?.id) stmts.push(env.DB.prepare('INSERT OR REPLACE INTO stars (sub_id, event_id, ev) VALUES (?, ?, ?)').bind(id, String(ev.id), JSON.stringify(snapshot(ev))));
    }
    await env.DB.batch(stmts);
    const starred = (await env.DB.prepare('SELECT event_id FROM stars WHERE sub_id = ?').bind(id).all()).results.map((r) => r.event_id);
    return json({ id, prefs, starred });
  }

  const findSub = (id) => env.DB.prepare('SELECT id, endpoint, p256dh, auth, prefs FROM subs WHERE id = ?').bind(String(id ?? '')).first();

  if (p === '/api/me' && m === 'GET') {
    const sub = await findSub(url.searchParams.get('id'));
    if (!sub) return json({ error: '找不到訂閱' }, 404);
    const starred = (await env.DB.prepare('SELECT event_id FROM stars WHERE sub_id = ?').bind(sub.id).all()).results.map((r) => r.event_id);
    return json({ prefs: JSON.parse(sub.prefs), starred });
  }
  if (p === '/api/prefs' && m === 'POST') {
    const body = await readBody(req);
    const sub = await findSub(body.id);
    if (!sub) return json({ error: '找不到訂閱' }, 404);
    const prefs = cleanPrefs(body.prefs);
    await env.DB.prepare('UPDATE subs SET prefs = ? WHERE id = ?').bind(JSON.stringify(prefs), sub.id).run();
    return json({ prefs });
  }
  if (p === '/api/star' && m === 'POST') {
    const body = await readBody(req);
    const sub = await findSub(body.id);
    if (!sub) return json({ error: '找不到訂閱' }, 404);
    if (body.on && body.ev?.id) await env.DB.prepare('INSERT OR REPLACE INTO stars (sub_id, event_id, ev) VALUES (?, ?, ?)').bind(sub.id, String(body.ev.id), JSON.stringify(snapshot(body.ev))).run();
    else await env.DB.prepare('DELETE FROM stars WHERE sub_id = ? AND event_id = ?').bind(sub.id, String(body.eventId ?? body.ev?.id)).run();
    return json({ ok: true });
  }
  if (p === '/api/unsubscribe' && m === 'POST') {
    const body = await readBody(req);
    const id = String(body.id ?? '');
    await env.DB.batch([env.DB.prepare('DELETE FROM subs WHERE id = ?').bind(id), env.DB.prepare('DELETE FROM stars WHERE sub_id = ?').bind(id)]);
    return json({ ok: true });
  }
  if (p === '/api/test-push' && m === 'POST') {
    const body = await readBody(req);
    if (!pushReady(env)) return json({ error: '伺服器還沒設定推播金鑰' }, 503);
    const sub = await findSub(body.id);
    if (!sub) return json({ error: '找不到訂閱' }, 404);
    const ok = await pushTo(env, sub, { title: '測試通知 ✅', body: '收到這則就代表通知設定成功了！', url: '/', tag: 'test' });
    return json({ ok }, ok ? 200 : 502);
  }

  // ---------- 配對碼同步（已讀、刪除、收藏），永久保存 ----------
  if (p === '/api/sync' && m === 'POST') {
    // 產生新的配對碼，帶上這台裝置目前的狀態
    const body = await readBody(req);
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易看錯的 0 O 1 I
    let code = '';
    for (let tries = 0; tries < 5; tries++) {
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      code = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
      const exists = await env.DB.prepare('SELECT 1 FROM sync WHERE code = ?').bind(code).first();
      if (!exists) break;
    }
    const data = mergeSync({}, body.data);
    await env.DB.prepare('INSERT INTO sync (code, data, updated) VALUES (?, ?, ?)').bind(code, JSON.stringify(data), new Date().toISOString()).run();
    return json({ code, data });
  }
  const syncMatch = p.match(/^\/api\/sync\/([A-Z0-9]{8})$/);
  if (syncMatch) {
    const code = syncMatch[1];
    const row = await env.DB.prepare('SELECT data FROM sync WHERE code = ?').bind(code).first('data');
    if (!row) return json({ error: '找不到這個配對碼' }, 404);
    if (m === 'GET') return json({ code, data: JSON.parse(row) });
    if (m === 'PUT') {
      // 合併（聯集），兩台裝置同時改也不會互相蓋掉
      const body = await readBody(req);
      const data = mergeSync(JSON.parse(row), body.data);
      await env.DB.prepare('UPDATE sync SET data = ?, updated = ? WHERE code = ?').bind(JSON.stringify(data), new Date().toISOString(), code).run();
      return json({ code, data });
    }
  }

  const ics = p.match(/^\/api\/ics\/(.+)\.ics$/);
  if (ics && m === 'GET') {
    const id = decodeURIComponent(ics[1]);
    const data = JSON.parse(await cachedText(env.EVENTS_URL, ctx));
    const e = data.events.find((x) => x.id === id);
    if (!e) return new Response('找不到這個活動', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    return new Response(buildIcs(e, url.searchParams.get('kind')), { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="event.ics"' } });
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await api(req, env, ctx, url);
    } catch (err) {
      console.error(req.method, url.pathname, err);
      return json({ error: err.status ? err.message : '伺服器錯誤' }, err.status ?? 500);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
};
