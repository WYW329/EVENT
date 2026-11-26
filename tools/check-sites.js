// 檢查網站清單：每個網址能不能打開、標題是什麼。輸出 public/sites.json（「網站」頁用）。
// 用法：node tools/check-sites.js tools/sites-candidates.tsv
import { readFile, writeFile } from 'node:fs/promises';

const file = process.argv[2] ?? 'tools/sites.tsv';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const rows = (await readFile(file, 'utf8')).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).map((l) => {
  const [category, name, url, note] = l.split('\t');
  return { category, name, url, note: note || undefined };
});

async function check(r) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(r.url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
      const html = res.ok ? (await res.text()).slice(0, 20000) : '';
      const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim().slice(0, 60) ?? '';
      // 403 多半是擋機器人，用瀏覽器開通常可以
      return { ...r, status: res.status, ok: res.ok || res.status === 403 || res.status === 401, title };
    } catch (err) {
      if (attempt) return { ...r, status: 0, ok: false, error: err.cause?.code ?? err.name };
    }
  }
}

const out = [];
const queue = [...rows];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) out.push(await check(queue.shift()));
}));
out.sort((a, b) => rows.indexOf(rows.find((r) => r.url === a.url)) - rows.indexOf(rows.find((r) => r.url === b.url)));
for (const r of out) console.log(`${r.ok ? '✓' : '✗'} ${String(r.status).padEnd(3)} ${r.category}｜${r.name}｜${r.url}${r.title ? `｜${r.title}` : ''}${r.error ? `｜${r.error}` : ''}`);
console.log(`\n可用 ${out.filter((r) => r.ok).length} / ${out.length}`);
await writeFile('tools/sites-check.json', JSON.stringify(out, null, 1));
