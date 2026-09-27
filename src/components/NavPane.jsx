import React, { useMemo, useState } from 'react';
import { Icon } from '../lib/icons.jsx';
import { addDays, dayKey, pad, sameDay, startOfMonth, startOfWeek } from '../lib/dates.mjs';

const ICON_FOR = { '\\Inbox': 'inbox', '\\Drafts': 'drafts', '\\Sent': 'sent', '\\Trash': 'delete', '\\Junk': 'junk', '\\Archive': 'archive', '\\All': 'archive', '\\Flagged': 'star', '\\Important': 'flag' };

function countLabel(folder, count) {
  if (!count) return '';
  if (folder.specialUse === '\\Drafts') return count.messages ? `[${count.messages}]` : '';
  if (folder.specialUse === '\\Trash' || folder.specialUse === '\\Sent' || folder.specialUse === '\\Archive' || folder.specialUse === '\\All') return '';
  return count.unseen ? String(count.unseen) : '';
}

function FolderNode({ account, folder, childrenOf, counts, sel, onSelect, onDrop, onMenu, depth }) {
  const [over, setOver] = useState(false);
  const kids = childrenOf.get(folder.path) || [];
  const [open, setOpen] = useState(true);
  const active = sel.kind === 'folder' && sel.accountId === account.id && sel.path === folder.path;
  const label = countLabel(folder, counts && counts[folder.path]);
  const unread = folder.specialUse !== '\\Drafts' && label;
  return (
    <>
      <div
        className={`tree-row ${active ? 'active' : ''} ${over ? 'drop' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        role="treeitem" aria-selected={active}
        onClick={() => folder.selectable && onSelect({ kind: 'folder', accountId: account.id, path: folder.path })}
        onContextMenu={(e) => { e.preventDefault(); onMenu(e, account, folder); }}
        onDragOver={(e) => { if (folder.selectable) { e.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (folder.selectable) onDrop(account.id, folder.path); }}
      >
        <span className="tree-caret" onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}>
          {kids.length ? <Icon name={open ? 'chevron' : 'chevron-right'} size={11} /> : null}
        </span>
        <Icon name={ICON_FOR[folder.specialUse] || 'folder'} size={15} className="tree-icon" />
        <span className={`tree-label ${unread ? 'unread' : ''}`}>{folder.displayName}</span>
        {label && <span className={`tree-count ${unread ? 'unread' : ''}`}>{label}</span>}
      </div>
      {open && kids.map(k => (
        <FolderNode key={k.path} account={account} folder={k} childrenOf={childrenOf} counts={counts} sel={sel} onSelect={onSelect} onDrop={onDrop} onMenu={onMenu} depth={depth + 1} />
      ))}
    </>
  );
}

function AccountTree({ account, folders, counts, sel, onSelect, onDrop, onMenu }) {
  const [open, setOpen] = useState(true);
  const childrenOf = useMemo(() => {
    const map = new Map();
    const paths = new Set((folders || []).map(f => f.path));
    for (const f of folders || []) {
      const parent = f.parentPath && paths.has(f.parentPath) ? f.parentPath : '';
      if (!map.has(parent)) map.set(parent, []);
      map.get(parent).push(f);
    }
    return map;
  }, [folders]);
  return (
    <div className="tree-account">
      <div className="tree-head" onClick={() => setOpen(o => !o)} title={account.email}>
        <Icon name={open ? 'chevron' : 'chevron-right'} size={11} />
        <span className="dot" style={{ background: account.color }} />
        <span className="tree-account-name">{account.email}</span>
      </div>
      {open && (folders ? (childrenOf.get('') || []).map(f => (
        <FolderNode key={f.path} account={account} folder={f} childrenOf={childrenOf} counts={counts} sel={sel} onSelect={onSelect} onDrop={onDrop} onMenu={onMenu} depth={0} />
      )) : <div className="tree-loading">Loading folders…</div>)}
    </div>
  );
}

function MiniMonth({ anchor, onPick, visible }) {
  const [shown, setShown] = useState(startOfMonth(anchor));
  const first = startOfWeek(shown, 0);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  const today = new Date();
  const inRange = (d) => visible && d >= visible.start && d < addDays(visible.start, visible.days);
  return (
    <div className="mini">
      <div className="mini-head">
        <button className="icon-btn" onClick={() => setShown(new Date(shown.getFullYear(), shown.getMonth() - 1, 1))} aria-label="Previous month"><Icon name="chevron-left" size={14} /></button>
        <span>{shown.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <button className="icon-btn" onClick={() => setShown(new Date(shown.getFullYear(), shown.getMonth() + 1, 1))} aria-label="Next month"><Icon name="chevron-right" size={14} /></button>
      </div>
      <div className="mini-grid">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <span key={i} className="mini-dow">{d}</span>)}
        {cells.map(d => (
          <button key={dayKey(d)}
            className={`mini-day ${d.getMonth() !== shown.getMonth() ? 'other' : ''} ${sameDay(d, today) ? 'today' : ''} ${inRange(d) ? 'inrange' : ''}`}
            onClick={() => onPick(d)}>{d.getDate()}</button>
        ))}
      </div>
    </div>
  );
}

export default function NavPane({ view, onView, accounts, folders, counts, sel, onSelect, onDrop, onFolderMenu, unifiedUnseen, calendars, onToggleCalendar, cal, onSettings }) {
  return (
    <nav className="nav" aria-label="Navigation">
      <div className="nav-scroll">
        {view === 'mail' ? (
          <>
            <div className="nav-section">Favorites</div>
            <div className={`tree-row fav ${sel.kind === 'unified' ? 'active' : ''}`} onClick={() => onSelect({ kind: 'unified' })}>
              <span className="tree-caret" /><Icon name="inbox" size={15} className="tree-icon" />
              <span className={`tree-label ${unifiedUnseen ? 'unread' : ''}`}>All Inboxes</span>
              {unifiedUnseen > 0 && <span className="tree-count unread">{unifiedUnseen}</span>}
            </div>
            <div className={`tree-row fav ${sel.kind === 'unread' ? 'active' : ''}`} onClick={() => onSelect({ kind: 'unread' })}>
              <span className="tree-caret" /><Icon name="mail" size={15} className="tree-icon" />
              <span className="tree-label">Unread Mail</span>
            </div>
            <div className="nav-section spaced">Accounts</div>
            {accounts.filter(a => a.enabled).map(a => (
              <AccountTree key={a.id} account={a} folders={folders[a.id]} counts={counts[a.id]} sel={sel} onSelect={onSelect} onDrop={onDrop} onMenu={onFolderMenu} />
            ))}
            {!accounts.length && <div className="nav-empty">No accounts yet.<br /><button className="link" onClick={onSettings}>Add an account</button></div>}
          </>
        ) : (
          <>
            <MiniMonth anchor={cal.anchor} onPick={cal.setAnchor} visible={cal.range} />
            <div className="nav-section spaced">My Calendars</div>
            {calendars.map(c => (
              <label key={c.id} className="cal-row" title={c.type === 'url' ? c.url : c.path}>
                <input type="checkbox" checked={c.enabled} onChange={e => onToggleCalendar(c, e.target.checked)} />
                <span className="cal-swatch" style={{ background: c.color }} />
                <span className="cal-name">{c.name}</span>
                {cal.errors[c.id] && <Icon name="warning" size={14} className="cal-warn" style={{ color: '#c4314b' }} />}
              </label>
            ))}
            {!calendars.length && <div className="nav-empty">No calendars yet.<br /><button className="link" onClick={cal.add}>Add a calendar</button></div>}
            {calendars.some(c => cal.errors[c.id]) && (
              <div className="cal-errors">{calendars.filter(c => cal.errors[c.id]).map(c => <div key={c.id}><b>{c.name}:</b> {cal.errors[c.id]}</div>)}</div>
            )}
          </>
        )}
      </div>
      <div className="nav-switch">
        <button className={view === 'mail' ? 'active' : ''} onClick={() => onView('mail')} title="Mail (Ctrl+1)"><Icon name="mail" size={20} /><span>Mail</span></button>
        <button className={view === 'calendar' ? 'active' : ''} onClick={() => onView('calendar')} title="Calendar (Ctrl+2)"><Icon name="calendar" size={20} /><span>Calendar</span></button>
        <button onClick={onSettings} title="Settings"><Icon name="settings" size={20} /><span>Settings</span></button>
      </div>
    </nav>
  );
}
