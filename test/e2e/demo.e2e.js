'use strict';
/*
 * End-to-end check of the user interface against the built-in demo data (no real mail server needed).
 *
 *   npm run test:e2e
 *
 * Needs Playwright with a Chromium build:  npm i -D playwright && npx playwright install chromium
 * (or point CM_CHROMIUM at any Chromium/Chrome binary).
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {
  try { ({ chromium } = require(path.join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright'))); } catch (__) {
    console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
    process.exit(2);
  }
}

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'dist-mock');
const SHOTS = process.env.CM_SHOTS || '';

function build() {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: ROOT, env: { ...process.env, CM_MOCK: '1', CM_OUT: 'dist-mock' }, stdio: 'ignore' });
}

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const file = path.join(OUT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(OUT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

const results = [];
async function step(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`  ok   ${name}`); }
  catch (err) { results.push([false, name]); console.log(`  FAIL ${name}\n       ${String(err.message).split('\n').join('\n       ')}`); }
}

(async () => {
  build();
  const { server, url } = await serve();
  const browser = await chromium.launch({ executablePath: process.env.CM_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 880 } });
  const hits = [];
  ctx.on('request', r => hits.push(r.url()));
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/tracker\.example|ERR_TUNNEL|ERR_NAME|ERR_INTERNET|Content Security Policy/.test(m.text())) problems.push(`${m.text()} @ ${m.location().url}`); });
  const shot = async (n) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${n}.png`) }); };
  const rows = () => page.locator('.msg-row');
  const row = text => page.locator('.msg-row', { hasText: text });
  const unreadTotal = async () => Number((await page.locator('.tree-row.fav', { hasText: 'All Inboxes' }).locator('.tree-count').textContent().catch(() => '0')) || 0);

  await page.goto(url);
  await page.waitForSelector('.msg-row');

  await step('unified inbox lists mail from all three accounts, newest first, with the right unread total', async () => {
    assert.equal(await rows().count(), 15);
    assert.equal(await unreadTotal(), 6);
    const first = await rows().first().textContent();
    assert.match(first, /Priya Nair/);
    const dots = await page.locator('.msg-row .dot').evaluateAll(els => new Set(els.map(e => e.style.background)).size);
    assert.equal(dots, 3, 'each account has its own colour');
  });

  await step('selecting a message shows it, and it is marked read after the delay', async () => {
    await row('Dana Whitfield').click();
    await page.waitForSelector('.read-subject:has-text("All-hands moved")');
    assert.ok(await row('Dana Whitfield').evaluate(e => e.classList.contains('unread')));
    await page.waitForFunction(() => !document.querySelector('.msg-row.selected').classList.contains('unread'), null, { timeout: 4000 });
    assert.equal(await unreadTotal(), 5);
    assert.equal((await page.locator('.tree-account:has-text("alex@northwind.example") .tree-row', { hasText: 'Inbox' }).locator('.tree-count').textContent()).trim(), '1');
  });

  await step('mark unread / flag from the ribbon update the row and the counts', async () => {
    await page.locator('.rbtn', { hasText: /^Unread$/ }).click();
    assert.ok(await row('Dana Whitfield').evaluate(e => e.classList.contains('unread')));
    assert.equal(await unreadTotal(), 6);
    await page.locator('.rbtn', { hasText: /^Flag$/ }).click();
    assert.equal(await row('Dana Whitfield').locator('.row-ico.flag').count(), 1);
    await page.locator('.rbtn', { hasText: /Clear Flag/ }).click();
    assert.equal(await row('Dana Whitfield').locator('.row-ico.flag').count(), 0);
    await page.locator('.rbtn', { hasText: /^Read$/ }).click();
    assert.equal(await unreadTotal(), 5);
  });

  await step('hostile HTML: nothing runs or loads until "Download pictures" is clicked', async () => {
    hits.length = 0;
    await row('Invoice #8841').click();
    await page.waitForSelector('.banner.warn');
    await page.waitForTimeout(700);
    assert.deepEqual(hits.filter(u => /tracker\.example|evil\.example|newsletter\.example/.test(u)), []);
    const doc = await page.locator('.body-frame').getAttribute('srcdoc');
    for (const bad of ['<script', 'onerror', 'onclick', 'javascript:', '<form', '<iframe', '<input', 'tracker.example']) assert.ok(!doc.includes(bad), `srcdoc must not contain ${bad}`);
    assert.equal(await page.title(), 'ClassicMail');
    assert.equal(await page.locator('.body-frame').getAttribute('sandbox'), 'allow-popups allow-popups-to-escape-sandbox', 'no scripts, no same-origin');
    await page.locator('.banner.warn button').click();
    await page.waitForFunction(() => !document.querySelector('.banner.warn'));
    await page.waitForTimeout(500);
    assert.ok(hits.some(u => /tracker\.example/.test(u)), 'pictures load once the user asks');
  });

  await step('reply and draft windows never fetch remote content that came from mail', async () => {
    const isTracker = u => /tracker\.example|evil\.example/.test(u);
    const forbidden = ['tracker.example', 'image-set(', '\\72', 'cross-fade(', '@import', '<style', '<script', 'url('];
    const logs = [];
    // 1. Reply quotes the hostile HTML into the editor.
    hits.length = 0;
    await row('Invoice #8841').click();
    await page.waitForSelector('.body-frame');
    const [reply] = await Promise.all([ctx.waitForEvent('page'), page.locator('.rbtn', { hasText: /^Reply$/ }).click()]);
    reply.on('console', m => logs.push(m.text()));
    await reply.waitForSelector('.editor');
    await reply.waitForTimeout(900);
    assert.deepEqual(hits.filter(isTracker), [], 'the quoted reply must not load anything');
    const quoted = await reply.locator('.editor').innerHTML();
    for (const bad of forbidden) assert.ok(!quoted.includes(bad), `editor content must not contain ${bad}`);
    assert.match(quoted, /quick note about your invoice/, 'the readable content is still quoted');
    // Backstop: even if markup got through, the window's own policy refuses remote pictures.
    await reply.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<img src="https://tracker.example/backstop.gif">'));
    await reply.waitForTimeout(500);
    assert.ok(logs.some(t => /Content Security Policy|Refused to load/i.test(t)), 'the compose window CSP blocks remote images');
    await reply.close();

    // 2. An old draft that contains the same tricks.
    hits.length = 0;
    await page.evaluate(() => localStorage.setItem('cmComposeInit', JSON.stringify({
      mode: 'draft', accountId: 'a1', to: [], cc: [], bcc: [], subject: 'Old draft',
      html: '<p>Draft text</p><img src="https://tracker.example/draft.gif"><div style="background:image-set(\'https://tracker.example/d.png\' 1x);color:red">styled</div><style>@import url(https://tracker.example/d.css)</style>'
    })));
    const draft = await ctx.newPage();
    await draft.goto(`${url}#compose`);
    await draft.waitForSelector('.editor');
    await draft.waitForTimeout(900);
    assert.deepEqual(hits.filter(isTracker), [], 'an old draft must not load anything');
    const html = await draft.locator('.editor').innerHTML();
    for (const bad of forbidden) assert.ok(!html.includes(bad), `draft content must not contain ${bad}`);
    assert.match(html, /Draft text/);
    assert.match(html, /color:\s*red/, 'harmless styling is kept');
    await draft.close();
    await page.evaluate(() => localStorage.removeItem('cmComposeInit'));
  });

  await step('mailing-list messages offer Unsubscribe; attachments are listed', async () => {
    await row('Five layouts').click();
    await page.waitForSelector('.banner.info');
    assert.ok(await page.locator('.rbtn', { hasText: 'Unsubscribe' }).isEnabled());
    await row('Q4 roadmap').click();
    await page.waitForSelector('.attach-strip .chip');
    assert.equal(await page.locator('.attach-strip .chip').count(), 2);
  });

  await step('search filters the list', async () => {
    await page.locator('.search-input').fill('lunch');
    await page.waitForFunction(() => document.querySelectorAll('.msg-row').length === 1);
    assert.match(await rows().first().textContent(), /Jordan Lee/);
    await page.locator('.search-input').fill('');
    await page.waitForFunction(() => document.querySelectorAll('.msg-row').length === 15);
  });

  await step('keyboard: arrows move the selection, Delete removes the message and selects the next one', async () => {
    await row('Priya Nair').click();
    await page.keyboard.press('ArrowDown');
    assert.ok(await row('Dana Whitfield').evaluate(e => e.classList.contains('selected')));
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => document.querySelectorAll('.msg-row').length === 14);
    assert.equal(await row('Dana Whitfield').count(), 0);
    assert.ok(await row('The Design Digest').evaluate(e => e.classList.contains('selected')), 'next message is selected');
  });

  await step('deleted mail is in Deleted Items; deleting there asks before removing for good', async () => {
    await page.locator('.tree-account:has-text("alex@northwind.example") .tree-row', { hasText: 'Deleted Items' }).click();
    await page.waitForSelector('.msg-row:has-text("All-hands moved")');
    await row('All-hands moved').click();
    await page.keyboard.press('Delete');
    await page.waitForSelector('.modal:has-text("Delete permanently")');
    await page.locator('.modal .btn', { hasText: 'Cancel' }).click();
    assert.equal(await row('All-hands moved').count(), 1, 'cancel keeps the message');
    await page.keyboard.press('Delete');
    await page.locator('.modal .btn.danger', { hasText: 'Delete' }).click();
    await page.waitForFunction(() => !document.body.innerText.includes('All-hands moved to 3pm'));
  });

  await step('drag and drop moves a message to another folder of the same account', async () => {
    await page.locator('.tree-row', { hasText: 'alex.morgan' }).first().click().catch(() => {});
    await page.locator('.tree-account:has-text("alex.morgan@example.com") .tree-row', { hasText: 'Inbox' }).first().click();
    await page.waitForSelector('.msg-row:has-text("Photos from the offsite")');
    await row('Photos from the offsite').dragTo(page.locator('.tree-account:has-text("alex.morgan@example.com") .tree-row', { hasText: 'Archive' }));
    await page.waitForFunction(() => !document.body.innerText.includes('Photos from the offsite'));
    await page.locator('.tree-account:has-text("alex.morgan@example.com") .tree-row', { hasText: 'Archive' }).click();
    await page.waitForSelector('.msg-row:has-text("Photos from the offsite")');
  });

  await step('moving across accounts is refused with a clear message', async () => {
    await page.locator('.tree-row.fav', { hasText: 'All Inboxes' }).click();
    await page.waitForSelector('.msg-row:has-text("IT Helpdesk")');
    await row('IT Helpdesk').dragTo(page.locator('.tree-account:has-text("alex.m@example.org") .tree-row', { hasText: 'Archive' }));
    await page.waitForSelector('.status-msg.error');
    assert.match(await page.locator('.status-msg.error').textContent(), /same account/);
    assert.equal(await row('IT Helpdesk').count(), 1, 'message stays put');
  });

  let popup;
  await step('Reply opens a compose window with recipient, subject and quoted original', async () => {
    await row('Q4 roadmap').click();
    const [p] = await Promise.all([ctx.waitForEvent('page'), page.locator('.rbtn', { hasText: /^Reply$/ }).click()]);
    popup = p;
    await popup.waitForSelector('.editor');
    await popup.waitForTimeout(300);
    assert.match(await popup.locator('.addr-box').first().textContent(), /Priya Nair/);
    assert.equal(await popup.locator('#subject-input').inputValue(), 'RE: Q4 roadmap review – slides attached');
    const body = await popup.locator('.editor').innerText();
    assert.match(body, /Alex Morgan/, 'signature');
    assert.match(body, /From:.*Priya Nair/s);
    assert.match(body, /slide 7/);
    assert.equal(await popup.locator('.from option:checked').textContent(), 'Alex Morgan <alex.morgan@example.com>');
    if (SHOTS) await popup.screenshot({ path: path.join(SHOTS, 'compose.png') });
  });

  await step('compose validates recipients, offers address suggestions, and sends', async () => {
    await popup.locator('.recip-x').first().click(); // remove Priya
    await popup.locator('.rbtn, .send-btn').first().click();
    await popup.waitForSelector('.banner.error');
    assert.match(await popup.locator('.banner.error').textContent(), /at least one recipient/);
    await popup.locator('.addr-input').first().fill('jor');
    await popup.waitForSelector('.sug');
    assert.match(await popup.locator('.sug').first().textContent(), /Jordan Lee/);
    await popup.keyboard.press('ArrowDown');
    await popup.keyboard.press('Enter');
    await popup.locator('.addr-box').nth(1).locator('.addr-input').fill('not-an-address');
    await popup.keyboard.press('Enter');
    await popup.locator('.send-btn').click();
    await popup.waitForFunction(() => /not a valid email/.test(document.querySelector('.banner.error').textContent));
    await popup.locator('.addr-box').nth(1).locator('.recip-x').click();
    await popup.locator('.editor').click();
    await popup.keyboard.type('Thanks, looks good.');
    const closed = popup.waitForEvent('close');
    await popup.locator('.send-btn').click();
    await closed;
  });

  await step('sent mail appears in Sent Items', async () => {
    await page.locator('.tree-account:has-text("alex.morgan@example.com") .tree-row', { hasText: 'Sent Items' }).click();
    await page.waitForSelector('.msg-row:has-text("RE: Q4 roadmap")');
  });

  await step('the calendar shows the week, event details with a Join button, and every view mode', async () => {
    await page.locator('.nav-switch button', { hasText: 'Calendar' }).click();
    await page.waitForSelector('.tg-ev');
    const title = await page.locator('.cal-title h2').textContent();
    assert.doesNotMatch(title, /day:/);
    assert.match(title, /2026/);
    assert.equal(await page.locator('.tg-day').count(), 5);
    await page.locator('.tg-ev', { hasText: 'Design sync' }).click();
    await page.waitForSelector('.ev-pop .join');
    assert.match(await page.locator('.ev-pop').textContent(), /Google Meet/);
    await page.keyboard.press('Escape');
    for (const [label, cols] of [['Week', 7], ['Day', 1], ['Work Week', 5]]) {
      await page.locator('.rbtn', { hasText: new RegExp(`^${label}$`) }).click();
      await page.waitForFunction((n) => document.querySelectorAll('.tg-day').length === n, cols);
    }
    await page.locator('.rbtn', { hasText: 'Month' }).click();
    await page.waitForSelector('.mg-cell');
    assert.ok((await page.locator('.mg-cell').count()) >= 28);
    await shot('calendar-month');
  });

  await step('hiding a calendar removes its events', async () => {
    await page.locator('.rbtn', { hasText: 'Work Week' }).click();
    await page.waitForSelector('.tg-ev');
    const before = await page.locator('.tg-ev').count();
    await page.locator('.cal-row', { hasText: 'Work' }).locator('input').uncheck();
    await page.waitForFunction((n) => document.querySelectorAll('.tg-ev').length < n, before);
    await page.locator('.cal-row', { hasText: 'Work' }).locator('input').check();
  });

  await step('adding an account from Settings detects the provider and tests before saving', async () => {
    await page.locator('.nav-switch button', { hasText: 'Mail' }).click();
    await page.locator('.rtab.file').click();
    await page.locator('.settings-body .btn.primary', { hasText: 'Add account' }).click();
    await page.locator('input[type=email]').fill('newperson@gmail.com');
    assert.equal(await page.locator('.form select').first().inputValue(), 'gmail');
    await page.locator('input[type=password]').fill('abcdabcdabcdabcd');
    await page.locator('.form-actions .btn.primary').click();
    await page.waitForSelector('.card:has-text("newperson@gmail.com")');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.tree-head:has-text("newperson@gmail.com")');
  });

  await step('reading-pane layouts and theme switch without breaking the list', async () => {
    await page.locator('.rtab', { hasText: 'View' }).click();
    for (const label of ['Bottom', 'Off', 'Right']) {
      await page.locator('.rbtn', { hasText: new RegExp(`^${label}$`) }).click();
      await page.waitForSelector('.msg-row');
    }
    await page.locator('.rbtn', { hasText: /^Dark$/ }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await page.locator('.rbtn', { hasText: /^Light$/ }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  });

  await step('no unexpected script errors were raised', async () => { assert.deepEqual(problems, []); });

  await browser.close();
  server.close();
  const failed = results.filter(r => !r[0]);
  console.log(`\n${results.length - failed.length}/${results.length} UI checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
