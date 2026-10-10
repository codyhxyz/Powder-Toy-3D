// Where the app's cold start blocks: loads the app on ANGLE/Metal with every
// fragment shader made unique (a random, never-taken discard at the top of
// main: real code, so no program cache can hit) and logs each WebGL call that
// held the main thread longer than SLOW_MS, plus the longest main-thread
// stalls and when the first realistic frame was drawn.
// usage: node tools/app-compile-probe.mjs --port 5311 [--detail off|full] [--warm] [--wait 40000]
import { launchBrowser, newTestPage } from './browser.mjs';
import { DETAIL, settingKey } from '../src/gfx/detail.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5311');
const warm = args.includes('--warm');
const detail = Object.fromEntries(DETAIL.map((f) => [settingKey(f), opt('detail', 'off') === 'full']));
const WAIT_MS = +opt('wait', '40000');
const SLOW_MS = 30;    // WebGL calls slower than this are logged

const b = await launchBrowser();
const p = await newTestPage(b, { mode: 'visual', viewport: { width: 1280, height: 800 } });   // (timing: full cadence)
await p.addInitScript(([warm, SLOW_MS, detail]) => {
  localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ ...detail }));
  const t0 = performance.now();
  const log = (window.__probe = { calls: [], stalls: [], firstBig: 0, start: t0 });
  const bust = 1 + Math.floor(Math.random() * 1e6);
  const P = WebGL2RenderingContext.prototype;
  const label = new WeakMap();   // shader/program -> short label
  const src = P.shaderSource;
  P.shaderSource = function (s, text) {
    if (!warm && /void main\(\)\s*\{/.test(text) && text.includes('gl_FragCoord') && !/gl_Position/.test(text))
      text = text.replace(/void main\(\)\s*\{/, `void main() { if (gl_FragCoord.x < -${bust}.5) discard;`);
    label.set(s, `${(text.length / 1024).toFixed(0)}KB`);
    return src.call(this, s, text);
  };
  const attach = P.attachShader;
  P.attachShader = function (pr, s) { label.set(pr, (label.get(pr) ? label.get(pr) + '+' : '') + label.get(s)); return attach.call(this, pr, s); };
  let cur = null;
  const use = P.useProgram;
  P.useProgram = function (pr) { cur = pr; return use.call(this, pr); };
  for (const k of ['compileShader', 'linkProgram', 'getProgramParameter', 'getShaderParameter', 'drawArrays', 'drawElements',
    'readPixels', 'getError', 'clientWaitSync', 'getUniformLocation', 'getActiveUniform', 'getProgramInfoLog', 'getShaderInfoLog', 'finish']) {
    const f = P[k];
    P[k] = function (...a) {
      const s = performance.now();
      const r = f.apply(this, a);
      const d = performance.now() - s;
      const obj = a[0] instanceof WebGLProgram || a[0] instanceof WebGLShader ? a[0] : cur;
      if ((k === 'drawArrays' || k === 'drawElements') && !log.firstBig && /^\d+KB\+(\d+)KB/.test(label.get(cur) ?? '') && +RegExp.$1 > 150) log.firstBig = s - t0;
      if (d > SLOW_MS) log.calls.push({ at: Math.round(s - t0), ms: Math.round(d), k, prog: label.get(obj) });
      return r;
    };
  }
  let last = performance.now();
  const tick = () => { const t = performance.now(); if (t - last > 100) log.stalls.push({ at: Math.round(last - t0), ms: Math.round(t - last) }); last = t; setTimeout(tick, 10); };
  tick();
}, [warm, SLOW_MS, detail]);
const errs = [];
p.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
const tNav = Date.now();
await p.goto(`http://localhost:${port}/?preset=lab`);
await p.waitForTimeout(WAIT_MS);
const r = await p.evaluate(() => window.__probe);
console.log(`first draw of the view program at ${Math.round(r.firstBig)} ms; load took ${Date.now() - tNav - WAIT_MS} ms past goto`);
console.log('slow calls:'); for (const c of r.calls) console.log(`  @${c.at} ${c.k} ${c.ms} ms ${c.prog ?? ''}`);
console.log('main-thread stalls > 100 ms:'); for (const s of r.stalls) console.log(`  @${s.at} ${s.ms} ms`);
if (errs.length) console.log(errs.join('\n'));
await b.close();
