// Small schematic silhouettes: construction hardware, not inventory items.
// All markup is local and static; icons supplement visible machine names.
const paths = {
  foundation: '<path d="m4 12 12-7 12 7-12 7Z M4 12v8l12 7 12-7v-8 M16 19v8 M9 9l12 7 M10 16l12-7"/>',
  belt: '<path d="M5 10h22v13H5z M9 23v4 M23 23v4 M8 14h13m-4-3 4 3-4 3"/><path d="M9 20h1m5 0h1m5 0h1"/>',
  separator: '<path d="M4 16h9m-4-3 4 3-4 3 M16 16V6m-3 3 3-3 3 3 M16 16h12m-3-3 3 3-3 3 M12 22h8v5h-8z"/><circle cx="16" cy="16" r="3"/>',
  ship: '<path d="M5 27V7h22v20 M5 7l4-3h14l4 3 M10 27V12h12v15 M16 14v9m-3-3 3 3 3-3"/>',
  miner: '<path d="M5 20V10h12v10 M17 12h5l6 4-6 4h-5 M7 10V6h6v4 M6 21h15a3 3 0 0 1 0 6H6a3 3 0 0 1 0-6Z M8 24h2m5 0h2"/>',
  lift: '<path d="M5 27V5m22 22V5 M4 27h24 M9 22h14 M16 18V6m-5 5 5-5 5 5"/>',
  pump: '<path d="M4 25h8V8h15m-4-4 4 4-4 4 M4 21v8"/><circle cx="12" cy="17" r="4"/><path d="M12 15v4"/>',
  heater: '<path d="M5 27V12h5m12 0h5v15 M5 27h22 M12 23c-5-6 3-8 2-16 8 5 11 10 5 16 M12 27v-4h7v4"/>',
  hearth: '<path d="M4 26h24 M6 25V9h20v16 M8 21h16 M9 17h14 M10 11c-2-4 2-5 2-8 4 3 6 7 2 9m2 5 3-2 3 2 M4 6h24"/>',
  gate: '<path d="M4 27V5h5v22 M23 27V5h5v22 M4 6h24 M8 11h16v11H8z M12 11v11m8-11v11 M4 27h24"/>',
};
export function machineIcon(type) {
  const icon = document.createElement('span');
  icon.className = 'industry-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true">${paths[type]}</svg>`;
  return icon;
}
