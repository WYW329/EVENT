// 台北、新北的場館和小型藝文平台：華山、松菸、北美館、北流、C-LAB、非池中藝術網（小畫廊、藝術空間）、iNDIEVOX（Live House）、新北市立博物館群。
import * as cheerio from 'cheerio';
import { fetchText, politeFetch, makeEvent, cleanText, findDistrict, supportedCity, todayTaipei } from '../util.js';
import { extractEventDates, EVENT_RE, SKIP_RE } from './tycgnews.js';

const ymd = (s) => {
  const m = String(s ?? '').match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
};
/** 「2026-11-01 - 2026-11-30」「2026.12.12 (六) ~ 2026.12.13 (日)」→ { start, end } */
const range = (s) => {
  const all = [...String(s ?? '').matchAll(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/g)].map((m) => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
  return all.length ? { start: all[0], end: all.at(-1) } : null;
};
const toTaipeiDate = (iso) => (iso ? todayTaipei(new Date(iso)) : null);
const ended = (end) => end && end < todayTaipei();

// ---------- 華山1914：展演活動總覽（Nuxt 的 __NUXT_DATA__，要把參照還原） ----------
export function readNuxtData(html) {
  const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  const a = JSON.parse(m[1]);
  const memo = new Map();
  const R = (i) => {
    if (typeof i !== 'number') return i;
    if (memo.has(i)) return memo.get(i);
    const v = a[i];
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string' && ['Reactive', 'ShallowReactive', 'Ref', 'ShallowRef', 'EmptyRef', 'Set', 'Map', 'Date', 'NuxtError'].includes(v[0])) return R(v[1]);
      const o = [];
      memo.set(i, o);
      for (const x of v) o.push(R(x));
      return o;
    }
    const o = {};
    memo.set(i, o);
    for (const k of Object.keys(v)) o[k] = R(v[k]);
    return o;
  };
  return R(0);
}

export const huashan = {
  id: 'huashan',
  name: '華山1914文化創意產業園區',
  city: '臺北市',
  async fetch() {
    const found = new Map();
    for (let page = 1; page <= 15; page++) {
      const root = readNuxtData(await fetchText(`https://www.huashan1914.com/exhibition${page > 1 ? `?page=${page}` : ''}`));
      const items = [];
      const walk = (o, d) => {
        if (!o || typeof o !== 'object' || d > 30) return;
        if (o.article?.default?.title && o.article?.event_time) { items.push(o); return; }
        for (const k of Object.keys(o)) walk(o[k], d + 1);
      };
      walk(root, 0);
      const before = found.size;
      for (const it of items) if (!found.has(it._id)) found.set(it._id, it);
      if (found.size === before) break;
    }
    return [...found.values()].map((o) => {
      const a = o.article;
      const title = a.default.title.trim();
      return makeEvent(this, o._id, {
        title,
        start: toTaipeiDate(a.event_time.start_date),
        end: toTaipeiDate(a.event_time.end_date),
        venue: '華山1914文化創意產業園區',
        address: '臺北市中正區八德路一段1號',
        district: '中正區',
        url: `https://www.huashan1914.com/exhibition/${encodeURIComponent(a.default.slug ?? title)}`,
        image: a.event_content?.hero_img?.[0]?.path ?? null,
        extra: { organizer: '華山1914' },
      });
    }).filter((e) => e.start && !ended(e.end));
  },
};

// ---------- 松山文創園區：展演資訊 ----------
export const songshan = {
  id: 'songshan',
  name: '松山文創園區',
  city: '臺北市',
  async fetch() {
    const $ = cheerio.load(await fetchText('https://www.songshanculturalpark.org/exhibition'));
    const seen = new Map();
    $('a[href^="/exhibition/activity/"]').each((_, el) => {
      const a = $(el);
      const id = a.attr('href').split('/').pop();
      const title = a.find('.title').first().text().trim();
      const r = range(a.find('.date').first().text());
      if (!title || !r || seen.has(id) || /展演攻略|場地租借/.test(title)) return;
      const img = a.find('img').attr('src');
      seen.set(id, makeEvent(this, id, {
        title,
        start: r.start,
        end: r.end,
        venue: '松山文創園區',
        address: '臺北市信義區光復南路133號',
        district: '信義區',
        url: `https://www.songshanculturalpark.org${a.attr('href')}`,
        image: img ? new URL(img, 'https://www.songshanculturalpark.org/').href : null,
        extra: { organizer: '松山文創園區' },
      }));
    });
    return [...seen.values()].filter((e) => !ended(e.end));
  },
};

// ---------- 臺北市立美術館：當期展覽＋教育推廣活動（網站自己的 JSON 介面） ----------
async function tfamApi(path, body) {
  const res = await politeFetch(`https://www.tfam.museum/ashx/${path}?ddlLang=zh-tw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.Status !== '1') throw new Error(j.StatusMessage);
  return j.Data ?? [];
}

export const tfam = {
  id: 'tfam',
  name: '臺北市立美術館',
  city: '臺北市',
  async fetch() {
    const base = { venue: '臺北市立美術館', address: '臺北市中山區中山北路三段181號', district: '中山區', extra: { organizer: '臺北市立美術館' } };
    const img = (p) => (p ? `https://www.tfam.museum/File/${String(p).replace(/\\/g, '/')}` : null);
    const out = [];
    for (const x of await tfamApi('Exhibition.ashx', { JJMethod: 'GetEx', Type: '1' })) {
      out.push(makeEvent(this, `ex${x.ExID}`, {
        ...base,
        title: x.ExName.trim(),
        start: ymd(x.BeginDate),
        end: ymd(x.EndDate),
        venue: x.Area ? `臺北市立美術館 ${x.Area}` : base.venue,
        category: '展覽',
        url: x.ExternalLink || `https://www.tfam.museum/Exhibition/Exhibition_Special.aspx?ddlLang=zh-tw&id=${x.ExID}`,
        image: img(x.NowPlayImg),
        summary: cleanText(x.Content, 1500),
      }));
    }
    for (const x of await tfamApi('Event.ashx', { JJMethod: 'GetEv', State: 'Now' })) {
      const text = cleanText(x.Content, 1800);
      out.push(makeEvent(this, `ev${x.EduID}`, {
        ...base,
        title: x.EduName.trim(),
        start: ymd(x.BeginDate),
        end: ymd(x.EndDate),
        venue: x.Area ? `臺北市立美術館 ${x.Area}` : base.venue,
        free: x.Fare === 0 ? true : null,
        url: `https://www.tfam.museum/Event/Event_page.aspx?ddlLang=zh-tw&id=${x.EduID}`,
        image: img(x.NowPlayImg),
        summary: text,
        tags: /工作坊|體驗/.test(x.Kind ?? '') ? ['體驗'] : /講座|座談/.test(x.Kind ?? '') ? ['講座課程'] : /親子|兒童/.test(x.Kind ?? '') ? ['親子'] : [],
        extra: { organizer: '臺北市立美術館', registration: x.EduReserve === 2 ? '需報名' : null },
      }));
    }
    return out.filter((e) => e.start && !ended(e.end));
  },
};

// ---------- 臺北流行音樂中心：最近活動 ----------
export const tmc = {
  id: 'tmc',
  name: '臺北流行音樂中心',
  city: '臺北市',
  async fetch() {
    const $ = cheerio.load(await fetchText('https://tmc.taipei/show/'));
    const out = new Map();
    $('a.c-card-clip-wrap').each((_, el) => {
      const a = $(el);
      const href = a.attr('href');
      const r = range(a.find('.date').first().text());
      const title = a.find('.c-card-clip__title').first().text().trim();
      if (!href || !r || !title || out.has(href)) return;
      out.set(href, makeEvent(this, href.split('/').pop(), {
        title,
        start: r.start,
        end: r.end,
        venue: `臺北流行音樂中心 ${a.find('.location').first().text().trim()}`.trim(),
        address: '臺北市南港區市民大道八段99號',
        district: '南港區',
        category: '表演',
        url: href,
        image: a.find('img').attr('src') ?? null,
        extra: { organizer: '臺北流行音樂中心' },
      }));
    });
    // 常設展、線上特展跨好幾年，不列
    return [...out.values()].filter((e) => !ended(e.end) && !/常設|線上特展/.test(e.title) && e.end < `${new Date().getFullYear() + 2}`);
  },
};

// ---------- 空總臺灣當代文化實驗場 C-LAB ----------
export const clab = {
  id: 'clab',
  name: '臺灣當代文化實驗場 C-LAB',
  city: '臺北市',
  async fetch() {
    const $ = cheerio.load(await fetchText('https://clab.org.tw/events/'));
    const out = new Map();
    $('.EventTileItem').each((_, el) => {
      const box = $(el);
      const href = box.find('a').attr('href');
      const text = box.text().replace(/\s+/g, ' ').trim();
      const dates = [...text.matchAll(/(\d{4})\/(\d{2})\/(\d{2})/g)];
      if (!href || !dates.length || out.has(href)) return;
      const title = text.slice(0, dates[0].index).replace(/^CREATORS創作\/研發支持計畫\s*/, '').trim();
      const venue = text.slice(dates.at(-1).index + 10).trim();
      const r = range(text);
      const img = box.find('img').attr('src');
      out.set(href, makeEvent(this, decodeURIComponent(href.split('/').filter(Boolean).pop()).slice(0, 60), {
        title,
        start: r.start,
        end: r.end,
        venue: venue ? `C-LAB ${venue}` : 'C-LAB 臺灣當代文化實驗場',
        address: '臺北市大安區建國南路一段177號',
        district: '大安區',
        url: new URL(href, 'https://clab.org.tw/').href,
        image: img && !img.startsWith('data:') ? new URL(img, 'https://clab.org.tw/').href : null,
        extra: { organizer: 'C-LAB' },
      }));
    });
    return [...out.values()].filter((e) => e.title && !ended(e.end));
  },
};

// ---------- 非池中藝術網：藝文展覽（很多小畫廊、藝術空間），只留台北、新北、桃園 ----------
export function parseArtemperor(html) {
  const $ = cheerio.load(html);
  return $('.list_box')
    .map((_, el) => {
      const box = $(el);
      const href = box.find('a[href*="/tidbits/"]').first().attr('href');
      const info = box.find('.list_text p').first().text().trim();
      const [datePart, place = ''] = info.replace(/^日期：/, '').split('｜');
      const bg = box.find('.pic').attr('style')?.match(/url\(([^)]+)\)/)?.[1] ?? null;
      return {
        id: href?.match(/tidbits\/(\d+)/)?.[1],
        url: href,
        venue: box.find('h3').first().text().trim(),
        title: box.find('h2').first().text().trim().replace(/^【(.+)】$/, '$1'),
        dates: range(datePart),
        place: place.replace(/^台灣，?/, ''),
        image: bg,
      };
    })
    .get()
    .filter((x) => x.id && x.title && x.dates);
}

export const artemperor = {
  id: 'artemperor',
  name: '非池中藝術網',
  async fetch() {
    const out = new Map();
    for (let page = 1; page <= 12; page++) {
      const list = parseArtemperor(await fetchText(`https://artemperor.tw/tidbits${page > 1 ? `?page=${page}` : ''}`));
      if (!list.length) break;
      for (const it of list) {
        const city = supportedCity(it.place);
        if (!city || out.has(it.id) || ended(it.dates.end)) continue;
        out.set(it.id, makeEvent({ ...this, city }, it.id, {
          title: it.title,
          start: it.dates.start,
          end: it.dates.end,
          venue: it.venue || null,
          city,
          category: '展覽',
          url: it.url,
          image: it.image,
          extra: { organizer: it.venue || null },
        }));
      }
    }
    return [...out.values()];
  },
};

// ---------- iNDIEVOX：Live House、獨立音樂演出（內頁有地點，存快取） ----------
// 地點沒寫地址時，用常見的雙北展演空間判斷
const TPE_LIVE = /Legacy\s*(Taipei|mini)|The Wall|這牆|PIPE|河岸留言|Revolver|女巫店|雷克雅維克|Corner House|THE WALL|SUB\b|華山|北流|臺北流行|台北流行|Clapper|月見ル君想フ|海邊的卡夫卡|Riverside|小巨蛋|大巨蛋|松山|信義|中山|大安|萬華|南港|內湖|士林|北投|文山|中正|大同/i;
const NTPC_LIVE = /Zepp New Taipei|新莊|板橋|三重|中和|永和|新店|淡水|林口/i;
export const indievox = {
  id: 'indievox',
  name: 'iNDIEVOX',
  async fetch() {
    const { readFile, writeFile } = await import('node:fs/promises');
    const cacheFile = new URL('../../data/indievox-cache.json', import.meta.url);
    const cache = JSON.parse(await readFile(cacheFile, 'utf8').catch(() => '{}'));
    // 表格模式列出所有之後的演出（日期、標題、場地）
    const end = new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10).replace(/-/g, '/');
    const $ = cheerio.load(await fetchText(`https://www.indievox.com/activity/list?type=table&startDate=${encodeURIComponent(todayTaipei().replace(/-/g, '/'))}&endDate=${encodeURIComponent(end)}`));
    const items = new Map();
    $('tr.fcTxt').each((_, el) => {
      const tds = $(el).find('td');
      const a = $(el).find('a[href*="/activity/detail/"]');
      const id = a.attr('href')?.split('/').pop();
      if (!id || items.has(id)) return;
      items.set(id, { id, title: a.text().trim(), date: ymd(tds.eq(0).text()), venue: tds.eq(2).text().trim(), image: null });
    });
    const out = [];
    for (const it of items.values()) {
      if (!it.title || !it.date || ended(it.date)) continue;
      // 標題寫了外縣市場次就不用看內頁
      if (/台中|臺中|Taichung|高雄|Kaohsiung|台南|臺南|新竹|嘉義|花蓮|台東|臺東|宜蘭|屏東|彰化|雲林|南投|苗栗/i.test(`${it.title} ${it.venue}`) && !/台北|臺北|Taipei|新北|桃園/i.test(`${it.title} ${it.venue}`)) continue;
      let d = cache[it.id];
      if (!d) {
        const html = await fetchText(`https://www.indievox.com/activity/detail/${it.id}`).catch(() => '');
        const text = html ? cheerio.load(html)('body').text().replace(/\s+/g, ' ') : '';
        const place = text.match(/(?:演出|活動)?(?:地點|場地|会場|Venue)[^:：]{0,12}[:：]\s*([^：:．]{2,80}?)(?=\s*(?:演出地址|地址|演出者|嘉賓|票\s?價|料金|售票|購票|出演|活動|主辦|．|$))/)?.[1]?.trim() ?? null;
        const addr = text.match(/(?:演出|活動)?地址\s*[:：]\s*([^：:]{4,60}?)(?=\s*(?:購票|票\s?價|主辦|演出|活動|$))/)?.[1]?.trim() ?? null;
        const time = text.match(/(?:演出|活動)日期(?:及時間)?\s*[:：]\s*(\d{4}\/\d{1,2}\/\d{1,2})[^\d]{0,8}(\d{1,2}:\d{2})?/);
        const sale = text.match(/售票時間\s*[:：]\s*(\d{4}\/\d{1,2}\/\d{1,2})[^\d]{0,8}(\d{1,2}:\d{2})?/);
        const price = text.match(/票價\s*[:：]\s*([^：:]{2,80}?)(?=\s*(?:售票|演出|活動|$))/)?.[1]?.trim() ?? null;
        d = { place, addr, time: time ? [ymd(time[1]), time[2] ?? null] : null, sale: sale ? [ymd(sale[1]), sale[2] ?? null] : null, price, summary: cleanText(text.slice(text.indexOf('演出日期'), text.indexOf('演出日期') + 1200), 1200), cachedAt: todayTaipei() };
        if (html) cache[it.id] = d;
      }
      const where = `${d.place ?? ''} ${it.venue}`;
      const city = supportedCity(d.addr, d.place, it.title) ?? (TPE_LIVE.test(where) ? '臺北市' : NTPC_LIVE.test(where) ? '新北市' : null);
      if (!city) continue;
      const at = (p) => (p?.[0] ? (p[1] ? `${p[0]}T${p[1].padStart(5, '0')}:00+08:00` : p[0]) : null);
      out.push(makeEvent({ ...this, city }, it.id, {
        title: it.title,
        start: at(d.time) ?? it.date,
        venue: it.venue || d.place?.replace(/[（(].*$/, '').trim() || null,
        address: d.addr ?? d.place?.match(/[（(]([^）)]+)[）)]/)?.[1] ?? null,
        city,
        category: '表演',
        free: /免費/.test(d.price ?? '') ? true : d.price ? false : null,
        regStart: at(d.sale),
        url: `https://www.indievox.com/activity/detail/${it.id}`,
        image: it.image,
        summary: d.summary,
        extra: { prices: d.price ? [d.price.slice(0, 40)] : null },
      }));
    }
    for (const [k, v] of Object.entries(cache)) if (!items.has(k) && Date.now() - Date.parse(v.cachedAt ?? 0) > 60 * 86400000) delete cache[k];
    await writeFile(cacheFile, JSON.stringify(cache));
    return out;
  },
};

// ---------- 新北市立博物館群、文化局（同一套網站系統的「活動訊息」） ----------
const NTPC_MUSEUMS = [
  ['新北市立十三行博物館', 'https://www.sshm.ntpc.gov.tw/xceventsnews?xsmsid=0G250557655940640091', '八里區'],
  ['新北市立黃金博物館', 'https://www.gep.ntpc.gov.tw/xceventsnews?xsmsid=0G266496700270752519', '瑞芳區'],
  ['新北市立淡水古蹟博物館', 'https://www.tshs.ntpc.gov.tw/xceventsnews?xsmsid=0G252620780150430418', '淡水區'],
  ['林本源園邸', 'https://www.linfamily.ntpc.gov.tw/xceventsnews?xsmsid=0G249617555861789607', '板橋區'],
  ['新北市坪林茶業博物館', 'https://www.tea.ntpc.gov.tw/xceventsnews?xsmsid=0G266539891005215502', '坪林區'],
  ['新北市政府文化局', 'https://www.culture.ntpc.gov.tw/xceventsnews?xsmsid=0G295700334178642420', null],
];

export const ntpcMuseums = {
  id: 'ntpcmuseum',
  name: '新北市立博物館群',
  city: '新北市',
  async fetch() {
    const out = [];
    const errors = [];
    await Promise.all(NTPC_MUSEUMS.map(async ([org, listUrl, district]) => {
      try {
        const $ = cheerio.load(await fetchText(listUrl));
        const links = new Map();
        $('a[href*="xceventsnews/cont"]').each((_, el) => {
          const href = new URL($(el).attr('href'), listUrl).href;
          const title = ($(el).attr('title') || $(el).text()).replace(/^標題：/, '').trim();
          if (!links.has(href) && title) links.set(href, title);
        });
        for (const [href, title] of [...links].slice(0, 15)) {
          if (!EVENT_RE.test(title) || SKIP_RE.test(title)) continue;
          const page = await fetchText(href).catch(() => '');
          if (!page) continue;
          const p = cheerio.load(page);
          p('script,style,header,nav,footer').remove();
          const text = cleanText(p('main, .cp, .editable_content, body').first().text(), 2500);
          const dates = extractEventDates(`${title} ${text}`);
          if (!dates || ended((dates.end ?? dates.start).slice(0, 10))) continue;
          out.push(makeEvent({ id: this.id, name: org, city: '新北市' }, new URL(href).searchParams.get('sid') ?? href, {
            title,
            start: dates.start,
            end: dates.end,
            venue: org.startsWith('新北市政府') ? null : org,
            district: findDistrict({ city: '新北市' }, text.slice(0, 600)) ?? district,
            city: '新北市',
            url: href,
            image: p('meta[property="og:image"]').attr('content') ?? null,
            summary: text,
            extra: { organizer: org },
          }));
        }
      } catch (err) {
        errors.push(`${org}: ${err.message}`);
      }
    }));
    if (errors.length && !out.length) throw new Error(errors.join('; '));
    if (errors.length) out.warnings = errors;
    return out;
  },
};

// ---------- 台北世貿中心、南港展覽館：展覽日程表（各種商展、動漫展、旅展、書展） ----------
export const twtc = {
  id: 'twtc',
  name: '台北世貿・南港展覽館',
  city: '臺北市',
  async fetch() {
    const { parseShortRange } = await import('./malls.js');
    const $ = cheerio.load(await fetchText('https://www.twtc.com.tw/exhibition?p=home'));
    const out = new Map();
    $('tr').each((_, tr) => {
      const td = $(tr).find('td');
      if (td.length < 5) return;
      const r = parseShortRange(td.eq(0).text());
      const cell = td.eq(1);
      const more = cell.find('a[href*="exhibition_more"]').attr('href');
      const id = more?.match(/id=(\d+)/)?.[1];
      const title = cell.clone().find('a[href*="exhibition_more"]').remove().end().text().replace(/\s+/g, ' ').trim();
      if (!r || !id || !title || out.has(id) || ended(r.end)) return;
      const hall = td.eq(4).text().trim();
      const nangang = /南港/.test(hall);
      out.set(id, makeEvent(this, id, {
        title,
        start: r.start,
        end: r.end,
        venue: hall || '台北世貿中心',
        address: nangang ? '臺北市南港區經貿二路1號' : '臺北市信義區信義路五段5號',
        district: nangang ? '南港區' : '信義區',
        category: '展覽',
        url: cell.find('a').not('[href*="exhibition_more"]').attr('href')?.trim() || `https://www.twtc.com.tw/${more}`,
        extra: { organizer: td.eq(2).text().replace(/\s+/g, ' ').trim() || null, page: `https://www.twtc.com.tw/${more}` },
      }));
    });
    return [...out.values()];
  },
};

// ---------- 台北當代藝術館 ----------
export const moca = {
  id: 'moca',
  name: '台北當代藝術館',
  city: '臺北市',
  async fetch() {
    const $ = cheerio.load(await fetchText('https://www.mocataipei.org.tw/tw/ExhibitionAndEvent'));
    const out = new Map();
    $('a.textFrame').each((_, el) => {
      const a = $(el);
      const href = a.attr('href');
      const dates = a.find('.date').map((_, d) => {
        const y = $(d).find('.year').text().trim();
        const md = $(d).find('.day').text().match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
        return y && md ? `${y}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}` : null;
      }).get().filter(Boolean);
      const title = a.find('.imgTitle').text().trim();
      if (!href || !title || !dates.length || out.has(href)) return;
      out.set(href, makeEvent(this, decodeURIComponent(href.split('/').pop()).slice(0, 60), {
        title,
        start: dates[0],
        end: dates.at(-1),
        venue: '台北當代藝術館',
        address: '臺北市大同區長安西路39號',
        district: '大同區',
        url: href,
        extra: { organizer: '台北當代藝術館' },
      }));
    });
    return [...out.values()].filter((e) => !ended(e.end));
  },
};

// ---------- 國家場館的「當期活動／展覽資訊」頁（同一套網站系統，卡片上有日期、地點） ----------
const ACTIVES_PAGES = [
  ['國立國父紀念館', 'https://www.yatsen.gov.tw/News_actives.aspx?n=6682&sms=13411', '臺北市信義區仁愛路四段505號', '信義區'],
  ['國立國父紀念館', 'https://www.yatsen.gov.tw/News_actives.aspx?n=7339&sms=13411', '臺北市信義區仁愛路四段505號', '信義區'],
  ['國立國父紀念館', 'https://www.yatsen.gov.tw/News_actives.aspx?n=7343&sms=13411', '臺北市信義區仁愛路四段505號', '信義區'],
  ['國立國父紀念館', 'https://www.yatsen.gov.tw/News_actives.aspx?n=7344&sms=13411', '臺北市信義區仁愛路四段505號', '信義區'],
  ['國立國父紀念館', 'https://www.yatsen.gov.tw/News_actives.aspx?n=7346&sms=13411', '臺北市信義區仁愛路四段505號', '信義區'],
  ['國立臺灣博物館', 'https://www.ntm.gov.tw/News_actives.aspx?n=5472&sms=13389', '臺北市中正區襄陽路2號', '中正區'],
  ['國立臺灣博物館', 'https://www.ntm.gov.tw/News_actives.aspx?n=5473&sms=13389', '臺北市中正區襄陽路25號', '中正區'],
  ['國立臺灣博物館', 'https://www.ntm.gov.tw/News_actives.aspx?n=5474&sms=13389', '臺北市中正區南昌路一段1號', '中正區'],
];

export function parseActives(html, base) {
  const $ = cheerio.load(html.replace(/\u0000/g, ''));
  const out = [];
  $('a').has('.essay').each((_, el) => {
    const a = $(el);
    const title = a.find('.caption').first().text().trim();
    const r = range(a.find('.activity-time').first().text());
    if (!title || !r) return;
    const img = a.find('img').attr('src');
    out.push({
      title,
      ...r,
      place: a.find('.activity-season').first().text().replace(/^地點：/, '').trim() || null,
      url: new URL(a.attr('href'), base).href,
      image: img ? new URL(img, base).href : null,
      summary: cleanText(a.find('.p').text(), 600),
    });
  });
  return out;
}

export const nationalVenues = {
  id: 'natvenue',
  name: '國父紀念館・臺灣博物館',
  city: '臺北市',
  async fetch() {
    const out = new Map();
    const errors = [];
    for (const [org, url, address, district] of ACTIVES_PAGES) {
      try {
        for (const it of parseActives(await fetchText(url), url)) {
          const key = `${org}:${it.title}:${it.start}`;
          if (out.has(key) || ended(it.end)) continue;
          out.set(key, makeEvent({ id: this.id, name: org, city: '臺北市' }, it.url.match(/[?&]s=(\d+)/)?.[1] ?? it.url.split('actId=')[1] ?? key, {
            title: it.title,
            start: it.start,
            end: it.end,
            venue: it.place ? `${org} ${it.place}`.slice(0, 80) : org,
            address,
            district,
            city: '臺北市',
            url: it.url,
            image: it.image,
            summary: it.summary,
            extra: { organizer: org },
          }));
        }
      } catch (err) {
        errors.push(`${org}: ${err.message}`);
      }
    }
    const list = [...out.values()];
    if (errors.length && !list.length) throw new Error(errors.join('; '));
    if (errors.length) list.warnings = errors;
    return list;
  },
};
