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

// 各縣市的行政區：「區」的只寫名字（例如 中壢 → 中壢區），縣的鄉鎮市寫全名（例如 竹北市、礁溪鄉）
export const CITY_DISTRICTS = {
  桃園市: ['桃園', '中壢', '平鎮', '八德', '楊梅', '蘆竹', '龜山', '大園', '觀音', '新屋', '龍潭', '大溪', '復興'],
  臺北市: ['中正', '大同', '中山', '松山', '大安', '萬華', '信義', '士林', '北投', '內湖', '南港', '文山'],
  新北市: ['板橋', '三重', '中和', '永和', '新莊', '新店', '樹林', '鶯歌', '三峽', '淡水', '汐止', '瑞芳', '土城', '蘆洲', '五股', '泰山', '林口', '深坑', '石碇', '坪林', '三芝', '石門', '八里', '平溪', '雙溪', '貢寮', '金山', '萬里', '烏來'],
  基隆市: ['中正', '信義', '仁愛', '中山', '安樂', '暖暖', '七堵'],
  新竹市: ['東', '北', '香山'],
  新竹縣: ['竹北市', '竹東鎮', '新埔鎮', '關西鎮', '湖口鄉', '新豐鄉', '芎林鄉', '橫山鄉', '北埔鄉', '寶山鄉', '峨眉鄉', '尖石鄉', '五峰鄉'],
  宜蘭縣: ['宜蘭市', '羅東鎮', '蘇澳鎮', '頭城鎮', '礁溪鄉', '壯圍鄉', '員山鄉', '冬山鄉', '五結鄉', '三星鄉', '大同鄉', '南澳鄉'],
  苗栗縣: ['苗栗市', '頭份市', '竹南鎮', '後龍鎮', '通霄鎮', '苑裡鎮', '卓蘭鎮', '造橋鄉', '西湖鄉', '頭屋鄉', '公館鄉', '銅鑼鄉', '三義鄉', '大湖鄉', '獅潭鄉', '三灣鄉', '南庄鄉', '泰安鄉'],
  臺中市: ['中', '東', '南', '西', '北', '北屯', '西屯', '南屯', '太平', '大里', '霧峰', '烏日', '豐原', '后里', '石岡', '東勢', '和平', '新社', '潭子', '大雅', '神岡', '大肚', '沙鹿', '龍井', '梧棲', '清水', '大甲', '外埔', '大安'],
  彰化縣: ['彰化市', '員林市', '和美鎮', '鹿港鎮', '溪湖鎮', '二林鎮', '田中鎮', '北斗鎮', '花壇鄉', '芬園鄉', '大村鄉', '永靖鄉', '伸港鄉', '線西鄉', '福興鄉', '秀水鄉', '埔心鄉', '埔鹽鄉', '大城鄉', '芳苑鄉', '竹塘鄉', '社頭鄉', '二水鄉', '田尾鄉', '埤頭鄉', '溪州鄉'],
  南投縣: ['南投市', '埔里鎮', '草屯鎮', '竹山鎮', '集集鎮', '名間鄉', '鹿谷鄉', '中寮鄉', '魚池鄉', '國姓鄉', '水里鄉', '信義鄉', '仁愛鄉'],
  雲林縣: ['斗六市', '斗南鎮', '虎尾鎮', '西螺鎮', '土庫鎮', '北港鎮', '莿桐鄉', '林內鄉', '古坑鄉', '大埤鄉', '崙背鄉', '二崙鄉', '麥寮鄉', '臺西鄉', '東勢鄉', '褒忠鄉', '四湖鄉', '口湖鄉', '水林鄉', '元長鄉'],
};
const DISTRICTS = CITY_DISTRICTS['桃園市'];
export const DISTRICT_LIST = DISTRICTS.map((d) => `${d}區`);
// 台北、新北的區名在別的縣市也有（基隆中正區、台中大安區…），所以要看文字裡有沒有寫別的縣市（給 isTaipeiArea 用）
const AMBIGUOUS = { 中正: /基隆(?!路)/, 中山: /基隆(?!路)/, 信義: /基隆(?!路)/, 大安: /臺中|台中/, 大同: /宜蘭/ };
/** 行政區的全名（縣的鄉鎮市已經是全名，其他加「區」）。 */
const fullDistrict = (d) => (/[市鎮鄉]$/.test(d) ? d : `${d}區`);

/** 本站有收的縣市（北部、中部）。順序＝沒寫縣市時找行政區的順序。 */
export const SUPPORTED_CITIES = ['桃園市', '臺北市', '新北市', '基隆市', '新竹市', '新竹縣', '宜蘭縣', '苗栗縣', '臺中市', '彰化縣', '南投縣', '雲林縣'];

// 文字裡提到縣市的簡稱（沒寫「市」「縣」也算），用來決定同名的區算哪裡
const CITY_HINT = {
  桃園市: /桃園/,
  臺北市: /臺北市|北市[^民府]/,
  新北市: /新北/,
  基隆市: /基隆(?!路)/,
  新竹市: /新竹(?!縣)|竹市/,
  新竹縣: /新竹縣|竹縣/,
  宜蘭縣: /宜蘭(?![路街])/,
  苗栗縣: /苗栗/,
  臺中市: /臺中(?![路街])|中市/,
  彰化縣: /彰化(?![路街銀])/,
  南投縣: /南投(?![路街])/,
  雲林縣: /雲林(?![路街])/,
};
// 沒提到縣市時不要猜的區名：東區、北區這種很多縣市都有；中正、中山、信義、大安預設算台北
const NEED_HINT = { 臺中市: ['中', '東', '南', '西', '北', '大安'], 新竹市: ['東', '北'], 基隆市: ['中正', '信義', '中山'] };
const DISTRICT_CITIES = new Map();
for (const [c, ds] of Object.entries(CITY_DISTRICTS)) for (const d of ds) DISTRICT_CITIES.set(fullDistrict(d), [...(DISTRICT_CITIES.get(fullDistrict(d)) ?? []), c]);

const norm = (texts) => texts.filter(Boolean).join(' ').replace(/台/g, '臺');

/** 找行政區和它的縣市：city 有給就只找那個縣市；文字提到的縣市先找；其他縣市跳過容易搞混的區名。 */
function locate(s, city) {
  if (city) {
    for (const d of CITY_DISTRICTS[city] ?? []) if (s.includes(fullDistrict(d))) return { city, district: fullDistrict(d) };
    return { city, district: null };
  }
  const named = findCity(s);
  const hinted = SUPPORTED_CITIES.filter((c) => c !== named && CITY_HINT[c].test(s));
  const first = [...(SUPPORTED_CITIES.includes(named) ? [named] : []), ...hinted];
  for (const c of first) for (const d of CITY_DISTRICTS[c]) if (s.includes(fullDistrict(d))) return { city: c, district: fullDistrict(d) };
  // 地址明寫了外縣市（例如臺南市東區）就不再猜
  if (named && !SUPPORTED_CITIES.includes(named)) return { city: null, district: null };
  for (const c of SUPPORTED_CITIES) {
    if (first.includes(c)) continue;
    for (const d of CITY_DISTRICTS[c]) {
      if (NEED_HINT[c]?.includes(d)) continue;
      if (s.includes(fullDistrict(d))) return { city: c, district: fullDistrict(d) };
    }
  }
  return { city: null, district: null };
}

/** 從文字找行政區，city 有給就只找那個縣市的。 */
export function findDistrict(...texts) {
  let city = null;
  if (texts[0] && typeof texts[0] === 'object') city = texts.shift().city;
  return locate(norm(texts), city).district;
}

/** 行政區屬於哪個縣市（同名的：中正、中山、信義、大安算台北；東區、北區這種不猜）。 */
export function cityOfDistrict(d) {
  if (!d) return null;
  const full = fullDistrict(String(d).replace(/區$/, '').replace(/台/g, '臺'));
  const cs = DISTRICT_CITIES.get(full) ?? DISTRICT_CITIES.get(String(d)) ?? [];
  if (cs.length === 1) return NEED_HINT[cs[0]]?.includes(full.replace(/區$/, '')) ? null : cs[0];
  return cs.includes('臺北市') ? '臺北市' : null;
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
  if (/桃園|基隆(?!路)|宜蘭|新竹|苗栗|臺中|彰化|南投|雲林|嘉義|高雄|臺南/.test(s)) return false;
  return [...CITY_DISTRICTS['臺北市'], ...CITY_DISTRICTS['新北市']].some((d) => s.includes(`${d}區`) && !AMBIGUOUS[d]);
}

/** 本站有收的縣市（看地址裡的縣市、行政區、縣市簡稱）。找不到回傳 null。 */
export function supportedCity(...texts) {
  const s = norm(texts);
  const c = findCity(s);
  if (c) return SUPPORTED_CITIES.includes(c) ? c : null;
  const loc = locate(s, null);
  if (loc.city) return loc.city;
  // 只寫「新竹」：寫了縣的鄉鎮名就是新竹縣，不然當作新竹市
  if (/竹縣|竹北|竹東|湖口|新豐|關西|新埔|芎林|橫山|北埔|寶山|峨眉|尖石|五峰|六福村/.test(s) && /新竹|竹縣|竹北|竹東/.test(s)) return '新竹縣';
  for (const city of ['基隆市', '新竹市', '宜蘭縣', '苗栗縣', '臺中市', '彰化縣', '南投縣', '雲林縣', '新北市', '桃園市']) if (CITY_HINT[city].test(s)) return city;
  if (/臺北(?![路街])/.test(s)) return '臺北市';
  return null;
}

/** 新竹地區（新竹市或新竹縣）。 */
export function isHsinchu(...texts) {
  const c = supportedCity(...texts);
  return c === '新竹市' || c === '新竹縣';
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
