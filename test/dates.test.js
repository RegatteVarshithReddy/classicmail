'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

let D;
let F;
test.before(async () => {
  D = await import('../src/lib/dates.mjs');
  F = await import('../src/lib/format.mjs');
});

const d = (y, m, day, h = 0, min = 0) => new Date(y, m - 1, day, h, min);

test('rangeFor: work week starts Monday, week starts Sunday, month covers whole weeks', () => {
  const wed = d(2026, 9, 23);
  assert.equal(D.dayKey(D.rangeFor('workweek', wed).start), '2026-09-21');
  assert.equal(D.rangeFor('workweek', wed).days, 5);
  assert.equal(D.dayKey(D.rangeFor('week', wed).start), '2026-09-20');
  assert.equal(D.rangeFor('week', wed).days, 7);
  const sat = d(2026, 9, 26);
  assert.equal(D.dayKey(D.rangeFor('workweek', sat).start), '2026-09-21', 'a Saturday belongs to the week that just ended');
  const m = D.rangeFor('month', wed);
  assert.equal(m.days % 7, 0);
  assert.equal(D.dayKey(m.start), '2026-08-30');
  assert.equal(m.days, 35);
  assert.equal(D.rangeFor('day', wed).days, 1);
});

test('rangeTitle never prints the raw Intl fallback for day+year', () => {
  const wed = d(2026, 9, 23);
  const r = D.rangeFor('workweek', wed);
  const t = D.rangeTitle('workweek', wed, r);
  assert.match(t, /21/);
  assert.match(t, /25/);
  assert.match(t, /2026/);
  assert.doesNotMatch(t, /day:/);
  assert.match(D.rangeTitle('month', wed, D.rangeFor('month', wed)), /September 2026/);
});

test('stepAnchor moves by the visible unit', () => {
  const a = d(2026, 9, 23);
  assert.equal(D.dayKey(D.stepAnchor('day', a, 1)), '2026-09-24');
  assert.equal(D.dayKey(D.stepAnchor('week', a, -1)), '2026-09-16');
  assert.equal(D.dayKey(D.stepAnchor('month', a, 1)), '2026-10-01');
});

test('layoutDay: overlapping events share lanes, separate ones do not', () => {
  const day = d(2026, 10, 1);
  const ev = (id, sh, sm, eh, em) => ({ id, allDay: false, start: d(2026, 10, 1, sh, sm).toISOString(), end: d(2026, 10, 1, eh, em).toISOString() });
  const { timed, allDay } = D.layoutDay([
    ev('roadmap', 10, 0, 11, 30), ev('one2one', 10, 30, 11, 0), ev('call', 10, 45, 11, 45), ev('lunch', 12, 0, 13, 0)
  ], day);
  assert.equal(allDay.length, 0);
  const by = Object.fromEntries(timed.map(t => [t.ev.id, t]));
  assert.equal(by.roadmap.lanes, 3);
  assert.deepEqual([by.roadmap.lane, by.one2one.lane, by.call.lane].sort(), [0, 1, 2]);
  assert.equal(by.lunch.lanes, 1);
  assert.equal(by.lunch.lane, 0);
  assert.equal(by.lunch.startMin, 720);
  assert.equal(by.lunch.endMin, 780);
});

test('layoutDay: all-day events use calendar days (end exclusive), multi-day timed events become all-day', () => {
  const trip = { id: 'trip', allDay: true, startDay: '2026-10-01', endDay: '2026-10-03', start: '', end: '' };
  const oneDay = { id: 'closed', allDay: true, startDay: '2026-10-02', endDay: '2026-10-03', start: '', end: '' };
  const noEnd = { id: 'noend', allDay: true, startDay: '2026-10-02', start: '', end: '' };
  const long = { id: 'long', allDay: false, start: d(2026, 10, 1, 9).toISOString(), end: d(2026, 10, 3, 9).toISOString() };
  const ids = date => D.layoutDay([trip, oneDay, noEnd, long], date).allDay.map(e => e.id).sort();
  assert.deepEqual(ids(d(2026, 10, 1)), ['long', 'trip']);
  assert.deepEqual(ids(d(2026, 10, 2)), ['closed', 'long', 'noend', 'trip']);
  assert.deepEqual(ids(d(2026, 10, 3)), ['long'], 'exclusive end day is not covered');
});

test('layoutDay: an event running past midnight is clipped to the day', () => {
  const late = { id: 'late', allDay: false, start: d(2026, 10, 1, 22).toISOString(), end: d(2026, 10, 2, 1).toISOString() };
  const first = D.layoutDay([late], d(2026, 10, 1)).timed[0];
  const second = D.layoutDay([late], d(2026, 10, 2)).timed[0];
  assert.equal(first.endMin, 1440);
  assert.equal(second.startMin, 0);
  assert.equal(second.endMin, 60);
  assert.equal(D.layoutDay([late], d(2026, 10, 3)).timed.length, 0);
});

test('format helpers', () => {
  assert.equal(F.initials('Priya Nair'), 'PN');
  assert.equal(F.initials('alex@example.com'), 'A');
  assert.equal(F.formatSize(1843200), '1.8 MB');
  assert.equal(F.formatSize(2100), '2 KB');
  const now = new Date(2026, 8, 26, 12);
  assert.equal(F.dateGroup(new Date(2026, 8, 26, 1).toISOString(), now), 'Today');
  assert.equal(F.dateGroup(new Date(2026, 8, 25, 23).toISOString(), now), 'Yesterday');
  assert.equal(F.dateGroup(new Date(2026, 7, 1).toISOString(), now), 'Last Month');
  assert.equal(F.dateGroup(new Date(2026, 5, 1).toISOString(), now), 'Older');
  assert.deepEqual(F.parseAddressList('Rae <rae@example.org>, "Lee, Jo" <jo@example.org>; plain@example.org'), [
    { name: 'Rae', address: 'rae@example.org' }, { name: 'Lee, Jo', address: 'jo@example.org' }, { name: '', address: 'plain@example.org' }
  ]);
  assert.equal(F.parseAddressList('not an address')[0].invalid, true);
  assert.equal(F.escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});
