import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../lib/icons.jsx';
import { dateGroup, formatSize, listDate, personLabel } from '../lib/format.mjs';

function Row({ row, layout, selected, showAccount, account, onClick, onDoubleClick, onMenu, onDragStart }) {
  const from = personLabel(row.from) || '(unknown sender)';
  const icons = (
    <>
      {row.hasAttachments && <Icon name="attach" size={13} className="row-ico" />}
      {row.flagged && <Icon name="flag-fill" size={13} className="row-ico flag" style={{ color: '#c4314b' }} />}
    </>
  );
  const common = {
    role: 'option', 'aria-selected': selected, draggable: true, 'data-key': row.key,
    onClick: (e) => onClick(e, row), onDoubleClick: () => onDoubleClick(row),
    onContextMenu: (e) => { e.preventDefault(); onMenu(e, row); },
    onDragStart: (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.subject || ''); onDragStart(row); }
  };
  if (layout === 'table') {
    return (
      <div {...common} className={`msg-row table ${row.seen ? '' : 'unread'} ${selected ? 'selected' : ''}`}>
        <span className="col-flag">{row.flagged ? <Icon name="flag-fill" size={13} style={{ color: '#c4314b' }} /> : null}</span>
        <span className="col-att">{row.hasAttachments ? <Icon name="attach" size={13} /> : null}</span>
        <span className="col-from">{showAccount && account && <span className="dot" style={{ background: account.color }} title={account.email} />}{from}</span>
        <span className="col-subject">{row.subject || '(no subject)'}</span>
        <span className="col-date">{listDate(row.date)}</span>
        <span className="col-size">{formatSize(row.size)}</span>
      </div>
    );
  }
  return (
    <div {...common} className={`msg-row ${row.seen ? '' : 'unread'} ${selected ? 'selected' : ''}`}>
      <span className="msg-bar" />
      <div className="msg-main">
        <div className="msg-top">
          <span className="msg-from">{showAccount && account && <span className="dot" style={{ background: account.color }} title={account.email} />}{from}</span>
          <span className="msg-date">{listDate(row.date)}</span>
        </div>
        <div className="msg-sub">
          <span className="msg-subject">{row.subject || '(no subject)'}</span>
          <span className="msg-icons">{icons}</span>
        </div>
      </div>
    </div>
  );
}

export default function MessageList({ title, rows, total, loading, loadingMore, error, hasMore, onLoadMore, onRetry, selectedKeys, onRowClick, onRowDoubleClick,
  onRowMenu, onDragStart, filter, setFilter, onSearch, layout, showAccount, accounts, searchRef, empty }) {
  const [text, setText] = useState('');
  const scroller = useRef(null);
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onSearch(text), 400);
    return () => clearTimeout(timer.current);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const byId = new Map((accounts || []).map(a => [a.id, a]));
  const onScroll = () => {
    const el = scroller.current;
    if (el && hasMore && !loadingMore && el.scrollHeight - el.scrollTop - el.clientHeight < 240) onLoadMore();
  };

  const items = [];
  let lastGroup = null;
  for (const row of rows) {
    const g = dateGroup(row.date);
    if (g !== lastGroup) { items.push(<div key={`g-${g}-${row.key}`} className="msg-group"><Icon name="chevron" size={10} />{g}</div>); lastGroup = g; }
    items.push(
      <Row key={row.key} row={row} layout={layout} selected={selectedKeys.has(row.key)} showAccount={showAccount} account={byId.get(row.accountId)}
        onClick={onRowClick} onDoubleClick={onRowDoubleClick} onMenu={onRowMenu} onDragStart={onDragStart} />
    );
  }

  return (
    <section className="list-pane" aria-label="Message list">
      <div className="search-row">
        <Icon name="search" size={15} />
        <input ref={searchRef} className="search-input" placeholder={`Search ${title || 'Current Mailbox'}`} value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') { setText(''); e.currentTarget.blur(); } }} aria-label="Search mail" />
        {text && <button className="icon-btn" onClick={() => setText('')} aria-label="Clear search"><Icon name="close" size={14} /></button>}
      </div>
      <div className="list-head">
        <div className="filters" role="tablist">
          <button role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
          <button role="tab" aria-selected={filter === 'unread'} className={filter === 'unread' ? 'active' : ''} onClick={() => setFilter('unread')}>Unread</button>
          {filter === 'flagged' && <button role="tab" aria-selected className="active" onClick={() => setFilter('all')}>Flagged ✕</button>}
        </div>
        <div className="list-title">{title}</div>
      </div>
      {layout === 'table' && (
        <div className="table-head"><span className="col-flag" /><span className="col-att" /><span className="col-from">From</span><span className="col-subject">Subject</span><span className="col-date">Received</span><span className="col-size">Size</span></div>
      )}
      <div className="list-scroll" ref={scroller} onScroll={onScroll} role="listbox" aria-multiselectable="true" tabIndex={0}>
        {error && !rows.length && (
          <div className="list-msg error"><Icon name="warning" size={22} /><p>{error}</p><button className="btn" onClick={onRetry}>Try again</button></div>
        )}
        {loading && !rows.length && !error && <div className="list-msg"><div className="spinner" /><p>Loading…</p></div>}
        {!loading && !error && !rows.length && <div className="list-msg muted"><Icon name="mail-open" size={26} /><p>{empty}</p></div>}
        {items}
        {loadingMore && <div className="list-more"><div className="spinner small" /> Loading more…</div>}
        {!loadingMore && hasMore && rows.length > 0 && <button className="list-more btn-link" onClick={onLoadMore}>Load more ({total - rows.length} older)</button>}
      </div>
    </section>
  );
}
