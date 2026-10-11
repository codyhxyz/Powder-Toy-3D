import { MEDALS } from './medals.js';
import { MEDALICONS, MEDALICON_BOX } from './medalIcons.js';

// A medal's badge (medals.js MEDALS key), drawn: a flat-topped hex or a disc in
// its kind's colours, a bevelled rim, a gloss over the top half and a white
// game-icons.net silhouette (medalIcons.js) with a drop shadow. Halo 3's medal
// art is Bungie's; this is its idea in our hand. A multi-kill is Halo 3's red
// disc with one pale star per kill round its icon. No text: the name goes
// beside it (medalHud.js, feel.css).
//
// Anything can draw one (the medal stack, a loading screen, a scoreboard):
//   badgeSvg(key, { size, label })  → an <svg> string (size px square; label: role=img and the medal's name)
//   badgeElement(key, opts)         → that <svg> as a DOM element
//   badgeDataUrl(key, opts)         → a data: URL for an <img> or a CSS background
// Every badge has its own gradient ids, so many can share a page. An unknown key draws ''.

// a kind's colours (light → dark face, the rim's dark, the stars'); shape 'hex' or 'round'.
// multi/spree/style are the mockup's gradients; the multi-kill's red disc and pale stars are
// Halo 3's (Halopedia's Killpocalypse: "nine pale pink stars on a red circle")
export const MEDAL_LOOK = {
  multi: { shape: 'round', light: '#ff8576', dark: '#9c1220', rim: '#43060c', mark: '#ffd9d6' },
  spree: { shape: 'hex', light: '#ffbf5a', dark: '#cc420a', rim: '#561b02' },
  style: { shape: 'hex', light: '#7fd0ff', dark: '#1a5cb5', rim: '#0a2550' },
  objective: { shape: 'round', light: '#ffd659', dark: '#a86f00', rim: '#422c00' },
  chaos: { shape: 'hex', light: '#ff9fe0', dark: '#b8207f', rim: '#470931' },   // the sim's: ours, not Halo's
};

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
const STAR_SPREAD_MAX_DEG = 280;  // ...across at most this much of the ring, centred on the top (ten leave the bottom open)
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
    const a = ((-90 - spread / 2 + (count > 1 ? (i * spread) / (count - 1) : 0)) * Math.PI) / 180;
    out += star(50 + STAR_RING * Math.cos(a), 50 + STAR_RING * Math.sin(a));
  }
  return out;
}

export function badgeSvg(key, { size = SIZE, label = true } = {}) {
  const m = MEDALS[key];
  const f = m && MEDAL_LOOK[m.kind];
  if (!f) return '';
  const id = `medal${++uid}-`;
  const shape = (attrs = '') => (f.shape === 'hex' ? `<polygon points="${HEX}" ${attrs}/>` : `<circle cx="50" cy="50" r="${DISC_R}" ${attrs}/>`);
  const face = `transform="translate(50 50) scale(${FACE_SCALE}) translate(-50 -50)"`;
  const count = m.kind === 'multi' ? Number(m.glyph) || 0 : 0;   // a multi-kill's glyph is its kill count
  const icon = count ? ICON_SIZE_STARRED : ICON_SIZE;
  const at = n1(50 - icon / 2), scale = icon / MEDALICON_BOX;
  const d = (MEDALICONS[key] ?? MEDALICONS[m.kind])?.d ?? '';
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
    + (count ? `<g fill="${f.mark}" stroke="${f.rim}" stroke-width=".8">${stars(count)}</g>` : '')
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
