// Cold compile time of the view shader (shaders/render.js volumeFrag) on the
// real GPU: headless Chromium on ANGLE/Metal, raw WebGL2 (no app, no vite).
// Each run makes the shader unique with real code (see BUST_DISCARD_RANGE), so
// no cache (Chrome's program cache, Apple's Metal compiler cache) can hit; an
// unused #define would be stripped and hit. Times, per run:
//   compile  compileShader + COMPILE_STATUS (both stages)
//   link     linkProgram + LINK_STATUS
//   draw     first draw of 1 px + readPixels (where ANGLE/Metal builds the pipeline)
// --parallel: link with KHR_parallel_shader_compile, then poll for completion
//   and issue the first draw without a sync call, and report the longest gap
//   between main-thread timer ticks (the page freeze) and how many animation
//   frames the page got meanwhile.
// usage: node tools/compile-bench.mjs [--variants base,full,base+VIEW=0,alt:base] [--alt dir] [--runs 3] [--parallel] [--warm] [--bust-steps N]
//        [--define NAME=1,...] (extra defines on every variant, for bisecting)
import { chromium } from 'playwright';
import { gridLayout } from '../src/sim.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { volumeFrag, volumeVert } from '../src/shaders/render.js';
import { allDetailDefines } from '../src/gfx/detail.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const runs = +opt('runs', '3');
const parallel = args.includes('--parallel');
const warm = args.includes('--warm');
const extra = Object.fromEntries(opt('define', '').split(',').filter(Boolean).map((s) => s.split('=')));
const VARIANTS = { base: {}, full: allDetailDefines() };
const variants = opt('variants', 'base,full').split(',');
// Cache busting: a never-taken discard at the top of main with a random
// constant (real code: the compiler can't drop it), as tools/app-compile-probe.mjs
// does. --bust steps instead offsets the DDA step bound by up to this many steps.
const BUST_DISCARD_RANGE = 1e6;
const bustSteps = +opt('bust-steps', '0');
const TICK_MS = 4;             // main-thread probe interval in --parallel
const POLL_TIMEOUT_MS = 120000;

// the prefix three.js puts on a ShaderMaterial (as tools/check-shaders.mjs)
const fragPrefix = `#version 300 es
precision highp float;
precision highp int;
#define varying in
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
#define texture2D texture
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;
`;
const vertSrc = `#version 300 es
precision highp float;
uniform mat4 modelMatrix, modelViewMatrix, projectionMatrix, viewMatrix;
in vec3 position;
${volumeVert}`;

// a variant: base or full, plus +NAME=value defines (e.g. base+VIEW=0)
const definesOf = (spec) => {
  const [head, ...more] = spec.split('+');
  return { ...VARIANTS[head], ...Object.fromEntries(more.map((s) => s.split('='))) };
};
const g0 = gridLayout(128, 128, 128);
const source = (spec) => {
  const alt = spec.startsWith('alt:');
  const defines = definesOf(alt ? spec.slice(4) : spec);
  const g = { ...g0, maxSteps: g0.maxSteps + (warm || !bustSteps ? 0 : 1 + Math.floor(Math.random() * bustSteps)) };
  const defs = Object.entries({ ...defines, ...extra }).map(([k, v]) => `#define ${k} ${v}\n`).join('');
  let src = fragPrefix + defs + (alt ? altFrag : volumeFrag)(g);
  if (!warm && !bustSteps) src = src.replace(/void main\(\)\s*\{/, `void main() { if (gl_FragCoord.x < -${1 + Math.floor(Math.random() * BUST_DISCARD_RANGE)}.5) discard;`);
  return src;
};

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage();
await p.setContent('<canvas width=1 height=1></canvas>');
const renderer = await p.evaluate(() => {
  const gl = document.querySelector('canvas').getContext('webgl2');
  const e = gl.getExtension('WEBGL_debug_renderer_info');
  return `${gl.getParameter(e.UNMASKED_RENDERER_WEBGL)}; parallel ext: ${!!gl.getExtension('KHR_parallel_shader_compile')}`;
});
console.log(renderer);

// --alt <dir>: a second source tree (an export of another commit's src/);
// variants named alt:<spec> build its view shader, for A/B of a refactor
const altDir = opt('alt', '');
const altFrag = altDir ? (await import(pathToFileURL(resolve(altDir, 'src/shaders/render.js')).href)).volumeFrag : null;
const totals = {};
for (let r = 0; r < runs; r++) {   // variants interleaved, so load from other processes hits them alike
  for (const name of variants) {
    const res = await p.evaluate(async ([vs, fs, parallel, TICK_MS, POLL_TIMEOUT_MS]) => {
      const gl = document.querySelector('canvas').getContext('webgl2');
      const ext = gl.getExtension('KHR_parallel_shader_compile');
      gl.getExtension('EXT_color_buffer_float');   // (three.js enables it too)
      const now = () => performance.now();
      const out = {};
      // main-thread probe: longest gap between timer ticks, animation frames seen
      let last = now(), gap = 0, frames = 0, probing = true;
      const tick = () => { const t = now(); gap = Math.max(gap, t - last); last = t; if (probing) setTimeout(tick, TICK_MS); };
      const raf = () => { frames++; if (probing) requestAnimationFrame(raf); };
      const t0 = now();
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
      const v = sh(gl.VERTEX_SHADER, vs), f = sh(gl.FRAGMENT_SHADER, fs);
      const prog = gl.createProgram();
      gl.attachShader(prog, v); gl.attachShader(prog, f);
      if (!parallel) {
        if (!gl.getShaderParameter(f, gl.COMPILE_STATUS)) return { error: gl.getShaderInfoLog(f).slice(0, 400) };
        out.compile = now() - t0;
      }
      const t1 = now();
      gl.linkProgram(prog);
      if (parallel) {
        tick(); raf();
        const t = now();
        while (!gl.getProgramParameter(prog, ext.COMPLETION_STATUS_KHR)) {
          if (now() - t > POLL_TIMEOUT_MS) return { error: 'timeout' };
          await new Promise((r) => setTimeout(r, TICK_MS));
        }
        out.linkAsync = now() - t1;
        out.linkGap = gap; gap = 0;
      }
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { error: gl.getProgramInfoLog(prog).slice(0, 400) };
      out.link = now() - t1;
      gl.useProgram(prog);
      const I = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      for (const u of ['modelMatrix', 'modelViewMatrix', 'projectionMatrix', 'viewMatrix']) gl.uniformMatrix4fv(gl.getUniformLocation(prog, u), false, I);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'position');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
      // the target and state the view draws with (gfx/post.js sceneRT: RGBA half
      // float colour, float depth texture; premultiplied blending, depth test)
      const tex = (fmt, f, type) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, fmt, 1, 1, 0, f, type, null); return t; };
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT), 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex(gl.DEPTH_COMPONENT32F, gl.DEPTH_COMPONENT, gl.FLOAT), 0);
      gl.viewport(0, 0, 1, 1);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      // every sampler its own unit, with a float texture behind it
      let unit = 0;
      for (let i = 0; i < gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i++) {
        const u = gl.getActiveUniform(prog, i);
        if (u.type !== gl.SAMPLER_2D && u.type !== gl.SAMPLER_3D) continue;
        gl.activeTexture(gl.TEXTURE0 + unit);
        if (u.type === gl.SAMPLER_2D) tex(gl.RGBA32F, gl.RGBA, gl.FLOAT);
        else { gl.bindTexture(gl.TEXTURE_3D, gl.createTexture()); gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, 1, 1, 1, 0, gl.RGBA, gl.HALF_FLOAT, null); }
        gl.uniform1i(gl.getUniformLocation(prog, u.name), unit++);
      }
      const t2 = now();
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const err = gl.getError();
      if (err) return { error: `draw: GL error ${err}` };
      if (parallel) {
        // no sync call: does the pipeline build freeze the page anyway?
        out.drawIssue = now() - t2;
        const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        frames = 0;
        while (gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) {
          if (now() - t2 > POLL_TIMEOUT_MS) return { error: 'draw timeout' };
          await new Promise((r) => setTimeout(r, TICK_MS));
        }
        out.drawAsync = now() - t2;
        out.drawGap = gap;
        out.frames = frames;
        probing = false;
      } else {
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, new Float32Array(4));
        out.draw = now() - t2;
      }
      gl.deleteProgram(prog); gl.deleteShader(v); gl.deleteShader(f); gl.deleteBuffer(buf);
      return out;
    }, [vertSrc, source(name), parallel, TICK_MS, POLL_TIMEOUT_MS]);
    const fmt = Object.entries(res).map(([k, v]) => `${k} ${typeof v !== 'number' ? v : k === 'frames' ? v : (v / 1000).toFixed(2) + ' s'}`).join('  ');
    console.log(`${name.padEnd(12)} run ${r + 1}: ${fmt}`);
    (totals[name] ??= []).push((res.compile ?? 0) + (res.link ?? res.linkAsync ?? 0) + (res.draw ?? res.drawAsync ?? 0));
  }
}
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
for (const [k, v] of Object.entries(totals)) console.log(`${k.padEnd(12)} median total ${(median(v) / 1000).toFixed(2)} s`);
await b.close();
