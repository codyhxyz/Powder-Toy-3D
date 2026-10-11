// Noita's biome card: entering a biome writes its name big across the middle
// of the screen for a couple of seconds, then it fades. Here it also covers a
// level load ("Descending…", up until the next level is in) and the run's end.

const FADE_MS = 600;   // the card fades in and out over this long

export function createDescentOverlay(parent = document.body) {
  const el = document.createElement('div');
  el.className = 'descent-card';
  Object.assign(el.style, {
    position: 'fixed', inset: '0', zIndex: 6, pointerEvents: 'none',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.6em',
    color: '#f1e6c8', textShadow: '0 2px 12px #000, 0 0 2px #000', textAlign: 'center',
    opacity: '0', transition: `opacity ${FADE_MS}ms ease`,
  });
  const title = document.createElement('div');
  Object.assign(title.style, { font: '400 clamp(32px, 7vw, 88px) Silkscreen, monospace', letterSpacing: '0.04em' });
  const sub = document.createElement('div');
  Object.assign(sub.style, { font: '500 clamp(14px, 2vw, 22px) Archivo, sans-serif', opacity: '0.85' });
  el.append(title, sub);
  parent.append(el);
  let timer = 0;
  return {
    // `seconds`: how long it stays up (none: until the next show or hide)
    show(text, subText = '', seconds = 0) {
      clearTimeout(timer);
      title.textContent = text;
      sub.textContent = subText;
      el.style.opacity = '1';
      if (seconds > 0) timer = setTimeout(() => { el.style.opacity = '0'; }, seconds * 1000);
    },
    hide() { clearTimeout(timer); el.style.opacity = '0'; },
    get shown() { return el.style.opacity === '1'; },
    get text() { return title.textContent; },
  };
}
