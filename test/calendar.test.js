'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Store } = require('../electron/services/store');
const { CalendarService } = require('../electron/services/calendar');
const { tempDir, dummySecrets } = require('./helpers');

const SAMPLE_PATH = path.join(__dirname, 'fixtures', 'sample.ics');
const SAMPLE = fs.readFileSync(SAMPLE_PATH, 'utf8');
// Week of Mon 28 Sep 2026 to Mon 5 Oct 2026 (UTC bounds are generous; assertions use exact instants).
const WEEK = ['2026-09-27T00:00:00Z', '2026-10-05T00:00:00Z'];

function fakeResponse({ status = 200, body = '', headers = {} } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: k => headers[k.toLowerCase()] || null }, text: async () => body };
}

function setup(fetchImpl, extra = {}) {
  const store = new Store(tempDir(), dummySecrets);
  const clock = { t: Date.parse('2026-09-26T12:00:00Z') };
  const svc = new CalendarService(store, { fetchImpl, now: () => clock.t, ...extra });
  return { store, svc, clock };
}

const titles = events => events.map(e => e.title);

test('file calendar: recurrence, EXDATE, moved instance, all-day, UTC and timezone conversion', async () => {
  const { store, svc } = setup(async () => { throw new Error('no network expected'); });
  store.saveCalendar({ type: 'file', path: SAMPLE_PATH, name: 'Work' });
  const { events, status } = await svc.getEvents(...WEEK);
  assert.equal(status[0].error, null);

  const standups = events.filter(e => /Standup/.test(e.title));
  // Mon 28 09:00 EDT, Tue 29 moved to 10:00 EDT, Wed 30 removed by EXDATE, Thu 1 Oct 09:00 EDT.
  assert.deepEqual(standups.map(e => e.start), [
    '2026-09-28T13:00:00.000Z',
    '2026-09-29T14:00:00.000Z',
    '2026-10-01T13:00:00.000Z'
  ]);
  assert.equal(standups[1].title, 'Daily Standup (moved)');
  assert.equal(standups[0].recurring, true);
  assert.match(standups[0].meetingUrl, /^https:\/\/teams\.microsoft\.com\//);

  const utc = events.find(e => e.title === 'UTC call');
  assert.equal(utc.start, '2026-09-30T13:00:00.000Z');
  assert.equal(utc.end, '2026-09-30T14:00:00.000Z');

  const lunch = events.find(e => e.title === 'Team Lunch');
  assert.equal(lunch.start, '2026-10-02T16:00:00.000Z'); // 12:00 EDT
  assert.equal(lunch.location, 'HQ Tahoe');

  assert.ok(!titles(events).includes('Cancelled thing'), 'cancelled events must not be shown');
});

test('file calendar: all-day events keep their calendar day and are free, not busy', async () => {
  const { store, svc } = setup(async () => { throw new Error('no network expected'); });
  store.saveCalendar({ type: 'file', path: SAMPLE_PATH, name: 'Work' });
  const { events } = await svc.getEvents('2026-10-11T00:00:00Z', '2026-10-14T00:00:00Z');
  const closed = events.find(e => e.title === 'Office closed');
  assert.ok(closed);
  assert.equal(closed.allDay, true);
  assert.equal(closed.startDay, '2026-10-12');
  assert.equal(closed.busy, false);
});

test('url calendar: webcal:// is fetched over https, cached for the TTL, and refreshed after it', async () => {
  const urls = [];
  const { store, svc, clock } = setup(async (url) => { urls.push(url); return fakeResponse({ body: SAMPLE }); });
  store.saveCalendar({ type: 'url', url: 'webcal://calendar.example.com/feed.ics', name: 'Remote' });
  await svc.getEvents(...WEEK);
  await svc.getEvents(...WEEK);
  assert.equal(urls.length, 1, 'second call within the TTL must use the cache');
  assert.equal(urls[0], 'https://calendar.example.com/feed.ics');

  clock.t += 16 * 60 * 1000;
  await svc.getEvents(...WEEK);
  assert.equal(urls.length, 2, 'stale feed is fetched again');

  await svc.getEvents(...WEEK, { force: true });
  assert.equal(urls.length, 3, 'force bypasses the cache');
});

test('url calendar: HTTP errors are reported per calendar, not thrown', async () => {
  const { store, svc } = setup(async () => fakeResponse({ status: 404 }));
  const cal = store.saveCalendar({ type: 'url', url: 'https://calendar.example.com/gone.ics', name: 'Gone' });
  const { events, status } = await svc.getEvents(...WEEK);
  assert.deepEqual(events, []);
  assert.equal(status.length, 1);
  assert.equal(status[0].calendarId, cal.id);
  assert.match(status[0].error, /404/);
});

test('url calendar: a page that is not a calendar is rejected with a clear message', async () => {
  const { store, svc } = setup(async () => fakeResponse({ body: '<html><body>Please sign in</body></html>' }));
  store.saveCalendar({ type: 'url', url: 'https://calendar.example.com/login', name: 'Login page' });
  const { events, status } = await svc.getEvents(...WEEK);
  assert.deepEqual(events, []);
  assert.match(status[0].error, /did not return a calendar/);
});

test('url calendar: oversized feeds are refused', async () => {
  const { store, svc } = setup(async () => fakeResponse({ body: 'BEGIN:VCALENDAR', headers: { 'content-length': String(50 * 1024 * 1024) } }));
  store.saveCalendar({ type: 'url', url: 'https://calendar.example.com/huge.ics', name: 'Huge' });
  const { status } = await svc.getEvents(...WEEK);
  assert.match(status[0].error, /too large/);
});

test('url calendar: a failed refresh keeps showing the last good copy and reports the error', async () => {
  let fail = false;
  const { store, svc, clock } = setup(async () => (fail ? fakeResponse({ status: 503 }) : fakeResponse({ body: SAMPLE })));
  store.saveCalendar({ type: 'url', url: 'https://calendar.example.com/feed.ics', name: 'Flaky' });
  const first = await svc.getEvents(...WEEK);
  assert.ok(first.events.length > 0);

  fail = true;
  clock.t += 20 * 60 * 1000;
  const second = await svc.getEvents(...WEEK);
  assert.equal(second.events.length, first.events.length, 'stale events stay visible');
  assert.match(second.status[0].error, /503/);
});

test('network failures and timeouts become readable messages', async () => {
  const { store, svc } = setup(async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; });
  store.saveCalendar({ type: 'url', url: 'https://calendar.example.com/slow.ics', name: 'Slow' });
  const { status } = await svc.getEvents(...WEEK);
  assert.match(status[0].error, /took too long/);
});

test('one broken calendar does not hide the others; disabled calendars are skipped', async () => {
  const { store, svc } = setup(async () => fakeResponse({ status: 500 }));
  store.saveCalendar({ type: 'file', path: SAMPLE_PATH, name: 'Work' });
  store.saveCalendar({ type: 'url', url: 'https://calendar.example.com/bad.ics', name: 'Bad' });
  store.saveCalendar({ type: 'file', path: path.join(__dirname, 'fixtures', 'does-not-exist.ics'), name: 'Missing file', enabled: false });
  const { events, status } = await svc.getEvents(...WEEK);
  assert.ok(events.some(e => e.title === 'Team Lunch'));
  assert.equal(status.length, 2, 'the disabled calendar is not loaded at all');
  assert.equal(status.filter(s => s.error).length, 1);
});

test('events carry their calendar colour and name', async () => {
  const { store, svc } = setup(async () => { throw new Error('unused'); });
  const cal = store.saveCalendar({ type: 'file', path: SAMPLE_PATH, name: 'Work' });
  const { events } = await svc.getEvents(...WEEK);
  assert.ok(events.length);
  for (const e of events) {
    assert.equal(e.color, cal.color);
    assert.equal(e.calendarName, 'Work');
  }
});

test('check(): reports the calendar name and event count, rejects junk', async () => {
  const { svc } = setup(async () => { throw new Error('unused'); });
  const ok = await svc.check({ type: 'file', path: SAMPLE_PATH });
  assert.equal(ok.ok, true);
  assert.equal(ok.name, 'Work');
  assert.equal(ok.events, 6);

  const junk = path.join(tempDir(), 'junk.ics');
  fs.writeFileSync(junk, 'this is not a calendar');
  await assert.rejects(() => svc.check({ type: 'file', path: junk }), /^Error: That file is not a calendar \(\.ics\) file\.$/);
  await assert.rejects(() => svc.check({ type: 'file', path: path.join(tempDir(), 'missing.ics') }), /could not be found/);
  const broken = path.join(tempDir(), 'broken.ics');
  fs.writeFileSync(broken, 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nthis line has no colon\nEND:VCALENDAR\n');
  await assert.rejects(() => svc.check({ type: 'file', path: broken }), /damaged or in a format/);
});

test('a calendar file that disappears is reported per calendar with a readable message', async () => {
  const { store, svc } = setup(async () => { throw new Error('unused'); });
  store.saveCalendar({ type: 'file', path: path.join(tempDir(), 'moved.ics'), name: 'Moved' });
  const { events, status } = await svc.getEvents(...WEEK);
  assert.deepEqual(events, []);
  assert.match(status[0].error, /could not be found/);
  assert.doesNotMatch(status[0].error, /ENOENT/);
});

test('getEvents rejects an invalid range', async () => {
  const { svc } = setup(async () => { throw new Error('unused'); });
  await assert.rejects(() => svc.getEvents('2026-10-05T00:00:00Z', '2026-10-01T00:00:00Z'), /Invalid date range/);
  await assert.rejects(() => svc.getEvents('nonsense', '2026-10-01T00:00:00Z'), /Invalid date range/);
});

// ---- regressions found in review --------------------------------------------------------------

function ics(...events) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
}
const vevent = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
function feed(body) { return async () => fakeResponse({ body }); }
async function eventsFor(body, range = WEEK, extra = {}) {
  const { store, svc } = setup(feed(body), extra);
  store.saveCalendar({ type: 'url', url: 'https://cal.example.com/x.ics', name: 'T' });
  return svc.getEvents(...range);
}

test('a rule that can never match cannot freeze the app; the rest of the calendar is still shown', async () => {
  const body = ics(
    vevent('UID:good-1', 'SUMMARY:Ordinary meeting', 'DTSTART:20260929T140000Z', 'DTEND:20260929T150000Z'),
    vevent('UID:evil-1', 'SUMMARY:Never happens', 'DTSTART:20260101T100000Z', 'DTEND:20260101T110000Z', 'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30'),
    vevent('UID:good-2', 'SUMMARY:Daily check-in', 'DTSTART:20260901T090000Z', 'DTEND:20260901T093000Z', 'RRULE:FREQ=DAILY')
  );
  const started = Date.now();
  const { events, status } = await eventsFor(body, WEEK, { expandTimeoutMs: 1500 });
  assert.ok(Date.now() - started < 12000, 'must give up in bounded time');
  assert.ok(titles(events).includes('Ordinary meeting'));
  assert.ok(events.filter(e => e.title === 'Daily check-in').length >= 7, 'events after the broken one survive');
  assert.ok(!titles(events).includes('Never happens'));
  assert.match(status[0].error, /One recurring event .* could not be read/);
});

test('old recurring events still show: a daily event since 2010 and an hourly one since January', async () => {
  const body = ics(
    vevent('UID:old-daily', 'SUMMARY:Since 2010', 'DTSTART:20100104T080000Z', 'DTEND:20100104T083000Z', 'RRULE:FREQ=DAILY'),
    vevent('UID:hourly', 'SUMMARY:Hourly ping', 'DTSTART:20260101T000000Z', 'DTEND:20260101T001500Z', 'RRULE:FREQ=HOURLY')
  );
  const started = Date.now();
  const { events, status } = await eventsFor(body);
  assert.equal(status[0].error, null);
  assert.equal(events.filter(e => e.title === 'Since 2010').length, 8, 'one per day across the 8-day window');
  assert.ok(events.filter(e => e.title === 'Hourly ping').length >= 190);
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
});

test('a TZID without a VTIMEZONE (IANA or Windows name) is converted correctly, including daylight saving', async () => {
  const body = ics(
    vevent('UID:iana', 'SUMMARY:IANA zone', 'DTSTART;TZID=America/New_York:20260929T090000', 'DTEND;TZID=America/New_York:20260929T100000'),
    vevent('UID:win', 'SUMMARY:Windows zone', 'DTSTART;TZID=Pacific Standard Time:20260929T090000', 'DTEND;TZID=Pacific Standard Time:20260929T100000'),
    vevent('UID:weekly', 'SUMMARY:Weekly London', 'DTSTART;TZID=Europe/London:20260928T100000', 'DTEND;TZID=Europe/London:20260928T110000', 'RRULE:FREQ=WEEKLY;COUNT=8')
  );
  // Independent of the machine's own time zone.
  for (const tz of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles']) {
    const prev = process.env.TZ; process.env.TZ = tz;
    try {
      const { events } = await eventsFor(body, ['2026-09-27T00:00:00Z', '2026-11-10T00:00:00Z'], { inProcess: true });
      const by = (t) => events.filter(e => e.title === t);
      assert.equal(by('IANA zone')[0].start, '2026-09-29T13:00:00.000Z', `EDT in ${tz}`);
      assert.equal(by('Windows zone')[0].start, '2026-09-29T16:00:00.000Z', `PDT in ${tz}`);
      const weekly = by('Weekly London').map(e => e.start);
      assert.equal(weekly[0], '2026-09-28T09:00:00.000Z', 'BST is UTC+1');
      assert.equal(weekly[5], '2026-11-02T10:00:00.000Z', 'after the clocks go back it is UTC+0 (10:00 local stays 10:00 local)');
    } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
  }
});

test('recurring events that have no UID do not overwrite each other', async () => {
  const body = ics(
    vevent('SUMMARY:First', 'DTSTART:20260929T090000Z', 'DTEND:20260929T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=2'),
    vevent('SUMMARY:Second', 'DTSTART:20260930T090000Z', 'DTEND:20260930T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=2')
  );
  const { events } = await eventsFor(body);
  assert.deepEqual(titles(events), ['First', 'Second']);
});
