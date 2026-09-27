'use strict';
/**
 * IMAP/SMTP engine. Plain Node (no Electron imports) so it can be tested
 * against a local mail server.
 *
 * One IMAP connection per account; operations on an account are queued so
 * mailbox locks never interleave. Idle connections are closed after a while.
 */
const { EventEmitter } = require('events');
const { ImapFlow } = require('imapflow');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { simpleParser } = require('mailparser');

const IDLE_CLOSE_MS = 4 * 60 * 1000;
const MAX_INLINE_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const OP_TIMEOUT_MS = 90 * 1000;

const SPECIAL_ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\All', '\\Junk', '\\Trash', '\\Flagged', '\\Important'];
const SPECIAL_NAMES = {
  '\\Inbox': 'Inbox',
  '\\Drafts': 'Drafts',
  '\\Sent': 'Sent Items',
  '\\Archive': 'Archive',
  '\\All': 'All Mail',
  '\\Junk': 'Junk Email',
  '\\Trash': 'Deleted Items',
  '\\Flagged': 'Starred',
  '\\Important': 'Important'
};

function friendlyError(err, account) {
  if (!err) return 'Unknown error';
  if (err.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|authentication failed|Application-specific password/i.test(`${err.response || ''} ${err.responseText || ''} ${err.message || ''}`)) {
    const gmail = account && account.provider === 'gmail';
    return gmail
      ? 'Gmail rejected the login. Use a Google app password (Google Account > Security > 2-Step Verification > App passwords), not your normal password, and make sure IMAP access is on.'
      : 'The server rejected the username or password.';
  }
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return `Cannot find the server (${err.hostname || 'DNS lookup failed'}). Check the server name and your network.`;
  if (err.code === 'ECONNREFUSED') return 'The server refused the connection. Check the server name, port and security setting.';
  if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT' || err.code === 'Timeout') return 'The connection timed out.';
  if (/self.signed|certificate|CERT_/i.test(err.message || '') || /CERT|SELF_SIGNED/.test(err.code || '')) return 'The server certificate could not be verified.';
  if (err.responseText) return String(err.responseText);
  return err.message || String(err);
}

function addr(a) {
  return { name: (a && a.name) || '', address: (a && a.address) || '' };
}

function hasAttachmentPart(node) {
  if (!node) return false;
  if (node.childNodes && node.childNodes.length) return node.childNodes.some(hasAttachmentPart);
  const type = String(node.type || '').toLowerCase();
  const disposition = String(node.disposition || '').toLowerCase();
  if (disposition === 'attachment') return true;
  // Some servers omit Content-Disposition from BODYSTRUCTURE; a named text part is still a file.
  const named = (node.dispositionParameters && (node.dispositionParameters.filename || node.dispositionParameters['filename*']))
    || (node.parameters && node.parameters.name);
  if (named && disposition !== 'inline' && !node.id) return true;
  if (type.startsWith('text/') || type.startsWith('multipart/')) return false;
  if (/signature|delivery-status|disposition-notification/.test(type)) return false;
  if (node.id && String(node.disposition || '').toLowerCase() !== 'attachment') return false; // inline (cid) image
  return true;
}

function toRow(accountId, path, m) {
  const env = m.envelope || {};
  const flags = m.flags || new Set();
  const date = m.internalDate || env.date;
  return {
    key: `${accountId}|${path}|${m.uid}`,
    accountId,
    path,
    uid: m.uid,
    subject: env.subject || '',
    from: addr((env.from || [])[0]),
    to: (env.to || []).map(addr),
    date: date ? new Date(date).toISOString() : null,
    size: m.size || 0,
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    draft: flags.has('\\Draft'),
    hasAttachments: hasAttachmentPart(m.bodyStructure),
    messageId: env.messageId || ''
  };
}

function uidList(uids) {
  const list = Array.isArray(uids) ? uids : [uids];
  const clean = list.map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (!clean.length) throw new Error('No messages selected');
  return clean.join(',');
}

function parseListUnsubscribe(value) {
  if (!value) return null;
  const text = Array.isArray(value) ? value.join(',') : (value.text || String(value));
  const out = {};
  for (const m of text.matchAll(/<([^>]+)>/g)) {
    const u = m[1].trim();
    if (/^https?:\/\//i.test(u) && !out.http) out.http = u;
    else if (/^mailto:/i.test(u) && !out.mailto) out.mailto = u;
  }
  return out.http || out.mailto ? out : null;
}

const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** Replace <img src="data:image/...;base64,..."> with cid: references and push the pictures onto `attachments`. */
function inlineDataImages(html, attachments, domain) {
  let n = 0;
  return html.replace(/(<img\b[^<>]{0,1024}?\ssrc\s*=\s*["'])data:(image\/[a-z]+);base64,([A-Za-z0-9+/=\s]+)(["'])/gi, (match, pre, mime, b64, post) => {
    const ext = IMAGE_EXT[mime.toLowerCase()];
    if (!ext) return match;
    n += 1;
    const cid = `img${n}-${crypto.randomBytes(6).toString('hex')}@${domain}`;
    attachments.push({
      filename: `image-${n}.${ext}`,
      content: Buffer.from(b64.replace(/\s+/g, ''), 'base64'),
      contentType: mime.toLowerCase(),
      cid,
      contentDisposition: 'inline'
    });
    return `${pre}cid:${cid}${post}`;
  });
}

/**
 * Move messages, never losing them. imapflow's own messageMove() resolves `false` (and only logs a warning) when the
 * server answers NO, and on servers without the MOVE extension it copies and then deletes the originals even when the
 * copy failed. So without MOVE we do the two steps ourselves: the originals are only removed after the server has
 * confirmed the copy. Never report a move as done unless the server accepted it.
 */
async function moveOrThrow(client, range, destination) {
  const refused = () => new Error(`The server would not move the message to "${destination}". It may be read-only, or the message may have been moved or deleted elsewhere. Nothing was changed here.`);
  const hasMove = client.capabilities && typeof client.capabilities.has === 'function' && client.capabilities.has('MOVE');
  if (hasMove) {
    const res = await client.messageMove(range, destination, { uid: true });
    if (!res) throw refused();
    return res;
  }
  const copied = await client.messageCopy(range, destination, { uid: true });
  if (!copied) throw refused();
  const removed = await client.messageDelete(range, { uid: true });
  if (!removed) {
    throw new Error(`The message was copied to "${destination}" but the server would not remove the original, so it now exists in both places.`);
  }
  return copied;
}

/**
 * Append a message with flags. imapflow drops any flag the *currently selected* mailbox does not list in
 * PERMANENTFLAGS, and a mailbox opened read-only (as our listings do) reports none, so appending right
 * after a listing would silently file the message unread and without \\Draft. Selecting the destination
 * read-write first makes the check use the folder we are actually writing to.
 */
async function appendMessage(client, path, raw, flags) {
  const lock = await client.getMailboxLock(path);
  try {
    return await client.append(path, raw, flags, new Date());
  } finally {
    lock.release();
  }
}

class MailService extends EventEmitter {
  constructor(store, options = {}) {
    super();
    this.store = store;
    this.options = options;
    this.entries = new Map();
    this.folderCache = new Map(); // accountId -> [{path, specialUse, flags}]
    this._sweeper = setInterval(() => this._sweep(), 60 * 1000);
    if (this._sweeper.unref) this._sweeper.unref();
  }

  // ---- connection handling --------------------------------------------
  _imapOptions(account, password) {
    const { imap } = account;
    const opts = {
      host: imap.host,
      port: imap.port,
      secure: imap.security === 'ssl',
      auth: { user: account.user, pass: password },
      logger: false,
      connectionTimeout: 20000,
      greetingTimeout: 20000,
      socketTimeout: 5 * 60 * 1000,
      tls: { rejectUnauthorized: !account.allowSelfSigned }
    };
    if (imap.security === 'none') opts.doSTARTTLS = false;
    else if (imap.security === 'starttls') opts.doSTARTTLS = true;
    return opts;
  }

  _entry(accountId) {
    let e = this.entries.get(accountId);
    if (!e) {
      e = { client: null, queue: Promise.resolve(), lastUsed: Date.now() };
      this.entries.set(accountId, e);
    }
    return e;
  }

  async _connect(accountId, entry) {
    if (entry.client && entry.client.usable) return entry.client;
    if (entry.client) { try { entry.client.close(); } catch (_) { /* ignore */ } entry.client = null; }
    const account = this.store.getAccount(accountId);
    if (!account.enabled) throw new Error('This account is turned off.');
    const client = new ImapFlow(this._imapOptions(account, this.store.getSecret(accountId)));
    client.on('error', () => { /* surfaced through the failing command */ });
    client.on('close', () => { if (entry.client === client) entry.client = null; });
    try {
      await client.connect();
    } catch (err) {
      const e = new Error(friendlyError(err, account));
      e.cause = err;
      throw e;
    }
    entry.client = client;
    return client;
  }

  _withClient(accountId, fn) {
    const entry = this._entry(accountId);
    const run = entry.queue.then(async () => {
      entry.lastUsed = Date.now();
      const client = await this._connect(accountId, entry);
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            // A hung command would block the queue forever: drop the connection so the next call reconnects.
            try { client.close(); } catch (_) { /* ignore */ }
            entry.client = null;
            const e = new Error('The server did not respond in time.');
            e._friendly = true;
            reject(e);
          }, this.options.opTimeoutMs || OP_TIMEOUT_MS);
        });
        const work = Promise.resolve(fn(client));
        work.catch(() => {}); // an abandoned operation may still fail later
        return await Promise.race([work, timeout]);
      } catch (err) {
        if (err && !err._friendly) {
          let account = null;
          try { account = this.store.getAccount(accountId); } catch (_) { /* ignore */ }
          const wrapped = new Error(friendlyError(err, account));
          wrapped._friendly = true;
          wrapped.cause = err;
          throw wrapped;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        entry.lastUsed = Date.now();
      }
    });
    entry.queue = run.catch(() => {});
    return run;
  }

  _sweep() {
    const now = Date.now();
    for (const [id, e] of this.entries) {
      if (e.client && now - e.lastUsed > IDLE_CLOSE_MS) {
        const c = e.client;
        e.client = null;
        c.logout().catch(() => { try { c.close(); } catch (_) { /* ignore */ } });
        this.entries.delete(id);
      }
    }
  }

  async disposeAccount(accountId) {
    const e = this.entries.get(accountId);
    this.entries.delete(accountId);
    this.folderCache.delete(accountId);
    if (e && e.client) { try { await e.client.logout(); } catch (_) { try { e.client.close(); } catch (__) { /* ignore */ } } }
  }

  async dispose() {
    clearInterval(this._sweeper);
    await Promise.all([...this.entries.keys()].map(id => this.disposeAccount(id)));
  }

  // ---- folders ---------------------------------------------------------
  async listFolders(accountId) {
    return this._withClient(accountId, client => this._loadFolders(client, accountId));
  }

  async _loadFolders(client, accountId) {
    {
      const list = await client.list();
      const folders = list
        .filter(f => !f.flags.has('\\NonExistent'))
        .map(f => {
          const isInbox = f.path.toUpperCase() === 'INBOX';
          const special = isInbox ? '\\Inbox' : (f.specialUse || '');
          return {
            path: f.path,
            name: f.name,
            delimiter: f.delimiter,
            parentPath: f.parentPath || '',
            specialUse: special,
            selectable: !f.flags.has('\\Noselect'),
            displayName: SPECIAL_NAMES[special] || f.name,
            order: special ? SPECIAL_ORDER.indexOf(special) : 100,
            subscribed: f.subscribed
          };
        });
      folders.sort((a, b) => (a.order - b.order) || a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }));
      this.folderCache.set(accountId, folders);
      return folders;
    }
  }

  /**
   * Folder list from cache. Code that already holds the account's client (i.e. runs inside
   * _withClient) must pass it, otherwise a cache miss would queue behind itself and deadlock.
   */
  async _folders(accountId, client) {
    const cached = this.folderCache.get(accountId);
    if (cached) return cached;
    return client ? this._loadFolders(client, accountId) : this.listFolders(accountId);
  }

  async _findSpecial(accountId, specialUse, nameGuesses = [], client) {
    const folders = await this._folders(accountId, client);
    let hit = folders.find(f => f.specialUse === specialUse && f.selectable);
    if (!hit) {
      const guesses = nameGuesses.map(n => n.toLowerCase());
      hit = folders.find(f => f.selectable && guesses.includes(f.name.toLowerCase()));
    }
    return hit ? hit.path : null;
  }

  async _ensureFolder(client, accountId, specialUse, nameGuesses, createName) {
    const found = await this._findSpecial(accountId, specialUse, nameGuesses, client);
    if (found) return found;
    const res = await client.mailboxCreate(createName);
    this.folderCache.delete(accountId);
    return res.path;
  }

  /** Message/unread counts for every selectable folder. */
  async folderCounts(accountId) {
    const folders = await this._folders(accountId);
    return this._withClient(accountId, async (client) => {
      const counts = {};
      for (const f of folders) {
        if (!f.selectable) continue;
        if (f.specialUse === '\\Important' || f.specialUse === '\\Flagged') continue; // Gmail virtual folders: slow, not useful
        try {
          const s = await client.status(f.path, { messages: true, unseen: true });
          counts[f.path] = { messages: s.messages || 0, unseen: s.unseen || 0 };
        } catch (_) { /* skip folders that cannot be queried */ }
      }
      return counts;
    });
  }

  async createFolder(accountId, path) {
    const res = await this._withClient(accountId, c => c.mailboxCreate(path));
    this.folderCache.delete(accountId);
    return res;
  }

  async renameFolder(accountId, path, newPath) {
    const res = await this._withClient(accountId, c => c.mailboxRename(path, newPath));
    this.folderCache.delete(accountId);
    return res;
  }

  async deleteFolder(accountId, path) {
    const folders = await this._folders(accountId);
    const f = folders.find(x => x.path === path);
    if (f && (f.specialUse || path.toUpperCase() === 'INBOX')) throw new Error('System folders cannot be deleted.');
    const res = await this._withClient(accountId, c => c.mailboxDelete(path));
    this.folderCache.delete(accountId);
    return res;
  }

  // ---- messages --------------------------------------------------------
  _searchObject(account, { filter, query }) {
    const s = {};
    if (filter === 'unread') s.seen = false;
    if (filter === 'flagged') s.flagged = true;
    const q = (query || '').trim();
    if (q) {
      if (account.provider === 'gmail') s.gmraw = q;
      else s.or = [{ subject: q }, { from: q }, { to: q }, { body: q }];
    }
    return s;
  }

  /**
   * One page of message headers, newest first.
   * opts: {offset, limit, filter: all|unread|flagged, query}
   */
  async listMessages(accountId, path, opts = {}) {
    const offset = Math.max(0, Number(opts.offset) || 0);
    const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
    const account = this.store.getAccount(accountId);
    const search = this._searchObject(account, opts);
    const fetchQuery = { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true };

    return this._withClient(accountId, async (client) => {
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        let total;
        let messages = [];
        if (!Object.keys(search).length) {
          total = client.mailbox.exists;
          const end = total - offset;
          if (end >= 1) {
            const start = Math.max(1, end - limit + 1);
            messages = await client.fetchAll(`${start}:${end}`, fetchQuery);
          }
        } else {
          let uids;
          try {
            uids = (await client.search(search, { uid: true })) || [];
          } catch (err) {
            // Not really Gmail (or Gmail-only syntax rejected): fall back to standard IMAP search.
            if (!search.gmraw) throw err;
            const generic = this._searchObject({ provider: 'other' }, opts);
            uids = (await client.search(generic, { uid: true })) || [];
          }
          total = uids.length;
          const hi = total - offset;
          const page = hi > 0 ? uids.slice(Math.max(0, hi - limit), hi) : [];
          if (page.length) messages = await client.fetchAll(page.join(','), fetchQuery, { uid: true });
        }
        const rows = messages.map(m => toRow(accountId, path, m));
        rows.sort((a, b) => (new Date(b.date) - new Date(a.date)) || (b.uid - a.uid));
        return { rows, total, offset, hasMore: offset + rows.length < total };
      } finally {
        lock.release();
      }
    });
  }

  /** Merged inbox across all enabled accounts. */
  async listUnified(opts = {}) {
    const offset = Math.max(0, Number(opts.offset) || 0);
    const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
    const accounts = this.store.listAccounts().filter(a => a.enabled);
    const want = offset + limit;
    const results = await Promise.allSettled(accounts.map(async (a) => {
      const inbox = (await this._findSpecial(a.id, '\\Inbox', ['inbox'])) || 'INBOX';
      const res = await this.listMessages(a.id, inbox, { offset: 0, limit: Math.min(200, want), filter: opts.filter, query: opts.query });
      return { account: a, res };
    }));
    const rows = [];
    const errors = [];
    let total = 0;
    let more = false;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        rows.push(...r.value.res.rows);
        total += r.value.res.total;
        if (r.value.res.hasMore) more = true;
      } else {
        errors.push({ accountId: accounts[i].id, email: accounts[i].email, error: r.reason && r.reason.message ? r.reason.message : String(r.reason) });
      }
    });
    rows.sort((a, b) => (new Date(b.date) - new Date(a.date)) || (b.uid - a.uid));
    const page = rows.slice(offset, offset + limit);
    // Each account contributes at most its newest 200 messages here, so once `want` reaches that cap there is nothing
    // further to page to (the account's own Inbox folder shows everything).
    const capped = want >= 200;
    return { rows: page, total, offset, hasMore: rows.length > offset + limit || (more && !capped), errors };
  }

  async _downloadParsed(accountId, path, uid) {
    return this._withClient(accountId, async (client) => {
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const dl = await client.download(String(uid), undefined, { uid: true });
        if (!dl || !dl.content) throw new Error('This message no longer exists on the server.');
        return await simpleParser(dl.content);
      } finally {
        lock.release();
      }
    });
  }

  async getMessage(accountId, path, uid) {
    const p = await this._downloadParsed(accountId, path, uid);
    let html = typeof p.html === 'string' ? p.html : '';
    const attachments = [];
    let inlineBytes = 0;
    (p.attachments || []).forEach((a, index) => {
      const cid = a.cid ? a.cid.replace(/^<|>$/g, '') : '';
      const referenced = cid && html && html.includes(`cid:${cid}`);
      if (referenced && a.content && inlineBytes + a.content.length <= MAX_INLINE_BYTES && /^image\//i.test(a.contentType || '')) {
        inlineBytes += a.content.length;
        const dataUrl = `data:${a.contentType};base64,${a.content.toString('base64')}`;
        html = html.split(`cid:${cid}`).join(dataUrl);
        return;
      }
      attachments.push({
        index,
        filename: a.filename || 'attachment',
        contentType: a.contentType || 'application/octet-stream',
        size: a.size || (a.content ? a.content.length : 0),
        inline: a.contentDisposition === 'inline'
      });
    });
    const list = (v) => (v && v.value ? v.value.map(addr) : []);
    if (this.store.noteContacts) this.store.noteContacts([...list(p.from), ...list(p.to), ...list(p.cc)]);
    return {
      key: `${accountId}|${path}|${uid}`,
      accountId,
      path,
      uid,
      subject: p.subject || '',
      from: list(p.from),
      to: list(p.to),
      cc: list(p.cc),
      bcc: list(p.bcc),
      replyTo: list(p.replyTo),
      date: p.date ? p.date.toISOString() : null,
      messageId: p.messageId || '',
      inReplyTo: p.inReplyTo || '',
      references: Array.isArray(p.references) ? p.references : (p.references ? [p.references] : []),
      html: html || '',
      text: p.text || '',
      attachments,
      listUnsubscribe: parseListUnsubscribe(p.headers && p.headers.get('list-unsubscribe'))
    };
  }

  async getAttachment(accountId, path, uid, index) {
    const p = await this._downloadParsed(accountId, path, uid);
    const a = (p.attachments || [])[index];
    if (!a || !a.content) throw new Error('Attachment not found.');
    if (a.content.length > MAX_ATTACHMENT_BYTES * 2) throw new Error('Attachment is too large.');
    return { filename: a.filename || 'attachment', contentType: a.contentType, content: a.content };
  }

  async setFlags(accountId, path, uids, { seen, flagged }) {
    const range = uidList(uids);
    return this._withClient(accountId, async (client) => {
      const lock = await client.getMailboxLock(path);
      try {
        if (seen === true) await client.messageFlagsAdd(range, ['\\Seen'], { uid: true });
        if (seen === false) await client.messageFlagsRemove(range, ['\\Seen'], { uid: true });
        if (flagged === true) await client.messageFlagsAdd(range, ['\\Flagged'], { uid: true });
        if (flagged === false) await client.messageFlagsRemove(range, ['\\Flagged'], { uid: true });
        return true;
      } finally {
        lock.release();
      }
    });
  }

  /** Marks every unread message in the folder as read, without fetching each UID first. */
  async markFolderRead(accountId, path) {
    return this._withClient(accountId, async (client) => {
      const lock = await client.getMailboxLock(path);
      try {
        await client.messageFlagsAdd({ seen: false }, ['\\Seen'], { uid: true });
        return true;
      } finally {
        lock.release();
      }
    });
  }

  async moveMessages(accountId, path, uids, destination) {
    if (path === destination) return { moved: 0 };
    const range = uidList(uids);
    return this._withClient(accountId, async (client) => {
      const lock = await client.getMailboxLock(path);
      try {
        const res = await moveOrThrow(client, range, destination);
        return { moved: range.split(',').length, destination: res && res.destination };
      } finally {
        lock.release();
      }
    });
  }

  /** Move to the Trash folder; if already in Trash, delete for good (only when `permanent` is set). */
  async trashMessages(accountId, path, uids, { permanent = false } = {}) {
    const range = uidList(uids);
    const trash = await this._findSpecial(accountId, '\\Trash', ['trash', 'deleted items', 'deleted messages', 'bin']);
    if (trash && trash === path) {
      if (!permanent) throw new Error('These messages are already in Deleted Items. Confirm to delete them permanently.');
      return this._withClient(accountId, async (client) => {
        const lock = await client.getMailboxLock(path);
        try {
          if (!(await client.messageDelete(range, { uid: true }))) throw new Error('The server would not delete these messages. Nothing was changed here.');
          return { deleted: range.split(',').length, permanent: true };
        } finally {
          lock.release();
        }
      });
    }
    return this._withClient(accountId, async (client) => {
      const dest = trash || await this._ensureFolder(client, accountId, '\\Trash', [], 'Trash');
      const lock = await client.getMailboxLock(path);
      try {
        await moveOrThrow(client, range, dest);
        return { deleted: range.split(',').length, permanent: false, destination: dest };
      } finally {
        lock.release();
      }
    });
  }

  async archiveMessages(accountId, path, uids) {
    const range = uidList(uids);
    return this._withClient(accountId, async (client) => {
      const dest = (await this._findSpecial(accountId, '\\Archive', ['archive', 'archives'], client))
        || (await this._findSpecial(accountId, '\\All', [], client))
        || await this._ensureFolder(client, accountId, '\\Archive', [], 'Archive');
      if (dest === path) throw new Error('These messages are already in the archive.');
      const lock = await client.getMailboxLock(path);
      try {
        await moveOrThrow(client, range, dest);
        return { archived: range.split(',').length, destination: dest };
      } finally {
        lock.release();
      }
    });
  }

  async junkMessages(accountId, path, uids) {
    const range = uidList(uids);
    return this._withClient(accountId, async (client) => {
      const dest = (await this._findSpecial(accountId, '\\Junk', ['junk', 'spam', 'junk email', 'bulk mail'], client))
        || await this._ensureFolder(client, accountId, '\\Junk', [], 'Junk');
      const lock = await client.getMailboxLock(path);
      try {
        await moveOrThrow(client, range, dest);
        return { junked: range.split(',').length, destination: dest };
      } finally {
        lock.release();
      }
    });
  }

  /** Cheap new-mail probe: returns unread count, uidNext and the newest messages since `sinceUidNext`. */
  async checkInbox(accountId, sinceUidNext = 0) {
    const inbox = (await this._findSpecial(accountId, '\\Inbox', ['inbox'])) || 'INBOX';
    return this._withClient(accountId, async (client) => {
      const s = await client.status(inbox, { messages: true, unseen: true, uidNext: true });
      const out = { path: inbox, unseen: s.unseen || 0, messages: s.messages || 0, uidNext: s.uidNext || 0, fresh: [] };
      if (sinceUidNext && out.uidNext > sinceUidNext) {
        const lock = await client.getMailboxLock(inbox, { readOnly: true });
        try {
          const msgs = await client.fetchAll(`${sinceUidNext}:*`, { uid: true, flags: true, envelope: true, internalDate: true, size: true }, { uid: true });
          out.fresh = msgs
            .filter(m => m.uid >= sinceUidNext && !(m.flags && m.flags.has('\\Seen')))
            .slice(-5)
            .map(m => toRow(accountId, inbox, m));
        } finally {
          lock.release();
        }
      }
      return out;
    });
  }

  // ---- sending ---------------------------------------------------------
  _smtpTransport(account, password) {
    const { smtp } = account;
    return nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.security === 'ssl',
      requireTLS: smtp.security === 'starttls',
      ignoreTLS: smtp.security === 'none',
      auth: { user: account.user, pass: password },
      connectionTimeout: 20000,
      greetingTimeout: 20000,
      socketTimeout: 60000,
      tls: { rejectUnauthorized: !account.allowSelfSigned }
    });
  }

  _buildMessage(account, draft) {
    const clean = (list) => (list || [])
      .map(a => (typeof a === 'string' ? { address: a } : a))
      .filter(a => a && a.address && /^[^\s@]+@[^\s@]+$/.test(a.address))
      .map(a => ({ name: a.name || '', address: a.address }));
    const attachments = (Array.isArray(draft.attachments) ? draft.attachments : []).map(a => ({
      filename: String((a && a.filename) || 'attachment'),
      content: Buffer.from(String((a && a.contentBase64) || ''), 'base64'),
      contentType: a && a.contentType ? String(a.contentType) : undefined
    }));
    const domain = account.email.split('@')[1] || 'localhost';
    // Pasted or forwarded inline pictures arrive as data: URLs; send them as CID parts, which every mail client displays.
    const html = draft.html ? inlineDataImages(String(draft.html), attachments, domain) : undefined;
    const total = attachments.reduce((n, a) => n + a.content.length, 0);
    if (total > MAX_ATTACHMENT_BYTES) throw new Error('Attachments are larger than 25 MB in total.');
    const mail = {
      from: { name: account.name, address: account.email },
      to: clean(draft.to),
      cc: clean(draft.cc),
      bcc: clean(draft.bcc),
      subject: String(draft.subject || '').replace(/[\r\n]+/g, ' '),
      html,
      text: draft.text ? String(draft.text) : undefined, // always a string: nodemailer would read {path: ...} from disk
      attachments
    };
    mail.messageId = `<${crypto.randomUUID()}@${domain}>`;
    if (draft.inReplyTo) mail.inReplyTo = String(draft.inReplyTo);
    if (Array.isArray(draft.references) && draft.references.length) mail.references = draft.references.map(String);
    return mail;
  }

  /**
   * Render the MIME message. `keepBcc` must be false for what goes over SMTP (nodemailer's stream
   * transport would always keep the Bcc header, so we drive the composer directly) and true for the
   * copy filed in Sent/Drafts.
   */
  async _renderRaw(mail, keepBcc) {
    const node = new MailComposer(mail).compile();
    node.keepBcc = Boolean(keepBcc);
    const raw = await node.build();
    return { raw, messageId: mail.messageId };
  }

  async sendMessage(accountId, draft) {
    const account = this.store.getAccount(accountId);
    const mail = this._buildMessage(account, draft);
    const recipients = [...mail.to, ...mail.cc, ...mail.bcc].map(a => a.address);
    if (!recipients.length) throw new Error('Add at least one recipient.');
    const wire = await this._renderRaw(mail, false);
    const transport = this._smtpTransport(account, this.store.getSecret(accountId));
    let info;
    try {
      info = await transport.sendMail({ envelope: { from: account.email, to: recipients }, raw: wire.raw });
    } catch (err) {
      throw new Error(friendlyError(err, account));
    } finally {
      transport.close();
    }
    // If the server refused only some recipients, the message HAS gone out to the others. Reporting that as a
    // failure would invite a second send, so it counts as sent (with the refused addresses reported back).
    const rejected = (info.rejected || []).map(r => (typeof r === 'string' ? r : r && r.address)).filter(Boolean);
    if (rejected.length && !(info.accepted && info.accepted.length)) {
      throw new Error(`The server refused every recipient: ${rejected.join(', ')}`);
    }
    const accepted = (info.accepted && info.accepted.length ? info.accepted : recipients).map(r => (typeof r === 'string' ? r : r.address));
    if (this.store.noteContacts) this.store.noteContacts(accepted.map(address => ({ address })));
    // Gmail files sent mail itself; other servers need a copy appended.
    let savedToSent = account.provider === 'gmail';
    if (account.provider !== 'gmail') {
      try {
        const copy = await this._renderRaw(mail, true);
        await this._withClient(accountId, async (client) => {
          const sent = await this._ensureFolder(client, accountId, '\\Sent', ['sent', 'sent items', 'sent messages'], 'Sent');
          await appendMessage(client, sent, copy.raw, ['\\Seen']);
        });
        savedToSent = true;
      } catch (_) { /* the message was sent; failing to file a copy is not fatal */ }
    }
    return { messageId: wire.messageId, accepted, rejected, savedToSent };
  }

  async saveDraft(accountId, draft, replaceUid) {
    const account = this.store.getAccount(accountId);
    const mail = this._buildMessage(account, draft);
    const { raw } = await this._renderRaw(mail, true);
    return this._withClient(accountId, async (client) => {
      const drafts = await this._ensureFolder(client, accountId, '\\Drafts', ['drafts', 'draft'], 'Drafts');
      const res = await appendMessage(client, drafts, raw, ['\\Draft', '\\Seen']);
      if (replaceUid) {
        const lock = await client.getMailboxLock(drafts);
        try { await client.messageDelete(String(replaceUid), { uid: true }); } catch (_) { /* ignore */ } finally { lock.release(); }
      }
      return { path: drafts, uid: res && res.uid ? res.uid : null };
    });
  }

  /** Remove a draft for good (used after it has been sent, or when the user discards it). */
  async deleteDraft(accountId, path, uid) {
    const range = uidList(uid);
    const drafts = await this._findSpecial(accountId, '\\Drafts', ['drafts', 'draft']);
    if (!drafts || drafts !== path) throw new Error('That message is not in the Drafts folder.');
    return this._withClient(accountId, async (client) => {
      const lock = await client.getMailboxLock(path);
      try {
        if (!(await client.messageDelete(range, { uid: true }))) throw new Error('The server would not delete that draft.');
        return true;
      } finally {
        lock.release();
      }
    });
  }

  // ---- account testing (used before saving) -------------------------------
  async testConnection(input, password) {
    const account = this.store.normalizeAccount(input, input.id ? this.store.getAccount(input.id) : null);
    const pass = password || (input.id ? this.store.getSecret(input.id) : '');
    if (!pass) return { imap: { ok: false, error: 'Enter the password.' }, smtp: { ok: false, error: 'Enter the password.' } };
    const result = { imap: { ok: false }, smtp: { ok: false } };
    const client = new ImapFlow(this._imapOptions(account, pass));
    client.on('error', () => {});
    try {
      await client.connect();
      const boxes = await client.list();
      result.imap = { ok: true, folders: boxes.length };
    } catch (err) {
      result.imap = { ok: false, error: friendlyError(err, account) };
    } finally {
      try { await client.logout(); } catch (_) { try { client.close(); } catch (__) { /* ignore */ } }
    }
    const transport = this._smtpTransport(account, pass);
    try {
      await transport.verify();
      result.smtp = { ok: true };
    } catch (err) {
      result.smtp = { ok: false, error: friendlyError(err, account) };
    } finally {
      transport.close();
    }
    return result;
  }
}

module.exports = { MailService, friendlyError, hasAttachmentPart, parseListUnsubscribe, moveOrThrow };
