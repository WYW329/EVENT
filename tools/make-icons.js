// 產生 App 圖示（PNG）：桃紅色圓角方塊上一個白色雷達（同心圓弧加中心點）。不需要額外套件。
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(OUT, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // 4x 超取樣讓邊緣平滑
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const p = pixel((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size);
        r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / 16) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const TOP = [240, 104, 124];
const BOTTOM = [214, 70, 98];
const WHITE = [255, 255, 255, 1];

function radar(u, v, { rounded = true, bg = true } = {}) {
  // 圓角方塊背景（iOS 會自己裁圓角，給滿版也可以）
  const inside = !rounded || (() => {
    const r = 0.22;
    const dx = Math.max(0, Math.abs(u - 0.5) - (0.5 - r));
    const dy = Math.max(0, Math.abs(v - 0.5) - (0.5 - r));
    return dx * dx + dy * dy <= r * r;
  })();
  if (!inside) return [0, 0, 0, 0];
  const base = bg ? [...TOP.map((c, i) => Math.round(c + (BOTTOM[i] - c) * v)), 1] : [0, 0, 0, 0];
  // 雷達中心在左下
  const cx = 0.34, cy = 0.68;
  const dx = u - cx, dy = v - cy;
  const d = Math.hypot(dx, dy);
  const ang = Math.atan2(-dy, dx); // 0 = 右，π/2 = 上
  if (d < 0.075) return WHITE;
  const inArc = ang > -0.15 && ang < Math.PI / 2 + 0.15;
  for (const [r, w] of [[0.2, 0.055], [0.33, 0.055], [0.46, 0.055]]) {
    if (inArc && Math.abs(d - r) < w / 2) return WHITE;
  }
  // 右上角小亮點（新活動）
  if (Math.hypot(u - 0.74, v - 0.27) < 0.075) return [255, 226, 120, 1];
  return base;
}

writeFileSync(join(OUT, 'icon-192.png'), png(192, (u, v) => radar(u, v)));
writeFileSync(join(OUT, 'icon-512.png'), png(512, (u, v) => radar(u, v, { rounded: false })));
writeFileSync(join(OUT, 'apple-touch-icon.png'), png(180, (u, v) => radar(u, v, { rounded: false })));
// Android 通知列的小圖示：只要白色形狀、透明背景
writeFileSync(join(OUT, 'badge-96.png'), png(96, (u, v) => radar(u, v, { rounded: false, bg: false })));
console.log('icons written to', OUT);
