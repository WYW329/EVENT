// 社群、小型活動平台：Eventbrite、Meetup、Luma（語言交換、讀書會、健行、講座、派對這類小活動）。
// 都是讀頁面裡給搜尋引擎的 schema.org 資料或頁面內建的 JSON；robots.txt 允許這些頁面。
import { fetchText, makeEvent, cleanText, supportedCity, todayTaipei, findDistrict } from '../util.js';

/** 英文地區名 → 本站縣市 */
export function cityFromEn(...texts) {
  const s = texts.filter(Boolean).join(' ');
  if (/New Taipei|新北/i.test(s)) return '新北市';
  if (/Taoyuan|桃園/i.test(s)) return '桃園市';
  if (/Taipei|臺北|台北/i.test(s)) return '臺北市';
  return supportedCity(s);
}

// 英文地址裡的行政區
const EN_DISTRICT = {
  "Zhongzheng": '中正區', 'Datong': '大同區', 'Zhongshan': '中山區', 'Songshan': '松山區', "Da'?an|Da’an|Daan": '大安區', 'Wanhua': '萬華區',
  'Xinyi': '信義區', 'Shilin': '士林區', 'Beitou': '北投區', 'Neihu': '內湖區', 'Nangang': '南港區', 'Wenshan': '文山區',
  'Banqiao': '板橋區', 'Sanchong': '三重區', 'Zhonghe': '中和區', 'Yonghe': '永和區', 'Xinzhuang': '新莊區', 'Xindian': '新店區', 'Tamsui|Danshui': '淡水區',
  'Xizhi': '汐止區', 'Tucheng': '土城區', 'Luzhou': '蘆洲區', 'Linkou': '林口區', 'Zhongli': '中壢區', 'Taoyuan District': '桃園區',
};
export function districtFromEn(...texts) {
  const s = texts.filter(Boolean).join(' ');
  const zh = findDistrict(s);
  if (zh) return zh;
  for (const [re, d] of Object.entries(EN_DISTRICT)) if (new RegExp(`\\b(${re})\\b(?:\\s+Dist)?`, 'i').test(s)) return d;
  return null;
}

/** UTC ISO → 台北時間字串（2026-11-27T19:30:00+08:00） */
export function toTaipeiIso(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const t = new Date(ms + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:00+08:00`;
}
const dateOrTime = (s) => (!s ? null : /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : toTaipeiIso(s));

/** 頁面裡所有 schema.org Event。 */
export function ldEvents(html) {
  return [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
    .flatMap((d) => (Array.isArray(d) ? d : d?.itemListElement ? d.itemListElement.map((x) => x.item ?? x) : [d]))
    .filter((x) => x?.['@type'] === 'Event');
}

const addrText = (loc) => {
  const a = loc?.address ?? {};
  return typeof a === 'string' ? a : [a.streetAddress, a.addressLocality, a.addressRegion].filter(Boolean).join(', ');
};
const ended = (e) => (e.end ?? e.start ?? '').slice(0, 10) < todayTaipei();

// ---------- Eventbrite（台北、新北、桃園的頁面） ----------
export const eventbrite = {
  id: 'eventbrite',
  name: 'Eventbrite',
  async fetch() {
    const out = new Map();
    const errors = [];
    for (const slug of ['taiwan--taipei', 'taiwan--new-taipei-city', 'taiwan--taoyuan-city']) {
      for (let page = 1; page <= 4; page++) {
        const html = await fetchText(`https://www.eventbrite.com/d/${slug}/events/${page > 1 ? `?page=${page}` : ''}`).catch((err) => { errors.push(`${slug}: ${err.message}`); return ''; });
        const list = ldEvents(html);
        if (!list.length) break;
        let added = 0;
        for (const ev of list) {
          const id = ev.url?.match(/-(\d{6,})(?:\?|$)/)?.[1];
          if (!id || out.has(id)) continue;
          const loc = ev.location ?? {};
          if (/online/i.test(loc['@type'] ?? '') || /online/i.test(loc.name ?? '')) continue;
          const city = cityFromEn(addrText(loc), loc.name);
          if (!city) continue;
          const e = makeEvent({ ...this, city }, id, {
            title: ev.name,
            start: dateOrTime(ev.startDate),
            end: dateOrTime(ev.endDate),
            venue: loc.name ?? null,
            address: addrText(loc) || null,
            district: districtFromEn(addrText(loc), loc.name),
            city,
            url: ev.url,
            image: ev.image ?? null,
            summary: cleanText(ev.description, 1200),
          });
          if (!ended(e)) { out.set(id, e); added++; }
        }
        if (!added) break;
      }
    }
    if (!out.size && errors.length) throw new Error(errors.join('; '));
    return [...out.values()];
  },
};

// ---------- Meetup（台北） ----------
export const meetup = {
  id: 'meetup',
  name: 'Meetup',
  async fetch() {
    const html = await fetchText('https://www.meetup.com/find/?location=tw--Taipei&source=EVENTS');
    const out = [];
    for (const ev of ldEvents(html)) {
      if (/Online/i.test(ev.eventAttendanceMode ?? '')) continue;
      const loc = ev.location ?? {};
      const city = cityFromEn(addrText(loc), loc.name) ?? cityFromEn(ev.name);
      if (!city) continue;
      const id = ev.url?.match(/events\/(\d+)/)?.[1];
      if (!id) continue;
      const e = makeEvent({ ...this, city }, id, {
        title: ev.name,
        start: toTaipeiIso(ev.startDate),
        end: ev.endDate ? toTaipeiIso(ev.endDate) : null,
        venue: loc.name ?? null,
        address: addrText(loc) || null,
        district: districtFromEn(addrText(loc), loc.name),
        city,
        url: ev.url,
        image: ev.image && !ev.image.startsWith('/') ? ev.image : null,
        summary: cleanText(ev.description, 1200),
        extra: { organizer: ev.organizer?.name ?? null },
      });
      if (!ended(e)) out.push(e);
    }
    return out;
  },
};

// ---------- Luma（台北頁面） ----------
export const luma = {
  id: 'luma',
  name: 'Luma',
  async fetch() {
    const html = await fetchText('https://lu.ma/taipei');
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error('找不到頁面資料');
    const list = JSON.parse(m[1])?.props?.pageProps?.initialData?.data?.events ?? [];
    const out = [];
    for (const x of list) {
      const ev = x.event ?? x;
      if (ev.location_type && ev.location_type !== 'offline') continue;
      const g = ev.geo_address_info ?? {};
      const zh = g.localized?.['zh-TW'] ?? {};
      const city = cityFromEn(zh.full_address, g.region, g.full_address);
      if (!city) continue;
      const e = makeEvent({ ...this, city }, ev.api_id, {
        title: ev.name,
        start: toTaipeiIso(ev.start_at),
        end: toTaipeiIso(ev.end_at),
        venue: g.address ?? null,
        address: zh.full_address ?? null,
        city,
        url: `https://lu.ma/${ev.url}`,
        image: ev.cover_url ?? null,
        extra: { organizer: x.calendar?.name ?? null },
      });
      if (!ended(e)) out.push(e);
    }
    return out;
  },
};
