'use strict';
/* Regressions found by an independent review of the mail engine. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { Store } = require('../electron/services/store');
const { MailService, moveOrThrow } = require('../electron/services/mail');
const { startImap, startSmtp, tempDir, dummySecrets } = require('./helpers');

let imap; let smtp; let store; let mail; let acc;

test.before(async () => {
  imap = await startImap();
  smtp = await startSmtp({ rejectTo: ['bad@example.org', 'worse@example.org'] });
  store = new Store(tempDir(), dummySecrets);
  acc = store.saveAccount({
    provider: 'other', user: 'demouser', email: 'demo@example.com', name: 'Demo User',
    imap: { host: '127.0.0.1', port: imap.port, security: 'none' },
    smtp: { host: '127.0.0.1', port: smtp.port, security: 'none' }
  }, 'demopass');
  mail = new MailService(store);
});
test.after(async () => { await mail.dispose(); store.flush(); imap.stop(); await smtp.stop(); });

// ---- moving mail must never lose it ---------------------------------------------------------
function fakeClient({ move, capabilities, copy, del }) {
  const calls = [];
  return {
    calls,
    capabilities: new Map(capabilities.map(c => [c, true])),
    messageMove: async (...a) => { calls.push(['move', ...a]); return move; },
    messageCopy: async (...a) => { calls.push(['copy', ...a]); return copy; },
    messageDelete: async (...a) => { calls.push(['delete', ...a]); return del; }
  };
}

test('server without MOVE: a refused COPY must not remove the originals', async () => {
  const c = fakeClient({ capabilities: ['IMAP4rev1'], copy: false, del: true });
  await assert.rejects(() => moveOrThrow(c, '5,6', 'Archive'), /would not move .*Nothing was changed/);
  assert.deepEqual(c.calls.map(x => x[0]), ['copy'], 'the originals must not be touched after a failed copy');
});

test('server without MOVE: a confirmed COPY is followed by removal of the originals', async () => {
  const c = fakeClient({ capabilities: ['IMAP4rev1'], copy: { uidMap: new Map([[5, 50]]) }, del: true });
  const res = await moveOrThrow(c, '5', 'Archive');
  assert.ok(res);
  assert.deepEqual(c.calls.map(x => x[0]), ['copy', 'delete']);
  assert.deepEqual(c.calls[0].slice(1), ['5', 'Archive', { uid: true }]);
});

test('server without MOVE: if the originals cannot be removed the user is told they now exist twice', async () => {
  const c = fakeClient({ capabilities: [], copy: { uidMap: new Map() }, del: false });
  await assert.rejects(() => moveOrThrow(c, '5', 'Archive'), /both places/);
});

test('server with MOVE: uses it, and a refusal is an error', async () => {
  const ok = fakeClient({ capabilities: ['MOVE'], move: { uidMap: new Map() } });
  await moveOrThrow(ok, '5', 'Archive');
  assert.deepEqual(ok.calls.map(x => x[0]), ['move']);
  const no = fakeClient({ capabilities: ['MOVE'], move: false });
  await assert.rejects(() => moveOrThrow(no, '5', 'Archive'), /would not move/);
});

test('trashing through the real client still works (pymap advertises MOVE or falls back safely)', async () => {
  const list = await mail.listMessages(acc.id, 'INBOX', { limit: 10 });
  const victim = list.rows[list.rows.length - 1];
  const before = list.total;
  await mail.trashMessages(acc.id, 'INBOX', [victim.uid]);
  const after = await mail.listMessages(acc.id, 'INBOX', { limit: 10 });
  assert.equal(after.total, before - 1);
});

// ---- sending -------------------------------------------------------------------------------
test('partly refused recipients: the mail counts as sent, the Sent copy is filed, the refused address is reported', async () => {
  const before = smtp.received.length;
  const res = await mail.sendMessage(acc.id, { to: [{ address: 'good@example.org' }, { address: 'bad@example.org' }], subject: 'Partial delivery', text: 'hello' });
  assert.deepEqual(res.rejected, ['bad@example.org']);
  assert.deepEqual(res.accepted, ['good@example.org']);
  assert.equal(smtp.received.length, before + 1, 'the accepted recipient did get the message');
  assert.equal(res.savedToSent, true);
  const sent = await mail.listMessages(acc.id, 'Sent', { limit: 50 });
  assert.ok(sent.rows.some(r => r.subject === 'Partial delivery'));
});

test('every recipient refused: reported as a failure, nothing filed in Sent', async () => {
  const before = smtp.received.length;
  await assert.rejects(() => mail.sendMessage(acc.id, { to: [{ address: 'bad@example.org' }, { address: 'worse@example.org' }], subject: 'All refused', text: 'hello' }), /refused|rejected|unavailable/i);
  assert.equal(smtp.received.length, before);
  const sent = await mail.listMessages(acc.id, 'Sent', { limit: 50 });
  assert.ok(!sent.rows.some(r => r.subject === 'All refused'));
});

test('message fields from the UI are always treated as plain data (no file reads through {path: ...})', async () => {
  const secretFile = path.join(tempDir(), 'secret.txt');
  fs.writeFileSync(secretFile, 'TOP-SECRET-MARKER');
  await mail.sendMessage(acc.id, {
    to: [{ address: 'good@example.org' }], subject: 'Coerced\r\nBcc: attacker@example.org',
    text: { path: secretFile }, html: undefined,
    attachments: [{ filename: { path: secretFile }, contentBase64: Buffer.from('x').toString('base64'), contentType: 'text/plain' }],
    inReplyTo: { path: secretFile }, references: [{ path: secretFile }]
  });
  const got = smtp.received[smtp.received.length - 1];
  assert.ok(!got.raw.toString().includes('TOP-SECRET-MARKER'), 'file contents must never be read from a renderer-supplied object');
  assert.ok(!/^bcc:/im.test(got.raw.toString().split('\r\n\r\n')[0]), 'no header injected through the subject');
  assert.ok(!got.envelope.rcptTo.some(r => /attacker/.test(r.address)));
});

// ---- unified inbox paging ----------------------------------------------------------------------
test('unified inbox: paging stops at the per-account cap instead of returning empty pages forever', async () => {
  const c = new ImapFlow({ host: '127.0.0.1', port: imap.port, secure: false, auth: { user: 'demouser', pass: 'demopass' }, logger: false, disableAutoIdle: true });
  await c.connect();
  for (let i = 0; i < 230; i++) {
    await c.append('INBOX', Buffer.from(`From: Bulk <bulk${i}@example.net>\r\nTo: demo@example.com\r\nSubject: Bulk ${i}\r\nDate: ${new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toUTCString()}\r\nMessage-ID: <bulk${i}@example.net>\r\n\r\nx\r\n`), []);
  }
  await c.logout();
  const first = await mail.listUnified({ offset: 0, limit: 50 });
  assert.equal(first.hasMore, true);
  const edge = await mail.listUnified({ offset: 150, limit: 50 });
  assert.equal(edge.rows.length, 50);
  assert.equal(edge.hasMore, false, 'the view is capped at 200 per account; do not invite another page');
  const beyond = await mail.listUnified({ offset: 200, limit: 50 });
  assert.equal(beyond.rows.length, 0);
  assert.equal(beyond.hasMore, false);
});

test('real server, MOVE hidden: copy+delete path moves a message; a copy to a missing folder leaves the original alone', async () => {
  const c = new ImapFlow({ host: '127.0.0.1', port: imap.port, secure: false, auth: { user: 'demouser', pass: 'demopass' }, logger: false, disableAutoIdle: true });
  await c.connect();
  try {
    c.capabilities.delete('MOVE'); // behave like an old server that only knows COPY
    const lock = await c.getMailboxLock('INBOX');
    try {
      const uids = await c.search({ all: true }, { uid: true });
      const target = uids[0];
      const total = async () => (await c.status('INBOX', { messages: true })).messages;
      const before = await total();

      await assert.rejects(() => moveOrThrow(c, String(target), 'No/Such/Folder'), /would not move/);
      assert.equal(await total(), before, 'a failed copy must not remove anything');
      assert.ok((await c.search({ uid: String(target) }, { uid: true })).length === 1, 'the original is still there');

      await moveOrThrow(c, String(target), 'Trash');
      assert.equal(await total(), before - 1);
    } finally { lock.release(); }
  } finally { await c.logout(); }
});
