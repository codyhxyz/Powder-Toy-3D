// Share assets, rendered from the app itself so they match what people see:
//   public/og.jpg          the link-preview card (Open Graph / X / iMessage / Discord)
//   docs/hero.jpg          the README screenshot (UI visible)
//   public/favicon.svg, favicon.ico, apple-touch-icon.png, icon-192.png, icon-512.png
// The card and hero need a dev server (`npm run dev`); the icons don't.
// usage: node tools/share-assets.mjs [--port 5173] [--only card|hero|icons]
import { chromium } from 'playwright';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { logoMark } from '../src/ui/logo.js';
import { ELEMENTS, E } from '../src/elements.js';
import { inkFor } from '../src/ui/dom.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5173');
const only = opt('only', '');
const ROOT = new URL('..', import.meta.url).pathname;

const CARD = { w: 1200, h: 630, supersample: 2, quality: 90 };  // OG's recommended size, rendered at 2× and downsampled
const HERO = { w: 1440, h: 810, dpr: 5 / 3, quality: 86 };   // wide enough for the whole dock; 2400×1350 out
const BG = '#161b25';            // index.html theme-color
const SKY_LOW = '#0e1117';       // styles.css --sky-low
const FONTS = 'https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=Silkscreen&display=swap';
const TAA_FRAMES = 60;           // frames rendered on the paused scene before a screenshot (TAA converges)

// The scene: the volcano preset after a while, with the near-side trees set
// alight shortly before the shot so they're mid-burn.
const SCENE = {
  preset: 'volcano',
  steps: 1600,
  burnSteps: 150,                 // trees catch fire this many steps before the shot
  burnTrees: [0, 1, 2, 3, 13],    // indices into the preset's tree ring (the ones facing the camera)
  burnRadius: 3,
  sun: [20, 24],                  // azimuth, elevation (degrees): low, warm light
};
const CARD_CAM = { pos: [6.5, 4.8, 7.6], target: [-1.6, 2.6, 1.37] };  // volcano right of centre, sky on the left for the copy
const HERO_CAM = { pos: [8.6, 7.2, 10], target: [0, 1.7, 0] };
// The volcano preset's tree ring (src/presets.js, 128³ grid): position of tree k's canopy.
function treeCanopy(k) {
  const R = 54, H = 48, C = 64, N = 14, TRUNK = 8, CANOPY_MID = 2;
  const ang = (k / N) * Math.PI * 2 + 0.3, d = R * (0.55 + 0.25 * ((k * 7) % 3) / 2);
  return [Math.round(C + Math.cos(ang) * d), Math.max(0, Math.round(H * (1 - d / R))) + TRUNK + CANOPY_MID, Math.round(C + Math.sin(ang) * d)];
}
const CARD_TILES = ['SAND', 'WATER', 'FIRE', 'LAVA', 'PLANT', 'ICE'];

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errs = [];

// ---- app captures
async function capture({ w, h, dpr = 1, ui, cam }) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 500)));
  await p.addInitScript(([sun, ui]) => {
    let s = 12345;   // mulberry32: same scene every run
    Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ sunAz: sun[0], sunEl: sun[1] }));
    addEventListener('DOMContentLoaded', () => {
      const st = document.createElement('style');
      st.textContent = ui ? '.toast, .stats, .pill, .hint { display: none !important; }'   // headless fps and transient hints
        : 'body * { visibility: hidden !important; } #app > canvas { visibility: visible !important; }';
      document.head.appendChild(st);
    });
  }, [SCENE.sun, ui]);
  await p.goto(`http://localhost:${port}/?preset=${SCENE.preset}`);
  await p.waitForFunction(() => window.__app?.sim);
  await p.evaluate(async ([scene, fires, dpr]) => {
    const a = window.__app;
    a.settings.paused = true;
    a.autoRes.enabled = false;
    a.renderer.setPixelRatio(dpr);
    a.renderer.setSize(innerWidth, innerHeight);
    dispatchEvent(new Event('resize'));
    a.loadPreset(scene.preset, false);
    a.sim.frame = 0;
    const { E } = await import('/src/elements.js');
    const V = a.sim.mats.paint.uniforms.uCenter.value.constructor;
    for (let i = 0; i < scene.steps; i++) {
      a.sim.step();
      if (i === scene.steps - scene.burnSteps)
        for (const c of fires) a.sim.paint({ center: new V(...c), radius: scene.burnRadius, shape: 0, tool: E.FIRE, rate: 1, replace: true });
      if (i % 50 === 0) await new Promise((r) => requestAnimationFrame(r));   // keep the page responsive
    }
  }, [SCENE, SCENE.burnTrees.map(treeCanopy), dpr]);
  await p.evaluate(async ([cam, frames]) => {
    const a = window.__app;
    a.camera.position.set(...cam.pos);
    a.controls.target.set(...cam.target);
    a.controls.update();
    a.post.reset();
    for (let i = 0; i < frames; i++) await new Promise((r) => requestAnimationFrame(r));
  }, [cam, TAA_FRAMES]);
  const shot = await p.screenshot({ type: 'png' });
  await p.close();
  return shot;
}

// ---- the card: the shot plus the wordmark, a pitch and a row of dock tiles
function cardHTML(shot) {
  const tiles = CARD_TILES.map((k) => ELEMENTS[E[k]]).map((e) =>
    `<div class="tile" style="--c:${e.color};--ink:${inkFor(e.color)}">${e.abbr}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><link href="${FONTS}" rel="stylesheet"><style>
  body { margin: 0; width: ${CARD.w}px; height: ${CARD.h}px; overflow: hidden; background: ${SKY_LOW};
    color: #e7eaf0; font-family: 'Archivo', sans-serif; -webkit-font-smoothing: antialiased; }
  .shot { position: absolute; inset: 0; background: url(data:image/png;base64,${shot.toString('base64')}) center / cover; }
  .shade { position: absolute; inset: 0; background:
    linear-gradient(90deg, rgba(14, 17, 23, 0.82) 0%, rgba(14, 17, 23, 0.55) 34%, rgba(14, 17, 23, 0) 60%),
    linear-gradient(0deg, rgba(14, 17, 23, 0.45) 0%, rgba(14, 17, 23, 0) 28%); }
  .copy { position: absolute; left: 68px; top: 76px; }
  .brand { display: flex; align-items: center; gap: 18px; }
  .brand svg { filter: drop-shadow(0 6px 12px rgba(0, 0, 0, 0.5)); overflow: visible; }
  .word { white-space: nowrap; font-weight: 800; font-size: 54px; line-height: 1; letter-spacing: -0.015em;
    font-variation-settings: 'wdth' 122; text-shadow: 0 2px 16px rgba(0, 0, 0, 0.5); }
  h1 { margin: 40px 0 0; font-weight: 700; font-size: 38px; line-height: 1.12; letter-spacing: -0.01em;
    font-variation-settings: 'wdth' 100; text-shadow: 0 2px 14px rgba(0, 0, 0, 0.6); }
  p { margin: 16px 0 0; font-size: 21px; line-height: 1.42; color: #aab2c2; font-weight: 450; max-width: 470px;
    text-shadow: 0 1px 10px rgba(0, 0, 0, 0.6); }
  .tiles { display: flex; gap: 10px; margin-top: 34px; }
  .tile { width: 62px; height: 62px; display: grid; place-items: center; border-radius: 8px;
    background: var(--c); color: var(--ink); font: 400 14px/1 'Silkscreen', monospace; letter-spacing: 0.02em;
    box-shadow: inset 0 1.5px 0 rgba(255, 255, 255, 0.28), inset 0 -3px 0 rgba(0, 0, 0, 0.22), 0 4px 14px rgba(0, 0, 0, 0.45); }
  </style></head><body>
  <div class="shot"></div><div class="shade"></div>
  <div class="copy">
    <div class="brand">${logoMark(66)}<div class="word">Powder Toy 3D</div></div>
    <h1>Falling-sand physics,<br>simulated on your GPU.</h1>
    <p>Pour sand, flood it, set it on fire, melt it. Two million cells, live in your browser.</p>
    <div class="tiles">${tiles}</div>
  </div></body></html>`;
}

async function card() {
  const shot = await capture({ w: CARD.w * CARD.supersample, h: CARD.h * CARD.supersample, ui: false, cam: CARD_CAM });
  const p = await browser.newPage({ viewport: { width: CARD.w, height: CARD.h } });
  await p.setContent(cardHTML(shot), { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  writeFileSync(join(ROOT, 'public/og.jpg'), await p.screenshot({ type: 'jpeg', quality: CARD.quality }));
  await p.close();
}

async function hero() {
  const shot = await capture({ w: HERO.w, h: HERO.h, dpr: HERO.dpr, ui: true, cam: HERO_CAM });
  execFileSync('magick', ['png:-', '-quality', String(HERO.quality), join(ROOT, 'docs/hero.jpg')], { input: shot });
}

// ---- icons: the logo mark, on the app's background where the platform needs an opaque square
const MARK_SVG = logoMark(64).replace('class="mark"', 'xmlns="http://www.w3.org/2000/svg"').replace(' aria-hidden="true"', '');
const ICONS = [
  // file, size, background, mark's share of the size (maskable icons keep it inside the 80% safe circle)
  ['apple-touch-icon.png', 180, BG, 0.72],
  ['icon-192.png', 192, BG, 0.6],
  ['icon-512.png', 512, BG, 0.6],
];
const ICO_SIZES = [16, 32, 48];

async function icons() {
  writeFileSync(join(ROOT, 'public/favicon.svg'), MARK_SVG + '\n');
  const p = await browser.newPage();
  const render = async (size, bg, share) => {
    await p.setViewportSize({ width: size, height: size });
    const m = Math.round(size * share);
    await p.setContent(`<body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${bg}">
      ${MARK_SVG.replace(/width="\d+" height="\d+"/, `width="${m}" height="${m}"`)}</body>`);
    return p.screenshot({ type: 'png', omitBackground: bg === 'transparent' });
  };
  for (const [file, size, bg, share] of ICONS) writeFileSync(join(ROOT, 'public', file), await render(size, bg, share));
  const tmp = mkdtempSync(join(tmpdir(), 'ico-'));
  const pngs = [];
  for (const s of ICO_SIZES) { const f = join(tmp, `${s}.png`); writeFileSync(f, await render(s, 'transparent', 1)); pngs.push(f); }
  execFileSync('magick', [...pngs, join(ROOT, 'public/favicon.ico')]);
  rmSync(tmp, { recursive: true });
  await p.close();
}

if (!only || only === 'icons') await icons();
if (!only || only === 'card') await card();
if (!only || only === 'hero') await hero();
console.log(errs.length ? errs.join('\n') : 'done');
await browser.close();
