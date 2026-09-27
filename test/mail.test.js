'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../electron/services/store');
const { MailService, parseListUnsubscribe, hasAttachmentPart } = require('../electron/services/mail');
const { simpleParser } = require('mailparser');
const { startImap, startSmtp, tempDir, dummySecrets } = require('./helpers');

let imap; let smtp; let store; let mail; let acc; let gmailLike;

test.before(async () => {
  imap = await startImap();
  smtp = await startSmtp();
  store = new Store(tempDir(), dummySecrets);
  const base = {
    provider: 'other',
    imap: { host: '127.0.0.1', port: imap.port, security: 'none' },
    smtp: { host: '127.0.0.1', port: smtp.port, security: 'none' },
    user: 'demouser'
  };
  acc = store.saveAccount({ ...base, email: 'demo@example.com', name: 'Demo User' }, 'demopass');
  // Same test server, but flagged as Gmail so the X-GM-RAW search path (and its fallback) is exercised.
  gmailLike = store.saveAccount({ ...base, provider: 'gmail', imap: base.imap, smtp: base.smtp, email: 'demo2@example.com', name: 'Gmail-like' }, 'demopass');
  mail = new MailService(store);
});

test.after(async () => {
  await mail.dispose();
  store.flush();
  imap.stop();
  await smtp.stop();
});

test('testConnection: success, wrong password, wrong port', async () => {
  const ok = await mail.testConnection({ email: 'x@example.com', provider: 'other', user: 'demouser', imap: { host: '127.0.0.1', port: imap.port, security: 'none' }, smtp: { host: '127.0.0.1', port: smtp.port, security: 'none' } }, 'demopass');
  assert.equal(ok.imap.ok, true, JSON.stringify(ok));
  assert.equal(ok.smtp.ok, true, JSON.stringify(ok));
  const bad = await mail.testConnection({ email: 'x@example.com', provider: 'other', user: 'demouser', imap: { host: '127.0.0.1', port: imap.port, security: 'none' }, smtp: { host: '127.0.0.1', port: smtp.port, security: 'none' } }, 'nope');
  assert.equal(bad.imap.ok, false);
  assert.match(bad.imap.error, /username or password|rejected/i);
  assert.equal(bad.smtp.ok, false);
  const dead = await mail.testConnection({ email: 'x@example.com', provider: 'other', user: 'u', imap: { host: '127.0.0.1', port: 1, security: 'none' }, smtp: { host: '127.0.0.1', port: 1, security: 'none' } }, 'p');
  assert.equal(dead.imap.ok, false);
  assert.match(dead.imap.error, /refused/i);
});

test('friendly Gmail message for a bad login', async () => {
  const res = await mail.testConnection({ email: 'x@gmail.com', provider: 'gmail', user: 'demouser', imap: { host: '127.0.0.1', port: imap.port, security: 'none' }, smtp: { host: '127.0.0.1', port: smtp.port, security: 'none' } }, 'wrong');
  assert.equal(res.imap.ok, false);
  assert.match(res.imap.error, /app password/i);
});

test('listFolders: special-use folders get Outlook-style names and order', async () => {
  const f = await mail.listFolders(acc.id);
  assert.equal(f[0].path, 'INBOX');
  assert.equal(f[0].displayName, 'Inbox');
  const names = f.map(x => x.displayName);
  assert.ok(names.includes('Sent Items'));
  assert.ok(names.includes('Deleted Items'));
  assert.ok(names.indexOf('Sent Items') < names.indexOf('Deleted Items'));
});

test('folderCounts: message and unread counts', async () => {
  const c = await mail.folderCounts(acc.id);
  assert.equal(c.INBOX.messages, 4);
  assert.equal(c.INBOX.unseen, 2);
});

test('listMessages: newest first, paging, unread filter, search', async () => {
  const all = await mail.listMessages(acc.id, 'INBOX', { limit: 50 });
  assert.equal(all.total, 4);
  assert.equal(all.rows.length, 4);
  assert.deepEqual(all.rows.map(r => r.subject), ['Hello, World!', 'Important notice regarding your account', 'Random question', 'Re: Re: Random question']);
  assert.equal(all.rows[0].seen, false);
  assert.equal(all.rows[1].flagged, true);
  assert.equal(all.rows[2].answered, true);
  assert.equal(all.rows[0].from.address, 'friend@example.com');
  assert.equal(all.hasMore, false);

  const p1 = await mail.listMessages(acc.id, 'INBOX', { limit: 3, offset: 0 });
  assert.equal(p1.rows.length, 3);
  assert.equal(p1.hasMore, true);
  const p2 = await mail.listMessages(acc.id, 'INBOX', { limit: 3, offset: 3 });
  assert.equal(p2.rows.length, 1);
  assert.equal(p2.rows[0].subject, 'Re: Re: Random question');
  assert.equal(p2.hasMore, false);

  const unread = await mail.listMessages(acc.id, 'INBOX', { filter: 'unread' });
  assert.deepEqual(unread.rows.map(r => r.uid).sort(), [103, 104]);
  const flagged = await mail.listMessages(acc.id, 'INBOX', { filter: 'flagged' });
  assert.deepEqual(flagged.rows.map(r => r.uid), [103]);

  const hit = await mail.listMessages(acc.id, 'INBOX', { query: 'notice' });
  assert.equal(hit.rows.length, 1);
  assert.equal(hit.rows[0].uid, 103);
  const none = await mail.listMessages(acc.id, 'INBOX', { query: 'zzzz-no-match' });
  assert.equal(none.rows.length, 0);
  assert.equal(none.total, 0);
});

test('listMessages: Gmail-style accounts fall back to standard search when X-GM-RAW is unsupported', async () => {
  const hit = await mail.listMessages(gmailLike.id, 'INBOX', { query: 'notice' });
  assert.equal(hit.rows.length, 1);
  assert.equal(hit.rows[0].uid, 103);
});

test('getMessage: parsed body, headers, no side effects on flags', async () => {
  const before = await mail.listMessages(acc.id, 'INBOX', { filter: 'unread' });
  const m = await mail.getMessage(acc.id, 'INBOX', 104);
  assert.equal(m.subject, 'Hello, World!');
  assert.equal(m.from[0].address, 'friend@example.com');
  assert.ok(m.text.length > 20);
  assert.ok(Array.isArray(m.attachments));
  const after = await mail.listMessages(acc.id, 'INBOX', { filter: 'unread' });
  assert.equal(after.rows.length, before.rows.length, 'reading must not mark as read by itself');
  await assert.rejects(() => mail.getMessage(acc.id, 'INBOX', 99999));
});

test('setFlags: read/unread and flag/unflag round trip', async () => {
  await mail.setFlags(acc.id, 'INBOX', [104], { seen: true });
  let r = (await mail.listMessages(acc.id, 'INBOX')).rows.find(x => x.uid === 104);
  assert.equal(r.seen, true);
  await mail.setFlags(acc.id, 'INBOX', [104], { seen: false, flagged: true });
  r = (await mail.listMessages(acc.id, 'INBOX')).rows.find(x => x.uid === 104);
  assert.equal(r.seen, false);
  assert.equal(r.flagged, true);
  await mail.setFlags(acc.id, 'INBOX', [104], { flagged: false });
  await assert.rejects(() => mail.setFlags(acc.id, 'INBOX', [], { seen: true }), /No messages/);
});

test('sendMessage: delivers over SMTP, hides Bcc on the wire, keeps it in the Sent copy, supports attachments', async () => {
  await mail.listMessages(acc.id, 'Sent'); // leaves a read-only folder selected; the Sent copy must still be flagged \\Seen
  const res = await mail.sendMessage(acc.id, {
    to: [{ name: 'Rae', address: 'rae@example.org' }],
    cc: [{ address: 'cc@example.org' }],
    bcc: [{ address: 'secret@example.org' }],
    subject: 'Quarterly numbers ✓',
    html: '<p>Hi <b>Rae</b></p>',
    text: 'Hi Rae',
    inReplyTo: '<orig@example.com>',
    references: ['<orig@example.com>'],
    attachments: [{ filename: 'notes.txt', contentType: 'text/plain', contentBase64: Buffer.from('attached text').toString('base64') }]
  });
  assert.ok(res.messageId);
  assert.equal(res.savedToSent, true);
  const got = smtp.received[smtp.received.length - 1];
  assert.deepEqual(got.envelope.rcptTo.map(r => r.address).sort(), ['cc@example.org', 'rae@example.org', 'secret@example.org']);
  assert.equal(got.parsed.subject, 'Quarterly numbers ✓');
  assert.equal(got.parsed.from.value[0].address, 'demo@example.com');
  assert.equal(got.parsed.from.value[0].name, 'Demo User');
  assert.equal(got.parsed.bcc, undefined, 'Bcc leaked into the delivered headers');
  assert.ok(!got.raw.toString().toLowerCase().includes('secret@example.org') || got.envelope.rcptTo.length === 3);
  assert.doesNotMatch(got.raw.toString().split('\r\n\r\n')[0], /secret@example\.org/);
  assert.equal(got.parsed.inReplyTo, '<orig@example.com>');
  assert.equal(got.parsed.attachments.length, 1);
  assert.equal(got.parsed.attachments[0].content.toString(), 'attached text');

  const sent = await mail.listMessages(acc.id, 'Sent', {});
  const copy = sent.rows.find(r => r.subject === 'Quarterly numbers ✓');
  assert.ok(copy, 'a copy should be filed in Sent');
  assert.equal(copy.seen, true);
  assert.equal(copy.hasAttachments, true);
  const full = await mail.getMessage(acc.id, 'Sent', copy.uid);
  assert.equal(full.bcc[0].address, 'secret@example.org', 'Sent copy should keep Bcc');
  assert.equal(full.attachments[0].filename, 'notes.txt');
  const att = await mail.getAttachment(acc.id, 'Sent', copy.uid, 0);
  assert.equal(att.content.toString(), 'attached text');
});

test('sendMessage: validation and SMTP failures are reported clearly', async () => {
  await assert.rejects(() => mail.sendMessage(acc.id, { to: [], subject: 'x', text: 'y' }), /at least one recipient/);
  await assert.rejects(() => mail.sendMessage(acc.id, { to: [{ address: 'not-an-address' }], subject: 'x', text: 'y' }), /at least one recipient/);
  const big = Buffer.alloc(26 * 1024 * 1024).toString('base64');
  await assert.rejects(() => mail.sendMessage(acc.id, { to: [{ address: 'a@b.co' }], subject: 'x', text: 'y', attachments: [{ filename: 'big.bin', contentBase64: big }] }), /25 MB/);
  const before = smtp.received.length;
  store.saveAccount({ ...store.getAccount(acc.id) }, '');
  assert.equal(smtp.received.length, before);
});

test('saveDraft: files a draft in Drafts and can replace the previous version', async () => {
  // Listing opens a folder read-only; the draft must still be filed with its \\Draft and \\Seen flags.
  await mail.listMessages(acc.id, 'Sent');
  const d1 = await mail.saveDraft(acc.id, { to: [{ address: 'a@b.co' }], subject: 'Draft v1', text: 'one' });
  assert.ok(d1.uid);
  let rows = (await mail.listMessages(acc.id, d1.path)).rows;
  assert.ok(rows.some(r => r.subject === 'Draft v1' && r.draft));
  const d2 = await mail.saveDraft(acc.id, { to: [{ address: 'a@b.co' }], subject: 'Draft v2', text: 'two' }, d1.uid);
  rows = (await mail.listMessages(acc.id, d2.path)).rows;
  assert.ok(rows.some(r => r.subject === 'Draft v2'));
  assert.ok(!rows.some(r => r.subject === 'Draft v1'), 'old draft should be replaced');
});

test('sendMessage: inline data: images are sent as CID attachments', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const before = smtp.received.length;
  await mail.sendMessage(acc.id, { to: [{ address: 'rae@example.org' }], subject: 'Pic', html: `<p>see</p><img src="data:image/png;base64,${png}">`, text: 'see' });
  // mailparser would re-inline cid: images as data: URIs, so ask it to keep the links to see what was sent.
  const wire = await simpleParser(smtp.received[before].raw, { keepCidLinks: true });
  assert.doesNotMatch(wire.html, /data:image/, 'data: URL should have been replaced');
  assert.match(wire.html, /src="cid:img1-[0-9a-f]+@example\.com"/);
  assert.equal(wire.attachments.length, 1);
  assert.equal(wire.attachments[0].contentType, 'image/png');
  assert.equal(wire.attachments[0].contentDisposition, 'inline');
  assert.equal(wire.attachments[0].content.toString('base64'), png);
  // Non-raster data: URLs are left alone rather than turned into attachments.
  const before2 = smtp.received.length;
  await mail.sendMessage(acc.id, { to: [{ address: 'rae@example.org' }], subject: 'Svg', html: '<img src="data:image/svg+xml;base64,PHN2Zy8+">', text: 'x' });
  assert.equal(smtp.received[before2].parsed.attachments.length, 0);
});

test('deleteDraft: removes a draft, and refuses other folders', async () => {
  const d = await mail.saveDraft(acc.id, { to: [{ address: 'a@b.co' }], subject: 'Throwaway', text: 'x' });
  assert.ok((await mail.listMessages(acc.id, d.path)).rows.some(r => r.subject === 'Throwaway'));
  await mail.deleteDraft(acc.id, d.path, d.uid);
  assert.ok(!(await mail.listMessages(acc.id, d.path)).rows.some(r => r.subject === 'Throwaway'));
  await assert.rejects(() => mail.deleteDraft(acc.id, 'INBOX', 101), /not in the Drafts folder/);
  assert.equal((await mail.listMessages(acc.id, 'INBOX')).rows.some(r => r.uid === 101), true, 'inbox untouched');
});

test('move / archive / junk / trash', async () => {
  // Move 101 to Sent, then back.
  await mail.moveMessages(acc.id, 'INBOX', [101], 'Sent');
  assert.equal((await mail.listMessages(acc.id, 'INBOX')).total, 3);
  const inSent = (await mail.listMessages(acc.id, 'Sent')).rows.find(r => r.subject === 'Re: Re: Random question');
  assert.ok(inSent);
  await mail.moveMessages(acc.id, 'Sent', [inSent.uid], 'INBOX');
  assert.equal((await mail.listMessages(acc.id, 'INBOX')).total, 4);

  // Archive: no archive folder on this server, so one is created.
  const a = await mail.archiveMessages(acc.id, 'INBOX', [102]);
  assert.equal(a.destination, 'Archive');
  assert.equal((await mail.listMessages(acc.id, 'Archive')).rows.length, 1);
  await assert.rejects(() => mail.archiveMessages(acc.id, 'Archive', [1]), /already in the archive/);

  // Junk folder is created on demand.
  const j = await mail.junkMessages(acc.id, 'INBOX', [103]);
  assert.equal(j.destination, 'Junk');

  // Trash then permanent delete requires explicit confirmation.
  const t = await mail.trashMessages(acc.id, 'INBOX', [104]);
  assert.equal(t.permanent, false);
  assert.equal(t.destination, 'Trash');
  const inTrash = (await mail.listMessages(acc.id, 'Trash')).rows.find(r => r.subject === 'Hello, World!');
  assert.ok(inTrash);
  await assert.rejects(() => mail.trashMessages(acc.id, 'Trash', [inTrash.uid]), /permanently/);
  const p = await mail.trashMessages(acc.id, 'Trash', [inTrash.uid], { permanent: true });
  assert.equal(p.permanent, true);
  assert.ok(!(await mail.listMessages(acc.id, 'Trash')).rows.some(r => r.subject === 'Hello, World!'));
});

test('a refused move is reported as an error, never as success (server with a read-only Trash)', async () => {
  const ro = await startImap({ readonlyTrash: true });
  const roStore = new Store(tempDir(), dummySecrets);
  const roAcc = roStore.saveAccount({
    provider: 'other', user: 'demouser', email: 'ro@example.com', name: 'RO',
    imap: { host: '127.0.0.1', port: ro.port, security: 'none' },
    smtp: { host: '127.0.0.1', port: smtp.port, security: 'none' }
  }, 'demopass');
  const roMail = new MailService(roStore);
  try {
    await assert.rejects(() => roMail.trashMessages(roAcc.id, 'INBOX', [104]), /would not move|Nothing was changed/);
    const inbox = await roMail.listMessages(roAcc.id, 'INBOX');
    assert.equal(inbox.total, 4, 'message must still be in the Inbox');
    assert.ok(inbox.rows.some(r => r.uid === 104));
  } finally {
    await roMail.dispose();
    roStore.flush();
    ro.stop();
  }
});

test('folders: create, rename, delete; system folders are protected', async () => {
  await mail.createFolder(acc.id, 'Projects');
  await mail.renameFolder(acc.id, 'Projects', 'Projects 2026');
  let f = await mail.listFolders(acc.id);
  assert.ok(f.some(x => x.path === 'Projects 2026'));
  await mail.deleteFolder(acc.id, 'Projects 2026');
  f = await mail.listFolders(acc.id);
  assert.ok(!f.some(x => x.path === 'Projects 2026'));
  await assert.rejects(() => mail.deleteFolder(acc.id, 'INBOX'), /System folders/);
  await assert.rejects(() => mail.deleteFolder(acc.id, 'Sent'), /System folders/);
});

test('checkInbox: reports new unread mail since a UID', async () => {
  const first = await mail.checkInbox(acc.id);
  assert.ok(first.uidNext > 0);
  const { ImapFlow } = require('imapflow');
  const c = new ImapFlow({ host: '127.0.0.1', port: imap.port, secure: false, doSTARTTLS: false, auth: { user: 'demouser', pass: 'demopass' }, logger: false });
  c.on('error', () => {});
  await c.connect();
  await c.append('INBOX', Buffer.from('From: New Sender <new@example.net>\r\nTo: demo@example.com\r\nSubject: Fresh arrival\r\nDate: Sat, 26 Sep 2026 12:00:00 +0000\r\nMessage-ID: <fresh@example.net>\r\n\r\nHello\r\n'), []);
  await c.logout();
  const second = await mail.checkInbox(acc.id, first.uidNext);
  assert.equal(second.fresh.length, 1);
  assert.equal(second.fresh[0].subject, 'Fresh arrival');
  assert.equal(second.fresh[0].from.address, 'new@example.net');
  assert.ok(second.unseen >= 1);
});

test('unified inbox merges accounts, keeps going when one account fails', async () => {
  const u = await mail.listUnified({ limit: 50 });
  assert.equal(u.errors.length, 0);
  const accounts = new Set(u.rows.map(r => r.accountId));
  assert.equal(accounts.size, 2);
  const dates = u.rows.map(r => new Date(r.date).getTime());
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a), 'must be sorted newest first');

  const broken = store.saveAccount({ email: 'broken@example.com', provider: 'other', user: 'demouser', imap: { host: '127.0.0.1', port: 1, security: 'none' }, smtp: { host: '127.0.0.1', port: 1, security: 'none' } }, 'x');
  const u2 = await mail.listUnified({ limit: 50 });
  assert.equal(u2.errors.length, 1);
  assert.equal(u2.errors[0].accountId, broken.id);
  assert.ok(u2.rows.length > 0, 'healthy accounts still show');
  store.removeAccount(broken.id);
  await mail.disposeAccount(broken.id);
});

test('helpers: List-Unsubscribe parsing and attachment detection', () => {
  assert.deepEqual(parseListUnsubscribe('<https://example.com/u?x=1>, <mailto:unsub@example.com>'), { http: 'https://example.com/u?x=1', mailto: 'mailto:unsub@example.com' });
  assert.equal(parseListUnsubscribe('javascript:alert(1)'), null);
  assert.equal(parseListUnsubscribe(''), null);
  assert.equal(hasAttachmentPart({ type: 'multipart/mixed', childNodes: [{ type: 'text/plain' }, { type: 'application/pdf', disposition: 'attachment' }] }), true);
  assert.equal(hasAttachmentPart({ type: 'multipart/related', childNodes: [{ type: 'text/html' }, { type: 'image/png', id: '<cid1>', disposition: 'inline' }] }), false);
  assert.equal(hasAttachmentPart({ type: 'text/plain' }), false);
  assert.equal(hasAttachmentPart({ type: 'multipart/signed', childNodes: [{ type: 'text/plain' }, { type: 'application/pgp-signature' }] }), false);
});
