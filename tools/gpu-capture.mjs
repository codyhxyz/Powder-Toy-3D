// A Metal GPU capture of Chrome's GPU process (Xcode's gpucapture) and its replay
// profile (gpudebug): per-pass and per-shader cost with one pass at a time on the
// GPU ("serial"), at a fixed GPU performance state, per-pixel heat maps and
// Apple's GPU counters. docs/profiler.md "Capture" says what each output means.
// research/apple-metal/KNOWLEDGE.md section 4A is the recipe.
//
// Module (tools/profile.mjs --capture uses it):
//   CAPTURE_ENV / CAPTURE_CHROME_ARGS   launch the browser with these (tools/browser.mjs launchBrowser({ env, args }))
//   await captureFrames({ pid, out })   while the page renders: saves <out>/frame.gputrace
//   await analyzeCapture(trace, out)    after the browser has closed: the replay (GPU work: run it under a
//                                       tools/gpu-log.mjs claim; the CLI below does)
// CLI:
//   node tools/gpu-capture.mjs --analyze <frame.gputrace> --out <dir>   (replays: run it under tools/gpu-log.mjs claim)
//   node tools/gpu-capture.mjs --analyze <frame.gputrace> --reuse       (re-reads the profile an earlier replay embedded: no GPU)
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

// MTL_CAPTURE_ENABLED loads Apple's capture layer into every Metal process the browser starts (gpucapture man
// page); the GPU process must also be able to reach gputoolsserviced, which its sandbox forbids.
export const CAPTURE_ENV = { MTL_CAPTURE_ENABLED: '1' };
export const CAPTURE_CHROME_ARGS = ['--disable-gpu-sandbox', '--enable-dawn-features=use_user_defined_labels_in_backend'];
const GPUCAPTURE = '/usr/bin/gpucapture';
const GPUDEBUG = '/usr/bin/gpudebug';
export const CAPTURE_BUFFERS = 48;        // command buffers captured on Dawn's queue: a frame is ~10-30 submits
const SAMPLE_MS = 600;                    // between two boundary listings: the busiest queue is Dawn's
const CAPTURE_TIMEOUT_MS = 8000;
const REPLAY_TIMEOUT_MS = 240000;         // trace load + replay + counters, CPU mostly
const READY_POLL_MS = 500;
const TOP_COMMANDS = 3;                   // draws whose heat maps are fetched (the costliest)
const TOP_SHADERS = 10;                   // shaders whose compiler numbers are read
// heat map kinds (gpudebug performance/commands/<draw>/heatmap/fragment): execution cost, thread divergence, instruction count
const HEATMAPS = ['cost', 'divergence', 'instr_count'];
const OCCUPANCY_GROUPS = ['occupancy', 'occupancy_manager'];   // counter groups whose series are saved as JSON

class CaptureError extends Error {}
const fail = (m) => { throw new CaptureError(`gpu-capture: ${m}`); };

function tool(bin, args, timeout = 15000) {
  if (!fs.existsSync(bin)) fail(`${bin} missing: it ships with Xcode 27.1+ (xcode-select -s /Applications/Xcode.app)`);
  try { return execFileSync(bin, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }); }
  catch (e) { fail(`${path.basename(bin)} ${args.join(' ')}: ${String(e.stderr || e.stdout || e.message).trim().slice(-400)}`); }
}

/** `gpucapture boundaries --pid` rows: [{ id, type, label, count }]. */
export function parseBoundaries(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(Device|Queue|Layer|Scope)\s+(.*?)\s+([\d.]+)\s+(\d+)\s*$/.exec(line);
    if (m) rows.push({ id: +m[1], type: m[2], label: m[3], gpuMs: +m[4], count: +m[5] });
  }
  return rows;
}

/** The queue that submitted the most command buffers between two listings: Dawn's. */
export function busiestQueue(before, after) {
  const was = new Map(before.map((b) => [b.id, b.count]));
  const q = after.filter((b) => b.type === 'Queue').map((b) => ({ ...b, delta: b.count - (was.get(b.id) ?? 0) })).sort((a, b) => b.delta - a.delta)[0];
  return q && q.delta > 0 ? q : null;
}

/**
 * Captures CAPTURE_BUFFERS command buffers of Dawn's queue in Chrome's GPU process `pid` (launched with
 * CAPTURE_ENV): saves `<out>/frame.gputrace`. The page must be rendering. Resolves { trace, boundary, bytes, ms }.
 */
export async function captureFrames({ pid, out, count = CAPTURE_BUFFERS, timeoutMs = CAPTURE_TIMEOUT_MS }) {
  const t0 = Date.now();
  if (!tool(GPUCAPTURE, ['list']).includes(String(pid))) fail(`process ${pid} is not capturable (was it launched with MTL_CAPTURE_ENABLED=1 and ${CAPTURE_CHROME_ARGS[0]}?)`);
  const before = parseBoundaries(tool(GPUCAPTURE, ['boundaries', '--pid', String(pid)]));
  await new Promise((r) => setTimeout(r, SAMPLE_MS));
  const after = parseBoundaries(tool(GPUCAPTURE, ['boundaries', '--pid', String(pid)]));
  const queue = busiestQueue(before, after);
  if (!queue) fail(`no queue submitted in ${SAMPLE_MS} ms (boundaries: ${JSON.stringify(after)}): is the page rendering?`);
  fs.mkdirSync(out, { recursive: true });
  const trace = path.join(out, 'frame.gputrace');
  fs.rmSync(trace, { recursive: true, force: true });
  const child = spawn(GPUCAPTURE, ['start', '--pid', String(pid), '--boundary', String(queue.id), '--count', String(count), '--output', trace], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { try { execFileSync(GPUCAPTURE, ['stop', '--pid', String(pid)], { timeout: 5000, stdio: 'ignore' }); } catch {} child.kill('SIGINT'); }, timeoutMs);
    child.once('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  if (!fs.existsSync(trace)) fail(`gpucapture saved no trace (exit ${code}): ${log.trim().slice(-400)}`);
  return { trace, boundary: { id: queue.id, type: queue.type, perSample: queue.delta }, count, bytes: dirBytes(trace), ms: Date.now() - t0, log: log.trim().slice(-400) };
}

function dirBytes(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((s, f) => s + dirBytes(path.join(p, f)), 0);
}

// ---------- replay ----------

// One gpudebug session: the trace loaded once, commands sent with -s (gpudebug(1) "-s <id> -c").
function session(trace, out) {
  const opened = tool(GPUDEBUG, ['-q', '--json', '-t', trace, '-o', out, '--timeout', '600', '-c', 'status'], REPLAY_TIMEOUT_MS);
  const id = /Session (\S+) created/.exec(opened)?.[1];
  if (!id) fail(`gpudebug opened no session: ${opened.slice(0, 400)}`);
  const send = (...cmds) => tool(GPUDEBUG, ['-q', '--json', '-s', id, ...cmds.flatMap((c) => ['-c', c])], REPLAY_TIMEOUT_MS);
  const close = () => { try { execFileSync(GPUDEBUG, ['--terminate', id], { timeout: 20000, stdio: 'ignore' }); } catch {} };
  return { id, send, close };
}
// gpudebug --json prints one JSON document per command (go also lists): the last one is the answer
export function lastJson(text) {
  const docs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') { if (!depth++) start = i; }
    else if ((c === '}' || c === ']') && depth && !--depth) { try { docs.push(JSON.parse(text.slice(start, i + 1))); } catch {} }
  }
  return docs.at(-1) ?? null;
}
const children = (doc) => doc?.children ?? [];
const value = (v) => (v == null ? null : v.type === 'percentage' ? v.value / 100 : v.value);
// "Dawn_RenderPassEncoder_world march@- (2)" -> "world march"
export const passLabel = (s) => String(s ?? '').replace(/^"|"$/g, '').replace(/ \(\d+\)$/, '').replace(/^Dawn_(?:Compute|Render)(?:Pass|Pipeline)(?:Encoder)?_?/, '').replace(/@[^@]*$/, '') || '(unlabelled)';
const pct = (s) => (typeof s === 'string' && s.endsWith('%') ? parseFloat(s) / 100 : null);
const msOf = (s) => (typeof s === 'string' && /ms$/.test(s) ? parseFloat(s) : null);

/**
 * Replays the capture with gpudebug: `profile run --exec serial --gpu-state high` (each pass alone on the GPU, a
 * fixed performance state: Apple's per-pass numbers), then per pass (encoders merged by label) its cost share,
 * duration, occupancy, Occupancy Manager Target and limiters; per shader its cost, registers, spill and
 * instruction mix; the costliest draws' heat maps (PNG: execution cost, thread divergence, instruction count);
 * and every counter group's averages, with the occupancy series as JSON. Writes `<out>/capture.json`.
 * GPU work (the replay): callers hold a claim (tools/gpu-log.mjs), as the CLI below does.
 */
export async function analyzeCapture(trace, out, { exec = 'serial', state = 'high', reuse = false } = {}) {
  fs.mkdirSync(out, { recursive: true });
  const ready = async (s) => {   // the replayer loads in the background (gpudebug(1)): profiling before it is ready collects nothing
    for (const until = Date.now() + REPLAY_TIMEOUT_MS; lastJson(s.send('status'))?.replayer?.state !== 'ready';) {
      if (Date.now() > until) fail('the replayer never became ready');
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
  };
  // the replay (GPU work), embedded into the trace. Its own session: after `profile run` the session's
  // performance tree stays empty (gpudebug 27.1), while a session that loads the embedded profile has it all
  if (!reuse) {
    const r = session(trace, out);
    try {
      await ready(r);
      const profiled = lastJson(r.send(`profile run --gpu-state ${state} --exec ${exec} --embed`));
      if (!profiled?.success) fail(`profile run failed: ${JSON.stringify(profiled).slice(0, 300)}`);
    } finally { r.close(); }
  }
  // reading it back: no GPU work (also --reuse: an earlier replay's profile)
  const s = session(trace, out);
  const errors = [];
  const tryDo = (what, f) => { try { return f(); } catch (e) { errors.push(`${what}: ${String(e.message).slice(0, 200)}`); return null; } };
  try {
    await ready(s);
    const loaded = lastJson(s.send('profile load'));   // (the latest embedded session)
    if (!loaded?.success) fail(`profile load failed: ${JSON.stringify(loaded).slice(0, 300)}`);
    const passes = new Map();
    for (const row of children(lastJson(s.send('go /performance/encoders')))) {
      const label = passLabel(value(row.values?.[0]));
      const info = tryDo(`info ${row.name}`, () => lastJson(s.send(`info /performance/encoders/${row.name}`))) ?? {};
      const p = passes.get(label) ?? { pass: label, encoders: 0, cost: 0, ms: 0, kind: info['Encoder type'] ?? null, limiters: {}, occupancy: {}, n: 0 };
      p.encoders++; p.cost += pct(info.Cost) ?? value(row.values?.[1]) ?? 0; p.ms += msOf(info.Duration) ?? 0;
      for (const [k, v] of Object.entries(info)) {
        const x = pct(v);
        if (x === null) continue;
        if (/Limiter$/.test(k)) p.limiters[k.replace(/ Limiter$/, '')] = (p.limiters[k.replace(/ Limiter$/, '')] ?? 0) + x;
        else if (/Occupancy/.test(k)) p.occupancy[k] = (p.occupancy[k] ?? 0) + x;
      }
      p.n++;
      passes.set(label, p);
    }
    const passList = [...passes.values()].map((p) => ({
      pass: p.pass, kind: p.kind, encoders: p.encoders, cost: p.cost, ms: p.ms,
      limiters: Object.fromEntries(Object.entries(p.limiters).map(([k, v]) => [k, v / p.n]).sort((a, b) => b[1] - a[1])),
      occupancy: Object.fromEntries(Object.entries(p.occupancy).map(([k, v]) => [k, v / p.n])),
    })).sort((a, b) => b.cost - a.cost);
    // shaders: cost and the compiler's numbers (registers, spill, instruction mix)
    const shaders = children(lastJson(s.send('go /performance/shaders'))).slice(0, TOP_SHADERS).map((row) => {
      const info = tryDo(`info ${row.name}`, () => lastJson(s.send(`info /performance/shaders/${row.name}`))) ?? {};
      return { node: row.name, pipeline: passLabel(String(value(row.values?.[1]) ?? '').replace(/^@\w+ /, '')), stage: info.Stage ?? null, cost: pct(info.Cost),
        tempRegisters: +info['Temp registers'] || null, spilledBytes: +info['Spilled bytes'] || 0, instructions: +info.Instructions || null,
        simdGroups: +info['SIMD groups'] || null, mix: Object.fromEntries(['ALU', 'FP32', 'FP16', 'INT32', 'INT16', 'Branch', 'Device loads', 'Texture reads', 'Wait'].filter((k) => k in info).map((k) => [k, +info[k]])) };
    });
    // the costliest draws' heat maps (fragment stage)
    const heatmaps = [];
    const draws = children(lastJson(s.send('go /performance/commands'))).filter((r) => /^draw\d+/.test(r.name)).slice(0, TOP_COMMANDS);
    for (const d of draws) {
      const pipe = passLabel(String(value(d.values?.[1]) ?? '').replace(/^@\w+ /, ''));
      for (const kind of HEATMAPS) {
        const file = path.join(out, `heat-${pipe.replace(/[^\w-]+/g, '_')}-${d.name}-${kind}.png`);
        if (tryDo(`heat map ${d.name} ${kind}`, () => s.send(`go /performance/commands/${d.name}/heatmap/fragment`, `fetch ${kind} --out ${file}`)) !== null && fs.existsSync(file))
          heatmaps.push({ command: d.name, pipeline: pipe, kind, file, cost: value(d.values?.[2]) });
      }
    }
    // counters: every group's children with their averages; the occupancy series kept as JSON
    const counters = {};
    for (const g of children(lastJson(s.send('go /performance/timeline/counters')))) {
      const kids = tryDo(`counters ${g.name}`, () => children(lastJson(s.send(`go /performance/timeline/counters/${g.name}`)))) ?? [];
      counters[value(g.values?.[0]) ?? g.name] = Object.fromEntries(kids.map((k) => [k.name, value(k.values?.[0])]));
      if (OCCUPANCY_GROUPS.includes(g.name)) for (const k of kids) tryDo(`series ${k.name}`, () => s.send(`go /performance/timeline/counters/${g.name}`, `fetch ${k.name} --out ${path.join(out, `counter-${k.name}.json`)}`));
    }
    const summary = { trace, exec, state, passes: passList, shaders, heatmaps, counters, errors };
    fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify(summary, null, 1));
    return summary;
  } finally { s.close(); }
}

/** The capture's printout: per pass and per shader, Apple's own numbers from the serial replay. */
export function captureText(c) {
  const p = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–');
  const lines = [`GPU capture replay (${c.exec}: one pass at a time on the GPU, GPU state ${c.state}; Apple's per-pass numbers, not the frame's overlap):`,
    `  ${'pass'.padEnd(34)} ${'cost'.padStart(5)} ${'ms'.padStart(7)}  occupancy   top limiters`];
  for (const x of c.passes.slice(0, 12)) {
    const occ = x.occupancy['FS Occupancy'] ?? x.occupancy['CS Occupancy'] ?? x.occupancy['Kernel Occupancy'] ?? Object.values(x.occupancy)[0];
    const mgr = x.occupancy['Occupancy Manager Target'];
    lines.push(`  ${x.pass.slice(0, 34).padEnd(34)} ${p(x.cost).padStart(5)} ${(Number.isFinite(x.ms) ? x.ms.toFixed(3) : '–').padStart(7)}  ${p(occ).padStart(4)}${mgr !== undefined && mgr < 1 ? ` (mgr ${p(mgr)})` : ''}   ${Object.entries(x.limiters).slice(0, 3).map(([k, v]) => `${k} ${p(v)}`).join(' · ')}`);
  }
  lines.push(`  ${'shader (pipeline · stage)'.padEnd(40)} ${'cost'.padStart(5)} regs  spill B  instr`);
  for (const sh of c.shaders.slice(0, 8)) lines.push(`  ${`${sh.pipeline} · ${sh.stage ?? '?'}`.slice(0, 40).padEnd(40)} ${p(sh.cost).padStart(5)} ${String(sh.tempRegisters ?? '–').padStart(4)} ${String(sh.spilledBytes).padStart(8)} ${String(sh.instructions ?? '–').padStart(6)}`);
  if (c.heatmaps.length) lines.push(`  heat maps: ${c.heatmaps.map((h) => path.basename(h.file)).join(', ')}`);
  const occ = c.counters?.Occupancy;
  if (occ) lines.push(`  occupancy over the capture: ${Object.entries(occ).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (c.errors.length) lines.push(`  (${c.errors.length} gpudebug errors: ${c.errors.slice(0, 2).join(' | ')})`);
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(`--${k}`); return i < 0 ? null : args[i + 1]; };
  const trace = opt('analyze'), out = opt('out') ?? (trace && path.dirname(trace));
  if (!trace) { console.error('node tools/gpu-capture.mjs --analyze <frame.gputrace> [--out dir] [--exec serial|overlapping] [--reuse]'); process.exit(2); }
  analyzeCapture(trace, out, { exec: opt('exec') ?? 'serial', reuse: args.includes('--reuse') })
    .then((s) => console.log(captureText(s)))
    .catch((e) => { console.error(e instanceof CaptureError ? e.message : e); process.exit(1); });
}
