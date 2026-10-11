import { MEDALS, MEDAL_FAMILIES } from './medaldefs.js';
import { MEDALICONS, MEDALICON_BOX } from './medalicons.js';

// A medal's badge, drawn: a flat-topped hex or a disc in its family's colours
// (medaldefs.js MEDAL_FAMILIES), a bevelled rim, a gloss over the top half and
// a white game-icons.net silhouette (medalicons.js) with a drop shadow. A
// multi-kill rings its silhouette with one pale star per kill, as Halo 3's
// multi-kill medals count theirs. No text: the name goes under it (medals.css).
//
// Anything can draw one (the medal row, a loading screen, a scoreboard):
//   badgeSvg(key, { size, label })  → an <svg> string (size px square; label: give it role=img and the name)
//   badgeElement(key, opts)         → that <svg> as a DOM element
//   badgeDataUrl(key, opts)         → a data: URL for an <img> or a CSS background
// Every badge has its own gradient ids, so many can share a page.

// geometry, in the badge's 100-unit box
const HEX = '25,4 75,4 99,50 75,96 25,96 1,50';   // flat-topped: the mockup's clip-path, as points
const DISC_R = 48;
const FACE_SCALE = 0.82;          // the coloured face inside the rim
const ICON_SIZE = 50;             // the silhouette fills half the badge (the mockup's 52%)
const ICON_SIZE_STARRED = 36;     // ...less inside a ring of stars
const SHADOW_DY = 2;              // the silhouette's drop shadow, down
const OUTLINE_W = 2;              // a dark edge so the badge reads on snow and sky alike
const STAR_R = 6.4;               // a star's outer radius
const STAR_INNER = 0.45;          // its inner radius, a share of the outer
const STAR_RING = 33.5;           // the ring the stars sit on, from the centre
const STAR_STEP_DEG = 30;         // degrees between two stars...
const STAR_SPREAD_MAX_DEG = 280;  // ...across at most this much of the ring, centred on the top (ten stars leave the bottom open)
const GLOSS = 0.4;                // the gloss's opacity at its top edge
const SIZE = 64;                  // px, by default

let uid = 0;
const n1 = (x) => +x.toFixed(1);

function star(cx, cy) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? STAR_R * STAR_INNER : STAR_R;
    pts.push(`${n1(cx + r * Math.cos(a))},${n1(cy + r * Math.sin(a))}`);
  }
  return `<polygon points="${pts.join(' ')}"/>`;
}

function stars(count) {
  const spread = Math.min(STAR_SPREAD_MAX_DEG, (count - 1) * STAR_STEP_DEG);
  let out = '';
  for (let i = 0; i < count; i++) {
    const deg = -90 - spread / 2 + (count > 1 ? (i * spread) / (count - 1) : 0);
    const a = (deg * Math.PI) / 180;
    out += star(50 + STAR_RING * Math.cos(a), 50 + STAR_RING * Math.sin(a));
  }
  return out;
}

export function badgeSvg(key, { size = SIZE, label = true } = {}) {
  const m = MEDALS[key];
  if (!m) return '';
  const f = MEDAL_FAMILIES[m.family];
  const id = `medal${++uid}-`;
  const shape = (attrs = '') => (f.shape === 'hex' ? `<polygon points="${HEX}" ${attrs}/>` : `<circle cx="50" cy="50" r="${DISC_R}" ${attrs}/>`);
  const face = `transform="translate(50 50) scale(${FACE_SCALE}) translate(-50 -50)"`;
  const icon = m.stars ? ICON_SIZE_STARRED : ICON_SIZE;
  const at = n1(50 - icon / 2), scale = icon / MEDALICON_BOX;
  const d = MEDALICONS[m.icon]?.d ?? '';
  const name = m.name.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" class="medal-badge" ${label ? `role="img" aria-label="${name}"` : 'aria-hidden="true"'}>`
    + '<defs>'
    + `<linearGradient id="${id}rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${f.light}"/><stop offset=".5" stop-color="${f.dark}"/><stop offset="1" stop-color="${f.rim}"/></linearGradient>`
    + `<linearGradient id="${id}face" x1=".3" y1="0" x2=".7" y2="1"><stop offset="0" stop-color="${f.light}"/><stop offset="1" stop-color="${f.dark}"/></linearGradient>`
    + `<linearGradient id="${id}gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="${GLOSS}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`
    + `<clipPath id="${id}clip">${shape(face)}</clipPath>`
    + '</defs>'
    + shape(`fill="url(#${id}rim)" stroke="rgba(0,0,0,.6)" stroke-width="${OUTLINE_W}"`)
    + shape(`${face} fill="url(#${id}face)" stroke="${f.rim}" stroke-width="2"`)
    + `<ellipse cx="50" cy="16" rx="62" ry="34" fill="url(#${id}gloss)" clip-path="url(#${id}clip)"/>`
    + (m.stars ? `<g fill="${f.mark}" stroke="${f.rim}" stroke-width=".8">${stars(m.stars)}</g>` : '')
    + `<path transform="translate(${at} ${n1(50 - icon / 2 + SHADOW_DY)}) scale(${scale})" fill="${f.rim}" fill-opacity=".7" d="${d}"/>`
    + `<path transform="translate(${at} ${at}) scale(${scale})" fill="#fff" d="${d}"/>`
    + '</svg>';
}

export function badgeElement(key, opts) {
  const t = document.createElement('template');
  t.innerHTML = badgeSvg(key, opts);
  return t.content.firstElementChild;
}

export const badgeDataUrl = (key, opts) => `data:image/svg+xml,${encodeURIComponent(badgeSvg(key, { ...opts, label: false }))}`;
