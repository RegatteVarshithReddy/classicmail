'use strict';
/**
 * Read-only calendar feeds (ICS). Works with Google's "secret address in iCal
 * format", Outlook/Microsoft 365 "published calendar" links, and local .ics
 * files. Feeds are parsed with ical.js; recurring events (including EXDATEs
 * and edited occurrences) and VTIMEZONE data are handled.
 */
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const ICALmod = require('ical.js');
const ICAL = ICALmod.default && ICALmod.default.Component ? ICALmod.default : ICALmod;

const MAX_FEED_BYTES = 25 * 1024 * 1024;
// Counts iterations of a recurrence rule, not visible occurrences: a daily event that started in 2010 needs ~6000
// steps before it reaches today, an hourly one ~150000. Occurrences before the window are skipped cheaply.
const MAX_ITERATIONS_PER_EVENT = 400000;
const EXPAND_TIMEOUT_MS = 8000;
const DAY = 24 * 3600 * 1000;

// Outlook feeds sometimes use Windows zone names without a matching VTIMEZONE.
const WINDOWS_TO_IANA = {
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'UTC': 'UTC'
};

const MEETING_LINK = /https:\/\/(?:teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"')]+|[\w-]+\.zoom\.us\/j\/[^\s<>"')]+|zoom\.us\/j\/[^\s<>"')]+|meet\.google\.com\/[a-z0-9-]+|[\w-]+\.webex\.com\/[^\s<>"')]+)/i;

function pad(n) { return String(n).padStart(2, '0'); }

/** Convert a wall-clock time in an IANA zone to a UTC instant (used as a fallback). */
function zonedToUtc(y, mo, d, h, mi, s, zone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map(p => [p.type, p.value]));
    const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return guess - (asIfUtc - guess);
  } catch (_) {
    return guess;
  }
}

/** IANA name for a TZID that has no VTIMEZONE in the feed (Windows names and plain IANA names), or ''. */
function zoneName(tzid) {
  const name = WINDOWS_TO_IANA[tzid] || String(tzid || '').replace(/^\//, '');
  if (!name) return '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: name }); return name; } catch (_) { return ''; }
}

/**
 * Instant for an ical.js time. `tzid` is the TZID parameter of the property the time came from: when the feed
 * ships no VTIMEZONE for it, ical.js treats the time as floating (machine-local), so we resolve the zone
 * ourselves, per occurrence, which keeps daylight-saving changes right.
 */
function timeToMs(t, tzid) {
  if (t.isDate) return new Date(t.year, t.month - 1, t.day).getTime(); // all-day: local midnight
  const known = t.zone && t.zone.component;
  if (!known && tzid && !/^utc$/i.test(tzid)) {
    const zone = zoneName(tzid);
    if (zone) return zonedToUtc(t.year, t.month, t.day, t.hour, t.minute, t.second, zone);
  }
  return t.toJSDate().getTime();
}

function tzidOf(ev, prop) {
  const p = ev.component.getFirstProperty(prop);
  return p ? p.getParameter('tzid') || '' : '';
}

function dayString(t) {
  return `${t.year}-${pad(t.month)}-${pad(t.day)}`;
}

function clip(s, n) {
  const v = String(s || '').replace(/\r/g, '').trim();
  return v.length > n ? `${v.slice(0, n)}…` : v;
}

function meetingUrl(...texts) {
  for (const t of texts) {
    const m = t && MEETING_LINK.exec(String(t));
    if (m) return m[0];
  }
  return '';
}

/**
 * Expand a feed's text into concrete occurrences overlapping [fromMs, toMs].
 * Synchronous on purpose: ical.js keeps timezone definitions in a global
 * registry, so a feed must be fully processed before another one is parsed.
 */
function expandFeed(text, cal, fromMs, toMs, opts = {}) {
  const skip = opts.skip || new Set();
  const jcal = ICAL.parse(text);
  const root = new ICAL.Component(jcal);
  ICAL.TimezoneService.reset();
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try { ICAL.TimezoneService.register(tz); } catch (_) { /* unusable zone: fall back later */ }
  }
  const mains = new Map();
  const exceptions = [];
  const singles = [];
  let anonymous = 0;
  for (const ve of root.getAllSubcomponents('vevent')) {
    let ev;
    try { ev = new ICAL.Event(ve); } catch (_) { continue; }
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else if (ev.isRecurring()) mains.set(ev.uid || `no-uid-${anonymous++}`, ev); // a missing UID must not overwrite another event
    else singles.push(ev);
  }
  const out = [];
  const push = (ev, start, end, recurrenceKey) => {
    const status = String(ev.component.getFirstPropertyValue('status') || '').toUpperCase();
    if (status === 'CANCELLED') return;
    const startZone = tzidOf(ev, 'dtstart');
    const s = timeToMs(start, startZone);
    let e = timeToMs(end || start, tzidOf(ev, 'dtend') || startZone);
    if (start.isDate) {
      if (e <= s) e = s + DAY;
    } else if (e < s) e = s;
    if (e < fromMs || s > toMs) return;
    const transp = String(ev.component.getFirstPropertyValue('transp') || '').toUpperCase();
    const description = ev.description || '';
    const location = ev.location || '';
    const urlProp = ev.component.getFirstPropertyValue('url') || '';
    out.push({
      id: `${cal.id}|${ev.uid}|${recurrenceKey || s}`,
      calendarId: cal.id,
      uid: ev.uid,
      title: clip(ev.summary, 300) || '(no title)',
      location: clip(location, 300),
      description: clip(description, 1500),
      allDay: Boolean(start.isDate),
      start: new Date(s).toISOString(),
      end: new Date(e).toISOString(),
      startDay: start.isDate ? dayString(start) : undefined,
      endDay: start.isDate && end ? dayString(end) : undefined,
      busy: transp !== 'TRANSPARENT',
      status: status || 'CONFIRMED',
      recurring: Boolean(recurrenceKey),
      organizer: clip(String(ev.component.getFirstPropertyValue('organizer') || '').replace(/^mailto:/i, ''), 200),
      meetingUrl: meetingUrl(urlProp, location, description)
    });
  };

  for (const ev of singles) {
    try { push(ev, ev.startDate, ev.endDate); } catch (_) { /* skip malformed event */ }
  }
  for (const ex of exceptions) {
    const main = mains.get(ex.uid);
    if (main) { try { main.relateException(ex); } catch (_) { /* ignore */ } } else {
      try { push(ex, ex.startDate, ex.endDate); } catch (_) { /* ignore */ }
    }
  }
  for (const [key, ev] of mains) {
    if (skip.has(key)) continue;
    if (opts.onStart) opts.onStart(key);
    let it;
    try { it = ev.iterator(); } catch (_) { continue; }
    let durationMs = 0;
    try { durationMs = Math.max(0, ev.duration.toSeconds() * 1000); } catch (_) { /* no duration */ }
    let next;
    let n = 0;
    while ((next = it.next())) {
      if (++n > MAX_ITERATIONS_PER_EVENT) break;
      // Cheap test first (accurate to a day or so): occurrences far before the window are not worth expanding.
      const rough = Date.UTC(next.year, next.month - 1, next.day);
      if (rough + durationMs + 3 * DAY < fromMs) continue;
      let d;
      try { d = ev.getOccurrenceDetails(next); } catch (_) { continue; }
      const s = timeToMs(d.startDate, tzidOf(d.item, 'dtstart'));
      if (s > toMs + 14 * DAY) break; // iterator is chronological; allow slack for moved occurrences
      try { push(d.item, d.startDate, d.endDate, d.recurrenceId ? d.recurrenceId.toString() : String(s)); } catch (_) { /* ignore */ }
    }
  }
  out.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  return out;
}

class CalendarService {
  constructor(store, options = {}) {
    this.store = store;
    this.fetchImpl = options.fetchImpl || ((...a) => fetch(...a));
    this.ttlMs = options.ttlMs || 15 * 60 * 1000;
    this.expandTimeoutMs = options.expandTimeoutMs || EXPAND_TIMEOUT_MS;
    this.inProcess = Boolean(options.inProcess); // tests only: skip the worker
    this.now = options.now || Date.now;
    this.feeds = new Map(); // calendarId -> {text, fetchedAt, error, window:{from,to}, events}
  }

  async _loadText(cal) {
    if (cal.type === 'file') {
      let text;
      try {
        const stat = await fs.promises.stat(cal.path);
        if (stat.size > MAX_FEED_BYTES) throw new Error('That calendar file is too large.');
        text = await fs.promises.readFile(cal.path, 'utf8');
      } catch (err) {
        if (err && err.code === 'ENOENT') throw new Error('That calendar file could not be found. It may have been moved or deleted.');
        if (err && (err.code === 'EACCES' || err.code === 'EPERM')) throw new Error('ClassicMail is not allowed to read that calendar file.');
        if (err && err.code === 'EISDIR') throw new Error('That is a folder, not a calendar (.ics) file.');
        throw err;
      }
      if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That file is not a calendar (.ics) file.');
      return text;
    }
    const url = cal.url.replace(/^webcal:\/\//i, 'https://');
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(25000), headers: { Accept: 'text/calendar, text/plain, */*', 'User-Agent': 'ClassicMail/0.1' } });
    if (!res.ok) throw new Error(`The calendar server answered ${res.status}. The link may have expired or been turned off.`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_FEED_BYTES) throw new Error('That calendar feed is too large.');
    const text = await res.text();
    if (text.length > MAX_FEED_BYTES) throw new Error('That calendar feed is too large.');
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That link did not return a calendar (.ics) file.');
    return text;
  }

  async refresh(cal) {
    const rec = this.feeds.get(cal.id) || {};
    try {
      rec.text = await this._loadText(cal);
      rec.fetchedAt = this.now();
      rec.error = null;
      rec.window = null;
      rec.events = null;
    } catch (err) {
      rec.error = err.name === 'TimeoutError' ? 'The calendar server took too long to respond.' : (err.message || String(err));
      if (!rec.text) rec.events = [];
    }
    this.feeds.set(cal.id, rec);
    return rec;
  }

  /**
   * Expansion runs in a worker thread with a time limit: ical.js can spin forever on a recurrence rule that
   * never matches (for example BYMONTH=2;BYMONTHDAY=30), and that must never freeze the app. When a rule
   * hangs, the worker is stopped, that one event is left out, and the rest of the calendar is shown.
   */
  _runWorker(text, cal, from, to, skip) {
    return new Promise((resolve) => {
      let worker;
      let lastStart = null;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (worker) worker.terminate().catch(() => {});
        resolve(result);
      };
      const timer = setTimeout(() => finish({ stuck: lastStart, timedOut: true }), this.expandTimeoutMs);
      try {
        worker = new Worker(path.join(__dirname, 'calendar-worker.js'), { workerData: { text, cal, from, to, skip: [...skip] } });
      } catch (err) {
        clearTimeout(timer);
        settled = true;
        resolve({ unavailable: err });
        return;
      }
      worker.on('message', (m) => {
        if (m.type === 'start') lastStart = m.key;
        else if (m.type === 'done') finish({ events: m.events });
        else if (m.type === 'error') finish({ error: m.message });
      });
      worker.on('error', (err) => finish({ error: err && err.message ? err.message : String(err) }));
      worker.on('exit', () => finish({ error: 'The calendar reader stopped unexpectedly.' }));
    });
  }

  async _expand(text, cal, from, to) {
    if (this.inProcess) return { events: expandFeed(text, cal, from, to), skipped: [] };
    const skip = new Set();
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await this._runWorker(text, cal, from, to, skip);
      if (r.events) return { events: r.events, skipped: [...skip] };
      if (r.unavailable) return { events: expandFeed(text, cal, from, to), skipped: [] }; // no worker support: best effort
      if (r.error) throw new Error(r.error);
      if (r.stuck == null) throw new Error('reading it took too long');
      skip.add(r.stuck); // leave out the event that never finished and try again
    }
    throw new Error('too many of its recurring events could not be read');
  }

  async _expandIfNeeded(cal, rec, fromMs, toMs) {
    if (!rec.text) return [];
    const w = rec.window;
    if (!rec.events || !w || fromMs < w.from || toMs > w.to) {
      const from = Math.min(fromMs, this.now() - 400 * DAY);
      const to = Math.max(toMs, this.now() + 800 * DAY);
      try {
        const { events, skipped } = await this._expand(rec.text, cal, from, to);
        rec.events = events;
        rec.window = { from, to };
        if (rec.error && /parse|could not be read/i.test(rec.error)) rec.error = null;
        if (skipped.length) rec.error = `${skipped.length === 1 ? 'One recurring event' : `${skipped.length} recurring events`} in this calendar could not be read and ${skipped.length === 1 ? 'is' : 'are'} not shown.`;
      } catch (err) {
        rec.events = [];
        rec.window = { from, to };
        rec.error = `This calendar could not be read (${err.message || 'parse error'}).`;
      }
    }
    return rec.events;
  }

  /** Events overlapping [start, end) from all enabled calendars. */
  async getEvents(startISO, endISO, { force = false } = {}) {
    const fromMs = new Date(startISO).getTime();
    const toMs = new Date(endISO).getTime();
    if (!(fromMs < toMs)) throw new Error('Invalid date range');
    const cals = this.store.listCalendars();
    const events = [];
    const status = [];
    await Promise.all(cals.filter(c => c.enabled).map(async (cal) => {
      let rec = this.feeds.get(cal.id);
      if (force || !rec || (!rec.text && !rec.error) || this.now() - (rec.fetchedAt || 0) > this.ttlMs) {
        rec = await this.refresh(cal);
      }
    }));
    for (const cal of cals.filter(c => c.enabled)) {
      const rec = this.feeds.get(cal.id);
      if (!rec) continue;
      for (const ev of await this._expandIfNeeded(cal, rec, fromMs, toMs)) {
        if (new Date(ev.end).getTime() >= fromMs && new Date(ev.start).getTime() < toMs) {
          events.push({ ...ev, color: cal.color, calendarName: cal.name });
        }
      }
      status.push({ calendarId: cal.id, error: rec.error || null, fetchedAt: rec.fetchedAt || null });
    }
    events.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    return { events, status };
  }

  /** Validate a calendar link/file before saving it. */
  async check(cal) {
    const text = await this._loadText(cal);
    let root;
    try {
      root = new ICAL.Component(ICAL.parse(text));
    } catch (_) {
      throw new Error('This calendar is damaged or in a format ClassicMail cannot read.');
    }
    const name = root.getFirstPropertyValue('x-wr-calname') || '';
    return { ok: true, name: String(name), events: root.getAllSubcomponents('vevent').length };
  }

  forget(calendarId) {
    this.feeds.delete(calendarId);
  }
}

module.exports = { CalendarService, expandFeed };
