import React, { useEffect, useState } from 'react';
import { call } from '../lib/api.js';
import { Icon } from '../lib/icons.jsx';
import { Modal, ConfirmDialog } from './Dialogs.jsx';

const DOMAIN_PRESET = { 'gmail.com': 'gmail', 'googlemail.com': 'gmail', 'yahoo.com': 'yahoo', 'ymail.com': 'yahoo', 'icloud.com': 'icloud', 'me.com': 'icloud', 'mac.com': 'icloud', 'fastmail.com': 'fastmail', 'fastmail.fm': 'fastmail' };
const SECURITY = [['ssl', 'SSL/TLS'], ['starttls', 'STARTTLS'], ['none', 'None (local only)']];

function blankAccount(presets) {
  const p = presets.gmail;
  return { id: '', provider: 'gmail', name: '', email: '', user: '', password: '', imap: { ...p.imap }, smtp: { ...p.smtp }, signature: '', allowSelfSigned: false, enabled: true };
}

function Endpoint({ label, value, onChange }) {
  return (
    <div className="ep">
      <div className="ep-label">{label}</div>
      <input className="input" placeholder="host name" value={value.host} onChange={e => onChange({ ...value, host: e.target.value })} aria-label={`${label} server`} />
      <input className="input port" type="number" min="1" max="65535" value={value.port} onChange={e => onChange({ ...value, port: Number(e.target.value) })} aria-label={`${label} port`} />
      <select className="input" value={value.security} onChange={e => onChange({ ...value, security: e.target.value })} aria-label={`${label} security`}>
        {SECURITY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}

function TestResult({ result }) {
  if (!result) return null;
  const line = (name, r) => (
    <div className={`test-line ${r.ok ? 'ok' : 'bad'}`}><Icon name={r.ok ? 'check' : 'warning'} size={15} /><span><b>{name}:</b> {r.ok ? 'connected' : r.error}</span></div>
  );
  return <div className="test-result">{line('Incoming (IMAP)', result.imap)}{line('Outgoing (SMTP)', result.smtp)}</div>;
}

function AccountForm({ initial, presets, onCancel, onSaved }) {
  const [a, setA] = useState(initial);
  const [touchedProvider, setTouchedProvider] = useState(Boolean(initial.id));
  const [showServers, setShowServers] = useState(!initial.id || initial.provider === 'other');
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const isNew = !initial.id;
  const preset = presets[a.provider] || presets.other;

  const setProvider = (p) => {
    setTouchedProvider(true);
    setResult(null);
    setA(cur => ({ ...cur, provider: p, imap: { ...presets[p].imap }, smtp: { ...presets[p].smtp } }));
    setShowServers(p === 'other');
  };
  const onEmail = (email) => {
    setA(cur => {
      const next = { ...cur, email };
      const domain = email.split('@')[1] && email.split('@')[1].toLowerCase();
      const guess = DOMAIN_PRESET[domain];
      if (isNew && !touchedProvider && guess && guess !== cur.provider) {
        next.provider = guess; next.imap = { ...presets[guess].imap }; next.smtp = { ...presets[guess].smtp };
      }
      return next;
    });
  };
  const payload = () => ({ account: { ...a, password: undefined, user: a.user || a.email }, password: a.password });

  const test = async () => {
    setBusy('test'); setError(''); setResult(null);
    try { setResult(await call('accounts.test', payload())); } catch (e) { setError(e.message); }
    setBusy('');
  };
  const save = async (force) => {
    setBusy('save'); setError('');
    try {
      if (!force) {
        const r = await call('accounts.test', payload());
        setResult(r);
        if (!r.imap.ok || !r.smtp.ok) { setBusy('failed'); return; }
      }
      const saved = await call('accounts.save', payload());
      onSaved(saved);
    } catch (e) { setError(e.message); setBusy(''); }
  };
  const canSave = a.email.includes('@') && (a.password || !isNew) && a.imap.host && a.smtp.host;

  return (
    <div className="form">
      <div className="form-grid">
        <label className="field-label">Account type</label>
        <select className="input" value={a.provider} disabled={!isNew} onChange={e => setProvider(e.target.value)}>
          {Object.entries(presets).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
        </select>
        <label className="field-label">Your name</label>
        <input className="input" value={a.name} onChange={e => setA({ ...a, name: e.target.value })} placeholder="Shown to people you email" />
        <label className="field-label">Email address</label>
        <input className="input" type="email" value={a.email} onChange={e => onEmail(e.target.value)} disabled={!isNew} placeholder="you@example.com" autoFocus={isNew} />
        <label className="field-label">{a.provider === 'gmail' ? 'App password' : 'Password'}</label>
        <input className="input" type="password" autoComplete="new-password" value={a.password} onChange={e => { setA({ ...a, password: e.target.value }); setResult(null); }}
          placeholder={isNew ? '' : 'Leave blank to keep the saved password'} />
      </div>
      {preset.note && <div className="hint"><Icon name="info" size={15} /><span>{preset.note}{a.provider === 'gmail' && <> Google only shows app passwords when 2-Step Verification is on. Enter the 16 letters without spaces.</>}</span></div>}

      <button className="link expander" onClick={() => setShowServers(s => !s)}><Icon name={showServers ? 'chevron' : 'chevron-right'} size={11} /> Server settings</button>
      {showServers && (
        <div className="servers">
          <Endpoint label="Incoming (IMAP)" value={a.imap} onChange={imap => setA({ ...a, imap })} />
          <Endpoint label="Outgoing (SMTP)" value={a.smtp} onChange={smtp => setA({ ...a, smtp })} />
          <div className="form-grid">
            <label className="field-label">User name</label>
            <input className="input" value={a.user} onChange={e => setA({ ...a, user: e.target.value })} placeholder={a.email || 'Same as email address'} />
          </div>
          <label className="check"><input type="checkbox" checked={a.allowSelfSigned} onChange={e => setA({ ...a, allowSelfSigned: e.target.checked })} /><span>Accept an untrusted (self-signed) server certificate <span className="muted">— only for a server you run yourself</span></span></label>
        </div>
      )}

      <div className="form-grid">
        <label className="field-label">Signature</label>
        <textarea className="input" rows="3" value={a.signature} onChange={e => setA({ ...a, signature: e.target.value })} placeholder="Added to new messages (plain text)" />
      </div>

      <TestResult result={result} />
      {error && <div className="banner error"><Icon name="warning" size={16} /><span>{error}</span></div>}
      <div className="form-actions">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn" onClick={test} disabled={!canSave || Boolean(busy)}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
        {busy === 'failed' && <button className="btn danger" onClick={() => save(true)}>Save anyway</button>}
        <button className="btn primary" onClick={() => save(false)} disabled={!canSave || busy === 'save' || busy === 'test'}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

function AccountsTab({ accounts, presets, onChanged }) {
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [error, setError] = useState('');
  if (editing) {
    return <AccountForm initial={editing} presets={presets} onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await onChanged(); }} />;
  }
  const toggle = async (acc) => {
    try { await call('accounts.save', { account: { ...acc, enabled: !acc.enabled }, password: '' }); await onChanged(); } catch (e) { setError(e.message); }
  };
  return (
    <div>
      <div className="section-head"><h3>Email accounts</h3><button className="btn primary" onClick={() => setEditing(blankAccount(presets))}><Icon name="plus" size={14} /> Add account</button></div>
      {error && <div className="banner error"><Icon name="warning" size={16} /><span>{error}</span></div>}
      {!accounts.length && <p className="muted">No accounts yet. Add your first account to start reading mail.</p>}
      <div className="cards">
        {accounts.map(a => (
          <div key={a.id} className={`card ${a.enabled ? '' : 'off'}`}>
            <span className="dot big" style={{ background: a.color }} />
            <div className="card-main"><b>{a.email}</b><span className="muted">{a.name} · {a.imap.host}</span></div>
            <label className="check inline"><input type="checkbox" checked={a.enabled} onChange={() => toggle(a)} /> Enabled</label>
            <button className="btn small" onClick={() => setEditing({ ...a, password: '' })}>Edit</button>
            <button className="btn small danger-outline" onClick={() => setRemoving(a)}>Remove</button>
          </div>
        ))}
      </div>
      {removing && (
        <ConfirmDialog title="Remove account" danger confirmLabel="Remove" onCancel={() => setRemoving(null)}
          message={`Remove ${removing.email} from ClassicMail? Your mail stays on the server; only the saved password and settings on this computer are deleted.`}
          onConfirm={async () => { const id = removing.id; setRemoving(null); try { await call('accounts.remove', id); await onChanged(); } catch (e) { setError(e.message); } }} />
      )}
    </div>
  );
}

function CalendarsTab({ calendars, onChanged }) {
  const [mode, setMode] = useState('url');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const add = async () => {
    setBusy(true); setError('');
    try {
      const cal = mode === 'url' ? { type: 'url', url: url.trim() } : { type: 'file', path: file };
      const check = await call('calendars.check', cal);
      await call('calendars.save', { ...cal, name: name.trim() || check.name || 'Calendar' });
      setUrl(''); setFile(''); setName('');
      await onChanged();
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const pick = async () => { try { const p = await call('calendars.pickFile'); if (p) setFile(p); } catch (e) { setError(e.message); } };
  const update = async (c, patch) => { try { await call('calendars.save', { ...c, ...patch }); await onChanged(); } catch (e) { setError(e.message); } };
  const remove = async (c) => { try { await call('calendars.remove', c.id); await onChanged(); } catch (e) { setError(e.message); } };
  return (
    <div>
      <div className="section-head"><h3>Calendars</h3></div>
      <div className="cards">
        {calendars.map(c => (
          <div key={c.id} className={`card ${c.enabled ? '' : 'off'}`}>
            <input type="color" className="color" value={c.color} onChange={e => update(c, { color: e.target.value })} aria-label={`Colour for ${c.name}`} />
            <div className="card-main"><b>{c.name}</b><span className="muted trunc">{c.type === 'url' ? c.url : c.path}</span></div>
            <label className="check inline"><input type="checkbox" checked={c.enabled} onChange={e => update(c, { enabled: e.target.checked })} /> Show</label>
            <button className="btn small danger-outline" onClick={() => remove(c)}>Remove</button>
          </div>
        ))}
        {!calendars.length && <p className="muted">No calendars yet.</p>}
      </div>
      <div className="section-head"><h3>Add a calendar</h3></div>
      <div className="seg">
        <button className={mode === 'url' ? 'active' : ''} onClick={() => setMode('url')}>From a link</button>
        <button className={mode === 'file' ? 'active' : ''} onClick={() => setMode('file')}>From a file</button>
      </div>
      <div className="form-grid">
        {mode === 'url' ? (
          <><label className="field-label">Calendar link</label>
            <input className="input" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…/basic.ics  or  webcal://…" /></>
        ) : (
          <><label className="field-label">.ics file</label>
            <div className="file-pick"><input className="input" readOnly value={file} placeholder="No file chosen" /><button className="btn" onClick={pick}>Browse…</button></div></>
        )}
        <label className="field-label">Name (optional)</label>
        <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Taken from the calendar if left empty" />
      </div>
      {error && <div className="banner error"><Icon name="warning" size={16} /><span>{error}</span></div>}
      <div className="form-actions"><button className="btn primary" disabled={busy || (mode === 'url' ? !url.trim() : !file)} onClick={add}>{busy ? 'Checking…' : 'Add calendar'}</button></div>
      <div className="hint stacked">
        <div><b>Google Calendar:</b> Settings → click the calendar → <i>Integrate calendar</i> → copy <i>Secret address in iCal format</i>.</div>
        <div><b>Outlook.com / Microsoft 365:</b> Settings → Calendar → Shared calendars → <i>Publish a calendar</i> → copy the <i>ICS</i> link.</div>
        <div className="muted">Calendars are read-only and refresh every 15 minutes. Anyone with a secret link can read that calendar, so treat it like a password.</div>
      </div>
    </div>
  );
}

function GeneralTab({ settings, onChange, info }) {
  const row = (label, control) => (<><label className="field-label">{label}</label><div>{control}</div></>);
  return (
    <div>
      <div className="section-head"><h3>Reading</h3></div>
      <div className="form-grid">
        {row('Reading pane', <select className="input" value={settings.readingPane} onChange={e => onChange({ readingPane: e.target.value })}><option value="right">Right</option><option value="bottom">Bottom</option><option value="off">Off</option></select>)}
        {row('Mark as read', <select className="input" value={settings.markReadDelayMs} onChange={e => onChange({ markReadDelayMs: Number(e.target.value) })}><option value={0}>Immediately</option><option value={1500}>After 1.5 seconds</option><option value={5000}>After 5 seconds</option><option value={-1}>Never (manually)</option></select>)}
        {row('Pictures', <label className="check"><input type="checkbox" checked={settings.loadRemoteImages} onChange={e => onChange({ loadRemoteImages: e.target.checked })} /><span>Always download pictures in messages <span className="muted">(senders can see that you opened the mail)</span></span></label>)}
        {row('Theme', <select className="input" value={settings.theme} onChange={e => onChange({ theme: e.target.value })}><option value="system">Match system</option><option value="light">Light</option><option value="dark">Dark</option></select>)}
      </div>
      <div className="section-head"><h3>New mail</h3></div>
      <div className="form-grid">
        {row('Check every', <select className="input" value={settings.checkIntervalSec} onChange={e => onChange({ checkIntervalSec: Number(e.target.value) })}>{[[60, '1 minute'], [90, '90 seconds'], [300, '5 minutes'], [600, '10 minutes'], [1800, '30 minutes']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}{![60, 90, 300, 600, 1800].includes(settings.checkIntervalSec) && <option value={settings.checkIntervalSec}>{settings.checkIntervalSec} seconds</option>}</select>)}
        {row('Notifications', <label className="check"><input type="checkbox" checked={settings.notifications} onChange={e => onChange({ notifications: e.target.checked })} /><span>Show a desktop notification for new mail</span></label>)}
      </div>
      <div className="section-head"><h3>About</h3></div>
      {info && (
        <div className="about">
          <div>ClassicMail {info.version} · Electron {info.electron}</div>
          <div className="muted">Settings and account data: {info.dataDir}</div>
          {info.keyring === 'ok' && <div className="ok-line"><Icon name="check" size={14} /> Passwords are stored in your system keyring.</div>}
          {info.keyring === 'missing' && <div className="banner error"><Icon name="warning" size={16} /><span>No system keyring found, so passwords cannot be saved. Run <code>sudo apt install gnome-keyring libsecret-1-0</code>, then log out and back in.</span></div>}
          {info.keyring === 'insecure-test' && <div className="banner warn"><Icon name="warning" size={16} /><span>Test mode: passwords are stored unencrypted.</span></div>}
        </div>
      )}
    </div>
  );
}

function AiTab() {
  const [enabled, setEnabled] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const cfg = await call('ai.getConfig');
        setEnabled(cfg.enabled); setHasKey(cfg.hasKey);
      } catch (e) { setError(e.message); }
      setLoaded(true);
    })();
  }, []);

  const save = async () => {
    setBusy(true); setError(''); setNote('');
    try {
      const cfg = await call('ai.setConfig', { enabled, apiKey });
      setEnabled(cfg.enabled); setHasKey(cfg.hasKey); setApiKey('');
      setNote('Saved.');
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  if (!loaded) return null;
  return (
    <div>
      <div className="section-head"><h3>AI drafting</h3></div>
      <div className="form-grid">
        <label className="field-label">Draft with Claude</label>
        <label className="check"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /><span>Enable AI drafting in the compose window <span className="muted">(uses the Claude API)</span></span></label>
        <label className="field-label">API key</label>
        <input className="input" type="password" autoComplete="new-password" value={apiKey} onChange={e => setApiKey(e.target.value)}
          placeholder={hasKey ? 'Leave blank to keep the saved key' : 'sk-ant-…'} />
      </div>
      <div className="hint">
        <Icon name="info" size={15} />
        <span>When you use “Draft with Claude”, the message you're replying to and your instructions are sent to Anthropic's API. Nothing else in ClassicMail leaves your computer. Get a key at <b>console.anthropic.com/settings/keys</b>.</span>
      </div>
      {error && <div className="banner error"><Icon name="warning" size={16} /><span>{error}</span></div>}
      <div className="form-actions">
        <button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        {note && <span className="muted">{note}</span>}
      </div>
    </div>
  );
}

export default function Settings({ initialTab = 'accounts', accounts, calendars, settings, presets, info, onClose, onAccountsChanged, onCalendarsChanged, onSettingChange }) {
  const [tab, setTab] = useState(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  return (
    <Modal title="ClassicMail Settings" onClose={onClose} width={720} className="settings-modal">
      <div className="settings">
        <div className="settings-tabs" role="tablist">
          {[['accounts', 'Accounts'], ['calendars', 'Calendars'], ['general', 'General'], ['ai', 'AI']].map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <div className="settings-body">
          {tab === 'accounts' && <AccountsTab accounts={accounts} presets={presets} onChanged={onAccountsChanged} />}
          {tab === 'calendars' && <CalendarsTab calendars={calendars} onChanged={onCalendarsChanged} />}
          {tab === 'general' && <GeneralTab settings={settings} onChange={onSettingChange} info={info} />}
          {tab === 'ai' && <AiTab />}
        </div>
      </div>
    </Modal>
  );
}
