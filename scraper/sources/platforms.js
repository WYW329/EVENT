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

export const kktix = {
  id: 'kktix',
  name: 'KKTIX',
  async fetch() {
    const xml = await fetchText('https://kktix.com/events.atom?search=%E6%A1%83%E5%9C%92');
    return parseKktixAtom(xml)
      .filter((it) => isTaoyuan(it.venue, it.address, it.title))
      .map((it) =>
        makeEvent(this, it.id, {
          title: it.title,
          start: it.start,
          end: it.end,
          venue: it.venue,
          address: it.address,
          url: it.url,
          summary: it.summary,
          extra: { organizer: it.organizer },
        }),
      );
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
