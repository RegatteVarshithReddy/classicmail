import React, { useState } from 'react';
import { Icon } from '../lib/icons.jsx';
import { Menu } from './Dialogs.jsx';

function Btn({ icon, label, onClick, disabled, big, active, title, caret }) {
  return (
    <button className={`rbtn ${big ? 'big' : 'small'} ${active ? 'active' : ''}`} onClick={onClick} disabled={disabled} title={title || label} aria-pressed={active === undefined ? undefined : Boolean(active)}>
      <Icon name={icon} size={big ? 26 : 17} />
      <span className="rlabel">{label}{caret && <Icon name="chevron" size={10} className="caret" />}</span>
    </button>
  );
}

function Group({ label, children }) {
  return (
    <div className="rgroup">
      <div className="rgroup-body">{children}</div>
      <div className="rgroup-label">{label}</div>
    </div>
  );
}

const TABS = [['home', 'Home'], ['sendreceive', 'Send / Receive'], ['view', 'View']];

export default function Ribbon({ view, tab, onTab, onFile, sel, actions, moveTargets, settings, setSetting, filter, setFilter, cal }) {
  const [menu, setMenu] = useState(null);
  const one = sel.count === 1;
  const any = sel.count > 0;
  const openMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 2, items: moveTargets.length ? moveTargets.map(t => ({ label: t.label, icon: 'folder', onClick: () => actions.move(t.path) })) : [{ label: 'No folders', disabled: true }] });
  };

  let body = null;
  if (view === 'mail' && tab === 'home') {
    body = (
      <>
        <Group label="New"><Btn big icon="mail-new" label="New Email" onClick={actions.newMail} title="New Email (Ctrl+N)" /></Group>
        <Group label="Delete">
          <Btn big icon="delete" label="Delete" onClick={actions.del} disabled={!any} title="Delete (Del)" />
          <div className="rstack">
            <Btn icon="archive" label="Archive" onClick={actions.archive} disabled={!any} title="Archive (Backspace)" />
            <Btn icon="junk" label="Junk" onClick={actions.junk} disabled={!any} title="Move to Junk Email" />
          </div>
        </Group>
        <Group label="Respond">
          <Btn big icon="reply" label="Reply" onClick={actions.reply} disabled={!one} title="Reply (Ctrl+R)" />
          <Btn big icon="reply-all" label="Reply All" onClick={actions.replyAll} disabled={!one} title="Reply All (Ctrl+Shift+R)" />
          <Btn big icon="forward" label="Forward" onClick={actions.forward} disabled={!one} title="Forward (Ctrl+F)" />
        </Group>
        <Group label="Move"><Btn big icon="move" label="Move to" caret onClick={openMove} disabled={!any} /></Group>
        <Group label="Tags">
          <Btn big icon={sel.allRead ? 'mail' : 'mail-open'} label={sel.allRead ? 'Unread' : 'Read'} onClick={actions.toggleRead} disabled={!any} title="Mark as read / unread (Ctrl+Q / Ctrl+U)" />
          <Btn big icon={sel.allFlagged ? 'flag-fill' : 'flag'} label={sel.allFlagged ? 'Clear Flag' : 'Flag'} onClick={actions.toggleFlag} disabled={!any} title="Flag / clear flag (Insert)" />
        </Group>
        <Group label="Junk">
          <Btn big icon="unsub" label="Unsubscribe" onClick={actions.unsubscribe} disabled={!sel.canUnsubscribe} title="Unsubscribe from this mailing list" />
        </Group>
      </>
    );
  } else if (view === 'mail' && tab === 'sendreceive') {
    body = (
      <>
        <Group label="Send & Receive"><Btn big icon="refresh" label="Send/Receive All" onClick={actions.sendReceive} title="Check all accounts (F9)" /></Group>
        <Group label="Server"><Btn big icon="folder" label="Update Folder" onClick={actions.refreshList} title="Reload this folder" /></Group>
      </>
    );
  } else if (view === 'mail' && tab === 'view') {
    body = (
      <>
        <Group label="Reading Pane">
          {[['right', 'Right'], ['bottom', 'Bottom'], ['off', 'Off']].map(([v, l]) => (
            <Btn key={v} big icon="mail-open" label={l} active={settings.readingPane === v} onClick={() => setSetting('readingPane', v)} />
          ))}
        </Group>
        <Group label="Show">
          {[['all', 'All Mail'], ['unread', 'Unread'], ['flagged', 'Flagged']].map(([v, l]) => (
            <Btn key={v} big icon={v === 'flagged' ? 'flag' : v === 'unread' ? 'mail' : 'inbox'} label={l} active={filter === v} onClick={() => setFilter(v)} />
          ))}
        </Group>
        <Group label="Appearance">
          {[['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => (
            <Btn key={v} big icon="settings" label={l} active={settings.theme === v} onClick={() => setSetting('theme', v)} />
          ))}
        </Group>
      </>
    );
  } else if (view === 'calendar' && tab === 'home') {
    body = (
      <>
        <Group label="Go To">
          <Btn big icon="today" label="Today" onClick={cal.today} />
          <div className="rstack">
            <Btn icon="chevron-left" label="Previous" onClick={() => cal.step(-1)} />
            <Btn icon="chevron-right" label="Next" onClick={() => cal.step(1)} />
          </div>
        </Group>
        <Group label="Arrange">
          {[['day', 'Day', 'calendar'], ['workweek', 'Work Week', 'calendar'], ['week', 'Week', 'calendar'], ['month', 'Month', 'calendar']].map(([v, l, i]) => (
            <Btn key={v} big icon={i} label={l} active={cal.mode === v} onClick={() => cal.setMode(v)} />
          ))}
        </Group>
        <Group label="Manage Calendars">
          <Btn big icon="plus" label="Add Calendar" onClick={cal.add} />
          <Btn big icon="refresh" label="Refresh" onClick={cal.refresh} />
        </Group>
      </>
    );
  } else {
    body = (
      <Group label={view === 'calendar' ? 'Calendars' : 'Options'}>
        <Btn big icon="refresh" label="Refresh" onClick={view === 'calendar' ? cal.refresh : actions.sendReceive} />
        <Btn big icon="settings" label="Settings" onClick={onFile} />
      </Group>
    );
  }

  return (
    <div className="ribbon">
      <div className="ribbon-tabs" role="tablist">
        <button className="rtab file" onClick={onFile}>File</button>
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`rtab ${tab === id ? 'active' : ''}`} onClick={() => onTab(id)}>{label}</button>
        ))}
      </div>
      <div className="ribbon-body" role="toolbar">{body}</div>
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
