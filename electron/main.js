'use strict';
const { app, BrowserWindow, Menu, Notification, dialog, ipcMain, safeStorage, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Store, PRESETS } = require('./services/store');
const { MailService } = require('./services/mail');
const { CalendarService } = require('./services/calendar');
const { AiService } = require('./services/ai');

const DEV = process.env.CLASSICMAIL_DEV === '1';
const DEV_URL = 'http://localhost:5173/';
const DIST_DIR = path.join(__dirname, '..', 'dist');
const APP_URL_PREFIX = DEV ? DEV_URL : pathToFileURL(DIST_DIR + path.sep).href;
// A mail client should only talk to the mail servers and calendar links the user configured. These switches turn off
// Chromium's own background traffic (component updates, safe-browsing and network-prediction pings, and so on).
for (const sw of ['disable-background-networking', 'disable-component-update', 'disable-sync', 'no-pings', 'disable-domain-reliability']) {
  app.commandLine.appendSwitch(sw);
}
app.commandLine.appendSwitch('disable-features', 'OptimizationHints,MediaRouter,Translate,AutofillServerCommunication');

const KEYRING_HELP = 'No system keyring was found, so ClassicMail cannot store passwords safely. '
  + 'Install one (sudo apt install gnome-keyring libsecret-1-0), log out and back in, then try again.';

let store;
let mail;
let calendar;
let ai;
let mainWindow = null;
const composeWindows = new Map(); // webContents.id -> { win, init, allowClose }
const uidBaseline = new Map(); // accountId -> last seen UIDNEXT of the inbox
let pollTimer = null;
let polling = false;

// ---- secrets ---------------------------------------------------------------
/**
 * Passwords are encrypted with the desktop keyring (libsecret) through Electron's safeStorage.
 * Without a real keyring Electron would fall back to a hard-coded key, which is not protection,
 * so in that case we refuse to store anything instead of pretending.
 * CLASSICMAIL_INSECURE_SECRETS=1 exists for automated tests only and stores passwords unencrypted.
 */
function keyringReady() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
    const backend = safeStorage.getSelectedStorageBackend();
    if (backend === 'basic_text' || backend === 'unknown') return false;
  }
  return true;
}

function makeSecrets() {
  if (process.env.CLASSICMAIL_INSECURE_SECRETS === '1') {
    console.warn('[classicmail] CLASSICMAIL_INSECURE_SECRETS=1: passwords are NOT encrypted. For testing only.');
    return {
      encrypt: plain => `insecure:${Buffer.from(plain, 'utf8').toString('base64')}`,
      decrypt: enc => Buffer.from(String(enc).replace(/^insecure:/, ''), 'base64').toString('utf8')
    };
  }
  return {
    encrypt(plain) {
      if (!keyringReady()) throw new Error(KEYRING_HELP);
      return safeStorage.encryptString(plain).toString('base64');
    },
    decrypt(enc) {
      if (!keyringReady()) throw new Error(KEYRING_HELP);
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    }
  };
}

// ---- helpers ---------------------------------------------------------------
function isAppUrl(url) {
  return typeof url === 'string' && url.startsWith(APP_URL_PREFIX);
}

/** Only calls made by our own top-level page are honoured (not by iframes such as message bodies). */
function trusted(event) {
  const frame = event.senderFrame;
  return Boolean(frame && frame === event.sender.mainFrame && isAppUrl(frame.url));
}

function handle(name, fn) {
  ipcMain.handle(`cm:${name}`, async (event, ...args) => {
    if (!trusted(event)) return { ok: false, error: 'Blocked request.' };
    try {
      return { ok: true, data: await fn(event, ...args) };
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err);
      return { ok: false, error: message.slice(0, 500) };
    }
  });
}

function sendToAll(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(`cm:${channel}`, payload);
  }
}

function safeFileName(name) {
  const base = path.basename(String(name || '')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return (base || 'attachment').slice(0, 200);
}

function parseMailto(url) {
  try {
    const u = new URL(url);
    const to = decodeURIComponent(u.pathname).split(',').map(s => s.trim()).filter(Boolean).map(address => ({ address }));
    const list = (key) => (u.searchParams.get(key) || '').split(',').map(s => s.trim()).filter(Boolean).map(address => ({ address }));
    return {
      to,
      cc: list('cc'),
      bcc: list('bcc'),
      subject: (u.searchParams.get('subject') || '').slice(0, 500),
      text: (u.searchParams.get('body') || '').slice(0, 20000)
    };
  } catch (_) {
    return null;
  }
}

/**
 * Links clicked inside the app: web links open in the default browser; mailto: opens a new message.
 * Anything else (file:, javascript:, custom schemes) is refused. Returns whether the link was handled.
 */
function routeExternal(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return false; }
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
    shell.openExternal(parsed.href).catch(() => {});
    return true;
  }
  if (parsed.protocol === 'mailto:') {
    const init = parseMailto(url);
    if (init) { openCompose({ mode: 'new', ...init }); return true; }
  }
  return false;
}

function harden(wc) {
  wc.setWindowOpenHandler(({ url }) => { routeExternal(url); return { action: 'deny' }; });
  wc.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) { event.preventDefault(); routeExternal(url); }
  });
  wc.on('will-frame-navigate', (event) => {
    const url = event.url || '';
    if (url.startsWith('about:') || isAppUrl(url)) return;
    event.preventDefault();
    routeExternal(url);
  });
  wc.on('context-menu', (_event, params) => {
    const template = [];
    if (params.isEditable) {
      template.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
    } else if (params.selectionText) {
      template.push({ role: 'copy' });
    }
    if (template.length) Menu.buildFromTemplate(template).popup();
  });
}

function loadRenderer(win, hash = '') {
  if (DEV) return win.loadURL(`${DEV_URL}${hash ? `#${hash}` : ''}`);
  return win.loadFile(path.join(DIST_DIR, 'index.html'), hash ? { hash } : undefined);
}

// ---- windows ---------------------------------------------------------------
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    title: 'ClassicMail',
    backgroundColor: '#ffffff',
    show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  mainWindow.setMenuBarVisibility(false);
  harden(mainWindow.webContents);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
    for (const { win } of composeWindows.values()) if (!win.isDestroyed()) win.close();
  });
  loadRenderer(mainWindow);
}

function openCompose(init) {
  const id = composeWindows.size;
  const win = new BrowserWindow({
    width: 940,
    height: 740,
    minWidth: 640,
    minHeight: 480,
    x: mainWindow ? mainWindow.getPosition()[0] + 60 + (id % 5) * 24 : undefined,
    y: mainWindow ? mainWindow.getPosition()[1] + 40 + (id % 5) * 24 : undefined,
    title: 'Untitled - Message',
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  win.setMenuBarVisibility(false);
  const wcId = win.webContents.id;
  const record = { win, init, allowClose: false };
  composeWindows.set(wcId, record);
  harden(win.webContents);
  // The window asks the page first, so unsaved text can be saved or discarded.
  win.on('close', (event) => {
    if (record.allowClose) return;
    event.preventDefault();
    win.webContents.send('cm:compose:request-close');
  });
  win.on('closed', () => composeWindows.delete(wcId));
  loadRenderer(win, 'compose');
  return win;
}

// ---- new-mail polling ------------------------------------------------------
function describeSender(row) {
  return (row.from && (row.from.name || row.from.address)) || 'Unknown sender';
}

function notifyNew(account, rows) {
  const settings = store.getSettings();
  if (!settings.notifications || !Notification.isSupported() || !rows.length) return;
  const title = rows.length === 1 ? describeSender(rows[0]) : `${rows.length} new messages`;
  const body = rows.length === 1 ? (rows[0].subject || '(no subject)') : `${account.email}`;
  const n = new Notification({ title, body, subtitle: account.email });
  n.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (rows.length === 1) mainWindow.webContents.send('cm:mail:open', { accountId: account.id, path: rows[0].path, uid: rows[0].uid });
  });
  n.show();
}

async function pollOnce() {
  if (polling) return;
  polling = true;
  let unseenTotal = 0;
  try {
    for (const account of store.listAccounts().filter(a => a.enabled)) {
      try {
        const previous = uidBaseline.get(account.id) || 0;
        const result = await mail.checkInbox(account.id, previous);
        uidBaseline.set(account.id, result.uidNext);
        unseenTotal += result.unseen;
        // The first pass only records where the inbox stands, so opening the app never floods notifications.
        if (previous && result.fresh.length) notifyNew(account, result.fresh);
        sendToAll('mail:new', { accountId: account.id, unseen: result.unseen, fresh: previous ? result.fresh.length : 0 });
      } catch (_) { /* offline or bad password: the UI shows it when the user refreshes */ }
    }
    if (typeof app.setBadgeCount === 'function') app.setBadgeCount(unseenTotal);
  } finally {
    polling = false;
  }
}

function schedulePolling() {
  clearTimeout(pollTimer);
  const seconds = Math.max(30, Number(store.getSettings().checkIntervalSec) || 90);
  pollTimer = setTimeout(async () => {
    await pollOnce();
    schedulePolling();
  }, seconds * 1000);
  if (pollTimer.unref) pollTimer.unref();
}

// ---- IPC ---------------------------------------------------------------------
function registerIpc() {
  // accounts
  handle('accounts.list', () => store.listAccounts());
  handle('accounts.presets', () => PRESETS);
  handle('accounts.save', async (_e, { account, password } = {}) => {
    const saved = store.saveAccount(account || {}, password || '');
    await mail.disposeAccount(saved.id); // reconnect with the new settings
    uidBaseline.delete(saved.id);
    setTimeout(pollOnce, 500);
    return saved;
  });
  handle('accounts.remove', async (_e, id) => {
    await mail.disposeAccount(id);
    store.removeAccount(id);
    uidBaseline.delete(id);
    return true;
  });
  handle('accounts.test', (_e, { account, password } = {}) => mail.testConnection(account || {}, password || ''));

  // folders
  handle('folders.list', (_e, accountId) => mail.listFolders(accountId));
  handle('folders.counts', (_e, accountId) => mail.folderCounts(accountId));
  handle('folders.create', (_e, accountId, folder) => mail.createFolder(accountId, folder));
  handle('folders.rename', (_e, accountId, folder, next) => mail.renameFolder(accountId, folder, next));
  handle('folders.delete', (_e, accountId, folder) => mail.deleteFolder(accountId, folder));

  // messages
  handle('messages.list', (_e, accountId, folder, opts) => mail.listMessages(accountId, folder, opts || {}));
  handle('messages.unified', (_e, opts) => mail.listUnified(opts || {}));
  handle('messages.get', (_e, accountId, folder, uid) => mail.getMessage(accountId, folder, Number(uid)));
  handle('messages.saveAttachment', async (event, accountId, folder, uid, index) => {
    const att = await mail.getAttachment(accountId, folder, Number(uid), Number(index));
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(owner, { defaultPath: path.join(app.getPath('downloads'), safeFileName(att.filename)) });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.promises.writeFile(result.filePath, att.content);
    return { canceled: false, path: result.filePath };
  });
  handle('messages.setFlags', (_e, accountId, folder, uids, flags) => mail.setFlags(accountId, folder, uids, flags || {}));
  handle('messages.move', (_e, accountId, folder, uids, destination) => mail.moveMessages(accountId, folder, uids, destination));
  handle('messages.trash', (_e, accountId, folder, uids, opts) => mail.trashMessages(accountId, folder, uids, opts || {}));
  handle('messages.archive', (_e, accountId, folder, uids) => mail.archiveMessages(accountId, folder, uids));
  handle('messages.junk', (_e, accountId, folder, uids) => mail.junkMessages(accountId, folder, uids));

  // sending
  handle('mail.send', async (_e, accountId, draft) => {
    const result = await mail.sendMessage(accountId, draft || {});
    sendToAll('mail:changed', { accountId, reason: 'sent' });
    return result;
  });
  handle('mail.deleteDraft', (_e, accountId, folder, uid) => mail.deleteDraft(accountId, folder, Number(uid)));
  handle('mail.saveDraft', async (_e, accountId, draft, replaceUid) => {
    const result = await mail.saveDraft(accountId, draft || {}, replaceUid);
    sendToAll('mail:changed', { accountId, reason: 'draft' });
    return result;
  });

  // calendars
  handle('calendars.list', () => store.listCalendars());
  handle('calendars.save', (_e, cal) => {
    const saved = store.saveCalendar(cal || {});
    calendar.forget(saved.id);
    return saved;
  });
  handle('calendars.remove', (_e, id) => { store.removeCalendar(id); calendar.forget(id); return true; });
  handle('calendars.check', (_e, cal) => calendar.check(cal || {}));
  handle('calendars.events', (_e, start, end, opts) => calendar.getEvents(start, end, opts || {}));
  handle('calendars.pickFile', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(owner, {
      properties: ['openFile'],
      filters: [{ name: 'Calendar files', extensions: ['ics', 'ical', 'ifb', 'icalendar'] }, { name: 'All files', extensions: ['*'] }]
    });
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
  });

  // settings and contacts
  handle('settings.get', () => store.getSettings());
  handle('settings.set', (_e, patch) => {
    const next = store.setSettings(patch || {});
    schedulePolling();
    return next;
  });
  handle('contacts.search', (_e, prefix) => store.searchContacts(prefix));

  // AI drafting (opt-in; off unless the user has enabled it and saved their own API key)
  handle('ai.getConfig', () => store.getAiConfig());
  handle('ai.setConfig', (_e, input) => store.setAiConfig(input || {}));
  handle('ai.draft', (_e, input) => {
    const cfg = store.getAiConfig();
    if (!cfg.enabled || !cfg.hasKey) throw new Error('Turn on AI drafting and add an API key in Settings → AI first.');
    return ai.draftReply(input || {});
  });

  // app
  handle('app.info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    keyring: process.env.CLASSICMAIL_INSECURE_SECRETS === '1' ? 'insecure-test' : (keyringReady() ? 'ok' : 'missing'),
    dataDir: store.dir
  }));
  handle('app.openExternal', (_e, url) => {
    if (!routeExternal(String(url || ''))) throw new Error('Only web (http/https) and mailto: links can be opened.');
    return true;
  });
  handle('app.checkNow', async () => { await pollOnce(); return true; });

  // compose windows
  handle('compose.open', async (_e, init) => {
    if (!init || typeof init !== 'object') throw new Error('Nothing to compose.');
    const payload = { ...init };
    // Forwarding carries the original attachments along (fetched here; the UI never holds the bytes).
    if (payload.forwardOf && Array.isArray(payload.forwardOf.indexes)) {
      const { accountId, path: folder, uid, indexes } = payload.forwardOf;
      payload.attachments = [];
      for (const index of indexes.slice(0, 20)) {
        const att = await mail.getAttachment(accountId, folder, Number(uid), Number(index));
        payload.attachments.push({
          filename: att.filename,
          contentType: att.contentType,
          size: att.content.length,
          contentBase64: att.content.toString('base64')
        });
      }
    }
    delete payload.forwardOf;
    openCompose(payload);
    return true;
  });
  handle('compose.init', (event) => {
    const record = composeWindows.get(event.sender.id);
    return record ? record.init : null;
  });
  handle('compose.close', (event, { sent, accountId } = {}) => {
    const record = composeWindows.get(event.sender.id);
    if (!record) return false;
    record.allowClose = true;
    if (sent) sendToAll('mail:changed', { accountId, reason: 'sent' });
    record.win.close();
    return true;
  });
}

/** When ClassicMail is the default mail app, the desktop passes the clicked mailto: link as an argument. */
function openMailtoFromArgs(argv) {
  const link = (argv || []).find(a => typeof a === 'string' && /^mailto:/i.test(a));
  if (!link) return;
  const init = parseMailto(link);
  if (init) openCompose({ mode: 'new', ...init });
}

// ---- lifecycle ---------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    openMailtoFromArgs(argv);
  });

  app.whenReady().then(() => {
    store = new Store(path.join(app.getPath('userData'), 'data'), makeSecrets());
    mail = new MailService(store);
    calendar = new CalendarService(store);
    ai = new AiService(store);

    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    // Spell checking downloads its word list from Google's CDN on first use (no mail content is sent). Opt out here.
    if (process.env.CLASSICMAIL_NO_SPELLCHECK === '1') session.defaultSession.setSpellCheckerEnabled(false);

    const template = [
      // Ctrl+Q is "mark as read" in the message list (as in Outlook), so Quit gets a different shortcut.
      { label: 'File', submenu: [{ role: 'quit', accelerator: 'CommandOrControl+Shift+Q' }] },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'resetZoom' }, { role: 'zoomIn', accelerator: 'CommandOrControl+=' }, { role: 'zoomOut' },
          { type: 'separator' }, { role: 'togglefullscreen' },
          ...(DEV ? [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] : [])
        ]
      }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));

    registerIpc();
    createMainWindow();
    openMailtoFromArgs(process.argv);
    setTimeout(pollOnce, 4000);
    schedulePolling();

    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createMainWindow(); });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    clearTimeout(pollTimer);
    if (store) store.flush();
    if (mail) mail.dispose().catch(() => {});
  });
}
