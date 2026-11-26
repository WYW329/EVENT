// 售票和活動平台、民間場館：KKTIX、Accupass、中原文創園區。
import * as cheerio from 'cheerio';
import { fetchText, politeFetch, makeEvent, parseDateTime, findDistrict, isTaoyuan, isTaipeiArea, cleanText, supportedCity } from '../util.js';

// ---------- KKTIX（有官方 Atom 訂閱） ----------
export function parseKktixAtom(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];
  $('entry').each((_, el) => {
    const e = $(el);
    const content = cheerio.load(e.find('content').text()).text();
    const time = content.match(/時間：\s*([^~\n]+?)(?:\(\+0800\))?\s*~\s*([^\n]+?)(?:\(\+0800\))?\s*(?:\n|地點|$)/);
    const place = content.match(/地點：\s*([^\n]+)/)?.[1]?.trim() ?? '';
    const [venue, address] = place.split(' / ').map((s) => s?.trim());
    items.push({
      id: e.find('id').text().split('/').pop(),
      title: e.find('title').text().trim(),
      url: e.find('link').attr('href'),
      start: time ? parseDateTime(time[1]) : parseDateTime(e.find('published').text()),
      end: time ? parseDateTime(time[2]) : null,
      venue,
      address: address || venue,
      summary: e.find('summary').text(),
      organizer: e.find('author name').text().trim(),
    });
  });
  return items;
}

/** KKTIX 活動頁的票種表：每種票的販售期間和價格（免費／TWD$）。 */
export function parseKktixTickets(html) {
  const text = cheerio.load(html)('body').text().replace(/\s+/g, ' ');
  const re = /(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2})\(\+0800\)\s*~\s*(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2})\(\+0800\)\s*([^\d$]{0,12}?)\s*(免費|TWD\$?\s?[\d,]+)/g;
  const tickets = [...text.matchAll(re)].map((m) => ({ saleStart: parseDateTime(m[1]), saleEnd: parseDateTime(m[2]), status: m[3].trim(), price: m[4] }));
  if (!tickets.length) return null;
  const starts = tickets.map((t) => t.saleStart).sort();
  const ends = tickets.map((t) => t.saleEnd).sort();
  return {
    regStart: starts[0],
    regEnd: ends.at(-1),
    free: tickets.every((t) => t.price === '免費') ? true : tickets.some((t) => t.price !== '免費') ? false : null,
    prices: [...new Set(tickets.map((t) => t.price))].slice(0, 4),
  };
}

export const kktix = {
  id: 'kktix',
  name: 'KKTIX',
  async fetch() {
    const out = [];
    const items = new Map();
    for (const q of ['桃園', '台北', '新北']) {
      const xml = await fetchText(`https://kktix.com/events.atom?search=${encodeURIComponent(q)}`);
      for (const it of parseKktixAtom(xml)) if (!items.has(it.id) && (isTaoyuan(it.venue, it.address, it.title) || isTaipeiArea(it.venue, it.address))) items.set(it.id, it);
    }
    for (const it of items.values()) {
      // 活動頁有開賣時間和票價；被擋就只用 Atom 的資料
      const t = await fetchText(it.url).then(parseKktixTickets).catch(() => null);
      out.push(
        makeEvent(this, it.id, {
          title: it.title,
          start: it.start,
          end: it.end,
          venue: it.venue,
          address: it.address,
          url: it.url,
          summary: it.summary,
          regStart: t?.regStart ?? null,
          regEnd: t?.regEnd ?? null,
          free: t?.free ?? null,
          extra: { organizer: it.organizer, prices: t?.prices ?? null },
        }),
      );
    }
    return out;
  },
};

// ---------- Accupass（用地區篩選 l=taoyuan 的搜尋結果頁） ----------
export function parseAccupassSearch(html) {
  const $ = cheerio.load(html);
  const items = new Map();
  $('a[href^="/event/"]').each((_, el) => {
    const a = $(el);
    const id = a.attr('href').match(/\/event\/(\d+)/)?.[1];
    if (!id) return;
    const card = a.closest('[class*="EventCard_home-event-card__"]');
    const name = card.find('[class*="EventCard_event-name"]').text().trim();
    if (!name || items.has(id)) return;
    const timeText = card.find('[class*="EventCard_event-time"]').text().trim();
    // 例：2026.11.29 (Sun) 14:00 - 16:00 或 2026.11.29 (Sun) 14:00 - 2026.12.01 (Tue) 16:00
    const parts = timeText.split(/\s+-\s+/);
    const start = parseDateTime(parts[0]);
    let end = null;
    if (parts[1]) {
      end = /\d{4}\./.test(parts[1]) ? parseDateTime(parts[1]) : parseDateTime(`${parts[0].slice(0, 10)} ${parts[1]}`);
    }
    items.set(id, {
      id,
      title: name,
      start,
      end,
      place: card.find('[class*="EventPlaceType_event-location-type"] span').text().trim(),
      image: card.find('img[alt^="event-banner"]').attr('src') ?? null,
      tags: card.find('[class*="TagStatsBottom_tag"]').map((_, t) => $(t).text().replace('#', '').trim()).get(),
    });
  });
  return [...items.values()];
}

export const accupass = {
  id: 'accupass',
  name: 'Accupass 活動通',
  async fetch() {
    const out = [];
    for (const [l, city] of [['taoyuan', '桃園市'], ['taipei', '臺北市'], ['new-taipei', '新北市']]) {
      const html = await fetchText(`https://www.accupass.com/search?l=${l}`);
      out.push(...parseAccupassSearch(html).map((it) => ({ ...it, city })));
    }
    return out
      // 地區篩選會混進線上活動，去掉
      .filter((it) => !/出租|租借|徵才/.test(it.title) && it.place !== '線上活動' && !/線上\s*online|【線上】|^線上/i.test(it.title))
      .map((it) =>
        makeEvent(this, it.id, {
          title: it.title,
          start: it.start,
          end: it.end,
          venue: it.place && !/City$|^(台北市|臺北市|新北市|桃園市)$/.test(it.place) ? it.place : null,
          city: supportedCity(it.place) ?? it.city,
          district: findDistrict({ city: supportedCity(it.place) ?? it.city }, it.title),
          url: `https://www.accupass.com/event/${it.id}`,
          image: it.image,
          extra: it.tags.length ? { tags: it.tags.slice(0, 5) } : null,
        }),
      );
  },
};

// ---------- 桃知道 GELEVEN PLAZA（商場展演廳、市集、活動；網站是 Cyberbiz 部落格） ----------
const G11_BLOGS = [
  ['同期活動精選', '展覽'],
  ['最新活動', null],
  ['市集活動', '節慶市集'],
];

/** 「11/21 - 1/28 | 化石博覽會 冰河巨獸展」→ 日期區間＋標題。年份取最接近現在的。 */
export function splitDatedTitle(raw, now = Date.now()) {
  const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(?:(\d{4})[./])?(\d{1,2})[./](\d{1,2})(?:\s*\([^)]*\))?\s*(?:[-~～至]\s*(?:(\d{4})[./])?(\d{1,2})[./](\d{1,2})(?:\s*\([^)]*\))?)?\s*[|｜]\s*(.+)$/);
  const title = (m ? m[7] : t).replace(/^[|｜\s]+|[|｜\s]+$/g, '').replace(/\s*[|｜]\s*/g, '｜');
  if (!m) return { title, start: null, end: null };
  const nowY = taipeiYear(now);
  const pick = (y, mo, d) => {
    if (y) return makeDate(Number(y), mo, d);
    // 沒寫年：取離現在最近的一年（跨年展期的結束日會在明年）
    const cands = [nowY - 1, nowY, nowY + 1].map((yy) => makeDate(yy, mo, d));
    return cands.sort((a, b) => Math.abs(Date.parse(a) - now) - Math.abs(Date.parse(b) - now))[0];
  };
  const start = pick(m[1], m[2], m[3]);
  let end = m[5] ? pick(m[4], m[5], m[6]) : start;
  if (end < start) end = makeDate(Number(end.slice(0, 4)) + 1, m[5], m[6]);
  return { title, start, end };
}
const taipeiYear = (ms) => new Date(ms + 8 * 3600000).getUTCFullYear();
const makeDate = (y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export function parseG11Blog(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('#blog_articles .article').each((_, el) => {
    const box = $(el);
    const a = box.find('.article_title a').first();
    const href = a.attr('href');
    if (!href) return;
    const style = box.find('.article_image a').attr('style') ?? '';
    const img = style.match(/url\(['"]?([^'")]+)/)?.[1];
    items.push({ href, raw: a.attr('title') || a.text(), image: img ? (img.startsWith('//') ? `https:${img}` : img) : null });
  });
  return items;
}

export const g11 = {
  id: 'g11',
  name: '桃知道 GELEVEN PLAZA',
  async fetch() {
    const out = [];
    const seen = new Set();
    for (const [blog, cat] of G11_BLOGS) {
      const html = await fetchText(`https://www.g11.com.tw/blogs/${encodeURIComponent(blog)}`);
      for (const it of parseG11Blog(html)) {
        const url = new URL(encodeURI(decodeURI(it.href)), 'https://www.g11.com.tw/').href;
        if (seen.has(url)) continue;
        seen.add(url);
        let { title, start, end } = splitDatedTitle(it.raw);
        let summary = null;
        // 標題沒寫日期的，到內文找「活動時間」
        const page = await fetchText(url).catch(() => '');
        if (page) {
          const $ = cheerio.load(page);
          const body = $('.article_content, .blog_content, article').first().text().replace(/\s+/g, ' ').trim();
          summary = body.slice(0, 1500) || null;
          if (!start) {
            const d = splitDatedTitle(`${body.match(/(?:活動|展覽|市集)?(?:時間|日期|期間)\s*[:：]\s*([\d/.\s\-~～至()（）一二三四五六日]+)/)?.[1] ?? ''} | x`);
            if (d.start) ({ start, end } = d);
          }
        }
        if (!start) continue; // 沒有日期就不列（例如全館公告）
        // 同一個活動常同時貼在「最新活動」和「展演廳」
        if (out.some((e) => e.title === title && e.start === start)) continue;
        out.push(
          makeEvent(this, decodeURIComponent(url.split('/blogs/')[1]), {
            title,
            start,
            end,
            venue: blog === '同期活動精選' ? '桃知道 3F 展演廳' : '桃知道 GELEVEN PLAZA',
            address: '桃園市桃園區南平路',
            district: '桃園區',
            category: cat ?? undefined,
            url,
            image: it.image,
            summary,
            extra: { organizer: '桃知道 GELEVEN PLAZA' },
          }),
        );
      }
    }
    return out;
  },
};

// ---------- WeKenGo 週末去哪玩（桃園頁） ----------
// robots.txt 允許抓取（只擋 /go/ 轉址）。列表每次都讀；活動內頁只在第一次看到時讀，結果存在 data/wekengo-cache.json。
const WKG = 'https://wekengo.tw';
const WKG_TAG = {
  音樂會: '表演', 演唱會: '表演', 戲劇: '表演', 舞蹈: '表演', 派對: '表演',
  展覽: '展覽', 市集: '節慶市集', 節慶: '節慶市集', 夜市: '節慶市集',
  手作: '體驗', 體驗: '體驗', 戶外: '體驗', '講座・導覽': '講座課程', 講座: '講座課程',
  電影: '電影', 運動: '運動', 親子: '親子',
};

export function parseWekengoList(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('a.event-card[href^="/event/"]').each((_, el) => {
    const a = $(el);
    const href = a.attr('href');
    const id = href.match(/^\/event\/([A-Za-z0-9]+)\//)?.[1];
    if (!id) return;
    const img = a.find('.event-card__image img').attr('src');
    items.push({
      id,
      url: `${WKG}${href}`,
      title: a.find('.event-card__title').text().trim(),
      dateText: a.find('.event-card__date').text().trim(),
      location: a.find('.event-card__location').text().trim(),
      registration: a.find('.event-card__registration').text().trim() || null,
      free: a.find('.event-card__badge--free').length > 0,
      tags: a.find('.event-card__tags .tag').map((_, t) => $(t).text().trim()).get(),
      area: a.find('.event-card__area-pill').contents().first().text().trim(),
      image: img ? new URL(img, WKG).href : null,
    });
  });
  return items;
}

/** 「2026/11/6 (五) - 11/27 (五)」「2026/11/26 (四)」→ 日期；「每日 17:00-24:00」這種常駐的回傳 null。 */
export function parseWekengoDates(text) {
  const m = String(text).match(/(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s*\([^)]*\))?(?:\s*-\s*(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2}))?/);
  if (!m) return null;
  const start = makeDate(Number(m[1]), m[2], m[3]);
  let end = m[5] ? makeDate(Number(m[4] ?? m[1]), m[5], m[6]) : start;
  if (end < start) end = makeDate(Number(m[1]) + 1, m[5], m[6]);
  return { start, end };
}

/** 內頁的 schema.org Event：精確時間、地址、主辦單位、說明。 */
export function parseWekengoDetail(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  for (const b of blocks) {
    try {
      const d = JSON.parse(b[1]);
      if (!d.startDate) continue;
      const tp = (iso) => {
        if (!iso) return null;
        const t = new Date(Date.parse(iso) + 8 * 3600000);
        const ymd = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
        const hm = `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
        // 00:00 開始、23:59 結束代表只有日期
        return hm === '00:00' || hm === '23:59' ? ymd : `${ymd}T${hm}:00+08:00`;
      };
      return {
        start: tp(d.startDate),
        end: tp(d.endDate),
        venue: d.location?.name ?? null,
        address: d.location?.address?.streetAddress ?? null,
        organizer: d.organizer?.name ?? null,
        summary: d.description ?? null,
        image: typeof d.image === 'string' ? d.image : d.image?.[0] ?? null,
        audience: d.audience?.audienceType ?? null,
      };
    } catch {}
  }
  return null;
}

/** WeKenGo 的 organizer 常是它的資料來源名稱（例如「Accupass 活動通」「桃園市立圖書館活動」），整理成真正的單位或丟掉。 */
export function cleanOrganizer(name) {
  if (!name) return null;
  if (/accupass|kktix|opentix|活動通|報名資訊|售票|ibon|年代|tixcraft|beclass/i.test(name)) return null;
  const n = name.replace(/\s*(當期展覽|熱門活動|活動訊息|最新活動|活動)$/,'').replace(/^桃園市政府$/, '').trim();
  return n || null;
}

export const wekengo = {
  id: 'wekengo',
  name: 'WeKenGo 週末去哪玩',
  async fetch() {
    const { readFile, writeFile } = await import('node:fs/promises');
    const cacheFile = new URL('../../data/wekengo-cache.json', import.meta.url);
    const cache = JSON.parse(await readFile(cacheFile, 'utf8').catch(() => '{}'));
    const items = new Map();
    const WKG_CITY = { taoyuan: ['桃園', '桃園市'], taipei: ['台北', '臺北市'], newtaipei: ['新北', '新北市'] };
    for (const [slug, [area, city]] of Object.entries(WKG_CITY)) {
      for (let page = 1; page <= 20; page++) {
        const html = await fetchText(`${WKG}/?city=${slug}${page > 1 ? `&page=${page}` : ''}`);
        const list = parseWekengoList(html).filter((x) => !x.area || x.area === area);
        const before = items.size;
        for (const it of list) if (!items.has(it.id)) items.set(it.id, { ...it, city });
        if (items.size === before) break; // 沒有新的就是最後一頁
      }
    }
    const out = [];
    const maxDetail = Number(process.env.WEKENGO_DETAIL_LIMIT ?? 400);
    let fetched = 0;
    for (const it of items.values()) {
      const dates = parseWekengoDates(it.dateText);
      if (!dates) continue; // 夜市這種每天都有的常駐活動不列
      if (dates.end < new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)) continue; // 已結束
      let d = cache[it.id];
      if (!d && fetched < maxDetail) {
        d = await fetchText(it.url).then(parseWekengoDetail).catch(() => null);
        fetched++;
        if (d) cache[it.id] = { ...d, cachedAt: new Date().toISOString().slice(0, 10) };
      }
      const cats = it.tags.map((t) => WKG_TAG[t]).filter(Boolean);
      if (/親子/.test(d?.audience ?? '') && !cats.includes('親子')) cats.push('親子');
      out.push(
        makeEvent(this, it.id, {
          title: it.title,
          // 內頁的精確時間要和列表日期一致才用（活動改期時以列表為準）
          start: d?.start && d.start.slice(0, 10) === dates.start ? d.start : dates.start,
          end: d?.end && d.end.slice(0, 10) === dates.end ? d.end : dates.end,
          venue: d?.venue || it.location,
          address: d?.address ?? null,
          city: supportedCity(d?.address) ?? it.city,
          category: cats[0],
          free: it.free ? true : null,
          url: it.url,
          image: d?.image || it.image,
          summary: d?.summary ?? null,
          tags: [...new Set(cats.slice(1))],
          extra: { organizer: cleanOrganizer(d?.organizer), registration: it.registration },
        }),
      );
    }
    // 清掉 60 天沒出現的快取
    const alive = new Set(items.keys());
    for (const [k, v] of Object.entries(cache)) if (!alive.has(k) && Date.now() - Date.parse(v.cachedAt ?? 0) > 60 * 86400000) delete cache[k];
    await writeFile(cacheFile, JSON.stringify(cache));
    return out;
  },
};

// ---------- OPENTIX 兩廳院文化生活（全台節目，篩出桃園；含開賣時間、票價） ----------
// 全部約 800 筆、每頁 15 筆，所以 3 小時才完整抓一次，中間沿用上次結果（data/opentix-cache.json）。
export const opentix = {
  id: 'opentix',
  name: 'OPENTIX',
  async fetch() {
    const { readFile, writeFile } = await import('node:fs/promises');
    const cacheFile = new URL('../../data/opentix-cache.json', import.meta.url);
    const cache = JSON.parse(await readFile(cacheFile, 'utf8').catch(() => '{}'));
    let found = cache.found;
    // regions 不同（例如新加了台北）就重新抓
    if (!found || cache.regions !== 'ty+tpe' || Date.now() - Date.parse(cache.at ?? 0) > 3 * 3600000) {
      found = [];
      for (let offset = 0, guard = 0; guard < 120; guard++) {
        const res = await politeFetch('https://search.opentix.life/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://www.opentix.life', Referer: 'https://www.opentix.life/' },
          body: JSON.stringify({ language: 'zh-CHT', offset }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const r = (await res.json()).result;
        for (const f of r?.found ?? []) {
          const s = f.source;
          // 只留桃園的節目，丟掉商品（雜誌、周邊）
          if (s.type === '商品' || !(s.places ?? []).some((p) => /桃園|臺北|台北|新北/.test(p))) continue;
          found.push(s);
        }
        if (!r?.found?.length || r.nextOffset == null || r.nextOffset <= offset) break;
        offset = r.nextOffset;
      }
      await writeFile(cacheFile, JSON.stringify({ at: new Date().toISOString(), regions: 'ty+tpe', found }));
    }
    const iso = (ms) => (ms ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);
    const toTaipei = (ms) => {
      if (!ms) return null;
      const t = new Date(ms + 8 * 3600000);
      return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}T${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}:00+08:00`;
    };
    return found.map((s) => {
      const venue = (s.eventVenues ?? []).find((v) => /桃園|臺北|台北|新北/.test(v.city ?? '')) ?? s.eventVenues?.[0];
      const c = venue?.city ?? '';
      const city = /桃園/.test(c) ? '桃園市' : /新北/.test(c) ? '新北市' : /[臺台]北/.test(c) ? '臺北市' : supportedCity(venue?.name) ?? '臺北市';
      const times = (venue?.times ?? []).filter((t) => t.start);
      const onlineStarts = times.map((t) => t.onlineStart).filter(Boolean).sort((a, b) => a - b);
      void iso;
      return makeEvent(this, s.id, {
        title: s.title,
        start: toTaipei(times[0]?.start ?? s.startDateTime),
        end: toTaipei(times.at(-1)?.end ?? times.at(-1)?.start ?? s.endDateTime),
        regStart: toTaipei(onlineStarts[0] ?? s.onlineStartDateTime),
        regEnd: toTaipei(s.onlineEndDateTime),
        venue: venue?.name ?? null,
        city,
        category: '表演',
        free: s.maxPrice === 0 ? true : s.minPrice > 0 ? false : null,
        url: `https://www.opentix.life/event/${s.id}`,
        image: s.imageUrl ?? null,
        summary: s.description,
        extra: { organizer: s.organizers || null, prices: s.minPrice ? [`$${s.minPrice}${s.maxPrice > s.minPrice ? `–${s.maxPrice}` : ''}`] : null, sessions: times.length },
      });
    });
  },
};

// ---------- 中原文創園區 ----------
export function parseCyccEvents(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('.eventpage-item').each((_, el) => {
    const box = $(el);
    const link = box.find('h3 a');
    const href = link.attr('href');
    if (!href) return;
    const dates = box.find('[property="dc:date"]').map((_, d) => $(d).attr('content')).get();
    const uniq = [...new Set(dates)];
    items.push({
      id: href.match(/node\/(\d+)/)?.[1] ?? href,
      title: link.text().trim(),
      url: new URL(href, 'https://cycc.org.tw/').href,
      start: uniq[0] ? uniq[0].slice(0, 10) : null,
      end: uniq[1] ? uniq[1].slice(0, 10) : null,
      image: box.find('img').attr('src') ?? null,
    });
  });
  return items;
}

export const cycc = {
  id: 'cycc',
  name: '中原文創園區',
  async fetch() {
    const html = await fetchText('https://cycc.org.tw/zh-hant/events');
    return parseCyccEvents(html)
      .filter((it) => !/招租|【申請】|徵件|招募/.test(it.title))
      .map((it) =>
        makeEvent(this, it.id, {
          title: it.title,
          start: it.start,
          end: it.end,
          venue: '中原文創園區',
          district: '中壢區',
          url: it.url,
          image: it.image,
        }),
      );
  },
};
