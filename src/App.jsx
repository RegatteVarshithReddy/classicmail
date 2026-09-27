import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, isDemo, on } from './lib/api.js';
import { buildForward, buildNew, buildReply } from './lib/compose.js';
import { addDays, rangeFor, rangeTitle, stepAnchor } from './lib/dates.mjs';
import { ConfirmDialog, Menu, PromptDialog } from './components/Dialogs.jsx';
import Ribbon from './components/Ribbon.jsx';
import NavPane from './components/NavPane.jsx';
import MessageList from './components/MessageList.jsx';
import ReadingPane from './components/ReadingPane.jsx';
import CalendarView from './components/CalendarView.jsx';
import Settings from './components/Settings.jsx';
import { Icon } from './lib/icons.jsx';

const DEFAULT_SETTINGS = { readingPane: 'right', markReadDelayMs: 1500, loadRemoteImages: false, notifications: true, checkIntervalSec: 90, listWidth: 380, theme: 'system' };

async function runGrouped(rows, fn) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.accountId}|${r.path}`;
    if (!groups.has(k)) groups.set(k, { accountId: r.accountId, path: r.path, uids: [] });
    groups.get(k).uids.push(r.uid);
  }
  for (const g of groups.values()) await fn(g.accountId, g.path, g.uids);
}

export default function App() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [accounts, setAccounts] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [folders, setFolders] = useState({});
  const [counts, setCounts] = useState({});
  const [presets, setPresets] = useState(null);
  const [info, setInfo] = useState(null);
  const [calendars, setCalendars] = useState([]);

  const [view, setView] = useState('mail');
  const [tab, setTab] = useState('home');
  const [sel, setSel] = useState({ kind: 'unified' });
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [tick, setTick] = useState(0);
  const [list, setList] = useState({ rows: [], total: 0, hasMore: false, loading: true, loadingMore: false, error: '', partial: [] });
  const [selected, setSelected] = useState([]);
  const [message, setMessage] = useState({ status: 'idle' });
  const [imagesFor, setImagesFor] = useState(() => new Set());
  const [openFull, setOpenFull] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [menu, setMenu] = useState(null);
  const [status, setStatus] = useState(null); // {kind:'error'|'info', text}
  const [busy, setBusy] = useState(false);
  const [listWidth, setListWidth] = useState(DEFAULT_SETTINGS.listWidth);

  const [calMode, setCalMode] = useState('workweek');
  const [anchor, setAnchor] = useState(() => new Date());
  const [calEvents, setCalEvents] = useState([]);
  const [calErrors, setCalErrors] = useState({});
  const [calLoading, setCalLoading] = useState(false);
  const [calTick, setCalTick] = useState(0);

  const reqId = useRef(0);
  const anchorKey = useRef(null);
  const msgCache = useRef(new Map());
  const activeKeyRef = useRef(null);
  const dragRows = useRef([]);
  const pendingSelect = useRef(null);
  const lastUnseen = useRef({});
  const searchRef = useRef(null);

  const reload = useCallback(() => setTick(t => t + 1), []);
  const fail = useCallback((err) => setStatus({ kind: 'error', text: (err && err.message) || String(err) }), []);

  // ---- start-up -------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const [s, a, p, c, i] = await Promise.all([call('settings.get'), call('accounts.list'), call('accounts.presets'), call('calendars.list'), call('app.info')]);
        setSettings(s); setListWidth(s.listWidth); setAccounts(a); setPresets(p); setCalendars(c); setInfo(i);
        setLoaded(true);
        if (!a.length) setDialog({ type: 'settings', tab: 'accounts' });
      } catch (e) { fail(e); setLoaded(true); }
    })();
  }, [fail]);

  useEffect(() => {
    const apply = () => {
      const dark = settings.theme === 'dark' || (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings.theme]);

  const setSetting = useCallback(async (key, value) => {
    setSettings(s => ({ ...s, [key]: value }));
    try { setSettings(await call('settings.set', { [key]: value })); } catch (e) { fail(e); }
  }, [fail]);

  const refreshAccounts = useCallback(async () => {
    const a = await call('accounts.list');
    setAccounts(a);
    setFolders(f => Object.fromEntries(Object.entries(f).filter(([id]) => a.some(x => x.id === id))));
    setSel(cur => (cur.kind === 'folder' && !a.some(x => x.id === cur.accountId && x.enabled) ? { kind: 'unified' } : cur));
    reload();
  }, [reload]);
  const refreshCalendars = useCallback(async () => { setCalendars(await call('calendars.list')); setCalTick(t => t + 1); }, []);

  // ---- folders and counts ----------------------------------------------------
  const refreshCounts = useCallback(async (accountId) => {
    try {
      const c = await call('folders.counts', accountId);
      setCounts(cur => ({ ...cur, [accountId]: c }));
      lastUnseen.current[accountId] = (c.INBOX && c.INBOX.unseen) || 0;
    } catch (_) { /* counts are cosmetic; list errors are shown elsewhere */ }
  }, []);

  const loadFolders = useCallback(async (accountId) => {
    try {
      const f = await call('folders.list', accountId);
      setFolders(cur => ({ ...cur, [accountId]: f }));
      refreshCounts(accountId);
    } catch (e) { fail(new Error(`${(accounts.find(a => a.id === accountId) || {}).email || 'Account'}: ${e.message}`)); }
  }, [accounts, fail, refreshCounts]);

  useEffect(() => {
    for (const a of accounts.filter(x => x.enabled)) if (!folders[a.id]) loadFolders(a.id);
  }, [accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const folderOf = useCallback((accountId, path) => (folders[accountId] || []).find(f => f.path === path), [folders]);
  const adjustCounts = useCallback((accountId, path, dUnseen, dMessages = 0) => {
    setCounts(cur => {
      const acc = cur[accountId] || {};
      const c = acc[path] || { messages: 0, unseen: 0 };
      return { ...cur, [accountId]: { ...acc, [path]: { messages: Math.max(0, c.messages + dMessages), unseen: Math.max(0, c.unseen + dUnseen) } } };
    });
  }, []);

  const unifiedUnseen = useMemo(() => accounts.filter(a => a.enabled).reduce((n, a) => {
    const inbox = (folders[a.id] || []).find(f => f.specialUse === '\\Inbox');
    return n + ((counts[a.id] && inbox && counts[a.id][inbox.path] && counts[a.id][inbox.path].unseen) || 0);
  }, 0), [accounts, folders, counts]);

  // ---- message list -----------------------------------------------------------
  const filterEff = sel.kind === 'unread' ? 'unread' : filter;
  const fetchPage = useCallback((offset) => {
    const opts = { offset, limit: 50, filter: filterEff, query: query.trim() };
    if (sel.kind === 'unified' || sel.kind === 'unread') return call('messages.unified', opts);
    return call('messages.list', sel.accountId, sel.path, opts);
  }, [sel, filterEff, query]);

  useEffect(() => {
    if (!loaded || view !== 'mail') return;
    if (!accounts.some(a => a.enabled)) { setList({ rows: [], total: 0, hasMore: false, loading: false, loadingMore: false, error: '', partial: [] }); return; }
    const id = ++reqId.current;
    setList(l => ({ ...l, loading: true, error: '' }));
    fetchPage(0).then((res) => {
      if (id !== reqId.current) return;
      const errors = res.errors || [];
      setList({ rows: res.rows, total: res.total, hasMore: res.hasMore, loading: false, loadingMore: false, error: errors.length && !res.rows.length ? errors[0].error : '', partial: errors });
    }).catch((err) => {
      if (id !== reqId.current) return;
      setList(l => ({ ...l, loading: false, error: err.message }));
    });
  }, [loaded, view, accounts, fetchPage, tick]);

  const loadMore = useCallback(async () => {
    if (list.loadingMore || !list.hasMore) return;
    const id = reqId.current;
    setList(l => ({ ...l, loadingMore: true }));
    try {
      const res = await fetchPage(list.rows.length);
      if (id !== reqId.current) return;
      setList(l => ({ ...l, rows: [...l.rows, ...res.rows.filter(r => !l.rows.some(x => x.key === r.key))], hasMore: res.hasMore, total: res.total, loadingMore: false }));
    } catch (e) { setList(l => ({ ...l, loadingMore: false })); fail(e); }
  }, [list.loadingMore, list.hasMore, list.rows.length, fetchPage, fail]);

  const selectFolder = useCallback((next) => {
    setSel(next); setSelected([]); setOpenFull(false); anchorKey.current = null;
    setList(l => ({ ...l, rows: [], total: 0, hasMore: false, loading: true, error: '' }));
    setView('mail');
  }, []);

  const rowsByKey = useMemo(() => new Map(list.rows.map(r => [r.key, r])), [list.rows]);
  const selRows = useMemo(() => selected.map(k => rowsByKey.get(k)).filter(Boolean), [selected, rowsByKey]);
  const activeRow = selRows.length === 1 ? selRows[0] : null;

  useEffect(() => {
    if (pendingSelect.current && rowsByKey.has(pendingSelect.current)) { setSelected([pendingSelect.current]); pendingSelect.current = null; }
  }, [rowsByKey]);

  // ---- reading -----------------------------------------------------------------
  const activeKey = activeRow ? activeRow.key : null;
  const [msgTick, setMsgTick] = useState(0);
  useEffect(() => {
    activeKeyRef.current = activeKey;
    if (!activeRow) { setMessage({ status: 'idle' }); return undefined; }
    const cached = msgCache.current.get(activeKey);
    if (cached) { setMessage({ status: 'ready', data: cached }); return undefined; }
    setMessage({ status: 'loading' });
    let cancelled = false;
    call('messages.get', activeRow.accountId, activeRow.path, activeRow.uid).then((data) => {
      if (cancelled) return;
      msgCache.current.set(activeKey, data);
      if (msgCache.current.size > 40) msgCache.current.delete(msgCache.current.keys().next().value);
      setMessage({ status: 'ready', data });
    }).catch((err) => { if (!cancelled) setMessage({ status: 'error', error: err.message }); });
    return () => { cancelled = true; };
  }, [activeKey, msgTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- actions ------------------------------------------------------------------
  const patchRows = useCallback((keys, patch) => setList(l => ({ ...l, rows: l.rows.map(r => (keys.has(r.key) ? { ...r, ...patch } : r)) })), []);

  const markRead = useCallback(async (rows, seen) => {
    const targets = rows.filter(r => r.seen !== seen);
    if (!targets.length) return;
    patchRows(new Set(targets.map(r => r.key)), { seen });
    for (const r of targets) adjustCounts(r.accountId, r.path, seen ? -1 : 1);
    try { await runGrouped(targets, (a, p, uids) => call('messages.setFlags', a, p, uids, { seen })); }
    catch (e) { fail(e); reload(); for (const id of new Set(targets.map(t => t.accountId))) refreshCounts(id); }
  }, [adjustCounts, fail, patchRows, refreshCounts, reload]);

  const setFlagged = useCallback(async (rows, flagged) => {
    patchRows(new Set(rows.map(r => r.key)), { flagged });
    try { await runGrouped(rows, (a, p, uids) => call('messages.setFlags', a, p, uids, { flagged })); }
    catch (e) { fail(e); reload(); }
  }, [fail, patchRows, reload]);

  useEffect(() => {
    if (!activeRow || activeRow.seen || settings.markReadDelayMs < 0) return undefined;
    if (settings.readingPane === 'off' && !openFull) return undefined;
    const t = setTimeout(() => markRead([activeRow], true), settings.markReadDelayMs);
    return () => clearTimeout(t);
  }, [activeKey, activeRow && activeRow.seen, settings.markReadDelayMs, settings.readingPane, openFull]); // eslint-disable-line react-hooks/exhaustive-deps

  const removeRows = useCallback((rows) => {
    const keys = new Set(rows.map(r => r.key));
    const idx = list.rows.findIndex(r => keys.has(r.key));
    const rest = list.rows.filter(r => !keys.has(r.key));
    const next = rest[Math.min(idx < 0 ? 0 : idx, rest.length - 1)];
    setList(l => ({ ...l, rows: rest, total: Math.max(0, l.total - keys.size) }));
    setSelected(next && rows.length === 1 && selected.length <= 1 ? [next.key] : []);
    for (const r of rows) adjustCounts(r.accountId, r.path, r.seen ? 0 : -1, -1);
  }, [list.rows, selected.length, adjustCounts]);

  const afterServerChange = useCallback((rows) => {
    for (const id of new Set(rows.map(r => r.accountId))) refreshCounts(id);
  }, [refreshCounts]);

  const trashRows = useCallback(async (rows, permanent = false) => {
    if (!rows.length) return;
    removeRows(rows);
    try { await runGrouped(rows, (a, p, uids) => call('messages.trash', a, p, uids, { permanent })); afterServerChange(rows); }
    catch (e) { fail(e); reload(); afterServerChange(rows); }
  }, [afterServerChange, fail, reload, removeRows]);

  const del = useCallback((rows = selRows) => {
    if (!rows.length) return;
    const inTrash = rows.every(r => { const f = folderOf(r.accountId, r.path); return f && f.specialUse === '\\Trash'; });
    if (inTrash) {
      setDialog({ type: 'confirm', title: 'Delete permanently', danger: true, confirmLabel: 'Delete',
        message: `Permanently delete ${rows.length === 1 ? 'this message' : `these ${rows.length} messages`}? This cannot be undone.`,
        onConfirm: () => { setDialog(null); trashRows(rows, true); } });
    } else trashRows(rows, false);
  }, [folderOf, selRows, trashRows]);

  const simpleMove = useCallback(async (rows, call_) => {
    if (!rows.length) return;
    removeRows(rows);
    try { await runGrouped(rows, call_); afterServerChange(rows); }
    catch (e) { fail(e); reload(); afterServerChange(rows); }
  }, [afterServerChange, fail, reload, removeRows]);

  const archive = useCallback((rows = selRows) => simpleMove(rows, (a, p, u) => call('messages.archive', a, p, u)), [selRows, simpleMove]);
  const junk = useCallback((rows = selRows) => simpleMove(rows, (a, p, u) => call('messages.junk', a, p, u)), [selRows, simpleMove]);
  const moveRows = useCallback((rows, accountId, dest) => {
    if (rows.some(r => r.accountId !== accountId)) { fail(new Error('Messages can only be moved within the same account.')); return; }
    const movable = rows.filter(r => r.path !== dest);
    simpleMove(movable, (a, p, u) => call('messages.move', a, p, u, dest));
  }, [fail, simpleMove]);

  // ---- composing -------------------------------------------------------------------
  const enabledAccounts = useMemo(() => accounts.filter(a => a.enabled), [accounts]);
  const currentAccount = useCallback(() => {
    if (sel.kind === 'folder') return enabledAccounts.find(a => a.id === sel.accountId);
    if (activeRow) return enabledAccounts.find(a => a.id === activeRow.accountId);
    return enabledAccounts[0];
  }, [sel, activeRow, enabledAccounts]);
  const openCompose = useCallback(async (init) => { try { await call('compose.open', init); } catch (e) { fail(e); } }, [fail]);

  const newMail = useCallback(() => {
    const acc = currentAccount();
    if (!acc) { setDialog({ type: 'settings', tab: 'accounts' }); return; }
    openCompose(buildNew(acc));
  }, [currentAccount, openCompose]);

  const withMessage = useCallback(async (fn) => {
    if (!activeRow) return;
    try {
      const data = message.status === 'ready' && message.data.key === activeRow.key ? message.data : await call('messages.get', activeRow.accountId, activeRow.path, activeRow.uid);
      const acc = enabledAccounts.find(a => a.id === activeRow.accountId);
      if (acc) fn(data, acc);
    } catch (e) { fail(e); }
  }, [activeRow, message, enabledAccounts, fail]);

  const reply = useCallback((all) => withMessage((m, acc) => { openCompose(buildReply(m, acc, enabledAccounts, all)); markRead([activeRow], true); }), [withMessage, openCompose, enabledAccounts, markRead, activeRow]);
  const forward = useCallback(() => withMessage((m, acc) => openCompose(buildForward(m, acc))), [withMessage, openCompose]);

  const openDraft = useCallback(async (row) => {
    try {
      const m = await call('messages.get', row.accountId, row.path, row.uid);
      const files = m.attachments || []; // everything the reading pane lists (pictures already shown inside the body are not in the list)
      await openCompose({
        mode: 'draft', accountId: row.accountId, to: m.to || [], cc: m.cc || [], bcc: m.bcc || [], subject: m.subject || '',
        html: m.html || (m.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>'),
        inReplyTo: m.inReplyTo || '', references: m.references || [],
        forwardOf: files.length ? { accountId: row.accountId, path: row.path, uid: row.uid, indexes: files.map(a => a.index) } : undefined,
        draft: { path: row.path, uid: row.uid }
      });
    } catch (e) { fail(e); }
  }, [fail, openCompose]);

  const unsubscribe = useCallback(() => {
    const u = message.status === 'ready' && message.data.listUnsubscribe;
    if (!u) return;
    if (u.http) call('app.openExternal', u.http).catch(fail);
    else if (u.mailto) call('app.openExternal', u.mailto).catch(fail);
  }, [message, fail]);

  const saveAttachment = useCallback(async (att) => {
    if (!activeRow) return;
    try {
      const res = await call('messages.saveAttachment', activeRow.accountId, activeRow.path, activeRow.uid, att.index);
      if (!res.canceled) setStatus({ kind: 'info', text: `Saved ${att.filename}` });
    } catch (e) { fail(e); }
  }, [activeRow, fail]);

  const sendReceive = useCallback(async () => {
    setBusy(true);
    try { await call('app.checkNow'); } catch (e) { fail(e); }
    for (const a of enabledAccounts) refreshCounts(a.id);
    reload();
    setBusy(false);
  }, [enabledAccounts, fail, refreshCounts, reload]);

  // ---- push events ------------------------------------------------------------------
  const ctx = useRef({});
  ctx.current = { sel, refreshCounts, reload, folders };
  useEffect(() => {
    const offNew = on('mail:new', ({ accountId, unseen, fresh }) => {
      const c = ctx.current;
      if (lastUnseen.current[accountId] !== unseen || fresh > 0) {
        lastUnseen.current[accountId] = unseen;
        c.refreshCounts(accountId);
        const showsInbox = c.sel.kind === 'unified' || c.sel.kind === 'unread' || (c.sel.kind === 'folder' && c.sel.accountId === accountId && c.sel.path === 'INBOX');
        if (showsInbox) c.reload();
      }
    });
    const offChanged = on('mail:changed', ({ accountId }) => { ctx.current.reload(); if (accountId) ctx.current.refreshCounts(accountId); });
    const offOpen = on('mail:open', ({ accountId, path, uid }) => {
      pendingSelect.current = `${accountId}|${path}|${uid}`;
      selectFolder({ kind: 'folder', accountId, path });
    });
    return () => { offNew(); offChanged(); offOpen(); };
  }, [selectFolder]);

  // ---- calendar -----------------------------------------------------------------------
  const range = useMemo(() => rangeFor(calMode, anchor), [calMode, anchor]);
  const calKey = calendars.map(c => `${c.id}:${c.enabled}`).join(',');
  useEffect(() => {
    if (view !== 'calendar' || !loaded) return undefined;
    let cancelled = false;
    setCalLoading(true);
    call('calendars.events', range.start.toISOString(), addDays(range.start, range.days).toISOString())
      .then((res) => {
        if (cancelled) return;
        setCalEvents(res.events);
        setCalErrors(Object.fromEntries(res.status.filter(s => s.error).map(s => [s.calendarId, s.error])));
      })
      .catch(e => { if (!cancelled) fail(e); })
      .finally(() => { if (!cancelled) setCalLoading(false); });
    return () => { cancelled = true; };
  }, [view, loaded, range, calKey, calTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshCalendarsNow = useCallback(async () => {
    setCalLoading(true);
    try {
      const res = await call('calendars.events', range.start.toISOString(), addDays(range.start, range.days).toISOString(), { force: true });
      setCalEvents(res.events);
      setCalErrors(Object.fromEntries(res.status.filter(s => s.error).map(s => [s.calendarId, s.error])));
    } catch (e) { fail(e); }
    setCalLoading(false);
  }, [range, fail]);

  const cal = {
    mode: calMode, setMode: setCalMode, anchor, setAnchor, range, errors: calErrors,
    today: () => setAnchor(new Date()), step: (d) => setAnchor(a => stepAnchor(calMode, a, d)),
    refresh: refreshCalendarsNow, add: () => setDialog({ type: 'settings', tab: 'calendars' })
  };

  // ---- keyboard ------------------------------------------------------------------------
  const moveSelection = useCallback((dir, extend) => {
    if (!list.rows.length) return;
    const cur = selected.length ? list.rows.findIndex(r => r.key === selected[selected.length - 1]) : -1;
    const idx = Math.min(list.rows.length - 1, Math.max(0, cur + dir));
    const key = list.rows[idx].key;
    if (extend && anchorKey.current) {
      const a = list.rows.findIndex(r => r.key === anchorKey.current);
      const [lo, hi] = a < idx ? [a, idx] : [idx, a];
      setSelected(list.rows.slice(lo, hi + 1).map(r => r.key));
    } else { setSelected([key]); anchorKey.current = key; }
    const el = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [list.rows, selected]);

  useEffect(() => {
    const onKey = (e) => {
      if (dialog || menu) return;
      const mod = e.ctrlKey || e.metaKey;
      const typing = e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]');
      if (mod && e.key === '1') { e.preventDefault(); setView('mail'); return; }
      if (mod && e.key === '2') { e.preventDefault(); setView('calendar'); return; }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newMail(); return; }
      if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); if (searchRef.current) searchRef.current.focus(); return; }
      if (e.key === 'F9') { e.preventDefault(); sendReceive(); return; }
      if (typing || view !== 'mail') return;
      if (mod && e.key.toLowerCase() === 'r') { e.preventDefault(); reply(e.shiftKey); return; }
      if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); forward(); return; }
      if (mod && e.key.toLowerCase() === 'q') { e.preventDefault(); markRead(selRows, true); return; }
      if (mod && e.key.toLowerCase() === 'u') { e.preventDefault(); markRead(selRows, false); return; }
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelected(list.rows.map(r => r.key)); return; }
      if (e.key === 'Delete') { e.preventDefault(); del(); return; }
      if (e.key === 'Insert' && selRows.length) { e.preventDefault(); setFlagged(selRows, !selRows.every(r => r.flagged)); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1, e.shiftKey); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1, e.shiftKey); return; }
      if (e.key === 'Enter' && activeRow) { e.preventDefault(); if (activeRow.draft) openDraft(activeRow); else if (settings.readingPane === 'off') setOpenFull(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, menu, view, newMail, reply, forward, markRead, selRows, list.rows, del, setFlagged, moveSelection, activeRow, settings.readingPane, sendReceive, openDraft]);

  // ---- list interactions ------------------------------------------------------------------
  const onRowClick = useCallback((e, row) => {
    if (e.shiftKey && anchorKey.current) {
      const a = list.rows.findIndex(r => r.key === anchorKey.current);
      const b = list.rows.findIndex(r => r.key === row.key);
      if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; setSelected(list.rows.slice(lo, hi + 1).map(r => r.key)); return; }
    }
    if (e.ctrlKey || e.metaKey) {
      setSelected(cur => (cur.includes(row.key) ? cur.filter(k => k !== row.key) : [...cur, row.key]));
      anchorKey.current = row.key;
      return;
    }
    setSelected([row.key]);
    anchorKey.current = row.key;
  }, [list.rows]);

  const onRowDoubleClick = useCallback((row) => {
    if (row.draft) openDraft(row);
    else if (settings.readingPane === 'off') { setSelected([row.key]); setOpenFull(true); }
  }, [openDraft, settings.readingPane]);

  const onRowMenu = useCallback((e, row) => {
    const x = e.clientX, y = e.clientY;
    const rows = selected.includes(row.key) ? selRows : [row];
    if (!selected.includes(row.key)) { setSelected([row.key]); anchorKey.current = row.key; }
    const one = rows.length === 1;
    const allRead = rows.every(r => r.seen);
    const allFlag = rows.every(r => r.flagged);
    const rowTargets = (folders[rows[0].accountId] || []).filter(f => f.selectable && f.path !== rows[0].path).map(f => ({ path: f.path, label: f.displayName }));
    const openMoveSubmenu = () => setMenu({ x, y, items: rowTargets.length
      ? rowTargets.map(t => ({ label: t.label, icon: 'folder', onClick: () => moveRows(rows, rows[0].accountId, t.path) }))
      : [{ label: 'No other folders', disabled: true }] });
    setMenu({ x, y, items: [
      { label: 'Reply', icon: 'reply', disabled: !one, onClick: () => reply(false) },
      { label: 'Reply All', icon: 'reply-all', disabled: !one, onClick: () => reply(true) },
      { label: 'Forward', icon: 'forward', disabled: !one, onClick: forward },
      { separator: true },
      { label: allRead ? 'Mark as Unread' : 'Mark as Read', icon: allRead ? 'mail' : 'mail-open', onClick: () => markRead(rows, !allRead) },
      { label: allFlag ? 'Clear Flag' : 'Flag', icon: 'flag', onClick: () => setFlagged(rows, !allFlag) },
      { separator: true },
      { label: 'Move to…', icon: 'move', onClick: openMoveSubmenu },
      { label: 'Archive', icon: 'archive', onClick: () => archive(rows) },
      { label: 'Junk', icon: 'junk', onClick: () => junk(rows) },
      { label: 'Delete', icon: 'delete', danger: true, onClick: () => del(rows) }
    ] });
  }, [selected, selRows, folders, reply, forward, markRead, setFlagged, moveRows, archive, junk, del]);

  // ---- folder management ---------------------------------------------------------------------
  const onFolderMenu = useCallback((e, account, folder) => {
    const special = Boolean(folder.specialUse);
    const unseen = (counts[account.id] && counts[account.id][folder.path] && counts[account.id][folder.path].unseen) || 0;
    const reloadFolders = async () => { setFolders(f => { const n = { ...f }; delete n[account.id]; return n; }); };
    setMenu({ x: e.clientX, y: e.clientY, items: [
      { label: 'New Subfolder…', icon: 'plus', onClick: () => setDialog({ type: 'prompt', title: 'New folder', label: 'Folder name', confirmLabel: 'Create',
        onSubmit: async (name) => { setDialog(null); try { await call('folders.create', account.id, folder.path ? `${folder.path}${folder.delimiter || '/'}${name}` : name); await reloadFolders(); } catch (err) { fail(err); } } }) },
      { label: 'Rename…', icon: 'drafts', disabled: special, onClick: () => setDialog({ type: 'prompt', title: 'Rename folder', label: 'New name', initial: folder.name, confirmLabel: 'Rename',
        onSubmit: async (name) => { setDialog(null); try { const parent = folder.parentPath ? `${folder.parentPath}${folder.delimiter || '/'}` : ''; await call('folders.rename', account.id, folder.path, `${parent}${name}`); await reloadFolders(); if (sel.kind === 'folder' && sel.path === folder.path) selectFolder({ kind: 'unified' }); } catch (err) { fail(err); } } }) },
      { separator: true },
      { label: 'Mark All as Read', icon: 'mail-open', disabled: unseen === 0, onClick: async () => {
        try {
          await call('folders.markRead', account.id, folder.path);
          patchRows(new Set(list.rows.filter(r => r.accountId === account.id && r.path === folder.path).map(r => r.key)), { seen: true });
          refreshCounts(account.id);
          reload();
        } catch (err) { fail(err); }
      } },
      { separator: true },
      { label: 'Delete Folder…', icon: 'delete', danger: true, disabled: special, onClick: () => setDialog({ type: 'confirm', title: 'Delete folder', danger: true, confirmLabel: 'Delete',
        message: `Delete the folder “${folder.name}”? Messages inside it will be deleted with it.`,
        onConfirm: async () => { setDialog(null); try { await call('folders.delete', account.id, folder.path); await reloadFolders(); if (sel.kind === 'folder' && sel.path === folder.path) selectFolder({ kind: 'unified' }); } catch (err) { fail(err); } } }) }
    ] });
  }, [fail, sel, selectFolder, counts, list.rows, patchRows, refreshCounts, reload]);

  // ---- derived ribbon/context info ----------------------------------------------------------------
  const moveTargets = useMemo(() => {
    const first = selRows[0];
    if (!first) return [];
    return (folders[first.accountId] || []).filter(f => f.selectable && f.path !== first.path).map(f => ({ path: f.path, label: f.displayName }));
  }, [selRows, folders]);

  const ribbonSel = {
    count: selRows.length,
    allRead: selRows.length > 0 && selRows.every(r => r.seen),
    allFlagged: selRows.length > 0 && selRows.every(r => r.flagged),
    canUnsubscribe: Boolean(message.status === 'ready' && message.data.listUnsubscribe && activeRow)
  };

  const title = sel.kind === 'unified' ? 'All Inboxes' : sel.kind === 'unread' ? 'Unread Mail'
    : ((folderOf(sel.accountId, sel.path) || {}).displayName || sel.path);
  const showAccount = sel.kind === 'unified' || sel.kind === 'unread';
  const unreadInList = list.rows.filter(r => !r.seen).length;
  const layout = settings.readingPane === 'bottom' ? 'table' : 'list';
  const activeAccount = activeRow ? accounts.find(a => a.id === activeRow.accountId) : null;
  const splitDrag = useRef(null);

  const startSplit = (e) => {
    e.preventDefault();
    splitDrag.current = { x: e.clientX, w: listWidth };
    let latest = listWidth;
    const move = (ev) => { latest = Math.min(900, Math.max(260, splitDrag.current.w + ev.clientX - splitDrag.current.x)); setListWidth(latest); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); setSetting('listWidth', latest); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const emptyText = query ? 'No results match your search.' : filterEff === 'unread' ? 'No unread messages.' : filterEff === 'flagged' ? 'No flagged messages.' : 'This folder is empty.';

  const readingPane = (
    <ReadingPane
      state={message} row={activeRow} account={activeAccount} multiCount={selRows.length}
      onReply={() => reply(false)} onReplyAll={() => reply(true)} onForward={forward}
      onSaveAttachment={saveAttachment} onUnsubscribe={unsubscribe}
      imagesAllowed={settings.loadRemoteImages || (activeRow && imagesFor.has(activeRow.key))}
      onAllowImages={() => activeRow && setImagesFor(s => new Set(s).add(activeRow.key))}
      onRetry={() => setMsgTick(t => t + 1)}
      showBack={settings.readingPane === 'off'} onBack={() => setOpenFull(false)}
    />
  );

  let statusMiddle;
  if (status) {
    statusMiddle = (
      <span className={`status-msg ${status.kind}`}>
        <Icon name={status.kind === 'error' ? 'warning' : 'check'} size={14} />{status.text}
        <button className="icon-btn" onClick={() => setStatus(null)} aria-label="Dismiss"><Icon name="close" size={12} /></button>
      </span>
    );
  } else if (list.partial.length) {
    statusMiddle = <span className="status-msg error"><Icon name="warning" size={14} />{list.partial.map(p => `${p.email}: ${p.error}`).join('  ·  ')}</span>;
  } else if (busy) {
    statusMiddle = <span className="status-msg"><span className="spinner small" /> Checking for new mail…</span>;
  } else {
    statusMiddle = <span className="muted">All folders are up to date.</span>;
  }

  return (
    <div className="app">
      <Ribbon
        view={view} tab={tab} onTab={setTab} onFile={() => setDialog({ type: 'settings', tab: 'accounts' })}
        sel={ribbonSel} moveTargets={moveTargets} settings={settings} setSetting={setSetting} filter={filter} setFilter={(f) => { setFilter(f); setView('mail'); }} cal={cal}
        actions={{
          newMail, del: () => del(), archive: () => archive(), junk: () => junk(), reply: () => reply(false), replyAll: () => reply(true), forward,
          move: (dest) => selRows[0] && moveRows(selRows, selRows[0].accountId, dest),
          toggleRead: () => markRead(selRows, !ribbonSel.allRead), toggleFlag: () => setFlagged(selRows, !ribbonSel.allFlagged),
          unsubscribe, sendReceive, refreshList: reload
        }}
      />
      <div className="main">
        <NavPane
          view={view} onView={setView} accounts={accounts} folders={folders} counts={counts} sel={sel} onSelect={selectFolder}
          onDrop={(accountId, path) => { const rows = dragRows.current; dragRows.current = []; if (rows.length) moveRows(rows, accountId, path); }}
          onFolderMenu={onFolderMenu} unifiedUnseen={unifiedUnseen} calendars={calendars}
          onToggleCalendar={async (c, enabled) => {
            setCalendars(cs => cs.map(x => (x.id === c.id ? { ...x, enabled } : x))); // tick the box at once
            try { await call('calendars.save', { ...c, enabled }); await refreshCalendars(); } catch (e) { fail(e); refreshCalendars().catch(() => {}); }
          }}
          cal={cal} onSettings={() => setDialog({ type: 'settings', tab: 'accounts' })}
        />
        {view === 'mail' ? (
          <div className={`mail layout-${settings.readingPane}`}>
            {!(settings.readingPane === 'off' && openFull) && (
              <div className="list-wrap" style={settings.readingPane === 'right' ? { width: listWidth } : undefined}>
                <MessageList
                  title={title} rows={list.rows} total={list.total} loading={list.loading} loadingMore={list.loadingMore} error={list.error} hasMore={list.hasMore}
                  onLoadMore={loadMore} onRetry={reload} selectedKeys={new Set(selected)} onRowClick={onRowClick} onRowDoubleClick={onRowDoubleClick}
                  onRowMenu={onRowMenu} onDragStart={(row) => { dragRows.current = selected.includes(row.key) ? selRows : [row]; }}
                  filter={filterEff} setFilter={(f) => { if (sel.kind === 'unread' && f === 'all') selectFolder({ kind: 'unified' }); else setFilter(f); }}
                  onSearch={setQuery} layout={layout} showAccount={showAccount} accounts={accounts} searchRef={searchRef} empty={emptyText}
                />
              </div>
            )}
            {settings.readingPane === 'right' && <div className="splitter" onMouseDown={startSplit} role="separator" aria-orientation="vertical" />}
            {(settings.readingPane !== 'off' || openFull) && <div className="read-wrap">{readingPane}</div>}
          </div>
        ) : (
          <div className="cal-wrap">
            <div className="cal-title"><h2>{rangeTitle(calMode, anchor, range)}</h2></div>
            <CalendarView mode={calMode} anchor={anchor} range={range} events={calEvents} loading={calLoading} hasCalendars={calendars.length > 0}
              onPickDay={(d) => { setAnchor(d); if (calMode === 'month') setCalMode('day'); }}
              onOpenExternal={(url) => call('app.openExternal', url).catch(fail)} onAddCalendar={cal.add} />
          </div>
        )}
      </div>
      <footer className="statusbar">
        <span>{view === 'mail' ? `Items: ${list.total}   Unread: ${sel.kind === 'unread' ? list.total : unreadInList}${list.hasMore ? '+' : ''}${ribbonSel.count > 0 ? `   Selected: ${ribbonSel.count}` : ''}` : `${calEvents.length} events shown`}</span>
        <span className="status-mid">{statusMiddle}</span>
        <span>{isDemo() ? 'Demo data' : `${enabledAccounts.length} account${enabledAccounts.length === 1 ? '' : 's'}`}</span>
      </footer>

      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {dialog && dialog.type === 'settings' && presets && (
        <Settings initialTab={dialog.tab} accounts={accounts} calendars={calendars} settings={settings} presets={presets} info={info}
          onClose={() => setDialog(null)} onAccountsChanged={refreshAccounts} onCalendarsChanged={refreshCalendars}
          onSettingChange={(patch) => Object.entries(patch).forEach(([k, v]) => setSetting(k, v))} />
      )}
      {dialog && dialog.type === 'confirm' && <ConfirmDialog {...dialog} onCancel={() => setDialog(null)} />}
      {dialog && dialog.type === 'prompt' && <PromptDialog {...dialog} onCancel={() => setDialog(null)} />}
    </div>
  );
}
