export function initials(nameOrEmail) {
  const s = String(nameOrEmail || '?').replace(/[<>"']/g, '').trim();
  const parts = s.includes('@') && !s.includes(' ') ? [s.split('@')[0]] : s.split(/\s+/);
  const letters = parts.filter(Boolean).slice(0, 2).map(p => p[0]).join('');
  return (letters || '?').toUpperCase();
}

const AVATAR_COLORS = ['#0f6cbd', '#c239b3', '#ca5010', '#107c10', '#8764b8', '#008272', '#b4009e', '#986f0b', '#4f6bed', '#a4262c'];
export function avatarColor(seed) {
  let h = 0;
  for (const ch of String(seed || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function personLabel(p) {
  if (!p) return '';
  return p.name && p.name !== p.address ? p.name : (p.address || '');
}

export function formatAddress(p) {
  if (!p) return '';
  return p.name && p.name !== p.address ? `${p.name} <${p.address}>` : p.address;
}

const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Outlook-style group name for a message date. */
export function dateGroup(iso, now = new Date()) {
  if (!iso) return 'Older';
  const d = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  if (days < 14) return 'Last Week';
  if (days < 30) return 'Earlier This Month';
  if (days < 60) return 'Last Month';
  return 'Older';
}

/** Short time for the list: time today, weekday this week, otherwise the date. */
export function listDate(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days <= 0) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: '2-digit' });
}

export function fullDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function parseAddressList(text) {
  const out = [];
  for (const part of String(text || '').split(/[;,]\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const t = part.trim();
    if (!t) continue;
    const m = t.match(/^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/);
    if (m) out.push({ name: m[1].replace(/^"|"$/g, '').trim(), address: m[2] });
    else if (/^[^\s@<>]+@[^\s@<>]+$/.test(t)) out.push({ name: '', address: t });
    else out.push({ name: '', address: t, invalid: true });
  }
  return out;
}
