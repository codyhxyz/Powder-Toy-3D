import { NOTICEICONS, NOTICEICON_BOX } from './noticeIcons.js';
import './notices.css';

// Notices: Garry's Mod's (lua/includes/modules/notification.lua, AddLegacy, and
// its NoticePanel). A dark tab with its kind's icon slides in from past the
// right edge, the stack grows upward from 80% of the way down the screen, and
// a notice about to go winds back a little, then flies off to the right. The
// numbers are GMod's; the code is a rewrite (Facepunch's Lua carries no
// licence) and the icons are game-icons.net's (noticeIcons.js,
// tools/noticeicons.mjs) in place of GMod's notice materials.
//
//   notices.add(text, { kind, ms, icon })   kind: GMod's NOTIFY_* ('generic',
//     'error', 'undo', 'hint', 'cleanup'); ms: how long (default: the kind's
//     length in GMod's sandbox); icon: another icon by name ('camera')
//
// Desktop only: on a phone or a narrow window the notices keep their place
// under the toolbar (styles.css .toasts), fading in and out, as before.

// ---- GMod's numbers
const START_X_PX = 200;      // a notice starts this far past the right edge (NOTIF_START_X)
const CHARGE_X = 0.04;       // its wind-up before it goes, a share of the width (NOTIF_CHARGE_X)
const GAP_X = 0.015;         // its right edge's gap from the screen's, a share of the width (NOTIF_GAP_X)
const ANCHOR_Y = 0.8;        // the stack's bottom, a share of the height (NOTIF_ANCHOR_Y)
const START_VX = -5;         // its first velocity (VelX), already heading in
const CHARGE_S = 0.7;        // s left when it winds up ("cartoon style about to go thing")...
const GONE_S = 0.2;          // ...and when it flies off, by twice its width
const GONE_W = 2;
const SPRING = 15;           // spd = frame time × 15: the pull toward its place, and its step
const FRICTION = 0.95;       // the velocity keeps 0.95 − frame time × 8 of itself each frame
const FRICTION_DT = 8;
const REST_PX = 2;           // nearer its place than this and slower than this, it stops
const REST_V = 0.1;
const STEP_H = 0.2;          // each notice takes its height plus 0.2 × the text height
const TEXT_H = 9;            // the font: ScreenScaleH(9), the height of 9 px on a 480-line screen...
const TEXT_H_LINES = 480;
const TEXT_H_MIN = 12;       // ...but at least 12 px
const ICON_H = 1.25;         // the icon: 1.25 × the text height
// a kind's length, s: GMod's sandbox gamemode (cl_init.lua: UnfrozeObjects 3, LimitHit 6,
// OnUndo 2, OnCleanup 5; cl_hints.lua: a hint 20)
export const NOTICE_S = { generic: 3, error: 6, undo: 2, hint: 20, cleanup: 5 };

// ---- ours
const MAX_DT = 0.05;         // s: a longer frame (a hidden tab) steps as this, so the spring can't overshoot
const MS_PER_S = 1000;
const FADE_LEAD_MS = 100;    // the narrow layout's fade-out ends this long before the notice is removed
const DESKTOP = '(min-width: 761px) and (hover: hover)';   // styles.css: where the notices sit bottom right

// the god view's open element bar on the right edge (ui/dock.js --spawn-bar-w): notices sit left of it
const barW = () => parseFloat(document.documentElement.style.getPropertyValue('--spawn-bar-w')) || 0;
const textH = () => Math.max(TEXT_H_MIN, Math.ceil(TEXT_H * innerHeight / TEXT_H_LINES));

function iconSvg(key) {
  const icon = NOTICEICONS[key] ?? NOTICEICONS.generic;
  const ns = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(ns, 'svg');
  el.setAttribute('viewBox', `0 0 ${NOTICEICON_BOX} ${NOTICEICON_BOX}`);
  el.setAttribute('class', 'nt-icon');
  el.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', icon.d);
  el.append(path);
  return el;
}

export function createNotices(root) {
  const desktop = matchMedia(DESKTOP);
  const list = [];   // oldest first: { el, at, ms, x, y, vx, vy, w, h }, the oldest lowest
  let raf = 0, last = 0;

  function size() {
    const t = textH();
    root.style.setProperty('--nt-text', `${t}px`);
    root.style.setProperty('--nt-icon', `${Math.ceil(t * ICON_H)}px`);
    for (const n of list) { n.w = n.el.offsetWidth; n.h = n.el.offsetHeight; }
  }
  function mode() {
    root.classList.toggle('nt-free', desktop.matches);
    if (!desktop.matches) for (const n of list) n.el.style.transform = '';
    else { size(); for (const n of list) { n.x = innerWidth + START_X_PX; n.y = innerHeight; } kick(); }
  }
  desktop.addEventListener('change', mode);
  addEventListener('resize', () => { if (desktop.matches) size(); });

  // GMod's UpdateNotice, for each notice in turn from the oldest
  function frame(t) {
    raf = 0;
    const now = t / MS_PER_S;
    const dt = Math.min(now - (last || now), MAX_DT);
    last = now;
    const spd = dt * SPRING, keep = FRICTION - dt * FRICTION_DT;
    const pad = Math.ceil(textH() * STEP_H);
    let total = 0;
    for (const n of list) {
      const h = n.h + pad;
      const idealY = innerHeight * ANCHOR_Y - h - total;
      let idealX = innerWidth - barW() - n.w - innerWidth * GAP_X;
      const left = (n.at + n.ms) / MS_PER_S - now;
      if (left < CHARGE_S) idealX -= innerWidth * CHARGE_X;
      if (left < GONE_S) idealX += n.w * GONE_W;
      n.y += n.vy * spd;
      n.x += n.vx * spd;
      let d = idealY - n.y;
      n.vy += d * spd;
      if (Math.abs(d) < REST_PX && Math.abs(n.vy) < REST_V) n.vy = 0;
      d = idealX - n.x;
      n.vx += d * spd;
      if (Math.abs(d) < REST_PX && Math.abs(n.vx) < REST_V) n.vx = 0;
      n.vx *= keep;
      n.vy *= keep;
      n.el.style.transform = `translate(${n.x.toFixed(1)}px, ${n.y.toFixed(1)}px)`;
      total += h;
    }
    if (list.length) kick();
    else last = 0;
  }
  function kick() { if (!raf && desktop.matches) raf = requestAnimationFrame(frame); }

  root.classList.toggle('nt-free', desktop.matches);
  size();

  return {
    add(text, { kind = 'generic', ms, icon } = {}) {
      if (!(kind in NOTICE_S)) kind = 'generic';
      ms ??= NOTICE_S[kind] * MS_PER_S;
      const label = document.createElement('span');
      label.className = 'nt-text';
      label.textContent = text;
      const el = document.createElement('div');
      el.className = `toast nt nt-${kind}`;
      el.style.setProperty('--nt-ms', `${Math.max(0, ms - FADE_LEAD_MS)}ms`);
      el.append(iconSvg(icon ?? kind), label);
      root.append(el);
      const n = { el, at: performance.now(), ms, x: innerWidth + START_X_PX, y: innerHeight, vx: START_VX, vy: 0, w: 0, h: 0 };
      list.push(n);
      if (desktop.matches) {
        n.w = el.offsetWidth; n.h = el.offsetHeight;
        el.style.transform = `translate(${n.x}px, ${n.y}px)`;
        kick();
      }
      setTimeout(() => { el.remove(); list.splice(list.indexOf(n), 1); }, ms);
      return el;
    },
  };
}
