// 新北：新北市觀光旅遊網的活動行事曆（全市，含東北角、北海岸）、東北角管理處的活動專區。
import * as cheerio from 'cheerio';
import { fetchText, politeFetch, makeEvent, makeTime, cleanText, findDistrict, supportedCity, todayTaipei } from '../util.js';
import { extractEventDates } from './tycgnews.js';

// ---------- 新北市觀光旅遊網（觀旅局）活動行事曆 ----------
const NTC = 'https://newtaipei.travel';

export const ntpcTravel = {
  id: 'ntpctravel',
  name: '新北市觀光旅遊網',
  city: '新北市',
  async fetch() {
    const today = todayTaipei();
    const year = Number(today.slice(0, 4));
    const items = new Map();
    for (const y of [year, year + 1]) {
      // 網站自己的活動列表用的資料（要帶 Referer 才給）
      const res = await politeFetch(`${NTC}/zh-tw/opendata/activities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Referer: `${NTC}/zh-tw/calendar/list?year=${y}` },
        body: JSON.stringify({ year: y }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (!j.success) continue;
      for (const it of j.data ?? []) if (!items.has(it.id)) items.set(it.id, it);
    }
    if (!items.size) throw new Error('沒有資料');
    const out = [];
    for (const it of items.values()) {
      const end = it.date_end?.slice(0, 10);
      if (!it.name || !it.date_begin || (end ?? '') < today) continue;
      const address = it.hide_address ? null : (it.address ?? '').replace(/^\d{3,6}\s*/, '') || null;
      const city = supportedCity(address) ?? (address ? null : '新北市');
      if (!city) continue; // 外縣市的（例如合作宣傳的別縣市活動）
      const venue = address?.match(/\d+號\s*(.+)$/)?.[1] ?? null;
      out.push(makeEvent(this, it.id, {
        title: it.name,
        start: it.date_begin.slice(0, 10),
        end: end ?? null,
        address,
        venue: venue && venue.length <= 30 ? venue : null,
        city,
        district: findDistrict({ city }, address, it.name),
        url: it.url ?? `${NTC}/zh-tw/calendar/detail/${it.id}`,
        image: it.thumb ?? null,
        extra: { organizer: '新北市政府觀光旅遊局' },
      }));
    }
    return out;
  },
};

// ---------- 東北角及宜蘭海岸國家風景區管理處：活動專區 ----------
// 管轄範圍跨新北（瑞芳、貢寮）和宜蘭，只收新北、基隆的。
const NEC = 'https://www.necoast-nsa.gov.tw/';
const NTPC_COAST = /福隆|貢寮|鼻頭|龍洞|草嶺|金瓜石|九份|瑞芳|深澳|南雅|澳底|和美|卯澳|馬崗|三貂角|猴硐|雙溪|水湳洞|陰陽海|舊草嶺|龍門|鹽寮/;
const YILAN = /宜蘭|頭城|壯圍|外澳|烏石|蘇澳|南方澳|礁溪|大里|大溪漁港|蜜月灣|龜山島|五結|冬山|羅東/;
const nd = (s, y) => {
  const m = s.match(/(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})/);
  return m ? makeTime(Number(m[1] ?? y), Number(m[2]), Number(m[3])) : null;
};

function coastCity(place, title) {
  const s = `${place ?? ''} ${title}`;
  const c = supportedCity(place);
  if (c) return c === '新北市' || c === '基隆市' ? c : null;
  if (NTPC_COAST.test(s) && !YILAN.test(place ?? '')) return '新北市';
  return null;
}

/** 「年度活動資訊」那種一頁列很多活動的：拆成一個一個。 */
export function parseNecoastBlocks(text) {
  const out = [];
  const re = /(?:。|！|關閉|\))\s*([^。！：]{3,40}?)\s+活動日期\s*[:：]\s*(?:順延)?\s*(\d{4}\/\d{1,2}\/\d{1,2})(?:\s*[~～-]\s*((?:\d{4}\/)?\d{1,2}\/\d{1,2}))?([^]*?)(?=活動簡介|活動日期|$)/g;
  for (const m of text.matchAll(re)) {
    if (/已結束/.test(m[4].slice(0, 12))) continue;
    const place = m[4].match(/活動地點\s*[:：]\s*(.+?)(?:\s+活動資訊|\s*$)/)?.[1]?.trim() ?? null;
    const start = nd(m[2]);
    const end = m[3] ? nd(m[3], m[2].slice(0, 4)) : start;
    out.push({ title: m[1].replace(/^.*(?:關閉|搜尋)\s+/, '').trim(), start, end, place });
  }
  return out;
}

export const necoast = {
  id: 'necoast',
  name: '東北角管理處',
  city: '新北市',
  async fetch() {
    const today = todayTaipei();
    const list = cheerio.load(await fetchText(`${NEC}Articles.aspx?a=7&l=1`));
    const links = new Map();
    list('a[href*="Activity-News-Content.aspx"]').each((_, a) => {
      const href = new URL(list(a).attr('href'), NEC);
      const nid = href.searchParams.get('nid');
      if (nid && !links.has(nid)) links.set(nid, `${NEC}Activity-News-Content.aspx?a=8&nid=${nid}&l=1`);
    });
    const out = [];
    for (const [nid, url] of [...links].slice(0, 12)) {
      const html = await fetchText(url).catch(() => '');
      if (!html) continue;
      const $ = cheerio.load(html);
      const pageTitle = $('title').text().trim().replace(/\s*-\s*東北角及宜蘭[^]*$/, '').trim();
      $('script,style,header,nav,footer').remove();
      const text = $('body').text().replace(/\s+/g, ' ');
      const body = text.slice(Math.max(0, text.indexOf(pageTitle, text.indexOf('大字級'))));
      const blocks = /活動資訊|年度活動/.test(pageTitle) ? parseNecoastBlocks(body) : [];
      if (!blocks.length) {
        const d = extractEventDates(`${pageTitle} ${body.slice(0, 1500)}`);
        // 新聞稿的日期常只寫月日，推出來的期間太長（跨年）就當只有一天
        if (d && d.end && Date.parse(d.end) - Date.parse(d.start) > 60 * 86400000) d.end = d.start;
        if (d && !YILAN.test(pageTitle)) blocks.push({ title: pageTitle, start: d.start, end: d.end, place: body.match(/活動地點\s*[:：]\s*([^\s，。]{2,30})/)?.[1] ?? null, summary: body.slice(0, 1200) });
      }
      blocks.forEach((b, i) => {
        if (!b.start || (b.end ?? b.start).slice(0, 10) < today) return;
        const city = coastCity(b.place, `${b.title} ${b.summary ?? ''}`.slice(0, 300));
        if (!city) return;
        out.push(makeEvent(this, `${nid}-${i}`, {
          title: b.title,
          start: b.start,
          end: b.end,
          venue: b.place?.replace(/[（(].*$/, '') ?? null,
          address: b.place?.match(/[（(]([^）)]*[路街號][^）)]*)[）)]/)?.[1] ?? null,
          city,
          district: findDistrict({ city }, b.place, b.title) ?? (/福隆|貢寮|草嶺|澳底|鹽寮|龍門|卯澳|馬崗|三貂角|和美/.test(`${b.place} ${b.title}`) ? '貢寮區' : /九份|金瓜石|瑞芳|猴硐|鼻頭|龍洞|深澳|南雅|水湳洞/.test(`${b.place} ${b.title}`) ? '瑞芳區' : null),
          url,
          summary: cleanText(b.summary ?? body.slice(body.indexOf(b.title), body.indexOf(b.title) + 800), 700),
          extra: { organizer: '交通部觀光署東北角及宜蘭海岸國家風景區管理處' },
        }));
      });
    }
    return out;
  },
};
