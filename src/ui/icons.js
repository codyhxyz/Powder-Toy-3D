// Stroke icons (24×24 grid), styled via CSS (stroke: currentColor).
const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

export const ICON = {
  pause: svg('<path d="M8 5v14M16 5v14"/>'),
  play: svg('<path d="M7 5l12 7-12 7z"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.5v.7M12 17h.01"/>'),
  recenter: svg('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4.5h4.5"/><circle cx="12" cy="12" r="2.5"/>'),
  camera: svg('<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13.5" r="3.5"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  person: svg('<circle cx="12" cy="5" r="2.5"/><path d="M12 8.5v6M12 14.5l-3.5 6M12 14.5l3.5 6M7 11.5l5-2 5 2"/>'),
  // a lightning bolt
  bolt: svg('<path d="M13.5 2.5L5 13.5h6l-1 8 8.5-11h-6z"/>'),
  // the trefoil: three 60° blades between radii 3.5 and 9, and a centre dot
  radioactive: svg('<circle cx="12" cy="12" r="1.5"/><path d="M10.25 8.97L7.5 4.21A9 9 0 0 1 16.5 4.21L13.75 8.97A3.5 3.5 0 0 0 10.25 8.97z'
    + 'M15.5 12H21A9 9 0 0 1 16.5 19.79L13.75 15.03A3.5 3.5 0 0 0 15.5 12z'
    + 'M10.25 15.03L7.5 19.79A9 9 0 0 1 3 12H8.5A3.5 3.5 0 0 0 10.25 15.03z"/>'),
  // a black hole and its tilted accretion disk (Exotic: antimatter, singularity)
  exotic: svg('<circle cx="12" cy="12" r="3.5"/><ellipse cx="12" cy="12" rx="9.5" ry="3.5" transform="rotate(-25 12 12)"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  // four map tiles: the start menu's grid
  maps: svg('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
  chevDown: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  chevUp: svg('<path d="M6 15l6-6 6 6"/>'),
  reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/></svg>',
  sphere: svg('<circle cx="12" cy="12" r="7.5"/><path d="M4.5 12c2 2.2 13 2.2 15 0"/>'),
  cube: svg('<path d="M12 3.5l7.5 4.3v8.4L12 20.5l-7.5-4.3V7.8z"/><path d="M4.5 7.8L12 12l7.5-4.2M12 12v8.5"/>'),
  replace: svg('<path d="M5 9h11l-3-3M19 15H8l3 3"/>'),
  eyedropper: svg('<path d="M13.5 6.5l4 4"/><path d="M15 5l1.8-1.8a2.1 2.1 0 0 1 3 3L18 8z"/><path d="M15.5 8.5L7 17l-3.5 1 1-3.5L13 6"/>'),
  minus: svg('<path d="M6 12h12"/>'),
  // a round bomb: its body, a neck, a curling fuse and a spark at its tip
  explosives: svg('<circle cx="10" cy="14" r="6.5"/><path d="M14.6 9.4l1.8-1.8M16.4 7.6c1-1 1.4-2.6 2.9-3"/>'
    + '<path d="M20.5 1.8v1.4M22.2 3.6h-1.4M21.7 2.3l-.8.8"/>'),
  plus: svg('<path d="M12 6v12M6 12h12"/>'),
  powders: svg('<circle cx="12" cy="5" r="1"/><circle cx="8" cy="11" r="1"/><circle cx="16" cy="11" r="1"/><circle cx="4" cy="18" r="1"/><circle cx="12" cy="18" r="1"/><circle cx="20" cy="18" r="1"/>'),
  liquids: svg('<path d="M12 3C10 7 5 11 5 15a7 7 0 0 0 14 0c0-4-5-8-7-12Z"/><path d="M8 15a4 4 0 0 0 4 4"/>'),
  gases: svg('<path d="M7 18a4 4 0 1 1-1-7.9 6 6 0 0 1 11.7-1.6A4.8 4.8 0 0 1 18 18M9 21h6M10 15h4"/>'),
  tools: svg('<path d="m4 20 10-10M14 4l6 6M12 6l6-4 4 4-6 6Z"/><path d="m3 17 4 4"/>'),
  constructions: svg('<path d="m3 11 9-8 9 8M5 10v11h14V10M10 21v-7h4v7"/>'),
  search: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>'),
};
