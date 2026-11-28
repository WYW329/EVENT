// 縣市文化局的新聞、公告、活動列表（CCMS 系統，沒有 RSS）：讀列表，再看內頁的活動日期。
// 基隆文化觀光局、彰化縣文化局、宜蘭縣文化局都用這個。
import * as cheerio from 'cheerio';
import { fetchText, makeEvent, cleanText, findDistrict, supportedCity, todayTaipei } from '../util.js';
import { extractEventDates, EVENT_RE, SKIP_RE } from './tycgnews.js';

// 網頁裡偶爾有 NUL 字元，先拿掉
const clean = (html) => html.replace(/\u0000/g, '');

/** lists：CCMS 的 News.aspx 列表網址；city：這個單位的縣市（內文寫了別的本站縣市就用那個）。 */
export function makeCcmsNewsSource({ id, name, city, organizer = name, lists, limit = 30, defaultDistrict = null }) {
  return {
    id,
    name,
    city,
    async fetch() {
      const links = new Map();
      for (const u of lists) {
        const $ = cheerio.load(clean(await fetchText(u)));
        $('a[href*="News_Content.aspx"]').each((_, a) => {
          const href = new URL($(a).attr('href'), u).href;
          const s = new URL(href).searchParams.get('s');
          const title = ($(a).attr('title') || $(a).text()).replace(/\s+/g, ' ').trim();
          if (s && title && !links.has(s)) links.set(s, { href, title });
        });
      }
      const out = [];
      const today = todayTaipei();
      for (const [s, it] of [...links].slice(0, limit)) {
        if (!EVENT_RE.test(it.title) || SKIP_RE.test(it.title) || /得獎|名單|停駛|開館時間|營運時間|調整|租借|審議/.test(it.title)) continue;
        const page = await fetchText(it.href).catch(() => '');
        if (!page) continue;
        const $p = cheerio.load(clean(page));
        $p('script,style,header,nav,footer').remove();
        // 內頁前面常有很長的選單，從標題最後一次出現的地方開始讀正文
        const full = $p('.area-essay, .essay, main, body').first().text().replace(/\s+/g, ' ');
        const at = full.lastIndexOf(it.title.slice(0, 12));
        const text = cleanText(at > 0 ? full.slice(at + it.title.length) : full, 2500);
        const dates = extractEventDates(`${it.title} ${text}`);
        if (!dates || (dates.end ?? dates.start).slice(0, 10) < today) continue;
        const named = supportedCity(it.title);
        const evCity = named && named !== city && /[市縣]/.test(it.title) ? named : city;
        out.push(makeEvent(this, s, {
          title: it.title.replace(/^【[^】]{0,12}】\s*/, (m) => (/館|中心|廳/.test(m) ? m : '')),
          start: dates.start,
          end: dates.end,
          district: findDistrict({ city: evCity }, it.title, text.slice(0, 800)) ?? (evCity === city ? defaultDistrict : null),
          city: evCity,
          url: it.href,
          image: $p('meta[property="og:image"]').attr('content') ?? null,
          summary: text,
          extra: { organizer },
        }));
      }
      return out;
    },
  };
}

export const klctb = makeCcmsNewsSource({
  id: 'klctb',
  name: '基隆市文化觀光局',
  city: '基隆市',
  lists: [
    'https://klctb.klcg.gov.tw/News.aspx?n=7466&sms=12270', // 新聞
    'https://klctb.klcg.gov.tw/News.aspx?n=7458&sms=12482', // 公告
  ],
});

export const bocach = makeCcmsNewsSource({
  id: 'bocach',
  name: '彰化縣文化局',
  city: '彰化縣',
  defaultDistrict: '彰化市',
  limit: 40,
  lists: [
    'https://www.bocach.gov.tw/News.aspx?n=1241&sms=10719', // 活動總覽
    'https://www.bocach.gov.tw/News.aspx?n=92&sms=10020', // 展覽活動
  ],
});

export const ilccb = makeCcmsNewsSource({
  id: 'ilccb',
  name: '宜蘭縣文化局',
  city: '宜蘭縣',
  defaultDistrict: '宜蘭市',
  lists: ['https://www.ilccb.gov.tw/News.aspx?n=10198&sms=12917'], // 最新消息及公告
});
