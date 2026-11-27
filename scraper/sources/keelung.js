// 基隆：文化觀光局的新聞、公告列表（沒有 RSS，讀列表再看內頁的活動日期）。
import * as cheerio from 'cheerio';
import { fetchText, makeEvent, cleanText, findDistrict, todayTaipei } from '../util.js';
import { extractEventDates, EVENT_RE, SKIP_RE } from './tycgnews.js';

const KLCTB_LISTS = [
  'https://klctb.klcg.gov.tw/News.aspx?n=7466&sms=12270', // 新聞
  'https://klctb.klcg.gov.tw/News.aspx?n=7458&sms=12482', // 公告
];

// 網頁裡偶爾有 NUL 字元，先拿掉
const clean = (html) => html.replace(/\u0000/g, '');

export const klctb = {
  id: 'klctb',
  name: '基隆市文化觀光局',
  city: '基隆市',
  async fetch() {
    const links = new Map();
    for (const u of KLCTB_LISTS) {
      const $ = cheerio.load(clean(await fetchText(u)));
      $('a[href*="News_Content.aspx"]').each((_, a) => {
        const href = new URL($(a).attr('href'), u).href;
        const s = new URL(href).searchParams.get('s');
        const title = ($(a).attr('title') || $(a).text()).trim();
        const posted = $(a).closest('tr').find('td').last().text().trim();
        if (s && title && !links.has(s)) links.set(s, { href, title, posted });
      });
    }
    const out = [];
    const today = todayTaipei();
    for (const [s, it] of [...links].slice(0, 30)) {
      if (!EVENT_RE.test(it.title) || SKIP_RE.test(it.title) || /得獎|名單|停駛|開館時間|調整/.test(it.title)) continue;
      const page = await fetchText(it.href).catch(() => '');
      if (!page) continue;
      const $p = cheerio.load(clean(page));
      $p('script,style,header,nav,footer').remove();
      const text = cleanText($p('.area-essay, .essay, main, body').first().text(), 2500);
      const dates = extractEventDates(`${it.title} ${text}`);
      if (!dates || (dates.end ?? dates.start).slice(0, 10) < today) continue;
      out.push(makeEvent(this, s, {
        title: it.title,
        start: dates.start,
        end: dates.end,
        district: findDistrict({ city: '基隆市' }, it.title, text.slice(0, 800)),
        city: '基隆市',
        url: it.href,
        image: $p('meta[property="og:image"]').attr('content') ?? null,
        summary: text,
        extra: { organizer: '基隆市文化觀光局' },
      }));
    }
    return out;
  },
};
