import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManualText } from '../server/parse.js';
import { parseDateTime, makeTime, isTaoyuan, findDistrict } from '../scraper/util.js';
import { babycareTitle, regFromTitle, parseCcmsRegDates } from '../scraper/sources/taoyuan.js';
import { dedupe, keepCurrent } from '../scraper/run.js';

const NOW = new Date('2026-10-25T06:36:00Z'); // 台北 14:36

test('FB 貼文：截止時間、公布時間、標題', () => {
  const r = parseManualText('📣 【重要提醒｜報名今天截止囉！】\n「貢寮鮑食魚教育親子體驗活動」報名即將截止！\n報名截止時間：今天（10/25）晚上 23:59！\n10/28（三）19:00 公布錄取及候補名單！', NOW);
  assert.equal(r.title, '貢寮鮑食魚教育親子體驗活動');
  assert.equal(r.regEnd, '2026-10-25T23:59:00+08:00');
  assert.equal(r.announce, '2026-10-28T19:00:00+08:00');
});

test('活動時間、報名時間、地點、連結', () => {
  const r = parseManualText('2026桃園閱讀節講座《當地球人遇見小王子》\n活動時間：2026年11月29日(日) 下午2點\n報名時間：11月15日上午10:00開始報名\n地點：桃園市立圖書館總館 https://example.com/x', NOW);
  assert.equal(r.start, '2026-11-29T14:00:00+08:00');
  assert.equal(r.regStart, '2026-11-15T10:00:00+08:00');
  assert.equal(r.venue, '桃園市立圖書館總館');
  assert.equal(r.url, 'https://example.com/x');
});

test('時間區間、不把「3/4位」「1-2歲」當日期', () => {
  const r = parseManualText('親子手作 12/6（六）14:00-16:00 名額20位 1-2歲 3/4位', NOW);
  assert.equal(r.start, '2026-12-06T14:00:00+08:00');
  assert.equal(r.end, '2026-12-06T16:00:00+08:00');
});

test('民國年報名期間 A ~ B', () => {
  const r = parseManualText('研習班開放報名 - 115-01-19 09:00 ~ 115-02-13 17:00', new Date('2026-01-10T00:00:00Z'));
  assert.equal(r.regStart, '2026-01-19T09:00:00+08:00');
  assert.equal(r.regEnd, '2026-02-13T17:00:00+08:00');
});

test('日期工具', () => {
  assert.equal(parseDateTime('115.11.28 (六) 14:30'), '2026-11-28T14:30:00+08:00');
  assert.equal(parseDateTime('2026/11/01 14:00(+0800)'), '2026-11-01T14:00:00+08:00');
  assert.equal(parseDateTime('2026.11.29 (Sun) 14:00'), '2026-11-29T14:00:00+08:00');
  assert.equal(makeTime(115, 1, 5), '2026-01-05');
  assert.equal(isTaoyuan('臺北市中正區'), false);
  assert.equal(isTaoyuan('龍潭區（桃園市）='), true);
  assert.equal(findDistrict('桃園市中壢區中美路16號'), '中壢區');
  assert.equal(findDistrict('桃園市桃園區縣府路1號'), '桃園區');
});

test('親子館標題整理', () => {
  assert.equal(babycareTitle('【親職講座】擁抱情緒小怪獸- 給幼兒的情緒教育'), '擁抱情緒小怪獸- 給幼兒的情緒教育');
  assert.equal(babycareTitle('【2歲~學齡前 11月迷你劇場-阿嬤的笑咪咪餅】※請於活動前15分鐘入場※'), '2歲~學齡前 11月迷你劇場-阿嬤的笑咪咪餅');
  assert.equal(babycareTitle('親子共讀1-2歲【請於活動開始前15分鐘報到】'), '親子共讀1-2歲');
});

test('市府線上報名：標題讀開放日、內頁讀報名日期', () => {
  assert.deepEqual(regFromTitle('116年1月初級四縣開班 (12月5日開放報名)', '2027-01-06T19:00:00+08:00'), { regStart: '2026-12-05', regEnd: null });
  assert.deepEqual(parseCcmsRegDates('<body><p>報名日期：115-11-05~115-11-30</p></body>'), { regStart: '2026-11-05', regEnd: '2026-11-30' });
});

test('去重複：不同來源同名同日合併，同來源不同場次保留', () => {
  const a = { id: 'a:1', source: 'a', sourceName: 'A', title: '2026 桃園燈會', start: '2026-02-25' };
  const b = { id: 'b:1', source: 'b', sourceName: 'B', title: '桃園燈會', start: '2026-02-25T18:00:00+08:00', image: 'x.jpg' };
  const c1 = { id: 'c:1', source: 'c', sourceName: 'C', title: '故事', start: '2026-02-25T10:00:00+08:00' };
  const c2 = { id: 'c:2', source: 'c', sourceName: 'C', title: '故事', start: '2026-02-25T14:00:00+08:00' };
  const out = dedupe([a, b, c1, c2]);
  assert.equal(out.length, 3);
  assert.equal(out[0].image, 'x.jpg');
  assert.deepEqual(out[0].alsoIn, ['B']);
});

test('過濾已結束活動', () => {
  const now = Date.parse('2026-11-23T12:00:00+08:00');
  const list = keepCurrent([
    { title: '昨天', start: '2026-11-22' },
    { title: '今天', start: '2026-11-23T09:00:00+08:00' },
    { title: '進行中', start: '2026-10-01', end: '2026-12-31' },
  ], now);
  assert.deepEqual(list.map((e) => e.title), ['今天', '進行中']);
});
