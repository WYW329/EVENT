// 找 CCMS 網站（桃園、台北市府用的同一套系統）的最新消息 RSS：讀首頁的 News.aspx 連結，再到列表頁找 OpenData.aspx?SN=。
// 用法：node tools/find-ccms-feeds.js https://zzdo.gov.taipei https://dado.gov.taipei ...
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const get = async (u) => {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    return r.ok ? await r.text() : '';
  } catch { return ''; }
};
const WANT = /活動|消息|新聞|藝文|公告|訊息|快訊|講座|課程|展覽|最新/;

for (const base of process.argv.slice(2)) {
  const home = await get(base);
  const title = home.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  const links = new Map();
  for (const m of home.matchAll(/<a[^>]+href="([^"]*News\.aspx\?n=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = (m[2].replace(/<[^>]+>/g, '').trim() || m[0].match(/title="([^"]*)"/)?.[1] || '').trim();
    const href = new URL(m[1].replace(/&amp;/g, '&'), base).href;
    if (!links.has(href)) links.set(href, text);
  }
  const feeds = [];
  for (const [href, text] of [...links].filter(([, t]) => WANT.test(t)).slice(0, 8)) {
    const page = await get(href);
    const sn = page.match(/OpenData\.aspx\?SN=([A-F0-9]+)/)?.[1];
    if (sn && !feeds.some((f) => f.sn === sn)) feeds.push({ sn, text });
  }
  console.log(`${base}\t${title}\t${feeds.map((f) => `${f.text}=${f.sn}`).join(' | ')}`);
}
