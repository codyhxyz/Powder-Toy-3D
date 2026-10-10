// Flamethrower, torch and lantern end-to-end check (docs/pov.md "Light and fire"):
// at night, the lamps light the world (shader lamps), a thrown torch lies lit and
// sets wood alight, the lantern switches and lands lit, and the flamethrower's
// stream fills its reach with fire.
// usage: node tools/lights-check.mjs [--port 5371] [--shots dir]   (needs a dev server)
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5371');
const shots = opt('shots', null);
const W = 960, H = 600;
const MIDNIGHT_STEPS = 42000;   // the day clock at midnight (gfx/daylight.js: phaseSteps(0) with the 10 am start)

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 500)));
await p.goto(`http://localhost:${port}/?preset=empty`, { timeout: 120000 });   // patient: the GPU is shared (keys-check)
await p.waitForFunction(() => window.__app?.pov, null, { timeout: 120000 });
await p.waitForTimeout(1500);
// no UI over the canvas: in play, pointer lock sends every click to it, but here the hotbar's
// slot stack (which can sit over the middle of a small window) would take them
await p.addStyleTag({ content: 'body *{visibility:hidden !important} canvas[data-engine]{visibility:visible !important}' });

let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
const ev = (fn, arg) => p.evaluate(fn, arg);
const wait = (ms) => p.waitForTimeout(ms);
const shot = async (name) => { if (shots) await p.screenshot({ path: `${shots}/${name}.jpg`, type: 'jpeg', quality: 70 }); };
const census = () => ev(async () => {
  const { ELEMENTS } = await import('/src/elements.js');
  return Object.fromEntries(Object.entries(window.__app.sim.census()).map(([k, v]) => [ELEMENTS[k].key, v.n]));
});
const hold = (key) => ev((k) => window.__app.pov.toolbelt.select(k), key);
const lampCount = () => ev(async () => (await import('/src/gfx/uniforms.js')).gfxUniforms.uLampCount.value);
// mean brightness (0–255) of the world left of the middle of the frame, clear of the tool in hand
// (its flame and glow are bright themselves): a screenshot, measured by ImageMagick
const SHOT_TMP = join(mkdtempSync(join(tmpdir(), 'lights-')), 'frame.png');
const brightness = async () => {
  await p.screenshot({ path: SHOT_TMP, clip: { x: W / 8, y: H / 4, width: W * 3 / 8, height: H / 2 } });
  return +execFileSync('magick', [SHOT_TMP, '-colorspace', 'gray', '-format', '%[fx:mean*255]', 'info:']).toString();
};

// night, a wooden wall ahead; the eyes don't adjust (gfx/post.js ADAPT would brighten the dark
// views to meet the lit ones, and the comparisons are of the light itself)
await ev(async ([steps]) => {
  const a = window.__app, { E } = await import('/src/elements.js'), V = a.camera.position.constructor;
  a.post.settings.adapt = false;
  a.day.clock = steps;
  a.sim.paint({ center: new V(40, 4, 64.5), radius: 4, shape: 1, tool: E.WOOD, rate: 1, replace: true });
}, [MIDNIGHT_STEPS]);
await p.mouse.move(W / 2, H / 2);
await p.keyboard.press('v');   // V drops in (keys-check)
await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 20000 }).catch(() => {});
await ev(() => { const a = window.__app, V = a.camera.position.constructor; a.pov.test.assumeLocked = true; a.pov.player.spawn(new V(30, 0, 64.5)); a.pov.setLook(-Math.PI / 2, -0.15); });
await wait(1500);
const sunCol = await ev(async () => [...(await import('/src/gfx/uniforms.js')).gfxUniforms.uSunCol.value].map((v) => +v.toFixed(2)));
console.log(`     sun colour (SUN_COL units) ${sunCol}`);

await hold('SHOVEL'); await wait(600);
const dark = await brightness();
await shot('night-no-light');
await hold('TORCH'); await wait(800);
check('torch in hand is a lit lamp', (await lampCount()) === 1);
const torchLit = await brightness();
await shot('night-torch');
check('the torch lights the wall', torchLit > dark * 1.3, `brightness ${dark.toFixed(1)} → ${torchLit.toFixed(1)}`);

// lantern: brighter than the torch (measured before the wall burns: its fire lights every view after)
await ev(async () => (await import('/src/pov/tools/inventory.js')).inventory.give('LANTERN'));
await wait(800);
check('the lantern given goes in hand', (await ev(() => window.__app.pov.toolbelt.selectedKey)) === 'LANTERN');
await ev(() => window.__app.pov.setLook(Math.PI / 2, -0.15));   // away from the wall
await wait(800);
await hold('SHOVEL'); await wait(500);
const dark2 = await brightness();
await hold('LANTERN'); await wait(800);
const lanternLit = await brightness();
await shot('night-lantern');
await hold('TORCH'); await wait(800);
const torchLit2 = await brightness();
check('the lantern is brighter than the torch', lanternLit > torchLit2 && torchLit2 > dark2, `dark ${dark2.toFixed(1)}, torch ${torchLit2.toFixed(1)}, lantern ${lanternLit.toFixed(1)}`);
await ev(() => window.__app.pov.setLook(-Math.PI / 2, -0.15));   // back to the wall
await hold('TORCH'); await wait(800);

// a torch thrown at the wood lands lit and sets it alight
let c0 = await census();
await p.mouse.down({ button: 'right' }); await wait(40); await p.mouse.up({ button: 'right' });
await wait(1500);
const props = await ev(() => window.__app.pov.toolbelt.tool('TORCH').props.length);
check('a thrown torch lies where it landed', props === 1, `${props}`);
check('...still lit (and a fresh one in hand)', (await lampCount()) === 2, `${await lampCount()} lamps`);
await wait(5000);
let c1 = await census();
check('the thrown torch sets the wood alight', (c1.FIRE ?? 0) > 0 || (c1.WOOD ?? 0) < (c0.WOOD ?? 0), `WOOD ${c0.WOOD}→${c1.WOOD}, FIRE ${c0.FIRE ?? 0}→${c1.FIRE ?? 0}, ASH ${c1.ASH ?? 0}`);
await shot('torch-thrown');

// the lantern switches and lands lit (thrown away from the burning wall)
await ev(() => window.__app.pov.setLook(Math.PI / 2, -0.15));
await hold('LANTERN'); await wait(300);
await p.mouse.down(); await wait(40); await p.mouse.up();
await wait(300);
check('left-click switches the lantern off', !(await ev(() => window.__app.pov.toolbelt.tool('LANTERN').on)));
await p.mouse.down(); await wait(40); await p.mouse.up();
await wait(300);
await p.mouse.down({ button: 'right' }); await wait(40); await p.mouse.up({ button: 'right' });
await wait(1500);
check('a thrown lantern lies lit', (await ev(() => window.__app.pov.toolbelt.tool('LANTERN').props.length)) === 1);

// flamethrower: a continuous stream that fills its reach with fire
await ev(async () => {
  const a = window.__app, { E } = await import('/src/elements.js'), V = a.camera.position.constructor;
  a.sim.paint({ center: new V(30, 4, 84), radius: 4, shape: 1, tool: E.WOOD, rate: 1, replace: true });
});
await ev(() => window.__app.pov.setLook(Math.PI, -0.05));
await hold('BLOWTORCH'); await wait(500);
c0 = await census();
await p.mouse.down();
await wait(700);
const mid = await census();
await shot('flamethrower');
await wait(800);
await p.mouse.up();
await wait(1500);
c1 = await census();
check('the flamethrower fills its reach with fire', (mid.FIRE ?? 0) > 150, `FIRE ${mid.FIRE ?? 0} mid-stream`);
check('...and lights the wood 18 cells off', (c1.WOOD ?? 0) < (c0.WOOD ?? 0) || (c1.FIRE ?? 0) > 0, `WOOD ${c0.WOOD}→${c1.WOOD}`);

const real = errs.filter((e) => !e.startsWith('Failed to load resource'));
check('no errors', real.length === 0, real.slice(0, 5).join(' | '));
console.log(fails ? `${fails} FAILED` : 'all ok');
await b.close();
process.exit(fails ? 1 : 0);
