// 試抓指定的來源（不寫入 data/）：node tools/try-source.js hchcc necoast
import { SOURCES } from '../scraper/run.js';

for (const id of process.argv.slice(2)) {
  const src = SOURCES.find((s) => s.id === id);
  if (!src) { console.log(`找不到來源 ${id}`); continue; }
  const t = Date.now();
  try {
    const list = await src.fetch();
    const by = {};
    for (const e of list) by[e.city] = (by[e.city] ?? 0) + 1;
    console.log(`\n== ${id} ${src.name}：${list.length} 筆，${((Date.now() - t) / 1000).toFixed(0)} 秒`, JSON.stringify(by), list.warnings ? `警告 ${list.warnings.join('; ')}` : '');
    for (const e of list.slice(0, Number(process.env.SHOW ?? 8))) console.log(`  ${e.start?.slice(0, 16)}~${e.end?.slice(0, 10)} ${e.city}${e.district ?? ''}｜${e.category}｜${e.title}｜${e.venue ?? ''}`);
  } catch (err) {
    console.log(`\n== ${id} 失敗：${err.message}`);
  }
}
