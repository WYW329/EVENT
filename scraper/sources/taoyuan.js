// 桃園市府的來源：觀光導覽網、市府局處「線上報名」、藝文設施管理中心、親子館報名系統、水務局預約規則。
import * as cheerio from 'cheerio';
import { politeFetch, fetchText, makeEvent, parseDateTime, makeTime, taipeiNow, todayTaipei, findDistrict, cleanText, toMs, guessCategory } from '../util.js';

// ---------- 桃園觀光導覽網・節慶與活動（要先拿 cookie 才能叫資料介面） ----------
export const travel = {
  id: 'tytravel',
  name: '桃園觀光導覽網',
  async fetch() {
    const page = 'https://travel.tycg.gov.tw/zh-tw/event/calendar';
    const first = await politeFetch(page);
    const cookie = first.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    await first.text();
    const { y } = taipeiNow();
    const out = [];
    for (const year of [y, y + 1]) {
      const res = await politeFetch(`https://travel.tycg.gov.tw/zh-tw/opendata/activities?year=${year}`, {
        headers: { Cookie: cookie, 'X-Requested-With': 'XMLHttpRequest', Referer: `${page}/${year}` },
      });
      const json = await res.json().catch(() => null);
      if (!json?.success) {
        if (year === y) throw new Error('資料介面沒有回傳資料（可能要更新 cookie 做法）');
        continue;
      }
      for (const a of json.data ?? []) {
        out.push(
          makeEvent(this, a.id, {
            title: a.name,
            start: parseDateTime(a.date_begin),
            end: parseDateTime(a.date_end),
            venue: a.local || null,
            address: a.address || null,
            district: findDistrict(a.address, a.local),
            url: `https://travel.tycg.gov.tw/zh-tw/event/calendardetail/${a.id}`,
            image: a.thumb && !a.thumb.includes('not-found') ? a.thumb : null,
            summary: a.description,
            extra: a.tentative ? { note: '日期暫定' } : null,
          }),
        );
      }
    }
    return out;
  },
};

// ---------- 市府局處「線上報名」（同一套網站系統，格式都一樣） ----------
const CCMS_SITES = [
  { key: 'culture', name: '文化局', base: 'https://culture.tycg.gov.tw', path: 'ActiveList.aspx?n=23648&sms=20299' },
  { key: 'agri', name: '農業局', base: 'https://agriculture.tycg.gov.tw', path: 'ActiveList.aspx?n=10596&sms=14305' },
  { key: 'hakka', name: '客家事務局', base: 'https://www.hakka.tycg.gov.tw', path: 'ActiveList.aspx?n=26658&sms=20998' },
  { key: 'ipb', name: '原住民族行政局', base: 'https://ipb.tycg.gov.tw', path: 'ActiveList.aspx?n=26673&sms=21008' },
  { key: 'dowcd', name: '婦幼發展局', base: 'https://dowcd.tycg.gov.tw', path: 'ActiveList.aspx?n=16499&sms=18176' },
  { key: 'land', name: '地政局', base: 'https://land.tycg.gov.tw', path: 'ActiveList.aspx?n=3930&sms=12326' },
];

/** 解析一頁「線上報名」列表。拆成獨立函式，方便用存下來的網頁測試。 */
export function parseCcmsActiveList(html, site) {
  const $ = cheerio.load(html);
  const items = [];
  $('.area-essay').each((_, el) => {
    const box = $(el);
    const title = box.find('.caption span').last().text().trim();
    if (!title) return;
    const bodyText = box.find('.p').text();
    const status = box.find('.ft a').first().text().trim();
    const href = box.find('.ft a').first().attr('href');
    // 「活動時間：說明 - 116-01-07 19:00 ~ 116-03-11 21:00」是活動（上課）期間；報名期間要看內頁
    const m = bodyText.match(/(\d{3,4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})\s*~\s*(\d{3,4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/);
    const ann = bodyText.match(/公告日期：\s*(\d{3,4}-\d{1,2}-\d{1,2})\s*~\s*(\d{3,4}-\d{1,2}-\d{1,2})/);
    items.push({
      title,
      status,
      detailUrl: href && !href.startsWith('#') ? new URL(href, `${site.base}/`).href : null,
      url: href && !href.startsWith('#') ? new URL(href, `${site.base}/`).href : `${site.base}/${site.path}`,
      start: m ? parseDateTime(m[1]) : null,
      end: m ? parseDateTime(m[2]) : null,
      annStart: ann ? parseDateTime(ann[1]) : null,
      annEnd: ann ? parseDateTime(ann[2]) : null,
      image: box.find('img').attr('src')?.startsWith('http') ? box.find('img').attr('src') : null,
    });
  });
  return items;
}

/** 內頁的「報名日期：115-11-05~115-11-30」（有時帶時間）。 */
export function parseCcmsRegDates(html) {
  const text = cheerio.load(html)('body').text().replace(/\s+/g, ' ');
  const m = text.match(/報名(?:日期|期間|時間)\s*[:：]\s*(\d{3,4}-\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{2})?)\s*[~～至-]\s*(\d{3,4}-\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{2})?)/);
  return m ? { regStart: parseDateTime(m[1]), regEnd: parseDateTime(m[2]) } : null;
}

/** 標題裡的「12月5日開放報名」→ 開放日（只有日期）。年份取活動開始前最近的那一年。 */
export function regFromTitle(title, start) {
  const m = String(title).match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(?:起)?\s*(?:開放|開始)報名/);
  if (!m) return null;
  const ref = start ? toMs(start) : Date.now();
  let year = taipeiNow(new Date(ref)).y;
  let date = makeTime(year, m[1], m[2]);
  if (start && toMs(date) > ref) date = makeTime(year - 1, m[1], m[2]);
  return { regStart: date, regEnd: null };
}

export const ccms = {
  id: 'tycg',
  name: '桃園市府線上報名',
  async fetch() {
    const out = [];
    const errors = [];
    const now = Date.now();
    for (const site of CCMS_SITES) {
      try {
        const html = await fetchText(`${site.base}/${site.path}`);
        for (const it of parseCcmsActiveList(html, site)) {
          if (/已截止|已結束/.test(it.status)) continue;
          // 給店家、廠商的招募不是民眾活動
          if (/合作意願|店家|廠商|招標|徵才|甄選|約僱|職務代理/.test(it.title)) continue;
          if (it.annEnd && toMs(it.annEnd) < now - 86400000) continue;
          let reg = null;
          if (it.detailUrl) reg = await fetchText(it.detailUrl).then(parseCcmsRegDates).catch(() => null);
          // 還沒開放的沒有內頁連結，改從標題「(12月5日開放報名)」讀開放日
          if (!reg) reg = regFromTitle(it.title, it.start);
          // 報名截止（整天的日期算到當天結束）已經過了就不列
          if (reg?.regEnd && toMs(reg.regEnd) + (reg.regEnd.includes('T') ? 0 : 86400000) < now) continue;
          const key = `${site.key}:${new URL(it.url).searchParams.get('ss') ?? it.title}`;
          out.push(
            makeEvent({ id: this.id, name: `${site.name}線上報名` }, key, {
              title: it.title,
              start: it.start ?? reg?.regStart ?? it.annStart,
              end: it.end ?? reg?.regEnd ?? it.annEnd,
              regStart: reg?.regStart ?? null,
              regEnd: reg?.regEnd ?? null,
              category: guessCategory(it.title, '講座課程'),
              url: it.url,
              image: it.image,
              extra: { status: it.status || null, office: site.name },
            }),
          );
        }
      } catch (err) {
        errors.push(`${site.name}: ${err.message}`);
      }
    }
    if (errors.length && !out.length) throw new Error(errors.join('; '));
    if (errors.length) out.warnings = errors;
    return out;
  },
};

// ---------- 藝文設施管理中心（桃園展演中心、中壢藝術館、光影文化館、藝文廣場、A8、陽光劇場） ----------
const AFMC_HALLS = ['hall1', 'hall2', 'hall3', 'hall4', 'hall5', 'hall6'];
const AFMC_KINDS = ['performance1', 'performance2', 'performance3', 'performance4', 'performance5'];
const AFMC_TYPE = { 表演類: '表演', 展覽類: '展覽', 培訓課程: '講座課程', 大眾講座: '講座課程' };

export function parseAfmcList(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('.Show > li > div > a').each((_, el) => {
    const a = $(el);
    const href = a.attr('href') ?? '';
    const id = href.match(/Activity_detail\/([0-9a-f]+)/)?.[1];
    if (!id) return;
    const dateText = a.find('.data').text().trim();
    const dates = [...dateText.matchAll(/(\d{3})\.(\d{1,2})\.(\d{1,2})/g)];
    const time = a.find('.time').text().match(/(\d{1,2}):(\d{2})(?:\s*-\s*(\d{1,2}):(\d{2}))?/);
    const start = dates[0] ? makeTime(dates[0][1], dates[0][2], dates[0][3], time?.[1], time?.[2]) : null;
    let end = start;
    if (dates[1]) end = makeTime(dates[1][1], dates[1][2], dates[1][3]);
    else if (dates[0] && time?.[3]) end = makeTime(dates[0][1], dates[0][2], dates[0][3], time[3], time[4]);
    items.push({
      id,
      title: a.find('.name').text().trim() || a.attr('title'),
      venue: a.find('.where').text().trim(),
      type: a.find('.dtype').text().trim(),
      start,
      end,
      image: a.find('img').attr('src') ? new URL(a.find('img').attr('src'), 'https://www.afmc.gov.tw/').href : null,
    });
  });
  return items;
}

const AFMC_ADDR = {
  桃園展演中心: '桃園市桃園區中正路1188號',
  中壢藝術館: '桃園市中壢區中美路16號',
  桃園光影文化館: '桃園市桃園區埔新路12號',
  桃園藝文廣場: '桃園市桃園區中正路1188號',
  A8藝文中心: '桃園市龜山區復興一路8號',
  桃園陽光劇場: '桃園市桃園區中正路1188號',
};

export const afmc = {
  id: 'afmc',
  name: '藝文設施管理中心',
  async fetch() {
    const seen = new Map();
    // 網站一次只列一個場館的一種類型（表演、展覽、其他、培訓課程、大眾講座），所以要逐一組合查
    for (const hall of AFMC_HALLS) {
      for (const type of AFMC_KINDS) {
        const html = await fetchText(`https://www.afmc.gov.tw/Activity?c3=${hall}&c5=${type}`);
        for (const it of parseAfmcList(html)) seen.set(it.id, it);
      }
    }
    return [...seen.values()].map((it) =>
      makeEvent(this, it.id, {
        title: it.title,
        start: it.start,
        end: it.end,
        venue: it.venue,
        address: AFMC_ADDR[it.venue] ?? null,
        category: AFMC_TYPE[it.type],
        url: `https://www.afmc.gov.tw/Activity_detail/${it.id}`,
        image: it.image,
      }),
    );
  },
};

// ---------- 親子館課程報名（桃園育兒資源網）。資料介面直接給報名開始時間和剩餘名額 ----------
const ZIP_DISTRICT = {
  330: '桃園區', 320: '中壢區', 324: '平鎮區', 334: '八德區', 326: '楊梅區', 338: '蘆竹區', 333: '龜山區',
  337: '大園區', 328: '觀音區', 327: '新屋區', 325: '龍潭區', 335: '大溪區', 336: '復興區',
};

/** 去掉「※請提早報到※」「【請於…】」這類提醒；整個標題都在【】裡時保留括號內文字。 */
export function babycareTitle(desc) {
  let t = String(desc ?? '').replace(/※[^※]*※?/g, '').replace(/[（(]?[＃#][^＃#]*[＃#][)）]?/g, '').replace(/【\s*(請|詳細)[^】]*】/g, '').trim();
  const stripped = t.replace(/【[^】]*】/g, '').replace(/^[\s\-－:：]+/, '').trim();
  if (stripped.length >= 2) return stripped;
  return t.replace(/[【】]/g, '').trim() || desc;
}
export const babycare = {
  id: 'babycare',
  name: '親子館報名',
  async fetch() {
    const out = [];
    const days = Number(process.env.BABYCARE_DAYS ?? 15);
    const base = Date.now();
    for (let i = 0; i < days; i++) {
      const date = todayTaipei(new Date(base + i * 86400000));
      const res = await politeFetch('https://babycare.tycg.gov.tw/api/VActlist/List', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_kind: 'PC', event_date: date, org_filter: [], age_filter: ['0', '0', '0', '0'], type_filter: [], distno_filter: [] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      for (const a of json.bc_v_act_list ?? []) {
        // 「自由入館」「自由活動」每天都有、量很大，不算活動
        if (a.act_kind === 'B' || /自由入館|自由活動|自由參觀|臨時托育|臨托/.test(a.act_desc)) continue;
        const ageText = a.age_end >= 99 ? '不限年齡' : `${a.age_start}～${a.age_end} 個月`;
        out.push(
          makeEvent(this, a.event_id, {
            title: `${babycareTitle(a.act_desc)}（${a.org_short}）`,
            start: makeTime(...a.event_date.split('-'), ...a.time_start.split(':')),
            end: makeTime(...a.event_date.split('-'), ...a.time_end.split(':')),
            regStart: parseDateTime(a.apply_start),
            regEnd: parseDateTime(a.apply_end),
            venue: a.org_short,
            district: ZIP_DISTRICT[a.addr_distno] ?? findDistrict(a.org_name),
            category: '親子館',
            free: a.pay_flag === '0',
            url: 'https://babycare.tycg.gov.tw/#/parent-child-apply',
            extra: { seatsLeft: a.online_remaining_count, seats: a.num_online, ages: ageText, zip: a.addr_distno },
          }),
        );
      }
    }
    return out;
  },
};

// ---------- 水務局參訪預約：規則固定（每月 15 日 10:00 開放下個月，遇週末順延），直接產生提醒 ----------
export const water = {
  id: 'water',
  name: '水務局參訪預約',
  async fetch() {
    const { y, m, d } = taipeiNow();
    const out = [];
    for (let k = 0; k < 2; k++) {
      let mm = m + k;
      let yy = y;
      if (mm > 12) { mm -= 12; yy += 1; }
      // 開放日：15 日，遇週六、週日順延到週一
      let openDay = 15;
      const dow = new Date(Date.UTC(yy, mm - 1, 15)).getUTCDay();
      if (dow === 6) openDay = 17;
      if (dow === 0) openDay = 16;
      if (k === 0 && d > openDay) continue; // 這個月的已經過了
      let ny = yy;
      let nm = mm + 1;
      if (nm > 12) { nm = 1; ny += 1; }
      const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
      out.push(
        makeEvent(this, `himitsu:${ny}-${nm}`, {
          title: `水の秘密基地導覽 ${nm}月場次開放預約`,
          start: makeTime(ny, nm, 1),
          end: makeTime(ny, nm, lastDay),
          regStart: makeTime(yy, mm, openDay, 10, 0),
          venue: '大樹林滯洪池「水の秘密基地」',
          address: '桃園市桃園區延平路368號',
          category: '體驗',
          free: true,
          url: 'https://www.wrbtycg.tw/tysafe/WebPage/VisitReservation_Query.html?Location=30',
          summary: '每週二到週六上午 10:00–12:00 導覽，每場上限 40 人，每人最多報 4 位。每月 15 日早上 10:00 開放預約下個月場次（遇假日順延），國定假日順延請以官網公告為準。',
        }),
      );
    }
    return out;
  },
};
