// 商場百貨：華泰名品城、台茂購物中心、Xpark。只收活動、展覽、市集、快閃，不收折扣促銷。
import * as cheerio from 'cheerio';
import { fetchText, makeEvent, cleanText } from '../util.js';
import { extractEventDates } from './tycgnews.js';

// 純促銷、公告不算活動
// 要像活動（展覽、市集、快閃、表演、體驗…）
const EVENT_LIKE_RE = /快閃|展|市集|聖誕|跨年|體驗|DIY|手作|表演|演出|音樂|派對|嘉年華|節|親子|講座|工作坊|課程|公園|企劃|Wonderland|Fun/i;
const isMallEvent = (t) => EVENT_LIKE_RE.test(t) && !PROMO_RE.test(t);
const PROMO_RE = /開幕|聯名|美食|餐|蟹|折|優惠|滿額|好禮|贈|送完|兌換|買單|購物金|點數|會員|週年慶|特賣|折扣|刷卡|回饋|公告|暫停|營業時間|防詐|停車|徵才|招商|線上購物/;

/** 「11/12 - 12/2」「11/26(四)－1/3(日)」「11/12~2027/1/3」「11/19│01/03」→ 日期區間。沒寫年取離現在最近的。 */
export function parseShortRange(text, now = Date.now()) {
  const t = String(text ?? '').replace(/\s+/g, '');
  const m = t.match(/(?:(\d{4})[/.])?(\d{1,2})[/.](\d{1,2})(?:\([^)]*\))?(?:[-－~～至│|](?:(\d{4})[/.])?(\d{1,2})[/.](\d{1,2}))?/);
  if (!m) return null;
  const y0 = new Date(now + 8 * 3600000).getUTCFullYear();
  const mk = (y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const near = (mo, d) => [y0 - 1, y0, y0 + 1].map((y) => mk(y, mo, d)).sort((a, b) => Math.abs(Date.parse(a) - now) - Math.abs(Date.parse(b) - now))[0];
  const start = m[1] ? mk(m[1], m[2], m[3]) : near(m[2], m[3]);
  let end = start;
  if (m[5]) {
    end = m[4] ? mk(m[4], m[5], m[6]) : mk(start.slice(0, 4), m[5], m[6]);
    if (end < start) end = mk(Number(start.slice(0, 4)) + 1, m[5], m[6]);
  }
  return { start, end };
}

// ---------- 華泰名品城 GLORIA OUTLETS ----------
export function parseGloriaList(html) {
  const $ = cheerio.load(html);
  const byHref = new Map();
  $('a[href*="/news_content/"]').each((_, a) => {
    const href = $(a).attr('href');
    const text = $(a).text().replace(/\s+/g, ' ').trim();
    if (!text) return;
    const it = byHref.get(href) ?? { href, image: null };
    if (/^\d{1,2}\/\d{1,2}\s*[│|]\s*\d{1,2}\/\d{1,2}$/.test(text)) it.dates = text;
    else if (!it.title) it.title = text;
    const img = $(a).find('img').attr('src');
    if (img && !it.image) it.image = new URL(img, 'https://www.gloriaoutlets.com/').href;
    byHref.set(href, it);
  });
  return [...byHref.values()].filter((x) => x.title);
}

export const gloria = {
  id: 'gloria',
  name: '華泰名品城',
  async fetch() {
    const html = await fetchText('https://www.gloriaoutlets.com/chi/news_list/');
    return parseGloriaList(html)
      .filter((it) => isMallEvent(it.title))
      .map((it) => {
        const r = parseShortRange(it.dates);
        if (!r) return null;
        return makeEvent(this, it.href.match(/news_content\/(\d+)/)?.[1] ?? it.href, {
          title: it.title.replace(/\s*(活動列表|公告)$/, ''),
          start: r.start,
          end: r.end,
          venue: '華泰名品城 GLORIA OUTLETS',
          address: '桃園市中壢區春德路189號',
          district: '中壢區',
          url: new URL(it.href, 'https://www.gloriaoutlets.com/').href,
          image: it.image,
          extra: { organizer: '華泰名品城' },
        });
      })
      .filter(Boolean);
  },
};

// ---------- 台茂購物中心（活動訊息、公園活動） ----------
export function parseTaimallList(html) {
  const $ = cheerio.load(html);
  return $('.c-news')
    .map((_, el) => {
      const box = $(el);
      const a = box.find('a.c-news__link');
      return {
        href: a.attr('href'),
        title: box.find('.c-news__content__info__title').text().trim() || a.attr('title'),
        dates: box.find('.c-news__content__intro__text').first().text().trim(),
        tags: box.find('.c-tag__item').map((_, t) => $(t).text().trim()).get(),
        image: box.find('img').attr('src') ? new URL(box.find('img').attr('src'), 'https://www.taimall.com.tw/').href : null,
      };
    })
    .get()
    .filter((x) => x.href && x.title);
}

export const taimall = {
  id: 'taimall',
  name: '台茂購物中心',
  async fetch() {
    const seen = new Map();
    for (const u of ['https://www.taimall.com.tw/news.php', 'https://www.taimall.com.tw/news.php?cid=2']) {
      for (const it of parseTaimallList(await fetchText(u))) {
        const no = it.href.match(/no=(\d+)/)?.[1];
        if (no && !seen.has(no)) seen.set(no, it);
      }
    }
    const out = [];
    for (const [no, it] of seen) {
      if (!isMallEvent(it.title)) continue;
      let r = parseShortRange(it.dates);
      let summary = null;
      // 列表沒寫日期（例如「週末還在想要去哪裡玩嗎?」）就看內頁
      const page = await fetchText(new URL(it.href, 'https://www.taimall.com.tw/').href).catch(() => '');
      if (page) {
        const $ = cheerio.load(page);
        $('script,style,header,nav,footer').remove();
        summary = cleanText($('main, .news-detail, body').first().text(), 1500);
        if (!r) {
          const d = extractEventDates(summary);
          if (d) r = { start: d.start, end: d.end ?? d.start };
        }
      }
      if (!r) continue;
      out.push(
        makeEvent(this, no, {
          title: it.title,
          start: r.start,
          end: r.end,
          venue: it.tags.includes('公園活動') ? '台茂公園' : '台茂購物中心',
          address: '桃園市蘆竹區南崁路一段112號',
          district: '蘆竹區',
          url: new URL(it.href, 'https://www.taimall.com.tw/').href,
          image: it.image,
          summary,
          extra: { organizer: '台茂購物中心', registration: it.tags.includes('報名活動') ? '需報名' : null },
        }),
      );
    }
    return out;
  },
};

// ---------- Xpark（最新消息裡的特展、季節活動；日期在內文「活動時間」） ----------
export const xpark = {
  id: 'xpark',
  name: 'Xpark',
  async fetch() {
    const html = await fetchText('https://www.xpark.com.tw/news');
    const $ = cheerio.load(html);
    const items = [];
    $('a[href^="/news/"]').each((_, a) => {
      const text = $(a).text().replace(/\s+/g, ' ').trim();
      const m = text.match(/^(20\d\d-\d\d-\d\d)\s+(.+?)\s{0,2}(?:$|\s)/);
      if (m) items.push({ href: $(a).attr('href'), posted: m[1], title: text.slice(11).split(/\s{2,}|(?<=[！!])\s/)[0].trim().slice(0, 60) });
    });
    const out = [];
    const recent = items.filter((x) => Date.now() - Date.parse(x.posted) < 200 * 86400000 && !PROMO_RE.test(x.title));
    for (const it of recent) {
      const url = new URL(it.href, 'https://www.xpark.com.tw/').href;
      const page = await fetchText(url).catch(() => '');
      if (!page) continue;
      const $p = cheerio.load(page);
      $p('script,style,header,nav,footer').remove();
      const text = cleanText($p('body').text(), 3000);
      const d = extractEventDates(text);
      if (!d) continue;
      const img = $p('meta[property="og:image"]').attr('content') ?? null;
      out.push(
        makeEvent(this, it.href.split('/').pop(), {
          title: it.title,
          start: d.start,
          end: d.end,
          venue: 'Xpark 水族館',
          address: '桃園市中壢區春德路105號',
          district: '中壢區',
          category: '展覽',
          free: false,
          url,
          image: img,
          summary: text.slice(0, 1200),
          extra: { organizer: 'Xpark' },
        }),
      );
    }
    return out;
  },
};
