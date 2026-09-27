import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../lib/icons.jsx';

export function Modal({ title, onClose, children, footer, width = 460, className = '' }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose && onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}>
      <div className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title} style={{ width }}>
        <div className="modal-title">
          <span>{title}</span>
          {onClose && <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" size={16} /></button>}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger, extra, onConfirm, onCancel }) {
  const ref = useRef(null);
  useEffect(() => { ref.current && ref.current.focus(); }, []);
  return (
    <Modal title={title} onClose={onCancel} width={440}
      footer={<>
        {extra}
        <button className="btn" onClick={onCancel}>{cancelLabel}</button>
        <button ref={ref} className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>{confirmLabel}</button>
      </>}>
      <p className="modal-text">{message}</p>
    </Modal>
  );
}

export function PromptDialog({ title, label, initial = '', confirmLabel = 'OK', onSubmit, onCancel }) {
  const [value, setValue] = useState(initial);
  const ref = useRef(null);
  useEffect(() => { ref.current && ref.current.select(); }, []);
  const submit = () => { if (value.trim()) onSubmit(value.trim()); };
  return (
    <Modal title={title} onClose={onCancel} width={400}
      footer={<><button className="btn" onClick={onCancel}>Cancel</button><button className="btn primary" disabled={!value.trim()} onClick={submit}>{confirmLabel}</button></>}>
      <label className="field-label" htmlFor="prompt-input">{label}</label>
      <input id="prompt-input" ref={ref} className="input" value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
    </Modal>
  );
}

/** A small popup menu positioned at a point (right-click) or under an anchor. */
export function Menu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
    }
    const close = (e) => { if (!ref.current || !ref.current.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    return () => { window.removeEventListener('mousedown', close, true); window.removeEventListener('keydown', key, true); window.removeEventListener('blur', onClose); };
  }, [x, y, onClose]);
  return (
    <div className="menu" ref={ref} style={pos} role="menu">
      {items.map((it, i) => it.separator
        ? <div key={i} className="menu-sep" />
        : (
          <button key={i} role="menuitem" className={`menu-item ${it.danger ? 'danger' : ''}`} disabled={it.disabled}
            onClick={() => { onClose(); it.onClick && it.onClick(); }}>
            {it.icon ? <Icon name={it.icon} size={15} /> : <span className="menu-gap" />}
            <span>{it.label}</span>
            {it.checked && <Icon name="check" size={14} className="menu-check" />}
          </button>
        ))}
    </div>
  );
}
