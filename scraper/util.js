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

// 各縣市的行政區（三個縣市的區名沒有重複）
export const CITY_DISTRICTS = {
  桃園市: ['桃園', '中壢', '平鎮', '八德', '楊梅', '蘆竹', '龜山', '大園', '觀音', '新屋', '龍潭', '大溪', '復興'],
  臺北市: ['中正', '大同', '中山', '松山', '大安', '萬華', '信義', '士林', '北投', '內湖', '南港', '文山'],
  新北市: ['板橋', '三重', '中和', '永和', '新莊', '新店', '樹林', '鶯歌', '三峽', '淡水', '汐止', '瑞芳', '土城', '蘆洲', '五股', '泰山', '林口', '深坑', '石碇', '坪林', '三芝', '石門', '八里', '平溪', '雙溪', '貢寮', '金山', '萬里', '烏來'],
};
const DISTRICTS = CITY_DISTRICTS['桃園市'];
export const DISTRICT_LIST = DISTRICTS.map((d) => `${d}區`);
// 台北、新北的區名在別的縣市也有（基隆中正區、台中大安區…），所以要看文字裡有沒有寫別的縣市
const AMBIGUOUS = { 中正: /基隆/, 中山: /基隆/, 信義: /基隆/, 大安: /臺中|台中/, 大同: /宜蘭/ };

/** 從文字找行政區，city 有給就只找那個縣市的。 */
export function findDistrict(...texts) {
  let city = null;
  if (texts[0] && typeof texts[0] === 'object') city = texts.shift().city;
  const s = texts.filter(Boolean).join(' ').replace(/桃園市/g, '');
  const cities = city ? [city] : ['桃園市', '臺北市', '新北市'];
  for (const c of cities) {
    for (const d of CITY_DISTRICTS[c] ?? []) {
      if (!s.includes(`${d}區`)) continue;
      if (!city && AMBIGUOUS[d]?.test(s)) continue;
      return `${d}區`;
    }
  }
  return null;
}

/** 行政區屬於哪個縣市。 */
export function cityOfDistrict(d) {
  if (!d) return null;
  const n = String(d).replace(/區$/, '');
  return Object.keys(CITY_DISTRICTS).find((c) => CITY_DISTRICTS[c].includes(n)) ?? null;
}

export function isTaoyuan(...texts) {
  const s = texts.filter(Boolean).join(' ');
  if (/桃園市|桃園縣|（桃園市）|\(桃園市\)/.test(s)) return true;
  return DISTRICTS.some((d) => s.includes(`${d}區`) && !/新北|台北|臺北|新竹|苗栗/.test(s));
}

/** 台北市或新北市（地址寫了縣市，或寫了雙北特有的區名）。 */
export function isTaipeiArea(...texts) {
  const s = texts.filter(Boolean).join(' ').replace(/台/g, '臺');
  if (/臺北市|新北市|臺北縣/.test(s)) return true;
  if (/桃園|基隆|宜蘭|新竹|臺中|高雄|臺南/.test(s)) return false;
  return [...CITY_DISTRICTS['臺北市'], ...CITY_DISTRICTS['新北市']].some((d) => s.includes(`${d}區`) && !AMBIGUOUS[d]);
}

/** 本站有收的縣市：桃園市、臺北市、新北市。找不到回傳 null。 */
export function supportedCity(...texts) {
  const s = texts.filter(Boolean).join(' ').replace(/台/g, '臺');
  const c = findCity(s);
  if (c) return ['桃園市', '臺北市', '新北市'].includes(c) ? c : null;
  return cityOfDistrict(findDistrict(s));
}

// ---------- 文字 ----------

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", middot: '·', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', times: '×' };
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

export function cleanText(s, max = 400) {
  if (!s) return '';
  const t = decodeEntities(String(s).replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' '))
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

export const CATEGORIES = ['免費', '表演', '展覽', '講座課程', '親子', '親子館', '節慶市集', '體驗', '運動', '電影', '其他'];

// 依標題關鍵字判斷類別，由上往下，一個活動可以符合好幾個
const CATEGORY_RULES = [
  ['節慶市集', /市集|嘉年華|燈會|跨年|祭(?!祀)|(?<!季)節(?!目|錄|省)|花季|藝術季/],
  ['展覽', /(?<!舞)展(?!演|開|現|望)|展覽|特展|個展/],
  ['講座課程', /講座|課程|研習|工作坊|學堂|開班|讀書會|分享會|培訓/],
  ['親子', /親子|兒童|孩子|小朋友|寶寶|幼兒|故事屋|說故事|繪本/],
  ['表演', /音樂會|演唱|演出|戲劇|劇場|舞蹈|舞展|舞劇|表演|公演|音樂節|樂團|合唱|馬戲/],
  ['電影', /影展|電影|放映/],
  ['運動', /馬拉松|路跑|球隊|籃球|棒球|運動|健走|自行車/],
  ['體驗', /體驗|DIY|手作|導覽|走讀|小旅行|參訪|採果/],
];

/** 標題（和說明）符合的所有類別。 */
export function guessCategories(text) {
  const t = text ?? '';
  return CATEGORY_RULES.filter(([, re]) => re.test(t)).map(([c]) => c);
}

/** 依標題猜主要類別（來源沒給類別時使用）。 */
export function guessCategory(title, fallback = '其他') {
  return guessCategories(title)[0] ?? fallback;
}

const FREE_RE = /免費|免門票|免票|自由入場|自由參觀|免費入場|不收費|免報名費|索票入場|免費索票|免費參加|免費參觀/;
const PAID_RE = /票價|全票|優待票|\$\s?\d|NT\$?\s?\d|TWD\s?\$?\s?\d|\d+\s*元|費用\s*\+?\s*\d/;

/** 從文字判斷是否免費：true 免費、false 要付費、null 不確定。 */
export function detectFree(...texts) {
  // 「免費停車」「免費接駁」這類不代表活動免費
  const s = texts.filter(Boolean).join(' ').replace(/免費\s*(停車|接駁|wi-?fi|寄物|提供|贈送|試吃|抽獎|拍照)/gi, '');
  if (!s) return null;
  if (FREE_RE.test(s) && !/(非|不是)免費/.test(s)) return true;
  if (PAID_RE.test(s)) return false;
  return null;
}

const CITIES = ['臺北市', '新北市', '桃園市', '臺中市', '臺南市', '高雄市', '基隆市', '新竹市', '嘉義市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣'];
export const CITY_LIST = CITIES;

/** 從地址找縣市（台/臺都可以），找不到回傳 null。 */
export function findCity(...texts) {
  const s = texts.filter(Boolean).join(' ').replace(/台/g, '臺');
  return CITIES.find((c) => s.includes(c)) ?? (s.includes('桃園縣') ? '桃園市' : null);
}

/** 整理出活動的所有類別（主要類別在最前面，免費的加上「免費」）。 */
export function finalizeCategories(e) {
  const list = [e.category, ...(e.tags ?? []), ...guessCategories(e.title)].filter((c) => c && c !== '其他');
  if (e.category === '親子館') list.push('親子');
  if (e.free === true) list.unshift('免費');
  const uniq = [...new Set(list)];
  return uniq.length ? uniq : ['其他'];
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
    // 來源有給縣市就用；沒有就看地址、行政區，最後才用來源預設的縣市（桃園的來源預設桃園）
    city: fields.city ?? findCity(fields.address, fields.venue) ?? cityOfDistrict(fields.district ?? findDistrict(fields.address, fields.venue)) ?? source.city ?? '桃園市',
    category: fields.category ?? guessCategory(fields.title),
    free: fields.free ?? detectFree(fields.title, fields.summary),
    url: fields.url ?? null,
    image: fields.image ?? null,
    summary: cleanText(fields.summary, 2000) || null,
    extra: fields.extra ?? null,
  };
  if (fields.tags?.length) e.tags = fields.tags; // 來源給的其他類別
  if (!e.end) e.end = e.start;
  e.categories = finalizeCategories(e);
  return e;
}
