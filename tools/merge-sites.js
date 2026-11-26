// 把桃園的 sites.json 和台北・新北的清單合在一起，加上地區（桃園／台北／全台）和「自動收錄」標記。
// 用法：node tools/merge-sites.js（會讀 tools/sites-taipei.tsv，寫回 public/sites.json）
import { readFile, writeFile } from 'node:fs/promises';

const cur = JSON.parse(await readFile('public/sites.json', 'utf8'));
const NATIONAL = new Set(['售票平台', '彙整網站']);
// 台北的網站裡，已經寫好爬蟲、會自動抓的
const TAIPEI_AUTO = new Set([
  '臺北旅遊網', '臺北市政府文化局', '臺北市政府社會局', '臺北市原住民族事務委員會', '臺北市政府產業發展局', '臺北市政府體育局',
  '臺北市政府民政局', '臺北市政府環境保護局', '臺北市政府勞動局', '臺北市動物保護處', '臺北市公園路燈工程管理處', '臺北市大地工程處（親山步道）',
  '中正區公所', '大同區公所', '中山區公所', '松山區公所', '大安區公所', '萬華區公所', '信義區公所', '士林區公所', '北投區公所', '內湖區公所', '南港區公所', '文山區公所',
  '新北市政府', '新北市立圖書館', '臺北市立天文科學教育館', '臺北市立動物園', '臺北市中山堂', '臺北市藝文推廣處（城市舞台、大稻埕戲苑）',
]);

const taipeiRows = (await readFile('tools/sites-taipei.tsv', 'utf8')).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).map((l) => {
  const [category, name, url] = l.split('\t');
  return { category, name, url, region: '台北', ...(TAIPEI_AUTO.has(name) ? { auto: true } : {}) };
});
const taipeiUrls = new Set(taipeiRows.map((s) => s.url));
const taipeiNames = new Set(taipeiRows.map((s) => s.name));

const base = cur.sites
  .filter((s) => !s.region || s.region !== '台北')
  // 科教館、影視聽中心其實在台北、新北，改放到台北
  .filter((s) => !taipeiUrls.has(s.url) && !taipeiNames.has(s.name))
  .map((s) => ({ ...s, region: NATIONAL.has(s.category) ? '全台' : '桃園' }));

const sites = [...base.filter((s) => s.region === '桃園'), ...taipeiRows, ...base.filter((s) => s.region === '全台')];
await writeFile('public/sites.json', JSON.stringify({ updatedAt: new Date().toISOString().slice(0, 10), sites }, null, 1));
const by = (r) => sites.filter((s) => s.region === r);
for (const r of ['桃園', '台北', '全台']) console.log(r, by(r).length, '個，自動', by(r).filter((s) => s.auto).length);
console.log('合計', sites.length);
