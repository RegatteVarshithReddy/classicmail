'use strict';
/*
 * Runs the real Electron app (main process, preload bridge, sandboxed renderer, production build loaded
 * from file://) against a local IMAP server (pymap) and a local SMTP sink. No real mail account is used.
 *
 *   npm run build:ui && xvfb-run -a npm run test:electron        (needs pymap:  pip install pymap)
 *
 * Environment: CM_CHROMIUM unused here; Playwright is found globally or in node_modules.
 * Electron runs with --no-sandbox because CI/containers usually run as root; the packaged .deb keeps the sandbox.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { startImap, startSmtp, tempDir } = require('../helpers');

let playwright;
try { playwright = require('playwright'); } catch (_) {
  try { playwright = require(path.join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright')); } catch (__) {
    console.error('Playwright is not installed. Run: npm i -D playwright');
    process.exit(2);
  }
}
const { _electron } = playwright;
const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = process.env.CM_SHOTS;
const results = [];
async function step(name, fn) {
  try { await fn(); results.push([true, name]); console.log('  ok   ' + name); }
  catch (e) { results.push([false, name]); console.log('  FAIL ' + name + '\n       ' + String(e.stack || e).split('\n').slice(0, 6).join('\n       ')); }
}
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `electron-${name}.png`) }); } };

(async () => {
  if (!process.env.CM_PACKAGED && !fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) { console.error('Run `npm run build:ui` first.'); process.exit(2); }
  const imap = await startImap();
  const smtp = await startSmtp();
  const userData = tempDir('classicmail-ud-');
  // CM_PACKAGED=/opt/ClassicMail/classicmail runs the same checks against an installed .deb instead of the source tree.
  const exe = process.env.CM_PACKAGED || require(path.join(ROOT, 'node_modules', 'electron'));
  const appArg = process.env.CM_PACKAGED ? [] : [ROOT];
  const launch = () => _electron.launch({
    executablePath: exe,
    args: [...appArg, '--no-sandbox', `--user-data-dir=${userData}`],
    env: { ...process.env, CLASSICMAIL_INSECURE_SECRETS: '1' },
    timeout: 45000
  });

  let app = await launch();
  let page = await app.firstWindow();
  const problems = [];
  const watch = (p) => p.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  watch(page);
  await page.waitForSelector('.ribbon');

  await step('the production build loads from file:// with the CSP in place and no demo data', async () => {
    assert.equal(await page.title(), 'ClassicMail');
    const csp = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-src 'none'/);
    // No accounts yet, so the real (not demo) app opens Settings on the accounts tab.
    await page.waitForSelector('text=No accounts yet');
  });

  await step('the renderer is sandboxed: no Node, no Electron, only the whitelisted bridge', async () => {
    const probe = await page.evaluate(async () => ({
      require: typeof require, process: typeof process, module: typeof module,
      bridge: Object.keys(window.classicmail).sort(),
      unknown: await window.classicmail.invoke('shell.exec', 'id')
    }));
    assert.equal(probe.require, 'undefined');
    assert.equal(probe.process, 'undefined');
    assert.equal(probe.module, 'undefined');
    assert.deepEqual(probe.bridge, ['invoke', 'on', 'platform']);
    assert.equal(probe.unknown.ok, false);
  });

  await step('a wrong password is reported and nothing is saved', async () => {
    await page.locator('.settings-body .btn.primary', { hasText: 'Add account' }).click();
    await page.locator('.form select').first().selectOption('other');
    await page.locator('input[type=email]').fill('demo@example.com');
    await page.locator('input[type=password]').fill('not-the-password');
    await page.getByLabel('Incoming (IMAP) server').waitFor(); // the server section is open by default for a new account
    await page.getByLabel('Incoming (IMAP) server').fill('127.0.0.1');
    await page.getByLabel('Incoming (IMAP) port').fill(String(imap.port));
    await page.getByLabel('Incoming (IMAP) security').selectOption('none');
    await page.getByLabel('Outgoing (SMTP) server').fill('127.0.0.1');
    await page.getByLabel('Outgoing (SMTP) port').fill(String(smtp.port));
    await page.getByLabel('Outgoing (SMTP) security').selectOption('none');
    await page.locator('.form-grid:has-text("User name") input').fill('demouser');
    await page.locator('.form-actions .btn.primary').click();
    await page.waitForSelector('.test-line.bad');
    assert.match(await page.locator('.test-line.bad').first().textContent(), /password|rejected|login/i);
    assert.equal(await page.locator('.card:has-text("demo@example.com")').count(), 0);
    await shot(page, 'bad-login');
  });

  await step('the right password connects to IMAP and SMTP and saves the account', async () => {
    await page.locator('input[type=password]').fill('demopass');
    await page.locator('.form-actions .btn.primary, .form-actions .btn.danger').last().click();
    await page.waitForSelector('.card:has-text("demo@example.com")');
    const stored = fs.readFileSync(path.join(userData, 'data', 'accounts.json'), 'utf8');
    assert.ok(!stored.includes('demopass'), 'the password must not be written to accounts.json');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.tree-head:has-text("demo@example.com")');
  });

  await step('the inbox lists the server\'s messages and opens one in the sandboxed reading pane', async () => {
    await page.locator('.tree-row', { hasText: 'Inbox' }).nth(1).click();
    await page.waitForSelector('.msg-row');
    const rows = await page.locator('.msg-row').count();
    assert.equal(rows, 4, 'pymap demo data has four messages');
    await page.locator('.msg-row').first().click();
    await page.waitForSelector('iframe.body-frame, .reading iframe');
    const frame = page.frameLocator('iframe').first();
    await frame.locator('body').waitFor();
    assert.ok((await frame.locator('body').innerText()).trim().length > 0, 'message body is shown');
    assert.equal(await page.locator('iframe').first().getAttribute('sandbox'), 'allow-popups allow-popups-to-escape-sandbox');
    await shot(page, 'inbox');
  });

  await step('Ctrl+Q marks the message read instead of quitting the app (Outlook shortcut)', async () => {
    await page.locator('.msg-row').first().click();
    await page.keyboard.press('Control+U');
    await page.waitForSelector('.msg-row.unread.selected');
    await page.keyboard.press('Control+Q');
    await page.waitForFunction(() => !document.querySelector('.msg-row.selected.unread'));
    assert.equal(await page.locator('.ribbon').count(), 1, 'the app must still be running');
  });

  await step('deleting a message moves it to Deleted Items on the server', async () => {
    const before = await page.locator('.msg-row').count();
    await page.locator('.msg-row').first().click();
    await page.keyboard.press('Delete');
    await page.waitForFunction(n => document.querySelectorAll('.msg-row').length === n, before - 1);
    await page.locator('.tree-row', { hasText: 'Deleted Items' }).click();
    await page.waitForSelector('.msg-row');
    assert.ok(await page.locator('.msg-row').count() >= 1);
    // Ask the server directly, through a fresh IMAP session, that the message really is gone from INBOX.
    const { ImapFlow } = require('imapflow');
    const c = new ImapFlow({ host: '127.0.0.1', port: imap.port, secure: false, auth: { user: 'demouser', pass: 'demopass' }, logger: false, disableAutoIdle: true });
    await c.connect();
    const inbox = await c.status('INBOX', { messages: true });
    await c.logout();
    assert.equal(inbox.messages, 3);
  });

  await step('composing in the pop-out window sends through SMTP and files a copy in Sent Items', async () => {
    await page.locator('.tree-row', { hasText: 'Inbox' }).nth(1).click();
    const popup = app.waitForEvent('window');
    await page.locator('.rbtn', { hasText: 'New Email' }).click();
    const compose = await popup;
    watch(compose);
    await compose.waitForSelector('[aria-label="To"]');
    await compose.locator('[aria-label="To"]').fill('someone@example.net');
    await compose.keyboard.press('Enter');
    await compose.locator('#subject-input').fill('Electron end-to-end test');
    await compose.locator('[aria-label="Message body"]').click();
    await compose.keyboard.type('Sent from the real Electron app.');
    await shot(compose, 'compose');
    await compose.locator('.send-btn').click();
    await compose.waitForEvent('close', { timeout: 20000 });
    await smtpHas(smtp, 'Electron end-to-end test');
    const got = smtp.received.find(m => m.parsed.subject === 'Electron end-to-end test');
    assert.equal(got.parsed.to.value[0].address, 'someone@example.net');
    assert.match(got.parsed.text, /Sent from the real Electron app/);
    assert.equal(got.parsed.from.value[0].address, 'demo@example.com');
    await page.locator('.tree-row', { hasText: 'Sent Items' }).click();
    await page.waitForSelector('.msg-row:has-text("Electron end-to-end test")', { timeout: 15000 });
  });

  await step('a read-only calendar file is loaded, expanded and shown', async () => {
    const ics = path.join(ROOT, 'test', 'fixtures', 'sample.ics');
    const res = await page.evaluate(p => window.classicmail.invoke('calendars.save', { type: 'file', path: p, name: 'Work', color: '#0f6cbd', enabled: true }), ics);
    assert.equal(res.ok, true, JSON.stringify(res));
    const events = await page.evaluate(() => window.classicmail.invoke('calendars.events', '2026-09-21T00:00:00.000Z', '2026-09-28T00:00:00.000Z'));
    assert.equal(events.ok, true, JSON.stringify(events));
    const list = events.data.events || events.data;
    assert.ok(list.some(e => /standup/i.test(e.summary || e.title || '')), 'recurring standup expanded');
    await page.reload(); // this calendar was added behind the UI's back; Settings normally refreshes the list
    await page.waitForSelector('.tree-head:has-text("demo@example.com")');
    await page.locator('.nav-switch button', { hasText: 'Calendar' }).click();
    await page.waitForSelector('.tg-ev');
    await page.locator('.tg-ev', { hasText: 'Daily Standup' }).first().click();
    await page.waitForSelector('.ev-pop');
    assert.match(await page.locator('.ev-pop').textContent(), /Join/);
    await shot(page, 'calendar');
    await page.keyboard.press('Escape');
    await page.locator('.nav-switch button', { hasText: 'Mail' }).click();
  });

  await step('a calendar with an endless recurrence rule cannot freeze the app, and the rest of it still shows', async () => {
    const evil = path.join(userData, 'endless.ics');
    fs.writeFileSync(evil, ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
      'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Never happens', 'DTSTART:20260101T100000Z', 'DTEND:20260101T110000Z', 'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Still shown', 'DTSTART:20260929T140000Z', 'DTEND:20260929T150000Z', 'END:VEVENT',
      'END:VCALENDAR'].join('\r\n'));
    const saved = await page.evaluate(p => window.classicmail.invoke('calendars.save', { type: 'file', path: p, name: 'Endless', color: '#a4262c', enabled: true }), evil);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const started = Date.now();
    const pending = page.evaluate(() => window.classicmail.invoke('calendars.events', '2026-09-27T00:00:00.000Z', '2026-10-05T00:00:00.000Z', { force: true }));
    // The window must keep answering while the calendar is being read.
    let answered = 0;
    while (Date.now() - started < 4000) { assert.equal(await page.evaluate(() => 1 + 1), 2); answered += 1; await page.waitForTimeout(250); }
    assert.ok(answered >= 8, 'the UI stayed responsive');
    const res = await pending;
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(Date.now() - started < 40000, 'finished in bounded time');
    assert.ok(res.data.events.some(e => e.title === 'Still shown'));
    assert.ok(!res.data.events.some(e => e.title === 'Never happens'));
    const st = res.data.status.find(x => x.error);
    assert.match(st.error, /could not be read/);
    const list = await page.evaluate(() => window.classicmail.invoke('calendars.list'));
    for (const c of list.data.filter(c => c.name === 'Endless')) await page.evaluate(id => window.classicmail.invoke('calendars.remove', id), c.id);
  });

  await step('links in mail open in the system browser, never inside the app window', async () => {
    const urls = await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (u) => { globalThis.__opened.push(u); }; return true; });
    assert.equal(urls, true);
    const win = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    assert.ok(win >= 1);
    const r = await page.evaluate(() => window.classicmail.invoke('app.openExternal', 'file:///etc/passwd'));
    assert.equal(r.ok, false, 'non-http(s) URLs are refused');
    const ok = await page.evaluate(() => window.classicmail.invoke('app.openExternal', 'https://example.com/x'));
    assert.equal(ok.ok, true);
    const opened = await app.evaluate(() => globalThis.__opened);
    assert.deepEqual(opened, ['https://example.com/x']);
  });

  await step('clicking a mailto: link elsewhere on the desktop opens a pre-filled compose window', async () => {
    const popup = app.waitForEvent('window');
    // This is exactly what the desktop runs for `Exec=classicmail %U` when ClassicMail is the default mail app.
    const second = require('child_process').spawn(exe,
      [...appArg, '--no-sandbox', `--user-data-dir=${userData}`, 'mailto:friend@example.net?subject=Lunch%20on%20Friday&attach=/etc/passwd'],
      { env: { ...process.env, CLASSICMAIL_INSECURE_SECRETS: '1' }, stdio: 'ignore' });
    const secondExited = new Promise(r => second.on('exit', r));
    const compose = await popup;
    await compose.waitForSelector('#subject-input');
    assert.equal(await compose.locator('#subject-input').inputValue(), 'Lunch on Friday');
    assert.match(await compose.locator('.recip').first().textContent(), /friend@example\.net/);
    assert.equal(await compose.locator('.attach-strip .chip').count(), 0, 'a mailto attach= parameter must never attach a local file');
    await secondExited; // the second instance hands the link over and quits by itself
    await compose.evaluate(() => window.classicmail.invoke('compose.close', {})).catch(() => {}); // the window closes under us
  });

  await step('after a restart the account, the saved password and the calendar are still there', async () => {
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    watch(page);
    await page.waitForSelector('.tree-head:has-text("demo@example.com")');
    await page.locator('.tree-row', { hasText: 'Inbox' }).nth(1).click();
    await page.waitForSelector('.msg-row');
    assert.equal(await page.locator('.msg-row').count(), 3);
    const cals = await page.evaluate(() => window.classicmail.invoke('calendars.list'));
    assert.equal(cals.data.length, 1);
    await shot(page, 'restart');
  });

  await step('no unexpected errors reached the console', async () => { assert.deepEqual(problems, []); });

  await app.close();
  imap.stop();
  await smtp.stop();
  fs.rmSync(userData, { recursive: true, force: true });
  const failed = results.filter(r => !r[0]);
  console.log(`\n${results.length - failed.length}/${results.length} Electron checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

async function smtpHas(smtp, subject, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (smtp.received.some(m => m.parsed.subject === subject)) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`SMTP server never received "${subject}"`);
}
