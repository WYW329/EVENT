// 新竹：縣文化局（展覽、劇場、活動）、市文化局（活動訊息）。縣府、市府的 RSS 在 tycgnews.js 的 hsinchuNews。
import * as cheerio from 'cheerio';
import { fetchText, makeEvent, makeTime, cleanText, findDistrict, supportedCity, todayTaipei } from '../util.js';

const ymd = (y, m, d) => makeTime(Number(y), Number(m), Number(d));
const pageText = ($) => {
  $('script,style,header,nav,footer,noscript').remove();
  return $('body').text().replace(/\s+/g, ' ');
};
// 活動時間 9:00-17:00 → 開始時間
const withTime = (day, t) => {
  const m = t?.match(/(\d{1,2})[:：](\d{2})/);
  return m ? day.replace(/T.*$/, '') + `T${m[1].padStart(2, '0')}:${m[2]}:00+08:00` : day;
};

// ---------- 新竹縣政府文化局：藝文活動（展覽、劇場、活動） ----------
const HCHCC = 'https://www.hchcc.gov.tw/Tw/News/';
const HCHCC_LISTS = [
  ['fff0eeb8-d017-46fa-a3b8-547a4049499f', '展覽'],
  ['58dd03be-c37d-40af-a540-6d34b3790b4c', '表演'],
  ['e2ce565c-7042-466e-9b77-bb81937b8cf9', null],
];

export const hchcc = {
  id: 'hchcc',
  name: '新竹縣政府文化局',
  city: '新竹縣',
  async fetch() {
    const today = todayTaipei();
    const out = [];
    for (const [filter, category] of HCHCC_LISTS) {
      const list = cheerio.load(await fetchText(`${HCHCC}ActList?filter=${filter}`));
      const ids = [...new Set(list('a[href*="ActDetail"]').map((_, a) => new URL(list(a).attr('href'), HCHCC).searchParams.get('id')).get().filter(Boolean))];
      for (const id of ids.slice(0, 15)) {
        const url = `${HCHCC}ActDetail?filter=${filter}&id=${id}`;
        const html = await fetchText(url).catch(() => '');
        if (!html) continue;
        const $ = cheerio.load(html);
        const title = $('title').text().replace(/\s*-\s*新竹縣政府文化局\s*$/, '').trim();
        const text = pageText($);
        const at = text.indexOf(title.slice(0, 10));
        const body = at >= 0 ? text.slice(at + title.length) : text;
        const r = body.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s*(?:[~～-]\s*(\d{4})\/(\d{1,2})\/(\d{1,2}))?/);
        if (!title || !r) continue;
        const start = ymd(r[1], r[2], r[3]);
        const end = r[4] ? ymd(r[4], r[5], r[6]) : start;
        if (end.slice(0, 10) < today || /得獎|名單|結果|徵件|徵選|招生/.test(title)) continue;
        const time = body.slice(0, 120).match(/◷\s*([\d:：]+)/)?.[1];
        const venue = body.match(/(?:活動)?地點\s*[:：]\s*([^\s|｜]{2,30})/)?.[1] ?? null;
        out.push(makeEvent(this, id, {
          title,
          start: withTime(start, time),
          end,
          venue,
          city: '新竹縣',
          district: findDistrict({ city: '新竹縣' }, venue, title, body.slice(0, 600)) ?? '竹北市',
          category: category ?? undefined,
          url,
          image: $('meta[property="og:image"]').attr('content') ?? null,
          summary: cleanText(body.replace(/^[\s\d/~～◷:：\-()（）周一及國定假日休館]*/, ''), 700),
          extra: { organizer: '新竹縣政府文化局' },
        }));
      }
    }
    return out;
  },
};

// ---------- 新竹市文化局：活動訊息（美術館、文化藝廊、241 藝術空間、鐵道藝術村、眷村博物館…） ----------
const HCCB = 'https://culture.hccg.gov.tw/ch/';

export const hccgCulture = {
  id: 'hccgculture',
  name: '新竹市文化局',
  city: '新竹市',
  async fetch() {
    const today = todayTaipei();
    const list = cheerio.load(await fetchText(`${HCCB}home.jsp?id=9&parentpath=0,1`));
    const links = new Map();
    list('a[href*="dataserno"]').each((_, a) => {
      const href = list(a).attr('href');
      const sn = href.match(/dataserno=(\d+)/)?.[1];
      const title = list(a).text().replace(/\s+/g, ' ').trim();
      if (sn && title && /activity_view/.test(href) && !links.has(sn)) links.set(sn, { url: new URL(href, HCCB).href, title });
    });
    const out = [];
    for (const [sn, it] of [...links].slice(0, 30)) {
      if (/徵件|徵選|招生|抵稅|借用|得獎|名單/.test(it.title)) continue;
      const html = await fetchText(it.url).catch(() => '');
      if (!html) continue;
      const text = pageText(cheerio.load(html));
      const field = (k) => text.match(new RegExp(`${k}\\s*[:：]\\s*(.+?)\\s+(?:活動|詳細內容|類\\s*別|發布|主辦|協辦|$)`))?.[1]?.trim();
      const roc = (s) => s?.match(/(\d{2,3})-(\d{1,2})-(\d{1,2})/);
      const a = roc(field('活動開始日期'));
      const b = roc(field('活動截止日期'));
      if (!a) continue;
      const start = ymd(Number(a[1]) + 1911, a[2], a[3]);
      const end = b ? ymd(Number(b[1]) + 1911, b[2], b[3]) : start;
      if (end.slice(0, 10) < today) continue;
      const venue = field('活動地點') ?? it.title.match(/\]\[([^\]]+)\]/)?.[1] ?? null;
      const tag = it.title.match(/^\[([^\]]+)\]/)?.[1];
      const title = it.title.replace(/^(\[[^\]]+\])+\s*/, '');
      const detail = text.split(/詳細內容\s*[:：]/)[1] ?? '';
      out.push(makeEvent(this, sn, {
        title,
        start: withTime(start, field('活動時間')),
        end,
        venue,
        city: supportedCity(venue) === '新竹縣' ? '新竹縣' : '新竹市',
        district: findDistrict({ city: '新竹市' }, venue, detail.slice(0, 400)) ?? '東區',
        category: tag === '展覽' ? '展覽' : undefined,
        url: it.url,
        summary: cleanText(detail, 700),
        extra: { organizer: field('主辦單位') ?? '新竹市文化局' },
      }));
    }
    return out;
  },
};
