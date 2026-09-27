export const DAY_MS = 86400000;
export const pad = n => String(n).padStart(2, '0');
export const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
export const sameDay = (a, b) => dayKey(a) === dayKey(b);
export const startOfWeek = (d, weekStart = 0) => addDays(startOfDay(d), -((d.getDay() - weekStart + 7) % 7));
export const startOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);
export const parseDayKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };

/** The visible day range for a calendar mode, starting from an anchor date. */
export function rangeFor(mode, anchor, weekStart = 0) {
  if (mode === 'day') { const s = startOfDay(anchor); return { start: s, days: 1 }; }
  if (mode === 'workweek') { const s = addDays(startOfWeek(anchor, 1), 0); return { start: s, days: 5 }; }
  if (mode === 'week') { const s = startOfWeek(anchor, weekStart); return { start: s, days: 7 }; }
  const first = startOfMonth(anchor);
  const s = startOfWeek(first, weekStart);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const weeks = Math.ceil(((startOfDay(last) - s) / DAY_MS + 1) / 7);
  return { start: s, days: weeks * 7 };
}

export function stepAnchor(mode, anchor, dir) {
  if (mode === 'day') return addDays(anchor, dir);
  if (mode === 'month') return new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
  return addDays(anchor, 7 * dir);
}

export function rangeTitle(mode, anchor, range) {
  if (mode === 'month') return anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  if (mode === 'day') return anchor.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const end = addDays(range.start, range.days - 1);
  // formatRange knows the locale's own way of writing "21 – 25 September 2026".
  return new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' }).formatRange(range.start, end);
}

export const timeLabel = d => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
export const hourLabel = h => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });

/**
 * Events for one day column: the timed ones with lane positions, and the all-day ones.
 * All-day events use the calendar days the feed gave us (no time-zone shifting).
 */
export function layoutDay(events, date) {
  const key = dayKey(date);
  const dayStart = startOfDay(date).getTime();
  const dayEnd = dayStart + DAY_MS;
  const allDay = [];
  const timed = [];
  for (const ev of events) {
    if (ev.allDay) {
      const end = ev.endDay && ev.endDay > ev.startDay ? ev.endDay : dayKey(addDays(parseDayKey(ev.startDay), 1));
      if (ev.startDay <= key && key < end) allDay.push(ev);
      continue;
    }
    const s = new Date(ev.start).getTime();
    const e = Math.max(new Date(ev.end).getTime(), s + 15 * 60000);
    if (e <= dayStart || s >= dayEnd) continue;
    if (e - s >= DAY_MS) { allDay.push(ev); continue; }
    timed.push({ ev, top: Math.max(s, dayStart), bottom: Math.min(e, dayEnd) });
  }
  timed.sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  // Pack overlapping events into side-by-side lanes.
  let cluster = [];
  let clusterEnd = 0;
  const flush = () => {
    const lanes = [];
    for (const item of cluster) {
      let lane = lanes.findIndex(end => end <= item.top);
      if (lane === -1) { lane = lanes.length; lanes.push(0); }
      lanes[lane] = item.bottom;
      item.lane = lane;
    }
    for (const item of cluster) item.lanes = lanes.length;
    cluster = [];
  };
  for (const item of timed) {
    if (cluster.length && item.top >= clusterEnd) flush();
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.bottom);
  }
  flush();
  return { allDay, timed: timed.map(t => ({ ...t, startMin: (t.top - dayStart) / 60000, endMin: (t.bottom - dayStart) / 60000 })) };
}
