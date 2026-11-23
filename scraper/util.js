// 抓取共用工具：有禮貌的 fetch（同一主機排隊、間隔、重試）、台北時間與民國年處理、活動欄位整理。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const hostQueues = new Map();
const HOST_GAP_MS = Number(process.env.HOST_GAP_MS ?? 1500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 同一個主機一次只發一個請求，請求之間至少隔 HOST_GAP_MS，避免被市府網站擋。 */
export async function politeFetch(url, opts = {}, { retries = 2, timeoutMs = 30000 } = {}) {
  const host = new URL(url).host;
  const prev = hostQueues.get(host) ?? Promise.resolve();
  let release;
  const mine = new Promise((r) => (release = r));
  hostQueues.set(host, prev.then(() => mine));
  await prev;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, {
          ...opts,
          headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9', ...(opts.headers ?? {}) },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status >= 500 && attempt < retries) throw new Error(`HTTP ${res.status}`);
        return res;
      } catch (err) {
        if (attempt >= retries) throw err;
        await sleep(2000 * (attempt + 1));
      }
    }
  } finally {
    setTimeout(release, HOST_GAP_MS);
  }
}

export async function fetchText(url, opts, cfg) {
  const res = await politeFetch(url, opts, cfg);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

export async function fetchJson(url, opts, cfg) {
  const text = await fetchText(url, opts, cfg);
  return JSON.parse(text.replace(/^﻿/, ''));
}

// ---------- 時間（一律用台北時間，輸出 ISO 字串，例如 2026-11-28T14:30:00+08:00；整天活動只給日期 2026-11-28） ----------

const pad = (n) => String(n).padStart(2, '0');

/** 現在的台北時間各欄位。 */
export function taipeiNow(date = new Date()) {
  const t = new Date(date.getTime() + 8 * 3600 * 1000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), hh: t.getUTCHours(), mm: t.getUTCMinutes(), dow: t.getUTCDay() };
}

export function todayTaipei(date = new Date()) {
  const n = taipeiNow(date);
  return `${n.y}-${pad(n.m)}-${pad(n.d)}`;
}

/** 組出台北時間字串。沒給時間就是整天（只有日期）。 */
export function makeTime(y, m, d, hh, mm) {
  y = Number(y);
  if (y < 1911) y += 1911; // 民國年
  const date = `${y}-${pad(m)}-${pad(d)}`;
  if (hh === undefined || hh === null || hh === '') return date;
  return `${date}T${pad(hh)}:${pad(mm ?? 0)}:00+08:00`;
}

/**
 * 從一段文字抓出第一個日期（可帶時間）。支援 2026/11/28、2026-11-28、2026.11.28、115-01-19、115.11.28，
 * 後面可接 14:30。回傳 makeTime 格式或 null。
 */
export function parseDateTime(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{3,4})\s*[./\-年]\s*(\d{1,2})\s*[./\-月]\s*(\d{1,2})\s*日?(?:\s*\([^)]*\)|\s*（[^）]*）)?(?:\s*T?\s*(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  return makeTime(m[1], m[2], m[3], m[4], m[5]);
}

/** 把任意時間字串轉成毫秒（台北時間的整天活動以 00:00 計）。 */
export function toMs(value) {
  if (!value) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(`${value}T00:00:00+08:00`);
  return Date.parse(value);
}

/** 時間字串的日期部分（台北）。 */
export function dateOf(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const ms = toMs(value);
  if (Number.isNaN(ms)) return null;
  return todayTaipei(new Date(ms));
}

// ---------- 地點 ----------

const DISTRICTS = ['桃園', '中壢', '平鎮', '八德', '楊梅', '蘆竹', '龜山', '大園', '觀音', '新屋', '龍潭', '大溪', '復興'];
export const DISTRICT_LIST = DISTRICTS.map((d) => `${d}區`);

export function findDistrict(...texts) {
  const s = texts.filter(Boolean).join(' ');
  for (const d of DISTRICTS) {
    if (new RegExp(`${d}區`).test(s.replace(/桃園市/g, ''))) return `${d}區`;
  }
  return null;
}

export function isTaoyuan(...texts) {
  const s = texts.filter(Boolean).join(' ');
  if (/桃園市|桃園縣|（桃園市）|\(桃園市\)/.test(s)) return true;
  return DISTRICTS.some((d) => s.includes(`${d}區`) && !/新北|台北|臺北|新竹|苗栗/.test(s));
}

// ---------- 文字 ----------

export function cleanText(s, max = 400) {
  if (!s) return '';
  const t = String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t　]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 比對重複活動用：去掉年份、空白、標點。 */
export function normTitle(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/20\d\d|1[01]\d年/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

export const CATEGORIES = ['表演', '展覽', '講座課程', '親子', '親子館', '節慶市集', '體驗', '運動', '電影', '報名', '其他'];

/** 依標題猜類別（來源沒給類別時使用）。 */
export function guessCategory(title, fallback = '其他') {
  const t = title ?? '';
  if (/市集|節|祭|嘉年華|燈會|跨年|季/.test(t)) return '節慶市集';
  if (/展(?!演)|展覽|特展|個展/.test(t)) return '展覽';
  if (/講座|課程|研習|工作坊|學堂|班|讀書會/.test(t)) return '講座課程';
  if (/親子|兒童|孩|寶寶|故事/.test(t)) return '親子';
  if (/音樂會|演唱|演出|劇|舞|表演|公演|音樂/.test(t)) return '表演';
  if (/影展|電影|放映/.test(t)) return '電影';
  if (/馬拉松|路跑|球|運動|賽/.test(t)) return '運動';
  if (/體驗|DIY|手作|導覽|走讀|小旅行/.test(t)) return '體驗';
  return fallback;
}

/** 每個來源都用這個整理成同一種格式。 */
export function makeEvent(source, key, fields) {
  const e = {
    id: `${source.id}:${key}`,
    source: source.id,
    sourceName: source.name,
    title: cleanText(fields.title, 120),
    start: fields.start ?? null,
    end: fields.end ?? null,
    regStart: fields.regStart ?? null,
    regEnd: fields.regEnd ?? null,
    venue: cleanText(fields.venue, 80) || null,
    address: cleanText(fields.address, 120) || null,
    district: fields.district ?? findDistrict(fields.address, fields.venue),
    category: fields.category ?? guessCategory(fields.title),
    free: fields.free ?? null,
    url: fields.url ?? null,
    image: fields.image ?? null,
    summary: cleanText(fields.summary, 300) || null,
    extra: fields.extra ?? null,
  };
  if (!e.end) e.end = e.start;
  return e;
}
