// CPU only, no GPU: what one shader of a Metal GPU capture compiled to, per function and per loop
// (docs/profiler.md "Capture"). A .gputrace from tools/gpu-capture.mjs (tools/profile.mjs --capture)
// keeps, for every pipeline, Apple's compile statistics with the GPU compiler's remarks (YAML: the
// instruction count of every basic block with the source line of its first instruction, the inlining,
// the hoisting it gave up, the copies and spills per loop), and the MSL source Dawn/Tint compiled
// ("program_source", Tint's symbols renamed v_N). This joins the two: the static instruction count of
// each source function (its inlined bodies counted where they sit), the loops' copies and spills, and
// the uniform loads the compiler could not hoist out of a loop.
//   node tools/capture-remarks.mjs <frame.gputrace> [--instructions N] [--top 30] [--msl out.metal]
// Without --instructions it lists every shader (stage, instructions, registers, spill); --instructions picks the
// one with that total (capture.json's shaders[].instructions: the statistics carry no pipeline label).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const trace = args[0];
if (!trace || trace.startsWith('--')) { console.error('usage: node tools/capture-remarks.mjs <frame.gputrace> [--instructions N] [--top 30] [--msl out.metal]'); process.exit(2); }
const want = opt('instructions', null), top = Number(opt('top', 30)), mslOut = opt('msl', null);

// ---- an XML property list (plutil -convert xml1), NSKeyedArchiver's $objects resolved ----
function parsePlist(xml) {
  let i = 0;
  const tag = () => { const m = /<(\/?)([A-Za-z]+)[^>]*?(\/?)>/y; m.lastIndex = xml.indexOf('<', i); const r = m.exec(xml); i = m.lastIndex; return { close: !!r[1], name: r[2], empty: !!r[3] }; };
  const text = (name) => { const e = xml.indexOf(`</${name}>`, i); const s = xml.slice(i, e); i = e + name.length + 3; return s; };
  const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  function value(t = tag()) {
    if (t.name === 'dict') {
      const o = {};
      if (t.empty) return o;
      for (;;) { const k = tag(); if (k.close) return o; const key = unescape(text('key')); o[key] = value(); }
    }
    if (t.name === 'array') {
      const a = [];
      if (t.empty) return a;
      for (;;) { const v = tag(); if (v.close) return a; a.push(value(v)); }
    }
    if (t.name === 'string') return t.empty ? '' : unescape(text('string'));
    if (t.name === 'integer') return Number(text('integer'));
    if (t.name === 'real') return Number(text('real'));
    if (t.name === 'true' || t.name === 'false') return t.name === 'true';
    if (t.name === 'data') { text('data'); return null; }
    if (t.name === 'date') return text('date');
    throw new Error(`plist: unexpected <${t.name}>`);
  }
  while (!xml.startsWith('<plist', xml.indexOf('<', i))) i = xml.indexOf('<', i) + 1;
  tag();
  return value();
}
const uid = (v) => (v && typeof v === 'object' && 'CF$UID' in v ? v['CF$UID'] : null);
function unarchive(plist) {
  const objs = plist.$objects;
  const res = (v, depth = 0) => {
    const u = uid(v);
    if (u !== null) v = objs[u];
    if (depth > 8 || v === null || typeof v !== 'object') return v === '$null' ? null : v;
    if (Array.isArray(v['NS.keys'])) return Object.fromEntries(v['NS.keys'].map((k, j) => [res(k, depth + 1), res(v['NS.objects'][j], depth + 1)]));
    if (Array.isArray(v['NS.objects'])) return v['NS.objects'].map((x) => res(x, depth + 1));
    return v;
  };
  return res(plist.$top?.root ?? objs[1]);
}

// ---- the trace's files: shader statistics (with remarks) and MSL sources ----
const files = readdirSync(trace).map((f) => join(trace, f)).filter((f) => statSync(f).isFile());
const stats = [], sources = [];
for (const f of files) {
  const head = readFileSync(f).subarray(0, 8).toString('latin1');
  if (head.startsWith('bplist')) {
    const raw = readFileSync(f);
    if (!raw.includes('InstructionMix')) continue;
    const root = unarchive(parsePlist(execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', f], { encoding: 'utf8', maxBuffer: 1 << 30 })));
    for (const [stage, s] of Object.entries(root ?? {})) if (s && typeof s === 'object' && 'Instruction count' in s) stats.push({ file: f, stage, s });
  } else {
    const t = readFileSync(f, 'latin1');
    if (t.includes('#include <metal_stdlib>')) sources.push({ file: f, lines: t.split('\n') });
  }
}
if (!want) {
  console.log('shaders (stage, instructions, registers, spill B, file):');
  for (const { file, stage, s } of stats.sort((a, b) => b.s['Instruction count'] - a.s['Instruction count'])) {
    console.log(`  ${stage.padEnd(16)} ${String(s['Instruction count']).padStart(7)} ${String(s['Temporary register count']).padStart(4)} ${String(s['Spilled bytes']).padStart(6)}  ${file.split('/').pop()}`);
  }
  console.log('pick one with --instructions N');
  process.exit(0);
}
const pick = stats.filter((x) => String(x.s['Instruction count']) === String(want));
if (pick.length !== 1) { console.error(`${pick.length} shaders with ${want} instructions`); process.exit(1); }
const { s } = pick[0];
const remarks = s.Remarks.split('\n--- !');

// ---- the source: the MSL whose function definitions sit where the inlining remarks say ----
const callees = [...s.Remarks.matchAll(/- Callee:\s+_Z\d+(v_\d+)\S*\n\s+DebugLoc:\s+\{ File: program_source, Line: (\d+)/g)].map((m) => [m[1], Number(m[2])]);
// (the best match, and nearly every callee where the remarks put it: a definition can open a line earlier)
const score = (src) => callees.filter(([n, l]) => (src.lines[l - 1] ?? '').includes(` ${n}(`)).length;
const src = sources.map((x) => [x, score(x)]).sort((a, b) => b[1] - a[1]).find(([, n]) => n >= 0.9 * callees.length)?.[0];
if (!src) { console.error('no MSL source in the trace matches this shader\'s remarks'); process.exit(1); }
if (mslOut) writeFileSync(mslOut, src.lines.join('\n'));
const fnOf = [];
let cur = '(file scope)';
src.lines.forEach((l, i) => { const m = /^[A-Za-z_][\w<>:, ]*?\s+\**(\w+)\(/.exec(l); if (m && !/^(struct|template|using|#)/.test(l)) cur = `${m[1]} @${i + 1}`; fnOf.push(cur); });

const loc = (r) => /DebugLoc:\s+\{ File: (\S+), Line: (\d+)/.exec(r);
const byFn = new Map();
let total = 0;
for (const r of remarks) {
  if (!/^Analysis\nPass:\s+asm-printer\nName:\s+InstructionMix/.test(r) || !/Function:\s+agc\.main\n/.test(r)) continue;
  const n = Number(/INST_:\s+'(\d+)'/.exec(r)?.[1] ?? 0);
  total += n;
  const l = loc(r);
  const key = l && l[1] === 'program_source' ? (fnOf[Number(l[2]) - 1] ?? '(past the source)') : l ? `(metal ${l[1].split('/').pop().replace(/'/g, '')})` : '(no line: moves, branches)';
  const e = byFn.get(key) ?? { n: 0, blocks: 0 };
  e.n += n; e.blocks++;
  byFn.set(key, e);
}
console.log(`shader: ${pick[0].stage}, ${s['Instruction count']} instructions (blocks sum ${total}), ${s['Temporary register count']} registers, ${s['Spilled bytes']} B spilled; source ${src.file.split('/').pop()} (${src.lines.length} lines)`);
console.log(`\nstatic instructions by source function (a block counts where its first instruction comes from):`);
for (const [k, e] of [...byFn].sort((a, b) => b[1].n - a[1].n).slice(0, top)) {
  const line = Number(/@(\d+)$/.exec(k)?.[1] ?? 0);
  console.log(`  ${String(e.n).padStart(6)} ${String(e.blocks).padStart(4)} blk  ${k.padEnd(14)} ${line ? src.lines[line - 1].trim().slice(0, 90) : ''}`);
}
console.log('\nloops: register copies and spills the allocator put in them (source line of the loop):');
for (const r of remarks) {
  if (!/Name:\s+LoopSpillReloadCopies/.test(r)) continue;
  const l = loc(r), num = (k) => Number(new RegExp(`${k}:\\s+'(\\d+)'`).exec(r)?.[1] ?? 0);
  console.log(`  line ${l?.[2]}: ${num('NumVRCopies')} copies, ${num('NumSpills')} spills, ${num('NumReloads')} reloads  ${(src.lines[Number(l?.[2]) - 1] ?? '').trim().slice(0, 70)}`);
}
const unhoisted = new Map();
for (const r of remarks) {
  if (!/Name:\s+LoadWithLoopInvariantAddressCondExecuted/.test(r)) continue;
  const l = loc(r)?.[2] ?? '0';
  unhoisted.set(l, (unhoisted.get(l) ?? 0) + 1);
}
console.log('\nloop-invariant loads left in a loop (conditionally executed): count, source line');
for (const [l, n] of [...unhoisted].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`  ${String(n).padStart(3)}  line ${l}: ${(src.lines[Number(l) - 1] ?? '').trim().slice(0, 100)}`);
