// Cloudflare 版的通知規則（src/logic.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reminderJobs, dueJobs, matchesPrefs, newEventMessages, cleanPrefs, DEFAULT_PREFS } from '../src/logic.js';
import { buildIcs } from '../src/worker.js';

test('開放報名前 1 天、30 分、5 分、開放當下各一次', () => {
  const e = { id: 'w', title: '水の秘密基地', regStart: '2026-12-15T10:00:00+08:00', start: '2027-01-05T10:00:00+08:00' };
  const jobs = reminderJobs(e, DEFAULT_PREFS);
  const reg = Date.parse(e.regStart);
  // 和 Worker 一樣，用「已發送」紀錄避免重複
  const sent = new Set();
  const fired = [1440, 30, 5, 0].map((m) =>
    dueJobs(jobs, reg - m * 60000 + 30000)
      .filter((j) => !sent.has(j.key) && sent.add(j.key))
      .map((j) => j.payload.title),
  );
  assert.deepEqual(fired, [['⏰ 1 天後開放報名'], ['⏰ 30 分鐘後開放報名'], ['⏰ 5 分鐘後開放報名'], ['🔔 現在開放報名了！']]);
  assert.deepEqual(dueJobs(jobs, reg - 120 * 60000), [], '中間時段不發');
});

test('只有日期的開放報名、活動前一天 9 點', () => {
  const e = { id: 'h', title: '客語班', regStart: '2026-12-05', start: '2027-01-06T19:00:00+08:00' };
  const jobs = reminderJobs(e, DEFAULT_PREFS);
  assert.deepEqual(dueJobs(jobs, Date.parse('2026-12-04T20:05:00+08:00')).map((j) => j.key), ['regd-1']);
  assert.deepEqual(dueJobs(jobs, Date.parse('2026-12-05T08:05:00+08:00')).map((j) => j.key), ['regd0']);
  assert.deepEqual(dueJobs(jobs, Date.parse('2027-01-05T09:01:00+08:00')).map((j) => j.key), ['day-1']);
});

test('篩選與訊息合併', () => {
  const ev = { id: '1', title: '大溪市集', category: '節慶市集', categories: ['免費', '節慶市集'], city: '桃園市' };
  assert.equal(matchesPrefs(ev, { ...DEFAULT_PREFS, categories: ['免費'] }), true);
  assert.equal(matchesPrefs(ev, { ...DEFAULT_PREFS, cities: ['臺北市'] }), false);
  assert.equal(matchesPrefs({ ...ev, category: '親子館' }, DEFAULT_PREFS), false);
  assert.equal(newEventMessages([ev, ev, ev, ev]).length, 1);
  assert.match(newEventMessages([{ ...ev, free: true }])[0].title, /^免費・新活動/);
});

test('設定清理', () => {
  const p = cleanPrefs({ cities: ['桃園市', ' '], remindMinutes: [5, 5, 99999, 30], notifyNew: 'x' });
  assert.deepEqual(p.cities, ['桃園市']);
  assert.deepEqual(p.remindMinutes, [5, 30]);
  assert.equal(p.notifyNew, true);
});

test('行事曆檔', () => {
  const ics = buildIcs({ id: 'a:1', title: '音樂會; 好聽', start: '2026-12-01T19:30:00+08:00', end: '2026-12-01T21:00:00+08:00', regStart: '2026-11-25T12:00:00+08:00', venue: '中壢藝術館' }, 'reg');
  assert.match(ics, /SUMMARY:開放報名：音樂會\\; 好聽/);
  assert.match(ics, /DTSTART:20261125T040000Z/);
  assert.match(ics, /TRIGGER:-PT5M/);
});
