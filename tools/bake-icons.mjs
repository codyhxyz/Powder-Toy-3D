// Bakes the hotbar icons and the class portraits (docs/webgpu.md F8, U13):
// the game no longer draws them at runtime with a WebGL renderer of their
// own; tools/harness/icons.* draws each through the real materials on
// WebGPU, once, into public/icons/<key>.png and public/icons/portrait-<class>-
// <model>.png, and public/icons/manifest.json records a fingerprint of what
// each was drawn from.
//
// The fingerprint is taken here in Node, CPU only, from the very scenes the
// page draws (models.js iconScene, classPortraits.js portraitScene): every
// object's type, transform and geometry, every material's look (colours,
// sides, blending, the toon ramp, the outline's width) and every light, the
// camera. So --check says exactly which sprites a change to a model or a
// class's colours left stale, without a GPU. What a scene doesn't show, a
// node material's TSL graph and WGSL (models.js's ember, the figures' light)
// and the outline pass's colours (models.js outlineSprite), is in the source
// of the modules the bake draws with (SOURCES) and the figures' light WGSL:
// their text, three's revision and the bake page's source make a key every
// sprite shares, so an edit there marks them all stale.
//
// The portraits: every class (pov/classes.js) holding each tool of its
// loadout that has a model (pov/tools/catalog.js), and holding nothing (the
// class picker shows the first one this build has, or none).
//
// usage: node tools/bake-icons.mjs [--check] [--port N] [--only key,…]
//   --check  compare the manifest with the scenes as they are now: exit 1 if
//            any sprite is missing, stale or not wanted any more (no browser)
//   --only   re-bake just these files' keys (gun, portrait-DEMO-rpg, …)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REVISION } from 'three/webgpu';
import { MODELS, iconScene, ICON_DIR } from '../src/pov/models.js';
import { portraitScene, portraitFile } from '../src/pov/classPortraits.js';
import { CLASSES } from '../src/pov/classes.js';
import { gearByKey } from '../src/pov/tools/catalog.js';
import { meshLightWGSL } from '../src/gfx/meshLight.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', ICON_DIR);
const MANIFEST = join(OUT, 'manifest.json');
const PAGE = join(ROOT, 'tools/harness/icons.js');
const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);

// ---------------------------------------------------------------- what is drawn

/** Every sprite the game shows: { file (under public/), kind, arg, scene() }. */
function entries() {
  const out = Object.keys(MODELS).map((key) => ({ file: `${ICON_DIR}${key}.png`, kind: 'icon', arg: key, scene: () => iconScene(key) }));
  for (const cls of CLASSES) {
    const models = [null, ...new Set(cls.tools.map((t) => gearByKey(t)?.model).filter((m) => m && MODELS[m]))];
    for (const model of models) {
      const arg = { color: cls.color, pose: cls.pose, model };
      out.push({ file: portraitFile(cls.key, model), kind: 'portrait', arg, scene: () => portraitScene(arg) });
    }
  }
  return out;
}

const r6 = (x) => Math.round(x * 1e6) / 1e6;   // (float noise below a millionth doesn't change a pixel)
const nums = (a) => Array.from(a, r6).join(',');
function textureKey(t) {
  if (!t) return '';
  const img = t.image;
  return `${t.constructor.name}|${t.minFilter}|${t.magFilter}|${img?.width}x${img?.height}|${img?.data ? createHash('sha256').update(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength)).digest('hex') : t.uuid}`;
}
function materialKey(m) {
  const parts = [m.type, m.name];
  for (const k of ['color', 'emissive', 'specular']) if (m[k]?.isColor) parts.push(`${k}:${nums(m[k].toArray())}`);
  for (const k of ['side', 'transparent', 'opacity', 'blending', 'flatShading', 'vertexColors', 'depthTest', 'depthWrite', 'alphaTest', 'wireframe', 'emissiveIntensity']) {
    if (m[k] !== undefined) parts.push(`${k}:${typeof m[k] === 'number' ? r6(m[k]) : m[k]}`);
  }
  for (const k of ['map', 'gradientMap']) if (m[k]) parts.push(`${k}:${textureKey(m[k])}`);
  if (m.userData?.outlineWidth != null) parts.push(`outline:${r6(m.userData.outlineWidth)}`);
  return parts.join(';');
}
/** A fingerprint of what a scene and camera would draw. */
export function sceneFingerprint(scene, camera) {
  const h = createHash('sha256');
  scene.updateMatrixWorld(true);
  h.update(`camera ${camera.type} ${nums(camera.projectionMatrix.elements)} ${nums(camera.matrixWorld.elements)}\n`);
  scene.traverse((o) => {
    h.update(`${o.type} ${o.visible} ${nums(o.matrixWorld.elements)}\n`);
    if (o.isLight) h.update(`light ${nums(o.color.toArray())} ${r6(o.intensity)} ${nums(o.position.toArray())}\n`);
    const g = o.geometry;
    if (g) {
      for (const name of Object.keys(g.attributes).sort()) {
        const a = g.attributes[name];
        h.update(`${name} ${a.itemSize} `);
        h.update(nums(a.array));
      }
      if (g.index) h.update(Buffer.from(g.index.array.buffer, g.index.array.byteOffset, g.index.array.byteLength));
      h.update(JSON.stringify(g.groups ?? []));
    }
    for (const m of [o.material].flat().filter(Boolean)) h.update(`${materialKey(m)}\n`);
  });
  return h.digest('hex').slice(0, 32);
}

// what every sprite depends on besides its scene: three, the bake page, and
// the modules whose code makes the sprites' materials and outline (the
// figures' parts, outline and light; the models, their node materials and
// outlineSprite; the portraits' poses), with the light's WGSL as it is
// emitted (it takes numbers from shaders/gfx/lighting.js and clouds.js)
const SOURCES = [
  'src/pov/models.js', 'src/pov/classPortraits.js', 'src/pov/figure.js', 'src/pov/figureCrasher.js', 'src/pov/limbs.js',
  'src/pov/constants.js', 'src/gfx/meshLight.js',
];
const hash32 = (h) => h.digest('hex').slice(0, 32);
function globalKey() {
  const src = createHash('sha256');
  for (const f of SOURCES) src.update(`${f}\n`).update(readFileSync(join(ROOT, f)));
  src.update(meshLightWGSL);
  return { three: REVISION, page: hash32(createHash('sha256').update(readFileSync(PAGE))), sources: hash32(src) };
}

function fingerprints(list) {
  return Object.fromEntries(list.map((e) => {
    const { scene, camera, dispose } = e.scene();
    try { return [e.file, sceneFingerprint(scene, camera)]; } finally { dispose(); }
  }));
}

// ---------------------------------------------------------------- --check

function check() {
  const list = entries();
  const want = fingerprints(list), global = globalKey();
  let have = null;
  try { have = JSON.parse(readFileSync(MANIFEST, 'utf8')); } catch { /* none */ }
  const problems = [];
  if (!have) problems.push(`no manifest (${MANIFEST}): run node tools/bake-icons.mjs`);
  else {
    if (have.three !== global.three) problems.push(`baked with three r${have.three}, now r${global.three}`);
    if (have.page !== global.page) problems.push('tools/harness/icons.js changed since the bake');
    if (have.sources !== global.sources) problems.push(`the modules the sprites are drawn with changed since the bake (one of ${SOURCES.join(', ')}, or the figures' light WGSL)`);
    for (const [file, fp] of Object.entries(want)) {
      if (!have.files?.[file]) problems.push(`${file}: not baked`);
      else if (have.files[file] !== fp) problems.push(`${file}: its scene changed since the bake`);
      if (!existsSync(join(ROOT, 'public', file))) problems.push(`${file}: missing from public/`);
    }
    for (const file of Object.keys(have.files ?? {})) if (!want[file]) problems.push(`${file}: baked but no longer wanted`);
  }
  for (const p of problems) console.log(`stale ${p}`);
  console.log(problems.length ? `bake-icons --check: ${problems.length} problem(s) of ${list.length} sprites; re-bake with node tools/bake-icons.mjs` : `bake-icons --check: clean (${list.length} sprites)`);
  return problems.length ? 1 : 0;
}

// ---------------------------------------------------------------- the bake

async function bake() {
  const { launchBrowser } = await import('./browser.mjs');
  const { startVite } = await import('./vite-server.mjs');
  const { openHarness } = await import('./harness/open.mjs');
  const only = opt('only')?.split(',').map((k) => (k.endsWith('.png') ? k : `${k}.png`));
  const list = entries().filter((e) => !only || only.some((o) => e.file.endsWith(`/${o}`)));
  mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  const vite = await startVite({ harness: true });
  const browser = await launchBrowser();
  let failures = 0;
  try {
    const errors = [];
    const page = await openHarness(browser, vite, '/tools/harness/icons.html', { errors });
    for (const e of list) {
      const r = await page.evaluate(([kind, arg]) => window.__harness.run(kind, arg), [e.kind, e.arg]);
      if (r.failures?.length) { failures++; console.log(`FAIL ${e.file}: ${r.failures.join(' | ')}`); continue; }
      writeFileSync(join(ROOT, 'public', e.file), Buffer.from(r.png, 'base64'));
      console.log(`baked ${e.file}`);
    }
    if (errors.length) { failures++; console.log(`FAIL page errors: ${errors.join(' | ').slice(0, 2000)}`); }
  } finally {
    await browser.close();
    await vite.close();
  }
  if (failures) { process.exitCode = 1; return; }
  // the manifest: the whole set's fingerprints (a partial bake keeps the others'), and what is no longer wanted goes
  let prev = {};
  try { prev = JSON.parse(readFileSync(MANIFEST, 'utf8')); } catch { /* none */ }
  const all = entries(), fps = fingerprints(all), now = new Set(list.map((e) => e.file));
  const files = {};
  for (const e of all) {
    if (now.has(e.file)) files[e.file] = fps[e.file];
    else if (prev.files?.[e.file]) files[e.file] = prev.files[e.file];
  }
  writeFileSync(MANIFEST, `${JSON.stringify({ ...globalKey(), files }, null, 1)}\n`);
  const wanted = new Set(all.map((e) => e.file.slice(ICON_DIR.length)));
  for (const f of readdirSync(OUT)) if (f.endsWith('.png') && !wanted.has(f)) { unlinkSync(join(OUT, f)); console.log(`removed ${ICON_DIR}${f}`); }
  console.log(`bake-icons: ${list.length} sprites in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

// (run as a script; imported, it only lends sceneFingerprint and entries)
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (argv.includes('--check')) process.exitCode = check();
  else await bake();
}
export { entries };
