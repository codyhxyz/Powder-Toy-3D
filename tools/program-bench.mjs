// Cold compile time of the app's own GPU programs, one at a time, on the real
// GPU (ANGLE/Metal): the page boots for a few seconds only to capture each
// program's sources as three.js hands them to WebGL (by SHADER_NAME), then a
// bare WebGL2 page compiles, links and draws each named program once into
// matching render targets and reads a pixel back (where ANGLE/Metal builds the
// pipeline), with the fragment shader made unique by a never-taken discard
// (real code, so no program or Metal compiler cache can hit; --warm skips it).
// tools/compile-bench.mjs does the same for the view shader from source.
// Needs a server: `npx vite --port 5735 --strictPort` (or --base for the live site).
// usage: node tools/program-bench.mjs [--port 5735] [--base URL] [--query '?map=damValley']
//        [--programs react,moveBlock] [--capture-ms 6000] [--warm] [--save dir]
//        [--from dir]   (bench <name>.vert/<name>.frag files instead of capturing: A/B an edited shader)
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, newTestPage } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const base = opt('base', `http://localhost:${opt('port', '5735')}`);
const query = opt('query', '?map=lab');
const wanted = opt('programs', '').split(',').filter(Boolean);
const CAPTURE_MS = +opt('capture-ms', '6000');   // the boot is cut off here: the sources are in by then
const warm = args.includes('--warm');
const save = opt('save', '');
const from = opt('from', '');
const BUST_RANGE = 1e6;

// 1. the sources, as three.js hands them to WebGL (its own browser: work it left on the GPU must not delay the timing)
let programs = {};
if (from) {
  for (const f of readdirSync(from).filter((f) => f.endsWith('.frag'))) {
    const name = f.slice(0, -5);
    programs[name] = { vert: readFileSync(join(from, `${name}.vert`), 'utf8'), frag: readFileSync(join(from, f), 'utf8') };
  }
} else {
const capture = await launchBrowser();
try {
  const boot = await newTestPage(capture, { mode: 'preview', viewport: { width: 640, height: 400 } });
  await boot.addInitScript(() => {
    const P = WebGL2RenderingContext.prototype;
    const src = new WeakMap();
    window.__programs = {};
    const ss = P.shaderSource;
    P.shaderSource = function (sh, text) { src.set(sh, text); return ss.call(this, sh, text); };
    const at = P.attachShader;
    P.attachShader = function (pr, sh) {
      const text = src.get(sh) ?? '';
      const stage = /gl_Position\s*=/.test(text) ? 'vert' : 'frag';
      (pr.__src ??= {})[stage] = text;
      const name = text.match(/#define SHADER_NAME (\S+)/)?.[1];
      if (name && pr.__src.vert && pr.__src.frag) window.__programs[name] ??= pr.__src;
      return at.call(this, pr, sh);
    };
  });
  await boot.goto(`${base}/${query}`);
  await boot.waitForTimeout(CAPTURE_MS);
  programs = await boot.evaluate(() => window.__programs);
} finally {
  await capture.close();
}
}
if (save) {
  mkdirSync(save, { recursive: true });
  for (const [name, { vert, frag }] of Object.entries(programs)) { writeFileSync(join(save, `${name}.vert`), vert); writeFileSync(join(save, `${name}.frag`), frag); }
}

// 2. each program cold, in a bare page
const browser = await launchBrowser();
try {
  const names = wanted.length ? wanted : Object.keys(programs);
  const missing = names.filter((n) => !programs[n]);
  if (missing.length) console.log(`not captured in ${CAPTURE_MS} ms: ${missing.join(', ')}`);
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 64, height: 64 } });
  await page.setContent('<canvas width=8 height=8></canvas>');
  console.log(`${base}/${query}, ${warm ? 'warm' : 'cold'}`);
  for (const name of names.filter((n) => programs[n])) {
    const { vert, frag } = programs[name];
    const fragSrc = warm ? frag : frag.replace(/void main\(\)\s*\{/, `void main() { if (gl_FragCoord.x < -${1 + Math.floor(Math.random() * BUST_RANGE)}.5) discard;`);
    const r = await page.evaluate(({ vert, frag }) => {
      const gl = document.querySelector('canvas').getContext('webgl2');
      gl.getExtension('EXT_color_buffer_float');
      const now = () => performance.now();
      const SAMPLERS = new Set(Object.getOwnPropertyNames(WebGL2RenderingContext).filter((k) => /SAMPLER/.test(k) && !/BINDING/.test(k)).map((k) => WebGL2RenderingContext[k]));
      const t0 = now();
      const sh = (type, text) => { const s = gl.createShader(type); gl.shaderSource(s, text); gl.compileShader(s); return s; };
      const vs = sh(gl.VERTEX_SHADER, vert), fs = sh(gl.FRAGMENT_SHADER, frag);
      const pr = gl.createProgram();
      gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return { error: (gl.getProgramInfoLog(pr) || gl.getShaderInfoLog(fs) || gl.getShaderInfoLog(vs) || '').slice(0, 300) };
      const tLink = now();
      gl.useProgram(pr);
      // every sampler on its own unit (nothing bound: sampling reads 0), so no unit mixes sampler types
      let unit = 0;
      for (let i = 0, n = gl.getProgramParameter(pr, gl.ACTIVE_UNIFORMS); i < n; i++) {
        const u = gl.getActiveUniform(pr, i);
        if (SAMPLERS.has(u.type)) {
          for (let j = 0; j < u.size; j++) gl.uniform1i(gl.getUniformLocation(pr, u.size > 1 ? u.name.replace(/\[0\]$/, `[${j}]`) : u.name), unit++);
        }
      }
      // every attribute fed zeros
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(64), gl.STATIC_DRAW);
      const INT_TYPES = [gl.INT, gl.INT_VEC2, gl.INT_VEC3, gl.INT_VEC4, gl.UNSIGNED_INT, gl.UNSIGNED_INT_VEC2, gl.UNSIGNED_INT_VEC3, gl.UNSIGNED_INT_VEC4];
      for (let i = 0, n = gl.getProgramParameter(pr, gl.ACTIVE_ATTRIBUTES); i < n; i++) {
        const a = gl.getActiveAttrib(pr, i), loc = gl.getAttribLocation(pr, a.name);
        gl.enableVertexAttribArray(loc);
        if (INT_TYPES.includes(a.type)) gl.vertexAttribIPointer(loc, 1, gl.INT, 0, 0); else gl.vertexAttribPointer(loc, 1, gl.FLOAT, false, 0, 0);
      }
      // render targets of the outputs' types
      const outs = [...frag.matchAll(/(?:layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*)?\bout\s+(?:highp\s+|mediump\s+|lowp\s+)?(\w+)\s+\w+\s*;/g)]
        .map((m) => ({ loc: +(m[1] ?? 0), type: m[2] }));
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      const fmt = (t) => (/^u/.test(t) ? [gl.RGBA32UI, gl.RGBA_INTEGER, gl.UNSIGNED_INT, Uint32Array] : /^i/.test(t) ? [gl.RGBA32I, gl.RGBA_INTEGER, gl.INT, Int32Array] : [gl.RGBA32F, gl.RGBA, gl.FLOAT, Float32Array]);
      for (const o of outs) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, fmt(o.type)[0], 1, 1);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + o.loc, gl.TEXTURE_2D, tex, 0);
      }
      gl.bindTexture(gl.TEXTURE_2D, null);
      const n = outs.length ? Math.max(...outs.map((o) => o.loc)) + 1 : 1;
      gl.drawBuffers(Array.from({ length: n }, (_, i) => (outs.some((o) => o.loc === i) ? gl.COLOR_ATTACHMENT0 + i : gl.NONE)));
      gl.viewport(0, 0, 1, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const o0 = outs.find((o) => o.loc === 0) ?? outs[0];
      const [, format, type, Arr] = fmt(o0?.type ?? 'vec4');
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + (o0?.loc ?? 0));
      gl.readPixels(0, 0, 1, 1, format, type, new Arr(4));
      const err = gl.getError();
      return { link: tLink - t0, draw: now() - tLink, outs: outs.length, err };
    }, { vert, frag: fragSrc });
    if (r.error) console.log(`${name.padEnd(16)} failed: ${r.error}`);
    else console.log(`${name.padEnd(16)} link ${(r.link / 1000).toFixed(2)} s  first draw ${(r.draw / 1000).toFixed(2)} s  (${Math.round(frag.length / 1024)} KB, ${r.outs} outputs${r.err ? `, GL error ${r.err}` : ''})`);
  }
} finally {
  await browser.close();
}
