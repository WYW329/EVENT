// 通知規則（純函式，Worker 和測試共用）：哪些新活動要通知誰、收藏的活動什麼時候提醒。

export const DEFAULT_PREFS = {
  notifyNew: true,
  categories: [], // 空 = 全部類別（親子館另外用 includeBabycare 控制）
  cities: [], // 空 = 全部縣市
  keywords: [], // 標題含任一關鍵字就通知（不管類別、縣市）
  includeBabycare: false,
  remindMinutes: [1440, 30, 5],
  remindEventDayBefore: true,
  vibrate: true, // false = 靜音通知
};

export function cleanPrefs(p = {}) {
  const out = { ...DEFAULT_PREFS };
  for (const k of ['notifyNew', 'includeBabycare', 'remindEventDayBefore', 'vibrate']) if (typeof p[k] === 'boolean') out[k] = p[k];
  for (const k of ['categories', 'cities', 'keywords']) if (Array.isArray(p[k])) out[k] = p[k].map(String).map((s) => s.trim()).filter(Boolean).slice(0, 30);
  if (Array.isArray(p.remindMinutes)) out.remindMinutes = [...new Set(p.remindMinutes.map(Number).filter((n) => n > 0 && n <= 10080))].slice(0, 6);
  return out;
}

const toMs = (v) => (!v ? NaN : /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00+08:00`) : Date.parse(v));

export function matchesPrefs(event, prefs) {
  const p = { ...DEFAULT_PREFS, ...prefs };
  if (!p.notifyNew) return false;
  const title = event.title ?? '';
  if (p.keywords?.length && p.keywords.some((k) => k && title.includes(k))) return true;
  if (event.category === '親子館' && !p.includeBabycare) return false;
  const cats = event.categories?.length ? event.categories : [event.category];
  if (p.categories?.length && !cats.some((c) => p.categories.includes(c))) return false;
  if (p.cities?.length && !p.cities.includes(event.city ?? '桃園市')) return false;
  return true;
}

export function fmt(iso) {
  const ms = toMs(iso);
  if (Number.isNaN(ms)) return '';
  const t = new Date(ms + 8 * 3600000);
  const md = `${t.getUTCMonth() + 1}/${t.getUTCDate()}`;
  return iso.includes('T') ? `${md} ${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}` : md;
}

function minutesText(min) {
  if (min >= 1440) return `${Math.round(min / 1440)} 天後`;
  if (min >= 60) return `${Math.round(min / 60)} 小時後`;
  return `${min} 分鐘後`;
}

/** 收藏的這個活動要在哪些時間點提醒。e 是收藏時存下的活動快照。 */
export function reminderJobs(e, prefs) {
  const p = { ...DEFAULT_PREFS, ...prefs };
  const jobs = [];
  const open = `/#event=${encodeURIComponent(e.id)}`;
  const url = e.url || open;
  if (e.regStart && !e.regStart.includes('T')) {
    // 只知道日期、不知道幾點：前一天晚上 8 點、當天早上 8 點
    const day0 = toMs(e.regStart);
    jobs.push({ key: 'regd-1', at: day0 - 4 * 3600000, payload: { title: '⏰ 明天開放報名', body: `${e.title}（${fmt(e.regStart)}，時間請看官網）`, url, tag: `reg-${e.id}` } });
    jobs.push({ key: 'regd0', at: day0 + 8 * 3600000, payload: { title: '🔔 今天開放報名', body: e.title, url, tag: `reg-${e.id}`, requireInteraction: true } });
  } else if (e.regStart) {
    const t = toMs(e.regStart);
    for (const min of p.remindMinutes) jobs.push({ key: `reg${min}`, at: t - min * 60000, payload: { title: `⏰ ${minutesText(min)}開放報名`, body: `${e.title}（${fmt(e.regStart)}）`, url, tag: `reg-${e.id}` } });
    jobs.push({ key: 'reg0', at: t, payload: { title: '🔔 現在開放報名了！', body: e.title, url, tag: `reg-${e.id}`, requireInteraction: true } });
  }
  if (p.remindEventDayBefore && e.start) {
    const startMs = toMs(e.start);
    const dayBefore9 = startMs - ((startMs + 8 * 3600000) % 86400000) - 86400000 + 9 * 3600000;
    jobs.push({ key: 'day-1', at: dayBefore9, payload: { title: '明天的活動', body: `${e.title}・${fmt(e.start)}${e.venue ? `・${e.venue}` : ''}`, url: open, tag: `day-${e.id}` } });
  }
  return jobs;
}

/** 現在該發的提醒（錯過 20 分鐘內還會補發）。 */
export const REMIND_WINDOW = 20 * 60000;
export const dueJobs = (jobs, now) => jobs.filter((j) => now >= j.at && now < j.at + REMIND_WINDOW);

/** 新活動通知的內容：3 個以內各一則，超過合併成一則。 */
export function newEventMessages(list) {
  if (list.length > 3) {
    return [{ title: `有 ${list.length} 個新活動`, body: `${list.slice(0, 3).map((e) => e.title).join('、')}…`, url: '/#new', tag: 'new-batch' }];
  }
  return list.map((e) => {
    const when = e.regStart && toMs(e.regStart) > Date.now() ? `${fmt(e.regStart)} 開放報名` : fmt(e.start);
    return { title: `${e.free ? '免費・' : ''}新活動：${e.title}`, body: [when, e.venue || e.district].filter(Boolean).join('・'), url: `/#event=${encodeURIComponent(e.id)}`, tag: e.id };
  });
}

/** 收藏時存的活動快照（只留提醒需要的欄位）。 */
export const snapshot = (e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, regStart: e.regStart, regEnd: e.regEnd, url: e.url, venue: e.venue, district: e.district });
