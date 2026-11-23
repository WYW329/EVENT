// 「手動加入」：從貼上的文字（例如 FB 貼文、報名公告）找出標題、活動時間、報名時間、地點、連結。
// 不用 AI，靠中文日期格式和關鍵字判斷；結果給使用者確認修改後才存。
import { taipeiNow } from '../scraper/util.js';

const pad = (n) => String(n).padStart(2, '0');

const DATE_RE = new RegExp(
  [
    '(?:(\\d{4}|1[01]\\d)\\s*[年/.\\-]\\s*)?', // 年（可省略；可民國年）
    '(\\d{1,2})\\s*[月/.\\-]\\s*(\\d{1,2})\\s*日?', // 月 日
    '(?:\\s*[（(]\\s*(?:週|周|星期)?\\s*[一二三四五六日天]\\s*[)）])?', // （日）
    '(?:\\s*[)）]?\\s*(?:\\(|（)?\\s*(?:今天|今日|當天)?\\s*(上午|早上|中午|下午|晚上|傍晚|凌晨)?\\s*(\\d{1,2})\\s*(?:[:：](\\d{2})|點\\s*(半|\\d{1,2}分?)?|時)\\s*(?:\\)|）)?)?', // 時間
    '(?:\\s*[-–~～至到]\\s*(\\d{1,2})[:：](\\d{2}))?', // 結束時間 14:00-16:00
  ].join(''),
  'g',
);

const TIME_ONLY_RE = /(今天|明天|今日|明日)?\s*[（(]?\s*(上午|早上|中午|下午|晚上|傍晚|凌晨)?\s*(\d{1,2})\s*[:：](\d{2})/g;

function to24(period, h) {
  h = Number(h);
  if (!period) return h;
  if (/下午|晚上|傍晚/.test(period) && h < 12) return h + 12;
  if (/中午/.test(period) && h < 11) return h + 12;
  if (/凌晨/.test(period) && h === 12) return 0;
  return h;
}

/** 沒寫年份時，挑最接近現在的年份（太久以前就當明年）。 */
function inferYear(m, d, now) {
  const { y } = taipeiNow(now);
  const thisYear = Date.UTC(y, m - 1, d);
  const today = Date.UTC(...(() => { const t = taipeiNow(now); return [t.y, t.m - 1, t.d]; })());
  return thisYear < today - 120 * 86400000 ? y + 1 : y;
}

function classify(context) {
  if (/截止|結束報名|報名至|報名到|收件至/.test(context)) return 'regEnd';
  if (/開放報名|開始報名|報名開始|開搶|開賣|開放預約|起報名|報名時間|受理報名|預約開放|售票/.test(context)) return 'regStart';
  if (/公布|公告|錄取|抽籤|名單/.test(context)) return 'announce';
  return 'event';
}

export function parseManualText(text, now = new Date()) {
  const raw = String(text ?? '').replace(/\r/g, '');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const found = [];

  for (const line of lines) {
    DATE_RE.lastIndex = 0;
    let m;
    while ((m = DATE_RE.exec(line))) {
      const [all, yRaw, mo, da, period, hh, mi, extra, endH, endM] = m;
      const month = Number(mo);
      const day = Number(da);
      if (month < 1 || month > 12 || day < 1 || day > 31) continue;
      // 避免把「1-2歲」「3/4位」之類誤判成日期：沒有年也沒有時間時，前後要有日期語意，後面也不能接單位
      const tail = line.slice(m.index + all.length, m.index + all.length + 1);
      if (!yRaw && !hh && /^[位人名歲個份張組件次]/.test(tail)) continue;
      if (!yRaw && !hh && !/[月日]/.test(all) && !/[（(]/.test(all) && !/\//.test(all)) continue;
      let year = yRaw ? Number(yRaw) : inferYear(month, day, now);
      if (year < 1911) year += 1911;
      let minute = mi ? Number(mi) : extra === '半' ? 30 : extra ? parseInt(extra, 10) || 0 : 0;
      const hour = hh !== undefined ? to24(period, hh) : null;
      const iso = hour === null || hour > 23
        ? `${year}-${pad(month)}-${pad(day)}`
        : `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+08:00`;
      const before = line.slice(Math.max(0, m.index - 14), m.index);
      const after = line.slice(m.index + all.length, m.index + all.length + 8);
      let kind = classify(`${before}${after}${line.length < 40 ? line : ''}`);
      // 「報名 A ~ B」：波浪號後面那個是截止
      if (/[~～至到]\s*$/.test(before) && found.at(-1)?.kind === 'regStart') kind = 'regEnd';
      found.push({ iso, kind, line });
      if (endH && hour !== null) {
        found.push({ iso: `${year}-${pad(month)}-${pad(day)}T${pad(endH)}:${endM}:00+08:00`, kind: kind === 'event' ? 'eventEnd' : kind, line });
      }
    }
    // 「今天晚上 23:59 截止」這種只有時間的
    if (!found.some((f) => f.line === line)) {
      TIME_ONLY_RE.lastIndex = 0;
      const t = TIME_ONLY_RE.exec(line);
      if (t && t[1]) {
        const base = new Date(now.getTime() + (/明/.test(t[1]) ? 86400000 : 0));
        const n = taipeiNow(base);
        const hour = to24(t[2], t[3]);
        found.push({ iso: `${n.y}-${pad(n.m)}-${pad(n.d)}T${pad(hour)}:${t[4]}:00+08:00`, kind: classify(line), line });
      }
    }
  }

  // 同一種時間有好幾個時，優先用有寫幾點幾分的
  const pick = (kind) => {
    const list = found.filter((f) => f.kind === kind);
    return (list.find((f) => f.iso.includes('T')) ?? list[0])?.iso ?? null;
  };
  const eventDates = found.filter((f) => f.kind === 'event').map((f) => f.iso).sort();

  const titleLine = lines.find((l) => /「[^」]{3,}」|《[^》]{3,}》/.test(l)) ?? lines.find((l) => l.length >= 4 && !/^https?:/.test(l)) ?? '';
  // 「」通常框住活動名稱（後面接的是「報名即將截止」之類的提醒）；《》通常是整個標題的一部分，保留整行
  const quoted = titleLine.match(/「([^」]{3,60})」/);
  const title = (quoted?.[1] ?? titleLine)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/^[【\[][^】\]]*[】\]]\s*/, '')
    .trim()
    .slice(0, 80);

  const venueLine = lines.find((l) => /^(?:📍\s*)?(地點|地址|場地|集合地點|活動地點)\s*[:：]/.test(l.replace(/^[^\p{L}]+/u, '')));
  const venue = venueLine ? venueLine.replace(/^[^:：]*[:：]\s*/, '').replace(/https?:\/\/\S+/g, '').trim().slice(0, 80) : null;
  const url = raw.match(/https?:\/\/[^\s）)」>]+/)?.[0] ?? null;

  return {
    title,
    start: eventDates[0] ?? null,
    end: pick('eventEnd') ?? (eventDates.length > 1 ? eventDates.at(-1) : null),
    regStart: pick('regStart'),
    regEnd: pick('regEnd'),
    announce: pick('announce'),
    venue,
    url,
    found,
  };
}
