'use strict';
/**
 * Persistent store for accounts, calendars, settings and the contact cache.
 *
 * Passwords never touch disk in clear text: they go through the `secrets`
 * adapter ({encrypt(plain) -> string, decrypt(string) -> plain}). In the app
 * that adapter wraps Electron's safeStorage (libsecret / GNOME Keyring on
 * Ubuntu). Tests pass a reversible dummy adapter.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PRESETS = {
  gmail: {
    label: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'ssl' },
    note: 'Use a Google app password (Google Account > Security > 2-Step Verification > App passwords), not your normal password.'
  },
  yahoo: {
    label: 'Yahoo Mail',
    imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'ssl' },
    note: 'Use a Yahoo app password.'
  },
  icloud: {
    label: 'iCloud Mail',
    imap: { host: 'imap.mail.me.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    note: 'Use an app-specific password from appleid.apple.com.'
  },
  fastmail: {
    label: 'Fastmail',
    imap: { host: 'imap.fastmail.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.fastmail.com', port: 465, security: 'ssl' },
    note: 'Use a Fastmail app password.'
  },
  other: {
    label: 'Other IMAP account',
    imap: { host: '', port: 993, security: 'ssl' },
    smtp: { host: '', port: 465, security: 'ssl' },
    note: ''
  }
};

const ACCOUNT_COLORS = ['#0072c6', '#d83b01', '#107c10', '#8764b8', '#b4009e', '#008272', '#c239b3', '#ca5010'];
const CALENDAR_COLORS = ['#0072c6', '#107c10', '#d83b01', '#8764b8', '#008272', '#b4009e', '#ca5010'];
const SECURITY = ['ssl', 'starttls', 'none'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const DEFAULT_SETTINGS = {
  readingPane: 'right',      // right | bottom | off
  markReadDelayMs: 1500,     // 0 = immediately, -1 = never
  loadRemoteImages: false,   // block remote images until the user clicks
  notifications: true,
  checkIntervalSec: 90,
  listWidth: 380,
  theme: 'system'            // system | light | dark
};

class ValidationError extends Error {}

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Corrupt file: keep a copy so nothing is silently lost.
      try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch (_) { /* ignore */ }
    }
    return fallback;
  }
}

function str(v, max = 500) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function normalizeEndpoint(input, label, { allowNone }) {
  const host = str(input && input.host, 253);
  const port = Number(input && input.port);
  const security = SECURITY.includes(input && input.security) ? input.security : 'ssl';
  if (!host) throw new ValidationError(`${label} server is required.`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ValidationError(`${label} port must be between 1 and 65535.`);
  if (security === 'none' && !(allowNone || LOCAL_HOSTS.has(host))) {
    throw new ValidationError(`${label}: unencrypted connections are only allowed to localhost.`);
  }
  return { host, port, security };
}

class Store {
  constructor(dir, secrets) {
    if (!secrets || typeof secrets.encrypt !== 'function' || typeof secrets.decrypt !== 'function') {
      throw new Error('Store needs a secrets adapter');
    }
    this.dir = dir;
    this.secrets = secrets;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.cacheDir = path.join(dir, 'cache');
    fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
    this.files = {
      accounts: path.join(dir, 'accounts.json'),
      calendars: path.join(dir, 'calendars.json'),
      settings: path.join(dir, 'settings.json'),
      contacts: path.join(dir, 'contacts.json'),
      ai: path.join(dir, 'ai.json')
    };
    this._accounts = readJson(this.files.accounts, []);
    this._calendars = readJson(this.files.calendars, []);
    this._settings = Object.assign({}, DEFAULT_SETTINGS, readJson(this.files.settings, {}));
    this._contacts = readJson(this.files.contacts, {});
    this._ai = Object.assign({ enabled: false, apiKeyEnc: '' }, readJson(this.files.ai, {}));
  }

  // ---- accounts -------------------------------------------------------
  _publicAccount(a) {
    // eslint-disable-next-line no-unused-vars
    const { passwordEnc, ...rest } = a;
    return { ...rest, hasPassword: Boolean(passwordEnc) };
  }

  listAccounts() {
    return this._accounts.map(a => this._publicAccount(a));
  }

  getAccount(id) {
    const a = this._accounts.find(x => x.id === id);
    if (!a) throw new Error('Unknown account');
    return this._publicAccount(a);
  }

  getSecret(id) {
    const a = this._accounts.find(x => x.id === id);
    if (!a || !a.passwordEnc) throw new Error('No saved password for this account');
    return this.secrets.decrypt(a.passwordEnc);
  }

  /** Validate an account draft without saving it. Returns the normalized account. */
  normalizeAccount(input, existing) {
    const email = str(input.email, 320).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('Enter a valid email address.');
    const provider = Object.prototype.hasOwnProperty.call(PRESETS, input.provider) ? input.provider : 'other';
    const preset = PRESETS[provider];
    const imap = normalizeEndpoint(input.imap || preset.imap, 'IMAP', {});
    const smtp = normalizeEndpoint(input.smtp || preset.smtp, 'SMTP', {});
    const usedColors = new Set(this._accounts.map(a => a.color));
    const color = /^#[0-9a-fA-F]{6}$/.test(input.color || '')
      ? input.color
      : (existing && existing.color) || ACCOUNT_COLORS.find(c => !usedColors.has(c)) || ACCOUNT_COLORS[this._accounts.length % ACCOUNT_COLORS.length];
    return {
      id: existing ? existing.id : (input.id || crypto.randomUUID()),
      name: str(input.name, 120) || email.split('@')[0],
      email,
      user: str(input.user, 320) || email,
      provider,
      imap,
      smtp,
      color,
      signature: str(input.signature, 4000),
      enabled: input.enabled !== false,
      allowSelfSigned: Boolean(input.allowSelfSigned)
    };
  }

  /** Create or update. `password` is required for new accounts; blank keeps the old one. */
  saveAccount(input, password) {
    const idx = input.id ? this._accounts.findIndex(a => a.id === input.id) : -1;
    const existing = idx >= 0 ? this._accounts[idx] : null;
    if (!existing && this._accounts.some(a => a.email === str(input.email, 320).toLowerCase())) {
      throw new ValidationError('That account has already been added.');
    }
    const acc = this.normalizeAccount(input, existing);
    let passwordEnc = existing ? existing.passwordEnc : '';
    if (password) passwordEnc = this.secrets.encrypt(String(password));
    if (!passwordEnc) throw new ValidationError('A password is required.');
    const rec = { ...acc, passwordEnc };
    if (existing) this._accounts[idx] = rec; else this._accounts.push(rec);
    atomicWrite(this.files.accounts, JSON.stringify(this._accounts, null, 2));
    return this._publicAccount(rec);
  }

  removeAccount(id) {
    const before = this._accounts.length;
    this._accounts = this._accounts.filter(a => a.id !== id);
    if (this._accounts.length === before) throw new Error('Unknown account');
    atomicWrite(this.files.accounts, JSON.stringify(this._accounts, null, 2));
  }

  // ---- calendars ------------------------------------------------------
  listCalendars() {
    return this._calendars.slice();
  }

  saveCalendar(input) {
    const type = input.type === 'file' ? 'file' : 'url';
    let url = '';
    let filePath = '';
    if (type === 'url') {
      url = str(input.url, 2000).replace(/^webcal:\/\//i, 'https://');
      let parsed;
      try { parsed = new URL(url); } catch (_) { throw new ValidationError('Enter a valid calendar link (https:// or webcal://).'); }
      if (!/^https?:$/.test(parsed.protocol)) throw new ValidationError('Calendar links must start with https:// or webcal://.');
    } else {
      filePath = str(input.path, 2000);
      if (!filePath) throw new ValidationError('Choose an .ics file.');
    }
    const idx = input.id ? this._calendars.findIndex(c => c.id === input.id) : -1;
    const used = new Set(this._calendars.map(c => c.color));
    const rec = {
      id: idx >= 0 ? this._calendars[idx].id : crypto.randomUUID(),
      name: str(input.name, 120) || 'Calendar',
      type,
      url,
      path: filePath,
      color: /^#[0-9a-fA-F]{6}$/.test(input.color || '') ? input.color : (idx >= 0 ? this._calendars[idx].color : (CALENDAR_COLORS.find(c => !used.has(c)) || CALENDAR_COLORS[this._calendars.length % CALENDAR_COLORS.length])),
      enabled: input.enabled !== false
    };
    if (idx >= 0) this._calendars[idx] = rec; else this._calendars.push(rec);
    atomicWrite(this.files.calendars, JSON.stringify(this._calendars, null, 2));
    return rec;
  }

  removeCalendar(id) {
    this._calendars = this._calendars.filter(c => c.id !== id);
    atomicWrite(this.files.calendars, JSON.stringify(this._calendars, null, 2));
  }

  // ---- settings -------------------------------------------------------
  getSettings() {
    return { ...this._settings };
  }

  setSettings(patch) {
    const next = { ...this._settings };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, key) && typeof patch[key] === typeof DEFAULT_SETTINGS[key]) {
        next[key] = patch[key];
      }
    }
    if (!['right', 'bottom', 'off'].includes(next.readingPane)) next.readingPane = 'right';
    if (!['system', 'light', 'dark'].includes(next.theme)) next.theme = 'system';
    next.listWidth = Math.min(900, Math.max(260, Math.round(next.listWidth)));
    next.checkIntervalSec = Math.min(3600, Math.max(30, Math.round(next.checkIntervalSec)));
    this._settings = next;
    atomicWrite(this.files.settings, JSON.stringify(next, null, 2));
    return this.getSettings();
  }

  // ---- AI drafting (opt-in; key encrypted the same way as account passwords) --
  getAiConfig() {
    return { enabled: this._ai.enabled, hasKey: Boolean(this._ai.apiKeyEnc) };
  }

  /** `apiKey` is optional: blank keeps the previously saved key, same as account passwords. */
  setAiConfig({ enabled, apiKey }) {
    const next = { enabled: Boolean(enabled), apiKeyEnc: this._ai.apiKeyEnc };
    if (apiKey) next.apiKeyEnc = this.secrets.encrypt(String(apiKey));
    if (next.enabled && !next.apiKeyEnc) throw new ValidationError('Enter an API key to enable AI drafting.');
    this._ai = next;
    atomicWrite(this.files.ai, JSON.stringify(next, null, 2));
    return this.getAiConfig();
  }

  /** Main-process only: never exposed over IPC. */
  getAiKey() {
    if (!this._ai.apiKeyEnc) throw new Error('No Claude API key saved.');
    return this.secrets.decrypt(this._ai.apiKeyEnc);
  }

  // ---- contact cache (for address auto-complete) ------------------------
  noteContacts(list) {
    let changed = false;
    for (const c of list || []) {
      const address = str(c && c.address, 320).toLowerCase();
      if (!address || !address.includes('@')) continue;
      const cur = this._contacts[address] || { address, name: '', count: 0 };
      if (c.name && !cur.name) cur.name = str(c.name, 120);
      cur.count += 1;
      cur.last = Date.now();
      this._contacts[address] = cur;
      changed = true;
    }
    if (changed) {
      const all = Object.values(this._contacts);
      if (all.length > 5000) {
        all.sort((a, b) => (b.count - a.count) || (b.last - a.last));
        this._contacts = Object.fromEntries(all.slice(0, 4000).map(c => [c.address, c]));
      }
      clearTimeout(this._contactTimer);
      this._contactTimer = setTimeout(() => {
        try { atomicWrite(this.files.contacts, JSON.stringify(this._contacts)); } catch (_) { /* ignore */ }
      }, 2000);
      if (this._contactTimer.unref) this._contactTimer.unref();
    }
  }

  flush() {
    clearTimeout(this._contactTimer);
    try { atomicWrite(this.files.contacts, JSON.stringify(this._contacts)); } catch (_) { /* ignore */ }
  }

  searchContacts(prefix, limit = 8) {
    const q = str(prefix, 100).toLowerCase();
    if (q.length < 1) return [];
    return Object.values(this._contacts)
      .filter(c => c.address.includes(q) || (c.name && c.name.toLowerCase().includes(q)))
      .sort((a, b) => (b.count - a.count) || (b.last - a.last))
      .slice(0, limit)
      .map(c => ({ name: c.name, address: c.address }));
  }
}

module.exports = { Store, PRESETS, DEFAULT_SETTINGS, ValidationError };
