import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../lib/icons.jsx';
import { addDays, dayKey, hourLabel, layoutDay, sameDay, timeLabel } from '../lib/dates.mjs';

const HOUR_PX = 48;
const PX_PER_MIN = HOUR_PX / 60;

function whenText(ev) {
  if (ev.allDay) {
    const s = new Date(`${ev.startDay}T00:00:00`);
    const endExclusive = ev.endDay ? new Date(`${ev.endDay}T00:00:00`) : addDays(s, 1);
    const last = addDays(endExclusive, -1);
    const fmt = d => d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    return last > s ? `${fmt(s)} – ${fmt(last)} (all day)` : `${fmt(s)} (all day)`;
  }
  const s = new Date(ev.start);
  const e = new Date(ev.end);
  const day = s.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  return `${day}, ${timeLabel(s)} – ${timeLabel(e)}`;
}

function Popover({ ev, anchor, onClose, onJoin }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: anchor.x, top: anchor.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(anchor.x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(anchor.y, window.innerHeight - r.height - 8)) });
  }, [anchor]);
  useEffect(() => {
    const down = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', key, true); };
  }, [onClose]);
  return (
    <div className="ev-pop" ref={ref} style={pos} role="dialog" aria-label={ev.title}>
      <div className="ev-pop-bar" style={{ background: ev.color }} />
      <div className="ev-pop-body">
        <div className="ev-pop-head"><h3>{ev.title}</h3><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" size={15} /></button></div>
        <div className="ev-pop-line"><Icon name="calendar" size={15} /><span>{whenText(ev)}{ev.recurring ? ' · recurring' : ''}</span></div>
        {ev.location && <div className="ev-pop-line"><Icon name="location" size={15} /><span>{ev.location}</span></div>}
        {ev.organizer && <div className="ev-pop-line"><Icon name="user" size={15} /><span>{ev.organizer}</span></div>}
        <div className="ev-pop-line muted"><span className="dot" style={{ background: ev.color }} /><span>{ev.calendarName}{ev.busy ? '' : ' · shown as free'}</span></div>
        {ev.description && <div className="ev-pop-desc">{ev.description}</div>}
        {ev.meetingUrl && <button className="btn primary join" onClick={() => onJoin(ev.meetingUrl)}><Icon name="video" size={15} /> Join meeting</button>}
      </div>
    </div>
  );
}

function EventChip({ ev, onClick, compact }) {
  return (
    <button className={`ev-chip ${ev.busy ? '' : 'free'}`} style={{ '--ev': ev.color }} onClick={(e) => onClick(ev, e)} title={ev.title}>
      {!ev.allDay && compact && <span className="ev-chip-time">{timeLabel(new Date(ev.start)).replace(' ', '').toLowerCase()}</span>}
      <span className="ev-chip-title">{ev.title}</span>
    </button>
  );
}

function TimeGrid({ days, events, onEventClick, onPickDay }) {
  const scroller = useRef(null);
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(t); }, []);
  const layouts = useMemo(() => days.map(d => layoutDay(events, d)), [days, events]);
  useEffect(() => {
    // Start the view a little before the working day, or before "now" when it's earlier.
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (Math.min(8, Math.max(0, now.getHours() - 1)) - 0.5) * HOUR_PX);
  }, [days.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const maxAllDay = Math.max(0, ...layouts.map(l => l.allDay.length));
  const cols = { gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` };
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return (
    <div className="tg">
      <div className="tg-head" style={cols}>
        <div className="tg-gutter" />
        {days.map(d => (
          <button key={dayKey(d)} className={`tg-day ${sameDay(d, now) ? 'today' : ''}`} onClick={() => onPickDay(d)}>
            <span className="tg-dow">{d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
            <span className="tg-date">{d.getDate()}</span>
          </button>
        ))}
      </div>
      {maxAllDay > 0 && (
        <div className="tg-allday" style={cols}>
          <div className="tg-gutter small">all day</div>
          {layouts.map((l, i) => (
            <div key={i} className="tg-allday-col">{l.allDay.map(ev => <EventChip key={ev.id} ev={ev} onClick={onEventClick} />)}</div>
          ))}
        </div>
      )}
      <div className="tg-scroll" ref={scroller}>
        <div className="tg-body" style={{ ...cols, height: HOUR_PX * 24 }}>
          <div className="tg-hours">
            {Array.from({ length: 24 }, (_, h) => <div key={h} className="tg-hour-label" style={{ top: h * HOUR_PX }}>{h === 0 ? '' : hourLabel(h)}</div>)}
          </div>
          {days.map((d, i) => (
            <div key={dayKey(d)} className={`tg-col ${sameDay(d, now) ? 'today' : ''}`}>
              {Array.from({ length: 24 }, (_, h) => <div key={h} className={`tg-cell ${h < 8 || h >= 18 ? 'off' : ''}`} style={{ height: HOUR_PX }} />)}
              {layouts[i].timed.map(t => {
                const h = Math.max(18, (t.endMin - t.startMin) * PX_PER_MIN - 1);
                return (
                  <button key={t.ev.id + t.startMin} className={`tg-ev ${t.ev.busy ? '' : 'free'}`}
                    style={{ '--ev': t.ev.color, top: t.startMin * PX_PER_MIN, height: h, left: `calc(${(t.lane / t.lanes) * 100}% + 1px)`, width: `calc(${100 / t.lanes}% - 3px)` }}
                    onClick={(e) => onEventClick(t.ev, e)} title={`${t.ev.title}\n${whenText(t.ev)}`}>
                    <span className="tg-ev-title">{t.ev.title}</span>
                    {h >= 34 && <span className="tg-ev-time">{timeLabel(new Date(t.ev.start))}{t.ev.location ? ` · ${t.ev.location}` : ''}</span>}
                  </button>
                );
              })}
              {sameDay(d, now) && <div className="tg-now" style={{ top: nowMin * PX_PER_MIN }}><span /></div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MonthGrid({ days, anchor, events, onEventClick, onPickDay }) {
  const now = new Date();
  const perDay = useMemo(() => days.map(d => {
    const l = layoutDay(events, d);
    return [...l.allDay, ...l.timed.map(t => t.ev)];
  }), [days, events]);
  return (
    <div className="mg">
      <div className="mg-head">{days.slice(0, 7).map(d => <div key={d.getDay()} className="mg-dow">{d.toLocaleDateString(undefined, { weekday: 'short' })}</div>)}</div>
      <div className="mg-body" style={{ gridTemplateRows: `repeat(${days.length / 7}, minmax(0, 1fr))` }}>
        {days.map((d, i) => {
          const list = perDay[i];
          return (
            <div key={dayKey(d)} className={`mg-cell ${d.getMonth() !== anchor.getMonth() ? 'other' : ''} ${sameDay(d, now) ? 'today' : ''}`}>
              <button className="mg-num" onClick={() => onPickDay(d)}>{d.getDate() === 1 ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : d.getDate()}</button>
              {list.slice(0, 3).map(ev => <EventChip key={ev.id} ev={ev} onClick={onEventClick} compact />)}
              {list.length > 3 && <button className="mg-more" onClick={() => onPickDay(d)}>+{list.length - 3} more</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function CalendarView({ mode, anchor, range, events, loading, hasCalendars, onPickDay, onOpenExternal, onAddCalendar }) {
  const [pop, setPop] = useState(null);
  const days = useMemo(() => Array.from({ length: range.days }, (_, i) => addDays(range.start, i)), [range]);
  const onEventClick = (ev, e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setPop({ ev, anchor: { x: Math.min(r.right + 6, window.innerWidth - 340), y: r.top } });
  };
  if (!hasCalendars) {
    return (
      <section className="cal-pane empty">
        <Icon name="calendar" size={44} />
        <h3>Add a calendar to see your events</h3>
        <p>Paste a calendar link (Google &ldquo;secret address in iCal format&rdquo;, or an Outlook published calendar) or choose an .ics file.</p>
        <button className="btn primary" onClick={onAddCalendar}>Add a calendar</button>
      </section>
    );
  }
  return (
    <section className="cal-pane">
      {loading && <div className="cal-loading"><div className="spinner small" /> Updating…</div>}
      {mode === 'month'
        ? <MonthGrid days={days} anchor={anchor} events={events} onEventClick={onEventClick} onPickDay={onPickDay} />
        : <TimeGrid days={days} events={events} onEventClick={onEventClick} onPickDay={onPickDay} />}
      {pop && <Popover ev={pop.ev} anchor={pop.anchor} onClose={() => setPop(null)} onJoin={onOpenExternal} />}
    </section>
  );
}
