// 全國開放資料：文化部藝文活動、觀光署活動。
import { fetchJson, politeFetch, makeEvent, parseDateTime, isTaoyuan, findDistrict, cleanText } from '../util.js';
import { inflateRawSync } from 'node:zlib';

// 文化部 iCulture 類別代碼 → 本站類別
const CULTURE_CAT = {
  1: '表演', 2: '表演', 3: '表演', 4: '親子', 5: '表演', 6: '展覽', 7: '講座課程', 8: '電影',
  11: '表演', 13: '其他', 14: '其他', 15: '其他', 17: '表演', 19: '講座課程',
};

export const culture = {
  id: 'moc',
  name: '文化部藝文活動',
  async fetch() {
    const list = await fetchJson('https://cloud.culture.tw/frontsite/trans/SearchShowAction.do?method=doFindTypeJ&category=all', {}, { timeoutMs: 90000 });
    const out = [];
    for (const it of list) {
      const shows = (it.showInfo ?? []).filter((s) => isTaoyuan(s.location, s.locationName) && !/臺中|台中|新北|臺北|台北|新竹|苗栗|高雄|臺南|台南/.test(s.location ?? ''));
      if (!shows.length) continue;
      const times = shows.map((s) => parseDateTime(s.time)).filter(Boolean).sort();
      const ends = shows.map((s) => parseDateTime(s.endTime)).filter(Boolean).sort();
      const first = shows[0];
      out.push(
        makeEvent(this, it.UID, {
          title: it.title,
          start: times[0] ?? parseDateTime(it.startDate),
          end: ends.at(-1) ?? parseDateTime(it.endDate),
          venue: first.locationName,
          address: first.location,
          district: findDistrict(first.location, first.locationName),
          category: CULTURE_CAT[it.category] ?? undefined,
          // 有寫票價就是要付費；沒寫不一定免費，交給文字判斷
          free: shows.some((s) => s.price) ? false : null,
          url: it.webSales || it.sourceWebPromote || `https://cloud.culture.tw/frontsite/inquiry/eventInquiryAction.do?method=showEventDetail&uid=${it.UID}`,
          image: it.imageUrl || null,
          summary: it.descriptionFilterHtml,
          extra: { showCount: shows.length, organizer: it.masterUnit?.join?.('、') || null },
        }),
      );
    }
    return out;
  },
};

/** 讀 zip 裡第一個指定檔名的檔案（觀光署資料是 zip，只有一層，用內建 zlib 解壓）。 */
function readZipEntry(buf, wanted) {
  let off = 0;
  while (off + 30 < buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    let size = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString();
    const dataStart = off + 30 + nameLen + extraLen;
    if (size === 0) {
      // 有資料描述區塊時，大小寫在中央目錄；改用中央目錄找
      return readZipCentral(buf, wanted);
    }
    if (name === wanted) {
      const data = buf.slice(dataStart, dataStart + size);
      return method === 8 ? inflateRawSync(data) : data;
    }
    off = dataStart + size;
  }
  return readZipCentral(buf, wanted);
}

function readZipCentral(buf, wanted) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('zip 格式不對');
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString();
    if (name === wanted) {
      const lNameLen = buf.readUInt16LE(local + 26);
      const lExtra = buf.readUInt16LE(local + 28);
      const data = buf.slice(local + 30 + lNameLen + lExtra, local + 30 + lNameLen + lExtra + size);
      return method === 8 ? inflateRawSync(data) : data;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip 裡沒有 ${wanted}`);
}

export const tourism = {
  id: 'tourism',
  name: '觀光署活動',
  async fetch() {
    const res = await politeFetch('https://media.taiwan.net.tw/XMLReleaseAll_public/v2.0/Zh_tw/Event-json.zip', {}, { timeoutMs: 90000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const json = JSON.parse(readZipEntry(buf, 'EventList.json').toString('utf8').replace(/^﻿/, ''));
    const list = json.Events ?? json.EventList ?? Object.values(json).find(Array.isArray) ?? [];
    const out = [];
    for (const e of list) {
      const addr = e.PostalAddress ?? {};
      if (addr.City !== '桃園市') continue;
      out.push(
        makeEvent(this, e.EventID, {
          title: e.EventName,
          start: parseDateTime(e.StartDateTime),
          end: parseDateTime(e.EndDateTime),
          venue: cleanText(addr.StreetAddress, 60),
          address: `${addr.City ?? ''}${addr.Town ?? ''}${addr.StreetAddress ?? ''}`,
          district: addr.Town || findDistrict(addr.StreetAddress),
          category: '節慶市集',
          free: e.IsAccessibleForFree === 1 ? true : null,
          url: e.WebsiteURL || e.SameAsURLs?.[0] || null,
          image: e.Images?.[0]?.URL ?? null,
          summary: e.Description,
        }),
      );
    }
    return out;
  },
};
