// 中部：臺中市政府活動訊息（開放資料）、南投縣文化局藝文活動。
// 縣府 RSS（宜蘭、苗栗、彰化）和科博館、國美館在 tycgnews.js 的 midNews；彰化、宜蘭文化局在 keelung.js。
import * as cheerio from 'cheerio';
import { fetchText, fetchJson, makeEvent, makeTime, cleanText, findDistrict, supportedCity, todayTaipei, decodeEntities } from '../util.js';
import { SKIP_RE } from './tycgnews.js';

// 20261208T020000（UTC）→ 台北時間
const fromStamp = (s) => {
  const m = String(s ?? '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
  if (!m) return null;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:00+08:00`;
};

// ---------- 臺中市政府全球資訊網活動訊息（data.gov.tw 84940） ----------
const TC_GOV = 'https://newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download?rid=a013118c-4b64-4a82-9d3e-3e804e16d8b9';

export const taichungGov = {
  id: 'tcgov',
  name: '臺中市政府',
  city: '臺中市',
  async fetch() {
    const list = await fetchJson(TC_GOV);
    if (!Array.isArray(list)) throw new Error('資料格式不對');
    const today = todayTaipei();
    const out = [];
    for (const r of list) {
      const title = cleanText(r['title_活動名稱'], 120);
      const start = fromStamp(r['activitystart_活動起日']);
      let end = fromStamp(r['activityclose_活動迄日']);
      if (!title || !start || SKIP_RE.test(title) || /徵才|篩檢|租稅|宣導/.test(title)) continue;
      if (end && end < start) end = start.slice(0, 10);
      if ((end ?? start).slice(0, 10) < today) continue;
      const html = String(r['content_內容'] ?? '');
      const text = cleanText(decodeEntities(html.replace(/<[^>]+>/g, ' ')), 1500);
      const area = String(r['area_行政區'] ?? '').trim();
      out.push(makeEvent(this, r['Id_編號'], {
        title,
        start,
        end,
        city: '臺中市',
        district: findDistrict({ city: '臺中市' }, area, title, text.slice(0, 500)),
        url: r['relatedLink_相關連結'] || `https://www.taichung.gov.tw/8868/8872/12026/${r['Id_編號']}/post`,
        image: r['mainImage_文章主圖'] || null,
        summary: text,
        extra: { organizer: cleanText(r['mainunit_主辦單位'], 40) || '臺中市政府' },
      }));
    }
    return out;
  },
};

// ---------- 南投縣政府文化局：藝文活動（RSS＋內頁的活動日期、地點） ----------
const NTHCC_RSS = 'https://www.nthcc.gov.tw/rss/2';

export const nthcc = {
  id: 'nthcc',
  name: '南投縣政府文化局',
  city: '南投縣',
  async fetch() {
    const xml = await fetchText(NTHCC_RSS);
    const links = [...new Set([...xml.matchAll(/<link>(https:\/\/www\.nthcc\.gov\.tw\/A4_1\/content\/\d+)<\/link>/g)].map((m) => m[1]))];
    const today = todayTaipei();
    const out = [];
    for (const url of links.slice(0, 20)) {
      const html = await fetchText(url).catch(() => '');
      if (!html) continue;
      const $ = cheerio.load(html);
      $('script,style,header,nav,footer').remove();
      const text = $('body').text().replace(/\s+/g, ' ');
      const field = (k, next) => text.match(new RegExp(`${k}\\s+(.+?)\\s+(?:${next})`))?.[1]?.trim() ?? null;
      const r = text.match(/活動日期\s+(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s*~\s*(\d{4})\/(\d{1,2})\/(\d{1,2}))?/);
      if (!r) continue;
      const start = makeTime(+r[1], +r[2], +r[3]);
      const end = r[4] ? makeTime(+r[4], +r[5], +r[6]) : start;
      if (end < today) continue;
      const title = text.match(/view_list列表\s+(.+?)\s+‹/)?.[1]?.trim() ?? $('title').text().split(/[|｜-]/)[0].trim();
      const venue = field('活動地點', '入場方式|票價|售票');
      const time = field('活動時間', '活動地點')?.match(/(\d{1,2}):(\d{2})/);
      const city = supportedCity(venue) ?? '南投縣';
      if (city !== '南投縣' && !/南投/.test(venue ?? '')) continue;
      out.push(makeEvent(this, url.split('/').pop(), {
        title,
        start: time ? `${start}T${time[1].padStart(2, '0')}:${time[2]}:00+08:00` : start,
        end,
        venue,
        city: '南投縣',
        district: findDistrict({ city: '南投縣' }, venue, title) ?? '南投市',
        free: /自由入場|免費/.test(field('入場方式', '票價') ?? '') ? true : null,
        url,
        summary: cleanText(text.split(/活動簡述/)[1] ?? '', 700),
        extra: { organizer: field('主辦單位', '發佈日期') ?? '南投縣政府文化局' },
      }));
    }
    return out;
  },
};
