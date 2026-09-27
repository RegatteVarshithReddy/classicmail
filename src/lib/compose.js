import { escapeHtml, formatAddress } from './format.mjs';
import { sanitizeHtml } from './emailHtml.js';

const lower = s => String(s || '').toLowerCase();

function signatureHtml(account) {
  const sig = (account && account.signature || '').trim();
  if (!sig) return '';
  return `<div class="cm-signature"><br>${escapeHtml(sig).replace(/\n/g, '<br>')}</div>`;
}

function headerBlock(msg) {
  const list = arr => (arr || []).map(formatAddress).map(escapeHtml).join('; ');
  const when = msg.date ? new Date(msg.date).toLocaleString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  let h = `<b>From:</b> ${list(msg.from)}<br><b>Sent:</b> ${escapeHtml(when)}<br><b>To:</b> ${list(msg.to)}<br>`;
  if (msg.cc && msg.cc.length) h += `<b>Cc:</b> ${list(msg.cc)}<br>`;
  h += `<b>Subject:</b> ${escapeHtml(msg.subject || '')}`;
  return h;
}

/** The original message as a quotation. Remote content is dropped so composing never phones home. */
function quotedBody(msg) {
  const inner = msg.html && msg.html.trim()
    ? sanitizeHtml(msg.html, { allowRemote: false }).html
    : escapeHtml(msg.text || '').replace(/\n/g, '<br>');
  return `<div class="cm-quote"><hr><p>${headerBlock(msg)}</p><blockquote>${inner}</blockquote></div>`;
}

const prefix = (subject, tag) => (new RegExp(`^\\s*${tag}:`, 'i').test(subject || '') ? subject : `${tag}: ${subject || ''}`);

export function buildNew(account, extra = {}) {
  return { mode: 'new', accountId: account.id, to: [], cc: [], bcc: [], subject: '', html: `<p><br></p>${signatureHtml(account)}`, references: [], ...extra };
}

export function buildReply(msg, account, allAccounts, all = false) {
  const own = new Set(allAccounts.map(a => lower(a.email)));
  const primary = (msg.replyTo && msg.replyTo.length ? msg.replyTo : msg.from) || [];
  const seen = new Set();
  const uniq = (list) => list.filter(p => {
    const k = lower(p.address);
    if (!k || own.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const to = uniq(primary.slice());
  const cc = all ? uniq([...(msg.to || []), ...(msg.cc || [])]) : [];
  return {
    mode: all ? 'reply-all' : 'reply',
    accountId: account.id,
    to: to.length ? to : primary.slice(0, 1),
    cc,
    bcc: [],
    subject: prefix(msg.subject, 'RE'),
    html: `<p><br></p>${signatureHtml(account)}${quotedBody(msg)}`,
    inReplyTo: msg.messageId || '',
    references: [...(msg.references || []), ...(msg.messageId ? [msg.messageId] : [])].slice(-20)
  };
}

export function buildForward(msg, account) {
  const files = msg.attachments || []; // everything the reading pane lists, including parts sent as Content-Disposition: inline
  return {
    mode: 'forward',
    accountId: account.id,
    to: [], cc: [], bcc: [],
    subject: prefix(msg.subject, 'FW'),
    html: `<p><br></p>${signatureHtml(account)}${quotedBody(msg)}`,
    inReplyTo: '',
    references: [...(msg.references || []), ...(msg.messageId ? [msg.messageId] : [])].slice(-20),
    forwardOf: files.length ? { accountId: msg.accountId, path: msg.path, uid: msg.uid, indexes: files.map(a => a.index) } : undefined
  };
}
