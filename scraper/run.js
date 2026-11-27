// 跑全部來源 → 合併、去重複、過濾已結束 → 寫入 data/events.json 和 data/status.json。
// GitHub Actions 定時執行這支；本機可用 npm run scrape。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { culture, tourism } from './sources/national.js';
import { travel, ccms, afmc, babycare, water } from './sources/taoyuan.js';
import { kktix, accupass, cycc, g11, wekengo, opentix } from './sources/platforms.js';
import { tycgNews, taipeiNews, keelungNews, library } from './sources/tycgnews.js';
import { klctb } from './sources/keelung.js';
import { gloria, taimall, xpark } from './sources/malls.js';
import { travelTaipei, ntpcEvents } from './sources/taipei.js';
import { huashan, songshan, tfam, tmc, clab, artemperor, indievox, ntpcMuseums, twtc, moca, nationalVenues } from './sources/taipei-venues.js';
import { eventbrite, meetup, luma } from './sources/community.js';
import { normTitle, dateOf, toMs, todayTaipei, finalizeCategories } from './util.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

// 排在前面的來源資料比較完整，重複時保留前面的
// WeKenGo 放最後：同一個活動官方來源有的話，用官方的資料
export const SOURCES = [travel, travelTaipei, huashan, songshan, tfam, tmc, clab, moca, twtc, nationalVenues, ntpcMuseums, tourism, afmc, culture, ccms, babycare, water, cycc, g11, gloria, taimall, xpark, library, ntpcEvents, opentix, kktix, indievox, accupass, artemperor, eventbrite, meetup, luma, tycgNews, taipeiNews, keelungNews, klctb, wekengo];

export const SEED = '2000-01-01T00:00:00.000Z';

const richness = (e) => ['venue', 'address', 'image', 'summary', 'url', 'regStart'].filter((k) => e[k]).length;

/** 合併重複活動：標題正規化後相同、而且開始日期相同（或其中一方沒有日期）。 */
export function dedupe(events) {
  const byKey = new Map();
  const ids = new Set();
  const out = [];
  const byTitle = new Map(); // 正規化標題 → 已收的活動（給「日期寫法不同」的重複用）
  const overlaps = (a, b) => {
    const as = dateOf(a.start), ae = dateOf(a.end ?? a.start) ?? as;
    const bs = dateOf(b.start), be = dateOf(b.end ?? b.start) ?? bs;
    return as && bs && as <= be && bs <= ae;
  };
  for (const e of events) {
    const nt = normTitle(e.title);
    const key = `${nt}|${dateOf(e.start) ?? ''}`;
    let prev = byKey.get(key);
    // 同名而且日期區間有重疊（例如一邊寫展期、一邊寫開幕時間），也算同一個活動
    if (!prev && nt.length >= 4) prev = (byTitle.get(nt) ?? []).find((p) => p.source !== e.source && overlaps(p, e));
    if (!prev || prev.source !== e.source) (byTitle.get(nt) ?? byTitle.set(nt, []).get(nt)).push(e);
    if (!prev || prev.source === e.source) {
      // 同一個來源裡標題日期相同的是不同場次（例如上午場、下午場），不合併
      if (!prev) byKey.set(key, e);
      if (!ids.has(e.id)) { ids.add(e.id); out.push(e); }
      continue;
    }
    // 合併：保留先出現（來源優先序較高）的，補上缺的欄位，記錄其他來源
    for (const k of ['venue', 'address', 'district', 'image', 'summary', 'url', 'regStart', 'regEnd', 'free']) {
      if (prev[k] == null && e[k] != null) prev[k] = e[k];
    }
    if (e.sourceName !== prev.sourceName) prev.alsoIn = [...new Set([...(prev.alsoIn ?? []), e.sourceName])];
    if (richness(e) > richness(prev) + 2 && !prev.url) prev.url = e.url;
  }
  return out;
}

/** 只留還沒結束、而且一年內開始的活動。 */
export function keepCurrent(events, now = Date.now()) {
  const today = todayTaipei(new Date(now));
  const horizon = now + 400 * 86400000;
  return events.filter((e) => {
    if (!e.title || !e.start) return false;
    const endDay = dateOf(e.end ?? e.start);
    if (endDay && endDay < today) return false;
    const s = toMs(e.start);
    return Number.isNaN(s) || s < horizon;
  });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function runAll({ only } = {}) {
  const started = Date.now();
  const sources = only ? SOURCES.filter((s) => only.includes(s.id)) : SOURCES;
  const results = await Promise.all(
    sources.map(async (src) => {
      const t0 = Date.now();
      try {
        const list = await src.fetch();
        return { src, list, ok: true, ms: Date.now() - t0, warnings: list.warnings };
      } catch (err) {
        return { src, list: [], ok: false, ms: Date.now() - t0, error: String(err?.message ?? err) };
      }
    }),
  );

  const prev = await readJson(join(DATA, 'events.json'), { events: [] });
  const prevById = new Map(prev.events.map((e) => [e.id, e]));
  // 看過的活動記 45 天：來源暫時少抓一批、之後又出現時，沿用第一次看到的時間，不會再被當成新活動
  const seenCache = await readJson(join(DATA, 'seen-cache.json'), {});

  // 來源這次失敗的話，沿用上次的資料，避免活動突然消失又被當成新活動
  const all = [];
  for (const r of results) {
    if (r.ok) all.push(...r.list);
    else all.push(...prev.events.filter((e) => e.source === r.src.id));
  }

  const nowIso = new Date().toISOString();
  // 新加的來源、或第一次有某個縣市的活動時，那批活動標成「一開始就有」（SEED），不放進通知、不推播，避免一次湧進幾百則
  const prevSources = new Set(prev.events.map((e) => e.source));
  const prevCities = new Set(prev.events.map((e) => e.city ?? '桃園市'));
  const merged = keepCurrent(dedupe(all));
  // 同一個來源一次冒出超過 60 個新活動，多半是來源改版或篩選條件變了（例如 OPENTIX 一次多了 400 個雙北節目），不是真的新活動，也不推播
  const burst = new Map();
  for (const e of merged) if (!prevById.has(e.id) && !seenCache[e.id]) burst.set(e.source, (burst.get(e.source) ?? 0) + 1);
  const firstSeenOf = (e) => prevById.get(e.id)?.firstSeen ?? seenCache[e.id] ?? (prev.events.length && (!prevSources.has(e.source) || !prevCities.has(e.city) || burst.get(e.source) > 60) ? SEED : nowIso);
  // 說明文字最多留 700 字（詳細內容看原網站），整份資料小很多，手機開 App 比較快
  const clip = (t) => (t && t.length > 700 ? `${t.slice(0, 700)}…` : t);
  const events = merged.map((e) => ({ ...e, summary: clip(e.summary), categories: finalizeCategories(e), firstSeen: firstSeenOf(e) }));
  events.sort((a, b) => (toMs(a.start) || 0) - (toMs(b.start) || 0));

  const status = {
    updatedAt: nowIso,
    tookMs: Date.now() - started,
    total: events.length,
    sources: results.map((r) => ({
      id: r.src.id,
      name: r.src.name,
      ok: r.ok,
      count: r.ok ? r.list.length : null,
      kept: events.filter((e) => e.source === r.src.id).length,
      ms: r.ms,
      error: r.error ?? null,
      warnings: r.warnings ?? null,
    })),
  };
  const cutoff = new Date(Date.now() - 45 * 86400000).toISOString();
  const nextSeen = {};
  for (const [id, t] of Object.entries(seenCache)) if (t >= cutoff) nextSeen[id] = t;
  for (const e of events) nextSeen[e.id] = e.firstSeen;
  // 太舊的（超過 45 天、而且已經不在清單上的）丟掉
  const alive = new Set(events.map((e) => e.id));
  for (const [id, t] of Object.entries(nextSeen)) if (t < cutoff && !alive.has(id)) delete nextSeen[id];
  return { events, status, seen: nextSeen };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const only = process.argv.slice(2);
  const { events, status, seen } = await runAll({ only: only.length ? only : undefined });
  await mkdir(DATA, { recursive: true });
  if (!only.length) {
    // 不排版（檔案小一半以上，手機下載快、Worker 解析快）
    await writeFile(join(DATA, 'events.json'), JSON.stringify({ updatedAt: status.updatedAt, events }));
    // 推播用的精簡版：Worker 每次有新資料都要整份解析，只留判斷通知需要的欄位
    const NOTIFY_KEYS = ['id', 'title', 'city', 'category', 'categories', 'free', 'start', 'end', 'regStart', 'regEnd', 'url', 'venue', 'district', 'firstSeen'];
    const lite = events.map((e) => Object.fromEntries(NOTIFY_KEYS.filter((k) => e[k] != null).map((k) => [k, e[k]])));
    await writeFile(join(DATA, 'notify.json'), JSON.stringify({ updatedAt: status.updatedAt, events: lite }));
    await writeFile(join(DATA, 'status.json'), JSON.stringify(status, null, 2));
    await writeFile(join(DATA, 'seen-cache.json'), JSON.stringify(seen));
  }
  for (const s of status.sources) {
    console.log(`${s.ok ? '✓' : '✗'} ${s.name.padEnd(10)} 抓到 ${String(s.count ?? '-').padStart(4)}，保留 ${String(s.kept).padStart(4)}，${(s.ms / 1000).toFixed(1)}s${s.error ? `  錯誤：${s.error}` : ''}${s.warnings ? `  警告：${s.warnings.join('; ')}` : ''}`);
  }
  console.log(`共 ${events.length} 個活動，花 ${(status.tookMs / 1000).toFixed(1)} 秒`);
  if (status.sources.every((s) => !s.ok)) process.exit(1);
}
