// 通知邏輯：新活動通知、收藏活動的「開放報名」和「活動前一天」提醒。每分鐘被 /api/tick 呼叫一次。
import webpush from 'web-push';
import { createHash } from 'node:crypto';
import { toMs } from '../scraper/util.js';

export const DEFAULT_PREFS = {
  notifyNew: true,
  categories: [], // 空陣列 = 全部類別（親子館另外用 includeBabycare 控制，因為量很大）
  cities: [], // 空陣列 = 全部縣市
  keywords: [], // 標題含任一關鍵字就通知（會覆蓋類別和行政區篩選）
  includeBabycare: false,
  remindMinutes: [1440, 30, 5], // 開放報名前多久提醒
  remindEventDayBefore: true,
};

export const subId = (endpoint) => createHash('sha256').update(endpoint).digest('hex').slice(0, 16);

export function setupWebPush() {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  return true;
}

/** 這個活動符不符合這個訂閱的「新活動通知」條件。 */
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

const fmt = (iso) => {
  const ms = toMs(iso);
  if (Number.isNaN(ms)) return '';
  const t = new Date(ms + 8 * 3600000);
  const md = `${t.getUTCMonth() + 1}/${t.getUTCDate()}`;
  return iso.includes('T') ? `${md} ${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}` : md;
};

function minutesText(min) {
  if (min >= 1440) return `${Math.round(min / 1440)} 天後`;
  if (min >= 60) return `${Math.round(min / 60)} 小時後`;
  return `${min} 分鐘後`;
}

export class Notifier {
  constructor(state, { send } = {}) {
    this.state = state;
    this.send = send ?? ((sub, payload) => webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 6 * 3600, urgency: 'high' }));
    this.log = [];
  }

  async push(id, payload) {
    const entry = this.state.data.subs[id];
    if (!entry) return false;
    try {
      await this.send(entry.subscription, payload);
      this.log.push({ at: new Date().toISOString(), id, title: payload.title });
      if (this.log.length > 100) this.log.shift();
      return true;
    } catch (err) {
      // 訂閱失效（使用者刪掉 App、關掉通知）就移除
      if (err.statusCode === 404 || err.statusCode === 410) {
        delete this.state.data.subs[id];
        this.state.touch();
      } else {
        console.error('[push]', id, err.statusCode ?? '', err.body ?? err.message);
      }
      return false;
    }
  }

  /** 找出新活動並通知。第一次執行只記錄、不通知，避免一次跳幾百則。 */
  async notifyNew(events) {
    const data = this.state.data;
    const seen = new Set(data.seen.ids);
    const fresh = events.filter((e) => !seen.has(e.id) && e.source !== 'manual');
    if (!data.seen.seededAt) {
      data.seen = { ids: events.map((e) => e.id), seededAt: new Date().toISOString() };
      this.state.touch();
      return { seeded: true, fresh: 0, sent: 0 };
    }
    if (!fresh.length) return { fresh: 0, sent: 0 };
    let sent = 0;
    for (const [id, entry] of Object.entries(data.subs)) {
      const mine = fresh.filter((e) => matchesPrefs(e, entry.prefs));
      if (!mine.length) continue;
      if (mine.length <= 3) {
        for (const e of mine) {
          const when = e.regStart && toMs(e.regStart) > Date.now() ? `${fmt(e.regStart)} 開放報名` : fmt(e.start);
          if (await this.push(id, { title: `${e.free ? '免費・' : ''}新活動：${e.title}`, body: [when, e.venue || e.district].filter(Boolean).join('・'), url: `/#event=${encodeURIComponent(e.id)}`, tag: e.id })) sent++;
        }
      } else {
        const names = mine.slice(0, 3).map((e) => e.title).join('、');
        if (await this.push(id, { title: `桃園有 ${mine.length} 個新活動`, body: `${names}…`, url: '/#new', tag: 'new-batch' })) sent++;
      }
    }
    // 只保留目前還存在的活動 id，避免越存越大
    const current = new Set(events.map((e) => e.id));
    data.seen.ids = [...new Set([...data.seen.ids.filter((i) => current.has(i)), ...fresh.map((e) => e.id)])];
    this.state.touch();
    return { fresh: fresh.length, sent };
  }

  /** 收藏活動的提醒：開放報名前（依設定的分鐘數），以及活動前一天早上 9 點。 */
  async remind(events, now = Date.now()) {
    const data = this.state.data;
    const byId = new Map(events.map((e) => [e.id, e]));
    const WINDOW = 20 * 60000; // 錯過時間點 20 分鐘內還會補發（伺服器剛醒來時）
    let sent = 0;
    for (const [id, entry] of Object.entries(data.subs)) {
      const prefs = { ...DEFAULT_PREFS, ...entry.prefs };
      for (const eventId of entry.starred ?? []) {
        const e = byId.get(eventId);
        if (!e) continue;
        const jobs = [];
        if (e.regStart && !e.regStart.includes('T')) {
          // 只知道哪一天開放、不知道幾點：前一天晚上 8 點和當天早上 8 點各提醒一次
          const day0 = toMs(e.regStart);
          const url = e.url || `/#event=${encodeURIComponent(e.id)}`;
          jobs.push({ key: 'regd-1', at: day0 - 4 * 3600000, payload: { title: '⏰ 明天開放報名', body: `${e.title}（${fmt(e.regStart)}，時間請看官網）`, url, tag: `reg-${e.id}` } });
          jobs.push({ key: 'regd0', at: day0 + 8 * 3600000, payload: { title: '🔔 今天開放報名', body: e.title, url, tag: `reg-${e.id}`, requireInteraction: true } });
        } else if (e.regStart) {
          const t = toMs(e.regStart);
          for (const min of prefs.remindMinutes) jobs.push({ key: `reg${min}`, at: t - min * 60000, payload: { title: `⏰ ${minutesText(min)}開放報名`, body: `${e.title}（${fmt(e.regStart)}）`, url: e.url || `/#event=${encodeURIComponent(e.id)}`, tag: `reg-${e.id}` } });
          jobs.push({ key: 'reg0', at: t, payload: { title: '🔔 現在開放報名了！', body: e.title, url: e.url || `/#event=${encodeURIComponent(e.id)}`, tag: `reg-${e.id}`, requireInteraction: true } });
        }
        if (prefs.remindEventDayBefore && e.start) {
          const startMs = toMs(e.start);
          const dayBefore9 = startMs - ((startMs + 8 * 3600000) % 86400000) - 86400000 + 9 * 3600000;
          jobs.push({ key: 'day-1', at: dayBefore9, payload: { title: '明天的活動', body: `${e.title}・${fmt(e.start)}${e.venue ? `・${e.venue}` : ''}`, url: `/#event=${encodeURIComponent(e.id)}`, tag: `day-${e.id}` } });
        }
        for (const job of jobs) {
          const sentKey = `${id}|${e.id}|${job.key}`;
          if (data.sent[sentKey]) continue;
          if (now >= job.at && now < job.at + WINDOW) {
            if (await this.push(id, job.payload)) sent++;
            data.sent[sentKey] = now;
            this.state.touch();
          }
        }
      }
    }
    // 清掉 40 天前的發送紀錄
    for (const [k, t] of Object.entries(data.sent)) if (now - t > 40 * 86400000) delete data.sent[k];
    return { sent };
  }
}
