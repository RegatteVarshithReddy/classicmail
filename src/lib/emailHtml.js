import DOMPurify from 'dompurify';
import { escapeHtml } from './format.mjs';

/**
 * Turns a message body into a self-contained document for a sandboxed iframe.
 *
 * Layers, from outermost: the iframe has no scripts and an opaque origin; its own CSP only allows
 * inline styles and data: images (plus remote images if the user chose to load them); DOMPurify strips
 * scripts, forms, embeds and event handlers; and remote pictures/backgrounds are removed from the markup
 * until the user asks for them, so a tracking pixel never fires.
 */
const REMOTE = /^\s*(https?:)?\/\//i;
// CSS that can make the browser fetch something. Written to over-match: a declaration that mentions any of these
// is dropped, unless it is a plain data: image. Escapes (\72 = "r") can hide any of the names, so a backslash counts too.
const RISKY_CSS = /\\|url\s*\(|image-set|cross-fade|(^|[^\w-])image\s*\(|element\s*\(|(^|[^\w-])src\s*\(|@import|expression|behavior|-moz-binding/i;
const DATA_IMAGE_ONLY = /^[^\\]*?url\(\s*(['"]?)data:image\/[a-z+.-]+;base64,[a-z0-9+/=\s]*\1\s*\)[^\\]*$/i;

/** Split a style attribute at top-level semicolons (a data: URL contains one inside its parentheses). */
function splitDeclarations(css) {
  const out = [];
  let cur = '';
  let depth = 0;
  let quote = '';
  for (const ch of css) {
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Keep the harmless declarations of an inline style; report whether any were dropped. */
function safeInlineStyle(css) {
  let dropped = false;
  const kept = splitDeclarations(String(css)).filter((d) => {
    const risky = RISKY_CSS.test(d) && !DATA_IMAGE_ONLY.test(d);
    if (risky) dropped = true;
    return !risky;
  });
  return { style: kept.join(';'), dropped };
}

/** A whole stylesheet: anything that could fetch, escape or import makes us drop the sheet rather than guess. */
function stylesheetIsSafe(css) {
  return !RISKY_CSS.test(String(css).replace(/url\(\s*(['"]?)data:image\/[a-z+.-]+;base64,[a-z0-9+/=\s]*\1\s*\)/gi, ''));
}

export function sanitizeHtml(html, { allowRemote, dropStyleTags = false }) {
  let blocked = 0;
  const purifier = DOMPurify(window);
  purifier.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style' && !allowRemote && node.textContent && !stylesheetIsSafe(node.textContent)) {
      blocked += 1;
      node.textContent = '';
    }
  });
  purifier.addHook('afterSanitizeAttributes', (node) => {
    const tag = node.tagName;
    if (tag === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    // Anything that fetches something must be inline data or, if the user allowed it, plain http(s).
    // Relative, file:, blob: and similar URLs never leave the markup.
    for (const attr of ['src', 'srcset', 'background', 'poster']) {
      const value = node.getAttribute && node.getAttribute(attr);
      if (!value) continue;
      const v = value.trim();
      const isData = attr !== 'srcset' && /^data:image\//i.test(v);
      const isRemote = attr === 'srcset' || REMOTE.test(v);
      if (isData || (isRemote && allowRemote)) continue;
      node.removeAttribute(attr);
      node.setAttribute('data-blocked', '1');
      if (isRemote) blocked += 1; // only real remote content is worth a "pictures were blocked" banner
    }
    if (!allowRemote) {
      const style = node.getAttribute && node.getAttribute('style');
      if (style && RISKY_CSS.test(style)) {
        const { style: cleaned, dropped } = safeInlineStyle(style);
        if (cleaned.trim()) node.setAttribute('style', cleaned); else node.removeAttribute('style');
        if (dropped) blocked += 1;
      }
    }
  });
  const clean = purifier.sanitize(html, {
    WHOLE_DOCUMENT: false,
    FORBID_TAGS: ['link', 'meta', 'base', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'textarea', 'svg', 'math', 'video', 'audio', 'source', 'track', 'template', ...(dropStyleTags ? ['style'] : [])],
    FORBID_ATTR: ['formaction', 'action', 'srcdoc'],
    ADD_TAGS: dropStyleTags ? [] : ['style'],
    ALLOW_DATA_ATTR: false
  });
  purifier.removeAllHooks();
  return { html: clean, blocked };
}

function linkify(escaped) {
  return escaped.replace(/\bhttps?:\/\/[^\s<>"')]+/gi, url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}

export function buildBody({ html, text, allowRemote = false }) {
  let body;
  let blocked = 0;
  if (html && html.trim()) {
    const res = sanitizeHtml(html, { allowRemote });
    body = res.html;
    blocked = res.blocked;
  } else {
    body = `<pre class="cm-plain">${linkify(escapeHtml(text || ''))}</pre>`;
  }
  const csp = [
    "default-src 'none'",
    `img-src data: cid: ${allowRemote ? 'https: http:' : ''}`,
    "style-src 'unsafe-inline'",
    `font-src data: ${allowRemote ? 'https:' : ''}`
  ].join('; ');
  const srcdoc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>
  html{background:#fff}
  body{margin:0;padding:14px 18px;font:14px/1.45 "Segoe UI","Noto Sans",Ubuntu,Arial,sans-serif;color:#222;overflow-wrap:anywhere;word-break:break-word}
  img{max-width:100%;height:auto}
  a{color:#0563c1}
  table{max-width:100%}
  blockquote{margin:8px 0 8px 4px;padding-left:10px;border-left:3px solid #c8c8c8;color:#555}
  .cm-plain{white-space:pre-wrap;font:inherit;margin:0}
  [data-blocked]{outline:1px dashed #bbb;outline-offset:-1px;min-width:12px;min-height:12px}
</style></head><body>${body}</body></html>`;
  return { srcdoc, blocked };
}

/** Clean HTML typed or pasted into the composer, safe to send and to show back. */
/** What is sent: the editor's content minus anything that could run. Pictures the user pasted stay as they are. */
export function sanitizeComposed(html) {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'link', 'meta', 'base', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'svg', 'math', 'video', 'audio'],
    FORBID_ATTR: ['srcdoc'],
    ALLOW_DATA_ATTR: false
  });
}

/**
 * HTML that is loaded INTO the compose editor (an old draft, a quoted reply). The compose window is not sandboxed the
 * way the reading pane is, so nothing that fetches from the network may get through: no remote pictures, no CSS that
 * loads anything, no <style> blocks, no scripts.
 */
export function sanitizeForEditor(html) {
  return sanitizeHtml(String(html || ''), { allowRemote: false, dropStyleTags: true }).html;
}
