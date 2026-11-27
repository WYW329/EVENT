// 產生「網站」頁的清單 public/sites.json：桃園（原本的清單）＋台北・新北（tools/sites-taipei*.tsv）＋全台平台。
// auto：有專門的爬蟲直接抓。via：沒有專門爬蟲，但它的活動已經透過別的來源（文化部、非池中、iNDIEVOX…）收進來了，看 data/events.json 判斷。
// 用法：node tools/merge-sites.js
import { readFile, writeFile } from 'node:fs/promises';

const cur = JSON.parse(await readFile('public/sites.json', 'utf8'));
const events = JSON.parse(await readFile('data/events.json', 'utf8')).events;
const NATIONAL = new Set(['售票平台', '彙整網站']);

// 台北・新北有專門爬蟲的網站（名稱要和 tsv 一樣）
const TAIPEI_AUTO = new Set([
  '臺北旅遊網', '臺北市政府文化局', '臺北市政府社會局', '臺北市原住民族事務委員會', '臺北市政府產業發展局', '臺北市政府體育局',
  '臺北市政府民政局', '臺北市政府環境保護局', '臺北市政府勞動局', '臺北市動物保護處', '臺北市公園路燈工程管理處', '臺北市大地工程處（親山步道）',
  '中正區公所', '大同區公所', '中山區公所', '松山區公所', '大安區公所', '萬華區公所', '信義區公所', '士林區公所', '北投區公所', '內湖區公所', '南港區公所', '文山區公所',
  '新北市政府', '新北市立圖書館', '臺北市立天文科學教育館', '臺北市立動物園', '臺北市中山堂', '臺北市藝文推廣處（城市舞台、大稻埕戲苑）',
  '華山1914文化創意產業園區', '松山文創園區', '臺北市立美術館', '臺北流行音樂中心', '空總臺灣當代文化實驗場 C-LAB', '臺北市立圖書館',
  '臺北市客家事務委員會', '臺北市立兒童新樂園', '臺北自來水園區', '新北市立十三行博物館', '新北市立黃金博物館', '新北市立淡水古蹟博物館',
  '林本源園邸', '新北市坪林茶業博物館', '新北市政府文化局', '台北世貿中心・南港展覽館', '臺北當代藝術館',
  '非池中藝術網（展覽，含小畫廊）', 'iNDIEVOX（Live House 演出）', 'Eventbrite 台北', 'Meetup 台北', 'Luma 台北',
]);

const readTsv = async (file) => (await readFile(file, 'utf8')).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).map((l) => {
  const [category, name, url, match] = l.split('\t');
  return { category, name, url, region: '台北', ...(match ? { match } : {}), ...(TAIPEI_AUTO.has(name) ? { auto: true } : {}) };
});
const taipeiRows = [];
for (const r of [...(await readTsv('tools/sites-taipei.tsv')), ...(await readTsv('tools/sites-taipei-more.tsv'))]) {
  if (!taipeiRows.some((x) => x.url === r.url || x.name === r.name)) taipeiRows.push(r);
}
const taipeiUrls = new Set(taipeiRows.map((s) => s.url));
const taipeiNames = new Set(taipeiRows.map((s) => s.name));

const base = cur.sites
  .filter((s) => s.region !== '台北')
  .filter((s) => !taipeiUrls.has(s.url) && !taipeiNames.has(s.name))
  .map(({ via, ...s }) => ({ ...s, region: NATIONAL.has(s.category) ? '全台' : '桃園' }));

const sites = [...base.filter((s) => s.region === '桃園'), ...taipeiRows, ...base.filter((s) => s.region === '全台')];

// 沒有專門爬蟲的網站：活動的場地、主辦、標題裡有它的名字（或指定的關鍵字），就記下是透過哪個來源收進來的
const hay = events.map((e) => ({ text: `${e.venue ?? ''} ${e.extra?.organizer ?? ''} ${e.title}`.replace(/臺/g, '台'), src: e.sourceName, city: e.city }));
for (const s of sites) {
  if (s.auto || s.region === '全台') continue;
  const key = (s.match ?? s.name.replace(/[（(].*$/, '').trim()).replace(/臺/g, '台');
  if (key.length < 2) continue;
  const city = s.region === '桃園' ? '桃園市' : null;
  const hits = hay.filter((h) => h.text.includes(key) && (!city || h.city === city) && (city || h.city !== '桃園市'));
  if (!hits.length) continue;
  const count = new Map();
  for (const h of hits) count.set(h.src, (count.get(h.src) ?? 0) + 1);
  s.via = [...count].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([src]) => src);
}
for (const s of sites) delete s.match;

await writeFile('public/sites.json', JSON.stringify({ updatedAt: new Date().toISOString().slice(0, 10), sites }, null, 1));
const by = (r) => sites.filter((s) => s.region === r);
for (const r of ['桃園', '台北', '全台']) console.log(r, by(r).length, '個，專門爬蟲', by(r).filter((s) => s.auto).length, '，透過其他來源', by(r).filter((s) => s.via).length);
console.log('合計', sites.length);
