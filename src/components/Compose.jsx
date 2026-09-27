import React, { useCallback, useEffect, useRef, useState } from 'react';
import { call, on } from '../lib/api.js';
import { Icon } from '../lib/icons.jsx';
import { formatAddress, formatSize, parseAddressList } from '../lib/format.mjs';
import { sanitizeComposed, sanitizeForEditor } from '../lib/emailHtml.js';
import { ConfirmDialog, Modal, PromptDialog } from './Dialogs.jsx';

const MAX_TOTAL = 25 * 1024 * 1024;

function AddressField({ label, value, onChange, autoFocus }) {
  const [text, setText] = useState('');
  const [sugs, setSugs] = useState([]);
  const [idx, setIdx] = useState(-1);
  const timer = useRef(null);
  const input = useRef(null);
  useEffect(() => { if (autoFocus && input.current) input.current.focus(); }, [autoFocus]);

  const add = (list) => { if (list.length) onChange([...value, ...list.filter(p => !value.some(v => v.address.toLowerCase() === p.address.toLowerCase()))]); };
  const commit = (t = text) => { if (t.trim()) add(parseAddressList(t)); setText(''); setSugs([]); setIdx(-1); };
  const search = (t) => {
    clearTimeout(timer.current);
    const q = t.trim();
    if (!q || q.includes('<')) { setSugs([]); return; }
    timer.current = setTimeout(async () => {
      try {
        const res = await call('contacts.search', q);
        setSugs(res.filter(r => !value.some(v => v.address.toLowerCase() === r.address.toLowerCase())).slice(0, 6));
        setIdx(-1);
      } catch (_) { setSugs([]); }
    }, 120);
  };
  const onKeyDown = (e) => {
    if ((e.key === 'Enter' || e.key === 'Tab') && sugs.length && idx >= 0) { e.preventDefault(); add([sugs[idx]]); setText(''); setSugs([]); setIdx(-1); return; }
    if (e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === 'Tab' && text.trim())) { if (text.trim() || e.key !== 'Tab') { e.preventDefault(); commit(); } return; }
    if (e.key === 'Backspace' && !text && value.length) { onChange(value.slice(0, -1)); return; }
    if (e.key === 'ArrowDown' && sugs.length) { e.preventDefault(); setIdx(i => (i + 1) % sugs.length); }
    if (e.key === 'ArrowUp' && sugs.length) { e.preventDefault(); setIdx(i => (i <= 0 ? sugs.length - 1 : i - 1)); }
    if (e.key === 'Escape') setSugs([]);
  };
  return (
    <div className="addr-row">
      <label className="addr-label" onClick={() => input.current && input.current.focus()}>{label}</label>
      <div className="addr-box" onClick={() => input.current && input.current.focus()}>
        {value.map((p, i) => (
          <span key={`${p.address}-${i}`} className={`recip ${p.invalid ? 'invalid' : ''}`} title={p.invalid ? 'This is not a valid email address' : p.address}>
            {p.name || p.address}
            <button className="recip-x" onClick={(e) => { e.stopPropagation(); onChange(value.filter((_, j) => j !== i)); }} aria-label={`Remove ${p.address}`}><Icon name="close" size={10} /></button>
          </span>
        ))}
        <input ref={input} className="addr-input" value={text} onChange={e => { setText(e.target.value); search(e.target.value); }} onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => commit(), 120)} onPaste={(e) => { const t = e.clipboardData.getData('text'); if (/[;,\n]/.test(t)) { e.preventDefault(); commit(t.replace(/\n/g, ',')); } }}
          aria-label={label} />
        {sugs.length > 0 && (
          <div className="sugs" role="listbox">
            {sugs.map((s, i) => (
              <div key={s.address} role="option" aria-selected={i === idx} className={`sug ${i === idx ? 'active' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); add([s]); setText(''); setSugs([]); }}>
                <b>{s.name || s.address}</b>{s.name && <span className="muted"> {s.address}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolBtn({ icon, label, onClick, active }) {
  return <button className={`tool ${active ? 'active' : ''}`} title={label} aria-label={label} onMouseDown={e => e.preventDefault()} onClick={onClick}><Icon name={icon} size={16} /></button>;
}

export default function Compose() {
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [aiCfg, setAiCfg] = useState({ enabled: false, hasKey: false });
  const [to, setTo] = useState([]);
  const [cc, setCc] = useState([]);
  const [bcc, setBcc] = useState([]);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [dialog, setDialog] = useState(null);
  const editor = useRef(null);
  const meta = useRef({ inReplyTo: '', references: [], mode: 'new' });
  const draft = useRef(null); // { path, uid }
  const fileInput = useRef(null);
  const savedRange = useRef(null);
  const latest = useRef({});

  useEffect(() => {
    (async () => {
      try {
        const [init, accs, aiCfgRes] = await Promise.all([call('compose.init'), call('accounts.list'), call('ai.getConfig').catch(() => ({ enabled: false, hasKey: false }))]);
        if (!init) throw new Error('This window has nothing to compose.');
        setAiCfg(aiCfgRes);
        const enabled = accs.filter(a => a.enabled);
        setAccounts(enabled);
        setAccountId(enabled.some(a => a.id === init.accountId) ? init.accountId : (enabled[0] && enabled[0].id) || '');
        setTo(init.to || []); setCc(init.cc || []); setBcc(init.bcc || []); setShowBcc(Boolean(init.bcc && init.bcc.length));
        setSubject(init.subject || '');
        setAttachments(init.attachments || []);
        meta.current = { inReplyTo: init.inReplyTo || '', references: init.references || [], mode: init.mode || 'new' };
        draft.current = init.draft || null; // editing an existing draft replaces it when saved
        setReady(true);
        requestAnimationFrame(() => {
          const el = editor.current;
          if (!el) return;
          el.innerHTML = sanitizeForEditor(init.html || (init.text ? init.text.replace(/</g, '&lt;').replace(/\n/g, '<br>') : '<p><br></p>'));
          if (init.to && init.to.length) {
            el.focus();
            const r = document.createRange(); r.setStart(el, 0); r.collapse(true);
            const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
          }
        });
      } catch (e) { setLoadError(e.message); }
    })();
  }, []);

  useEffect(() => { document.title = `${subject.trim() || 'Untitled'} - Message`; }, [subject]);

  const collect = useCallback(() => {
    const body = sanitizeComposed(editor.current ? editor.current.innerHTML : '');
    return {
      to, cc, bcc, subject,
      html: `<div style="font-family:Calibri,'Segoe UI',Arial,sans-serif;font-size:11pt">${body}</div>`,
      text: editor.current ? editor.current.innerText : '',
      inReplyTo: meta.current.inReplyTo,
      references: meta.current.references,
      attachments: attachments.map(({ filename, contentType, contentBase64 }) => ({ filename, contentType, contentBase64 }))
    };
  }, [to, cc, bcc, subject, attachments]);

  const touch = useCallback(() => setDirty(true), []);
  const set = (fn) => (v) => { fn(v); setDirty(true); };

  const saveDraft = useCallback(async (quiet) => {
    if (!accountId) return false;
    setBusy('draft'); if (!quiet) setError('');
    try {
      const res = await call('mail.saveDraft', accountId, collect(), draft.current ? draft.current.uid : undefined);
      draft.current = res && res.uid ? res : draft.current;
      setDirty(false);
      setNote(`Draft saved at ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`);
      return true;
    } catch (e) { if (!quiet) setError(`Could not save the draft: ${e.message}`); return false; }
    finally { setBusy(''); }
  }, [accountId, collect]);

  const runAi = useCallback(async (instruction) => {
    setDialog(null); setBusy('ai'); setError('');
    try {
      const quote = editor.current && editor.current.querySelector('.cm-quote');
      const { text } = await call('ai.draft', { subject, quotedText: quote ? quote.innerText : '', instruction, mode: meta.current.mode });
      const el = editor.current;
      el.focus();
      const r = document.createRange(); r.setStart(el, 0); r.collapse(true);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.execCommand('insertText', false, `${text}\n\n`);
      setDirty(true);
    } catch (e) { setError(`Could not draft with Claude: ${e.message}`); }
    finally { setBusy(''); }
  }, [subject]);

  const doSend = useCallback(async () => {
    setBusy('send'); setError('');
    try {
      const result = await call('mail.send', accountId, collect());
      if (draft.current) { try { await call('mail.deleteDraft', accountId, draft.current.path, draft.current.uid); } catch (_) { /* leave the draft */ } }
      if (result && result.rejected && result.rejected.length) {
        // The message HAS been sent to the other recipients. Say so, so nobody sends it a second time.
        setBusy('');
        setDialog({ type: 'partial', rejected: result.rejected });
        return;
      }
      await call('compose.close', { sent: true, accountId });
    } catch (e) { setError(e.message); setBusy(''); }
  }, [accountId, collect]);

  const send = useCallback(() => {
    setError('');
    if (!to.length && !cc.length && !bcc.length) { setError('Add at least one recipient before sending.'); return; }
    const bad = [...to, ...cc, ...bcc].find(p => p.invalid);
    if (bad) { setError(`“${bad.address}” is not a valid email address.`); return; }
    if (!subject.trim()) {
      setDialog({ type: 'nosubject' });
      return;
    }
    doSend();
  }, [to, cc, bcc, subject, doSend]);

  latest.current = { send, saveDraft, dirty, accountId };

  // Ask before closing a window with unsaved changes.
  useEffect(() => on('compose:request-close', () => {
    if (!latest.current.dirty) { call('compose.close', {}).catch(() => {}); return; }
    setDialog({ type: 'close' });
  }), []);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); latest.current.send(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); latest.current.saveDraft(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Autosave every 90 seconds while there are unsaved changes.
  useEffect(() => {
    const t = setInterval(() => { if (latest.current.dirty && editor.current && (editor.current.innerText || '').trim()) latest.current.saveDraft(true); }, 90000);
    return () => clearInterval(t);
  }, []);

  const fmt = (cmd, value) => { editor.current && editor.current.focus(); document.execCommand(cmd, false, value); setDirty(true); };

  const aiDefaultInstruction = () => {
    const m = meta.current.mode;
    if (m === 'forward') return 'Write a brief, friendly note introducing the forwarded message below.';
    if (m === 'reply' || m === 'reply-all') return 'Write a polite, concise reply to the message below.';
    return 'Write a short, professional email.';
  };

  const addFiles = async (files) => {
    const list = Array.from(files || []);
    let total = attachments.reduce((n, a) => n + a.size, 0);
    const next = [];
    for (const f of list) {
      if (total + f.size > MAX_TOTAL) { setError(`“${f.name}” would make the attachments larger than 25 MB.`); continue; }
      const base64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] || '');
        r.onerror = () => reject(new Error(`Could not read ${f.name}`));
        r.readAsDataURL(f);
      }).catch((e) => { setError(e.message); return null; });
      if (base64 === null) continue;
      total += f.size;
      next.push({ filename: f.name, contentType: f.type || 'application/octet-stream', size: f.size, contentBase64: base64 });
    }
    if (next.length) { setAttachments(a => [...a, ...next]); setDirty(true); }
  };

  const onPaste = (e) => {
    const img = Array.from(e.clipboardData.files || []).find(f => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    if (img) {
      e.preventDefault();
      const r = new FileReader();
      r.onload = () => { document.execCommand('insertImage', false, String(r.result)); setDirty(true); };
      r.readAsDataURL(img);
    }
  };

  const rememberRange = () => {
    const s = window.getSelection();
    savedRange.current = s && s.rangeCount ? s.getRangeAt(0).cloneRange() : null;
  };
  const applyLink = (url) => {
    setDialog(null);
    let href = url.trim();
    if (!/^(https?:|mailto:)/i.test(href)) href = /^[^\s@]+@[^\s@]+$/.test(href) ? `mailto:${href}` : `https://${href}`;
    editor.current.focus();
    const s = window.getSelection();
    if (savedRange.current) { s.removeAllRanges(); s.addRange(savedRange.current); }
    if (s.isCollapsed) document.execCommand('insertHTML', false, `<a href="${href.replace(/"/g, '&quot;')}">${href.replace(/</g, '&lt;')}</a>`);
    else document.execCommand('createLink', false, href);
    setDirty(true);
  };

  if (loadError) return <div className="compose-fatal"><Icon name="warning" size={28} /><p>{loadError}</p></div>;
  if (!ready) return <div className="compose-fatal"><div className="spinner" /></div>;

  const account = accounts.find(a => a.id === accountId);
  return (
    <div className="compose">
      <div className="compose-ribbon">
        <button className="send-btn" onClick={send} disabled={busy === 'send'} title="Send (Ctrl+Enter)"><Icon name="send" size={26} /><span>{busy === 'send' ? 'Sending…' : 'Send'}</span></button>
        <div className="c-sep" />
        <div className="c-tools">
          <select className="input tiny" aria-label="Font size" defaultValue="3" onChange={e => { fmt('fontSize', e.target.value); }} onMouseDown={rememberRange}>
            <option value="2">Small</option><option value="3">Normal</option><option value="4">Large</option><option value="5">Huge</option>
          </select>
          <ToolBtn icon="bold" label="Bold (Ctrl+B)" onClick={() => fmt('bold')} />
          <ToolBtn icon="italic" label="Italic (Ctrl+I)" onClick={() => fmt('italic')} />
          <ToolBtn icon="underline" label="Underline (Ctrl+U)" onClick={() => fmt('underline')} />
          <span className="c-sep thin" />
          <ToolBtn icon="list-ul" label="Bullets" onClick={() => fmt('insertUnorderedList')} />
          <ToolBtn icon="list-ol" label="Numbering" onClick={() => fmt('insertOrderedList')} />
          <ToolBtn icon="link" label="Insert link" onClick={() => { rememberRange(); setDialog({ type: 'link' }); }} />
          <ToolBtn icon="eraser" label="Clear formatting" onClick={() => fmt('removeFormat')} />
        </div>
        <div className="c-sep" />
        <button className="tool wide" onClick={() => fileInput.current && fileInput.current.click()} title="Attach a file"><Icon name="attach" size={16} /> Attach</button>
        <button className="tool wide" onClick={() => saveDraft(false)} disabled={busy === 'draft'} title="Save draft (Ctrl+S)"><Icon name="save" size={16} /> Save draft</button>
        {aiCfg.enabled && aiCfg.hasKey && (
          <button className="tool wide" onClick={() => setDialog({ type: 'ai' })} disabled={busy === 'ai'} title="Draft the message body with Claude">
            <Icon name="mail-new" size={16} /> {busy === 'ai' ? 'Drafting…' : 'Draft with Claude'}
          </button>
        )}
        <input ref={fileInput} type="file" multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
      </div>

      <div className="compose-head">
        <div className="addr-row">
          <label className="addr-label" htmlFor="from-select">From</label>
          <select id="from-select" className="input from" value={accountId} onChange={e => { setAccountId(e.target.value); setDirty(true); draft.current = null; }}>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name ? `${a.name} <${a.email}>` : a.email}</option>)}
          </select>
        </div>
        <AddressField label="To" value={to} onChange={set(setTo)} autoFocus={!to.length} />
        <AddressField label="Cc" value={cc} onChange={set(setCc)} />
        {showBcc ? <AddressField label="Bcc" value={bcc} onChange={set(setBcc)} /> : <div className="addr-row"><span className="addr-label" /><button className="link small" onClick={() => setShowBcc(true)}>Add Bcc</button></div>}
        <div className="addr-row">
          <label className="addr-label" htmlFor="subject-input">Subject</label>
          <input id="subject-input" className="input subject" value={subject} onChange={e => { setSubject(e.target.value); setDirty(true); }} />
        </div>
        {attachments.length > 0 && (
          <div className="addr-row"><span className="addr-label">Attached</span>
            <div className="attach-strip inline">{attachments.map((a, i) => (
              <span key={i} className="chip"><Icon name="attach" size={13} /><span className="chip-name">{a.filename}</span><span className="chip-size">{formatSize(a.size)}</span>
                <button className="recip-x" onClick={() => { setAttachments(list => list.filter((_, j) => j !== i)); setDirty(true); }} aria-label={`Remove ${a.filename}`}><Icon name="close" size={10} /></button></span>
            ))}</div>
          </div>
        )}
      </div>
      {error && <div className="banner error"><Icon name="warning" size={16} /><span>{error}</span><button className="icon-btn" onClick={() => setError('')} aria-label="Dismiss"><Icon name="close" size={13} /></button></div>}

      <div ref={editor} className="editor" contentEditable suppressContentEditableWarning spellCheck onInput={touch} onPaste={onPaste} role="textbox" aria-multiline="true" aria-label="Message body" />
      <div className="compose-status"><span>{account ? `Sending as ${account.email}` : ''}</span><span>{note}</span></div>

      {dialog && dialog.type === 'nosubject' && (
        <ConfirmDialog title="No subject" message="This message has no subject. Send it anyway?" confirmLabel="Send" onCancel={() => setDialog(null)} onConfirm={() => { setDialog(null); doSend(); }} />
      )}
      {dialog && dialog.type === 'partial' && (
        <Modal title="Sent, with a problem" onClose={() => {}} width={480}
          footer={<button className="btn primary" autoFocus onClick={() => call('compose.close', { sent: true, accountId }).catch(() => {})}>OK</button>}>
          <p className="modal-text">Your message was sent, but the mail server refused {dialog.rejected.length === 1 ? 'this address' : 'these addresses'}:</p>
          <p className="modal-text"><b>{dialog.rejected.join(', ')}</b></p>
          <p className="modal-text">Everyone else received it. Check the spelling of the address and send a new message to it if needed. Do not send this message again.</p>
        </Modal>
      )}
      {dialog && dialog.type === 'link' && (
        <PromptDialog title="Insert link" label="Address (https://…)" initial="https://" confirmLabel="Insert" onCancel={() => setDialog(null)} onSubmit={applyLink} />
      )}
      {dialog && dialog.type === 'ai' && (
        <PromptDialog title="Draft with Claude" label="What should this email say?" initial={aiDefaultInstruction()} confirmLabel="Draft" onCancel={() => setDialog(null)} onSubmit={runAi} />
      )}
      {dialog && dialog.type === 'close' && (
        <Modal title="ClassicMail" onClose={() => setDialog(null)} width={440}
          footer={<>
            <button className="btn" onClick={() => setDialog(null)}>Cancel</button>
            <button className="btn danger" onClick={async () => {
              if (draft.current) { try { await call('mail.deleteDraft', accountId, draft.current.path, draft.current.uid); } catch (_) { /* ignore */ } }
              call('compose.close', {}).catch(() => {});
            }}>Discard</button>
            <button className="btn primary" onClick={async () => { const ok = await saveDraft(false); if (ok) call('compose.close', {}).catch(() => {}); else setDialog(null); }}>Save draft</button>
          </>}>
          <p className="modal-text">This message has not been sent. Save it as a draft?</p>
        </Modal>
      )}
    </div>
  );
}
