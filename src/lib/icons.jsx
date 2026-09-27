import React from 'react';

const P = {
  'mail-new': <><rect x="3" y="5" width="15" height="12" rx="1.5" /><path d="m3.5 6.5 7 5.5 7-5.5" /><path d="M19 3v6M16 6h6" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="m3.5 6.5 8.5 6.5 8.5-6.5" /></>,
  'mail-open': <><path d="M3 10v9a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-9" /><path d="m3 10 9-6 9 6-9 6z" /></>,
  delete: <><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6" /></>,
  archive: <><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10h14V9M10 13h4" /></>,
  junk: <><circle cx="12" cy="12" r="8.5" /><path d="m6 6 12 12" /></>,
  reply: <><path d="M10 8 4 13l6 5" /><path d="M4 13h9a7 7 0 0 1 7 7" /></>,
  'reply-all': <><path d="M8 8 2.5 13 8 18" /><path d="M12.5 8 7 13l5.5 5" /><path d="M7 13h6a7 7 0 0 1 7 7" /></>,
  forward: <><path d="m14 8 6 5-6 5" /><path d="M20 13h-9a7 7 0 0 0-7 7" /></>,
  move: <><path d="M3 7h6l2 2h10v10H3z" /><path d="M12 13h5m-2-2 2 2-2 2" /></>,
  flag: <><path d="M5 21V4M5 4h11l-2 4 2 4H5" /></>,
  'flag-fill': <><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5z" fill="currentColor" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0-2.3 6.3" /><path d="M20 4v7h-7" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15" rx="1.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  today: <><rect x="3.5" y="5" width="17" height="15" rx="1.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /><circle cx="12" cy="15" r="1.6" fill="currentColor" /></>,
  attach: <><path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 6 6" /></>,
  chevron: <path d="m6 9 6 6 6-6" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  'chevron-left': <path d="m15 6-6 6 6 6" />,
  folder: <path d="M3 6.5a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />,
  inbox: <><path d="M3 13h5l1.5 3h5L16 13h5" /><path d="M5 5h14l2 8v6H3v-6z" /></>,
  sent: <><path d="m21 3-9.5 18-2.5-8-6-2.5z" /><path d="m9 13 12-10" /></>,
  drafts: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>,
  star: <path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.7l1-5.9-4.3-4.1 5.9-.8z" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  send: <><path d="m21 3-9.5 18-2.5-8-6-2.5z" /><path d="m9 13 12-10" /></>,
  bold: <path d="M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z" />,
  italic: <path d="M10 4h8M6 20h8M14 4 10 20" />,
  underline: <path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14" />,
  'list-ul': <><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" fill="currentColor" /><circle cx="4.5" cy="12" r="1" fill="currentColor" /><circle cx="4.5" cy="18" r="1" fill="currentColor" /></>,
  'list-ol': <><path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1v4M3.5 13.5c1-1.5 3-.5 2.5.8L3.5 16.5H6.2" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  eraser: <><path d="m8 20-4-4 10-10 6 6-7 8z" /><path d="M8 20h12" /></>,
  save: <><path d="M5 4h11l3 3v13H5z" /><path d="M8 4v5h7V4M8 20v-6h8v6" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 20a8 8 0 0 1 16 0" /></>,
  unsub: <><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="m3.5 6.5 8.5 6.5 8.5-6.5M4 20 20 4" /></>,
  video: <><rect x="3" y="6" width="12" height="12" rx="2" /><path d="m15 10 6-3v10l-6-3z" /></>,
  location: <><path d="M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></>,
  image: <><rect x="3" y="5" width="18" height="14" rx="1.5" /><circle cx="9" cy="10" r="1.6" /><path d="m4 18 5.5-5 4 3.5 3-2.5 4 4" /></>,
  warning: <><path d="M12 3.5 2.5 20h19z" /><path d="M12 10v5M12 17.5v.5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.5v.5" /></>
};

export function Icon({ name, size = 18, className = '', style }) {
  const filled = name === 'flag-fill';
  return (
    <svg className={`icon ${className}`} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={filled ? 1.5 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {P[name] || P.mail}
    </svg>
  );
}
