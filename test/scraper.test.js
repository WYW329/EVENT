import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDateTime, makeTime, isTaoyuan, findDistrict } from '../scraper/util.js';
import { babycareTitle, regFromTitle, parseCcmsRegDates } from '../scraper/sources/taoyuan.js';
import { dedupe, keepCurrent } from '../scraper/run.js';

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

test('類別、免費、縣市判斷', async () => {
  const { guessCategories, detectFree, findCity } = await import('../scraper/util.js');
  assert.deepEqual(guessCategories('畢業舞展《UNFOLD》'), ['表演']);
  assert.deepEqual(guessCategories('親子音樂劇場《聖誕危機》'), ['親子', '表演']);
  assert.equal(detectFree('索票入場'), true);
  assert.equal(detectFree('全票 300 元'), false);
  assert.equal(detectFree('現場提供免費停車'), null);
  assert.equal(findCity('台北市中正區'), '臺北市');
  assert.equal(findCity('桃園市中壢區'), '桃園市');
});

test('KKTIX 票種：開賣時間、免費', async () => {
  const { parseKktixTickets } = await import('../scraper/sources/platforms.js');
  const html = '<body>售價 11/01 放映 2026/10/25 09:00(+0800) ~ 2026/11/01 13:00(+0800) 結束販售 免費 11/07 放映 2026/10/26 09:00(+0800) ~ 2026/11/07 13:00(+0800) 販售中 免費</body>';
  assert.deepEqual(parseKktixTickets(html), { regStart: '2026-10-25T09:00:00+08:00', regEnd: '2026-11-07T13:00:00+08:00', free: true, prices: ['免費'] });
});

test('藝文中心內頁：索票＝免費、開放索票日', async () => {
  const { parseAfmcDetail } = await import('../scraper/sources/taoyuan.js');
  const d = parseAfmcDetail('<body>入場說明 入場方式 報名或索票 入場說明 1.索票進場 演出介紹 好聽的音樂。預計10/29開放索票連結 回列表</body>', '2026-11-26T19:30:00+08:00');
  assert.equal(d.free, true);
  assert.equal(d.regStart, '2026-10-29');
  const p = parseAfmcDetail('<body>入場方式 售票 入場說明 售票入場 OPENTIX $300、$500 入場相關連結 https://www.opentix.life/event/1 演出介紹 介紹 回列表</body>');
  assert.equal(p.free, false);
  assert.equal(p.ticketUrl, 'https://www.opentix.life/event/1');
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

test('雙北：行政區、縣市判斷', async () => {
  const { findDistrict, supportedCity, isTaipeiArea, cityOfDistrict } = await import('../scraper/util.js');
  assert.equal(findDistrict('新北市板橋區文化路一段'), '板橋區');
  assert.equal(findDistrict('臺中市大安區'), null); // 台中也有大安區
  assert.equal(findDistrict({ city: '臺北市' }, '大安區'), '大安區');
  assert.equal(findDistrict('桃園市中壢區'), '中壢區');
  assert.equal(supportedCity('台北市信義區松高路'), '臺北市');
  assert.equal(supportedCity('永和區中正路'), '新北市');
  assert.equal(supportedCity('台中市西屯區'), null);
  assert.equal(isTaipeiArea('桃園市中壢區'), false);
  assert.equal(cityOfDistrict('淡水區'), '新北市');
});
