'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Store } = require('../electron/services/store');
const { tempDir, dummySecrets } = require('./helpers');

const gmail = (over = {}) => ({ email: 'Me@Example.com', provider: 'gmail', name: 'Me', ...over });

test('accounts: password is encrypted at rest and never returned', () => {
  const dir = tempDir();
  const s = new Store(dir, dummySecrets);
  const pub = s.saveAccount(gmail(), 'sup3r-secret-app-pw');
  assert.equal(pub.email, 'me@example.com');
  assert.equal(pub.hasPassword, true);
  assert.equal('passwordEnc' in pub, false);
  const onDisk = fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8');
  assert.ok(!onDisk.includes('sup3r-secret-app-pw'), 'plaintext password found on disk');
  assert.equal(s.getSecret(pub.id), 'sup3r-secret-app-pw');
  assert.equal(pub.imap.host, 'imap.gmail.com');
  assert.equal(pub.smtp.port, 465);
  assert.equal((fs.statSync(path.join(dir, 'accounts.json')).mode & 0o777).toString(8), '600');
});

test('accounts: validation', () => {
  const s = new Store(tempDir(), dummySecrets);
  assert.throws(() => s.saveAccount(gmail({ email: 'nope' }), 'x'), /valid email/);
  assert.throws(() => s.saveAccount(gmail(), ''), /password is required/);
  assert.throws(() => s.saveAccount({ email: 'a@b.co', provider: 'other', imap: { host: 'mail.b.co', port: 143, security: 'none' }, smtp: { host: 'mail.b.co', port: 587, security: 'starttls' } }, 'x'), /localhost/);
  assert.throws(() => s.saveAccount({ email: 'a@b.co', provider: 'other', imap: { host: '', port: 993, security: 'ssl' } }, 'x'), /IMAP server is required/);
  assert.throws(() => s.saveAccount({ email: 'a@b.co', provider: 'other', imap: { host: 'h', port: 99999, security: 'ssl' } }, 'x'), /port/);
  s.saveAccount(gmail(), 'pw');
  assert.throws(() => s.saveAccount(gmail(), 'pw'), /already been added/);
});

test('accounts: update keeps password when left blank; remove works; state survives reload', () => {
  const dir = tempDir();
  const s = new Store(dir, dummySecrets);
  const a = s.saveAccount(gmail(), 'first');
  s.saveAccount({ ...gmail(), id: a.id, name: 'Renamed' }, '');
  assert.equal(s.getAccount(a.id).name, 'Renamed');
  assert.equal(s.getSecret(a.id), 'first');
  const s2 = new Store(dir, dummySecrets);
  assert.equal(s2.listAccounts().length, 1);
  assert.equal(s2.getSecret(a.id), 'first');
  s2.removeAccount(a.id);
  assert.equal(s2.listAccounts().length, 0);
  assert.throws(() => s2.removeAccount(a.id), /Unknown account/);
});

test('accounts: each new account gets a distinct colour', () => {
  const s = new Store(tempDir(), dummySecrets);
  const colors = ['a', 'b', 'c'].map(n => s.saveAccount(gmail({ email: `${n}@example.com` }), 'pw').color);
  assert.equal(new Set(colors).size, 3);
});

test('calendars: webcal:// is upgraded, bad links and schemes rejected', () => {
  const s = new Store(tempDir(), dummySecrets);
  const c = s.saveCalendar({ name: 'Work', url: 'webcal://outlook.office365.com/owa/calendar/x/reachcalendar.ics' });
  assert.match(c.url, /^https:\/\/outlook\.office365\.com/);
  assert.throws(() => s.saveCalendar({ url: 'javascript:alert(1)' }), /valid calendar link|https/);
  assert.throws(() => s.saveCalendar({ url: 'file:///etc/passwd' }), /https/);
  assert.throws(() => s.saveCalendar({ url: 'not a url' }), /valid calendar link/);
  assert.equal(s.listCalendars().length, 1);
});

test('settings: only known keys with the right type are accepted and clamped', () => {
  const s = new Store(tempDir(), dummySecrets);
  const out = s.setSettings({ readingPane: 'bottom', listWidth: 99999, checkIntervalSec: 1, evil: true, theme: 'nope' });
  assert.equal(out.readingPane, 'bottom');
  assert.equal(out.listWidth, 900);
  assert.equal(out.checkIntervalSec, 30);
  assert.equal(out.theme, 'system');
  assert.equal('evil' in out, false);
});

test('AI config: key is encrypted at rest, blank keeps it, disabling needs no key', () => {
  const dir = tempDir();
  const s = new Store(dir, dummySecrets);
  assert.deepEqual(s.getAiConfig(), { enabled: false, hasKey: false });
  assert.throws(() => s.setAiConfig({ enabled: true, apiKey: '' }), /Enter an API key/);

  const cfg = s.setAiConfig({ enabled: true, apiKey: 'sk-ant-secret' });
  assert.deepEqual(cfg, { enabled: true, hasKey: true });
  assert.equal(s.getAiKey(), 'sk-ant-secret');
  const onDisk = fs.readFileSync(path.join(dir, 'ai.json'), 'utf8');
  assert.ok(!onDisk.includes('sk-ant-secret'), 'plaintext API key found on disk');

  s.setAiConfig({ enabled: false, apiKey: '' });
  assert.deepEqual(s.getAiConfig(), { enabled: false, hasKey: true });
  assert.equal(s.getAiKey(), 'sk-ant-secret', 'blank apiKey must keep the saved key');

  const s2 = new Store(dir, dummySecrets);
  assert.equal(s2.getAiKey(), 'sk-ant-secret');
});

test('contacts: auto-complete ranks by frequency', () => {
  const s = new Store(tempDir(), dummySecrets);
  s.noteContacts([{ name: 'Ann Lee', address: 'ann@x.com' }, { address: 'bob@x.com' }, { address: 'ann@x.com' }]);
  const r = s.searchContacts('a');
  assert.equal(r[0].address, 'ann@x.com');
  assert.equal(s.searchContacts('').length, 0);
  s.flush();
});
