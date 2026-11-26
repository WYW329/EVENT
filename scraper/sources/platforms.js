// 售票和活動平台、民間場館：KKTIX、Accupass、中原文創園區。
import * as cheerio from 'cheerio';
import { fetchText, makeEvent, parseDateTime, findDistrict, isTaoyuan, cleanText } from '../util.js';

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
    const xml = await fetchText('https://kktix.com/events.atom?search=%E6%A1%83%E5%9C%92');
    const out = [];
    for (const it of parseKktixAtom(xml).filter((x) => isTaoyuan(x.venue, x.address, x.title))) {
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
    const html = await fetchText('https://www.accupass.com/search?l=taoyuan');
    return parseAccupassSearch(html)
      // 地區篩選會混進線上活動，去掉
      .filter((it) => !/出租|租借|徵才/.test(it.title) && it.place !== '線上活動' && !/線上\s*online|【線上】|^線上/i.test(it.title))
      .map((it) =>
        makeEvent(this, it.id, {
          title: it.title,
          start: it.start,
          end: it.end,
          venue: it.place && it.place !== 'Taoyuan City' ? it.place : null,
          district: findDistrict(it.title),
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
