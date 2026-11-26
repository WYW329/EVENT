// 跑全部來源 → 合併、去重複、過濾已結束 → 寫入 data/events.json 和 data/status.json。
// GitHub Actions 定時執行這支；本機可用 npm run scrape。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { culture, tourism } from './sources/national.js';
import { travel, ccms, afmc, babycare, water } from './sources/taoyuan.js';
import { kktix, accupass, cycc, g11 } from './sources/platforms.js';
import { normTitle, dateOf, toMs, todayTaipei, finalizeCategories } from './util.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

// 排在前面的來源資料比較完整，重複時保留前面的
export const SOURCES = [travel, tourism, afmc, culture, ccms, babycare, water, cycc, g11, kktix, accupass];

const richness = (e) => ['venue', 'address', 'image', 'summary', 'url', 'regStart'].filter((k) => e[k]).length;

/** 合併重複活動：標題正規化後相同、而且開始日期相同（或其中一方沒有日期）。 */
export function dedupe(events) {
  const byKey = new Map();
  const ids = new Set();
  const out = [];
  for (const e of events) {
    const key = `${normTitle(e.title)}|${dateOf(e.start) ?? ''}`;
    const prev = byKey.get(key);
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

  // 來源這次失敗的話，沿用上次的資料，避免活動突然消失又被當成新活動
  const all = [];
  for (const r of results) {
    if (r.ok) all.push(...r.list);
    else all.push(...prev.events.filter((e) => e.source === r.src.id));
  }

  const nowIso = new Date().toISOString();
  const events = keepCurrent(dedupe(all)).map((e) => ({ ...e, categories: finalizeCategories(e), firstSeen: prevById.get(e.id)?.firstSeen ?? nowIso }));
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
  return { events, status };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const only = process.argv.slice(2);
  const { events, status } = await runAll({ only: only.length ? only : undefined });
  await mkdir(DATA, { recursive: true });
  if (!only.length) {
    await writeFile(join(DATA, 'events.json'), JSON.stringify({ updatedAt: status.updatedAt, events }, null, 1));
    await writeFile(join(DATA, 'status.json'), JSON.stringify(status, null, 2));
  }
  for (const s of status.sources) {
    console.log(`${s.ok ? '✓' : '✗'} ${s.name.padEnd(10)} 抓到 ${String(s.count ?? '-').padStart(4)}，保留 ${String(s.kept).padStart(4)}，${(s.ms / 1000).toFixed(1)}s${s.error ? `  錯誤：${s.error}` : ''}${s.warnings ? `  警告：${s.warnings.join('; ')}` : ''}`);
  }
  console.log(`共 ${events.length} 個活動，花 ${(status.tookMs / 1000).toFixed(1)} 秒`);
  if (status.sources.every((s) => !s.ok)) process.exit(1);
}
