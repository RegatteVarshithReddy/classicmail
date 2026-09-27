import React, { useMemo, useState } from 'react';
import { Icon } from '../lib/icons.jsx';
import { avatarColor, formatAddress, formatSize, fullDate, initials, personLabel } from '../lib/format.mjs';
import { buildBody } from '../lib/emailHtml.js';

function People({ label, list }) {
  if (!list || !list.length) return null;
  return (
    <div className="hdr-line"><span className="hdr-label">{label}</span><span className="hdr-people">{list.map((p, i) => <span key={i} title={p.address}>{personLabel(p)}{i < list.length - 1 ? '; ' : ''}</span>)}</span></div>
  );
}

function Body({ msg, allowRemote, onBlocked }) {
  const { srcdoc, blocked } = useMemo(() => buildBody({ html: msg.html, text: msg.text, allowRemote }), [msg.key, msg.html, msg.text, allowRemote]);
  React.useEffect(() => { onBlocked(blocked); }, [blocked]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <iframe
      title="Message body"
      className="body-frame"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={srcdoc}
    />
  );
}

export default function ReadingPane({ state, row, account, onReply, onReplyAll, onForward, onSaveAttachment, onAllowImages, imagesAllowed, onUnsubscribe, onRetry, onBack, showBack, multiCount }) {
  const [blocked, setBlocked] = useState(0);
  const [showAllTo, setShowAllTo] = useState(false);

  if (multiCount > 1) {
    return <section className="read-pane empty"><Icon name="mail" size={40} /><p>{multiCount} items selected</p></section>;
  }
  if (!row) {
    return <section className="read-pane empty"><Icon name="mail-open" size={40} /><p>Select an item to read</p></section>;
  }
  if (state.status === 'loading' || state.status === 'idle') {
    return (
      <section className="read-pane">
        <div className="read-head"><h2 className="read-subject">{row.subject || '(no subject)'}</h2><div className="hdr-line muted">{personLabel(row.from)}</div></div>
        <div className="read-loading"><div className="spinner" /> Loading message…</div>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section className="read-pane">
        <div className="read-head"><h2 className="read-subject">{row.subject || '(no subject)'}</h2></div>
        <div className="banner error"><Icon name="warning" size={16} /><span>{state.error}</span><button className="btn small" onClick={onRetry}>Try again</button></div>
      </section>
    );
  }
  const msg = state.data;
  const from = msg.from && msg.from[0];
  const toShown = showAllTo ? msg.to : (msg.to || []).slice(0, 3);
  const files = (msg.attachments || []);
  return (
    <section className="read-pane">
      <div className="read-head">
        {showBack && <button className="btn small back" onClick={onBack}><Icon name="chevron-left" size={14} /> Back to list</button>}
        <div className="read-top">
          <div className="avatar" style={{ background: avatarColor(from && from.address) }}>{initials(personLabel(from))}</div>
          <div className="read-who">
            <div className="read-from"><b title={from && from.address}>{personLabel(from)}</b> <span className="muted">&lt;{from && from.address}&gt;</span></div>
            <div className="read-date muted">{fullDate(msg.date)}{account && <span className="acct-chip"><span className="dot" style={{ background: account.color }} />{account.email}</span>}</div>
          </div>
          <div className="read-actions">
            <button className="icon-btn" onClick={onReply} title="Reply"><Icon name="reply" size={17} /></button>
            <button className="icon-btn" onClick={onReplyAll} title="Reply All"><Icon name="reply-all" size={17} /></button>
            <button className="icon-btn" onClick={onForward} title="Forward"><Icon name="forward" size={17} /></button>
          </div>
        </div>
        <h2 className="read-subject">{msg.subject || '(no subject)'}</h2>
        <People label="To" list={toShown} />
        {(msg.to || []).length > 3 && !showAllTo && <button className="link small" onClick={() => setShowAllTo(true)}>+{msg.to.length - 3} more</button>}
        <People label="Cc" list={msg.cc} />
      </div>
      {msg.listUnsubscribe && (
        <div className="banner info"><Icon name="info" size={16} /><span>This message is from a mailing list.</span><button className="btn small" onClick={onUnsubscribe}>Unsubscribe</button></div>
      )}
      {blocked > 0 && !imagesAllowed && (
        <div className="banner warn"><Icon name="image" size={16} /><span>Pictures were blocked to protect your privacy.</span><button className="btn small" onClick={onAllowImages}>Download pictures</button></div>
      )}
      {files.length > 0 && (
        <div className="attach-strip" aria-label="Attachments">
          {files.map(a => (
            <button key={a.index} className="chip" onClick={() => onSaveAttachment(a)} title={`Save ${a.filename}`}>
              <Icon name="attach" size={14} /><span className="chip-name">{a.filename}</span><span className="chip-size">{formatSize(a.size)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="read-body"><Body msg={msg} allowRemote={imagesAllowed} onBlocked={setBlocked} /></div>
    </section>
  );
}
