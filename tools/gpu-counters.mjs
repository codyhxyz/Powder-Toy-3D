// Hardware-side GPU facts for one process, from Xcode's Metal System Trace
// (xctrace), per Metal encoder: GPU time per channel (vertex / fragment /
// compute), register spills of the shaders each encoder ran, and whatever GPU
// counters the device streams. docs/profiler.md, "GPU counters", says what
// each field means and what an occupancy or spill problem looks like.
//
// Module (tools/profile.mjs --counters uses it):
//   const c = await startCounters({ pid, seconds });   // recording when it resolves
//   ... drive the page ...
//   const result = await c.stop();   // { byEncoder: [{ label, gpuMs, occupancy, limiters, ... }], summary }
// stop() ends the recording at once (SIGINT) and then parses for a while (the
// trace is CPU work only); a caller may close its browser before awaiting it.
//
// CLI (attaches to a running Chrome GPU process):
//   node tools/gpu-counters.mjs [--pid N | --browser-pid N] [--seconds 4]
//     [--all-processes] [--keep] [--dir DIR] [--json OUT]
//   With no pid it picks the only running Chrome / chrome-headless-shell GPU process.
//
// Labels: Dawn forwards WebGPU pass labels to Metal encoders only with the
// Chrome switch --enable-dawn-features=use_user_defined_labels_in_backend
// (COUNTER_CHROME_ARGS). Without it every encoder is "Compute Command N".
//
// Limits found on the M5 / Xcode 27.1 (2026-10-24): the xctrace CLI streams
// only the "RT Unit Active" counter whatever counter set the template names
// (Performance Limiters, Performance Utilizations...), and Shader Timeline
// records nothing. Occupancy and ALU/texture/memory limiters therefore come
// back null with summary.counterNote saying why; spills and channel times are real.
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const COUNTER_CHROME_ARGS = ['--enable-dawn-features=use_user_defined_labels_in_backend'];

const TEMPLATE = '/Applications/Xcode.app/Contents/Applications/Instruments.app/Contents/Packages/GPU.instrdst/Contents/Templates/Metal System Trace.tracetemplate';
// DTGPUServiceCounterProfile raw values, read off the recorded "Counter Set:" line
// (0 is null, 3 Performance Limiters, 4 Performance Utilizations).
const COUNTER_PROFILE_LIMITERS = 3;
const READY_TIMEOUT_MS = 30000;   // xctrace prints "Ctrl-C to stop" within ~3 s here
const SAVE_TIMEOUT_MS = 180000;   // all-processes: ~45 s to save 3 s of trace on an M5
const EXPORT_TIMEOUT_MS = 180000;
const DEFAULT_SECONDS = 5;
const MAX_SECONDS = 60;
const NS_PER_MS = 1e6;
const DEFAULT_DIR = path.join(os.tmpdir(), 'tpt-gpu-counters');
const TABLES = {
  intervals: 'metal-gpu-intervals',
  encoders: 'metal-application-encoders-list',
  spills: 'graphics-compiler-spill-events',
  counterInfo: 'gpu-counter-info',
  counterValues: 'gpu-counter-value',
  timeInfo: 'time-info',
};

class CountersError extends Error {}
const fail = msg => { throw new CountersError(`gpu-counters: ${msg}`); };

function xctracePath() {
  if (process.platform !== 'darwin') fail('needs macOS with Xcode (xctrace); this is ' + process.platform);
  try {
    return execFileSync('/usr/bin/xcrun', ['--find', 'xctrace'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    fail('xctrace not found. Install Xcode, then run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer');
  }
}

/** The IORegistry id of the GPU (AGXAccelerator...), which the counter instrument targets. */
function acceleratorId() {
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator', '-x'], { encoding: 'utf8', timeout: 5000 });
    const m = /class \w+, id 0x([0-9a-f]+)/.exec(out);
    return m ? parseInt(m[1], 16) : null;
  } catch { return null; }
}

// Metal System Trace with its counter set switched to Performance Limiters and
// pointed at this Mac's GPU (Apple's template names another machine's id). The
// template is an NSKeyedArchiver plist; python3 ships with Xcode's tools.
const PATCH_TEMPLATE = `
import plistlib, sys
src, dst, profile, device = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
p = plistlib.load(open(src, 'rb')); o = p['$objects']
def uid(v): o.append(v); return plistlib.UID(len(o) - 1)
pu = uid(profile); du = uid(int(device)) if device != 'none' else None
for x in list(o):
    if isinstance(x, dict) and 'NS.keys' in x:
        for i, k in enumerate(x['NS.keys']):
            k = o[k.data] if isinstance(k, plistlib.UID) else k
            if k in ('counterprofile', 'counterprofileinternal', 'counterscounterprofile'): x['NS.objects'][i] = pu
            if du is not None and k in ('counterdevice', 'counterdeviceinternal', 'counterscounterdevice'): x['NS.objects'][i] = du
plistlib.dump(p, open(dst, 'wb'), fmt=plistlib.FMT_BINARY)
`;
function makeTemplate(dir, profile) {
  if (!fs.existsSync(TEMPLATE)) fail(`Metal System Trace template missing at ${TEMPLATE}; install the full Xcode (not only the command line tools)`);
  const out = path.join(dir, `counters-${profile}.tracetemplate`);
  try {
    execFileSync('/usr/bin/python3', ['-I', '-c', PATCH_TEMPLATE, TEMPLATE, out, String(profile), String(acceleratorId() ?? 'none')],
      { timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    fail(`could not write the counter template (python3 -I): ${String(e.stderr || e.message).trim().split('\n').pop()}`);
  }
  return out;
}

function processTable() {
  const out = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 5000, maxBuffer: 32 << 20 });
  return out.split('\n').map(l => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .map(m => ({ pid: +m[1], ppid: +m[2], command: m[3] }));
}
const isGpuProcess = p => /--type=gpu-process/.test(p.command) && /chrom|Chrome/i.test(p.command);

/**
 * Chrome's GPU process: the child of `browserPid`, or of a browser whose parent
 * is `parentPid` (a tools/browser.mjs browser is a child of its node process).
 * With neither, the only Chrome GPU process running.
 * @param {{ browserPid?: number, parentPid?: number }} [opts]
 * @returns {number}
 */
export function findGpuProcess({ browserPid, parentPid } = {}) {
  const procs = processTable();
  let gpus = procs.filter(isGpuProcess);
  if (browserPid) gpus = gpus.filter(p => p.ppid === browserPid);
  else if (parentPid) {
    const browsers = new Set(procs.filter(p => p.ppid === parentPid).map(p => p.pid));
    gpus = gpus.filter(p => browsers.has(p.ppid));
  }
  if (gpus.length === 1) return gpus[0].pid;
  if (!gpus.length) fail(`no Chrome GPU process (--type=gpu-process) found${browserPid ? ` under browser ${browserPid}` : parentPid ? ` under node ${parentPid}` : ''}; is the browser running?`);
  fail(`${gpus.length} Chrome GPU processes; pass --pid: ${gpus.map(p => `${p.pid} (parent ${p.ppid})`).join(', ')}`);
}

function otherRecording() {
  return processTable().find(p => p.pid !== process.pid && /^\S*\bxctrace record\b/.test(p.command));
}

const PERMISSION = /not permitted|permission|authoriz|privacy|DevToolsSecurity|developer tools/i;
const ATTACH = /attach|no such process|cannot find process|failed to target|not debuggable|task_for_pid/i;

function record(xctrace, args, log) {
  const child = spawn(xctrace, ['record', ...args, '--no-prompt'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new CountersError(`gpu-counters: xctrace did not start recording within ${READY_TIMEOUT_MS / 1000}s (killed). Output: ${output.trim().slice(-400)}`)); }, READY_TIMEOUT_MS);
    const onData = d => {
      output += d; log?.(String(d).trimEnd());
      if (/Ctrl-C to stop/.test(output)) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.once('error', e => { clearTimeout(timer); reject(new CountersError(`gpu-counters: could not run xctrace: ${e.message}`)); });
    child.once('exit', code => { clearTimeout(timer); reject(Object.assign(new CountersError(`gpu-counters: xctrace exited (${code}) before recording: ${output.trim().slice(-600)}`), { output })); });
  });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  return { child, ready, exited, output: () => output };
}

// ---------- trace export and parsing ----------

// One streaming pass over `xctrace export --xpath` output. Rows reuse earlier
// values by id (`<tag ref="N"/>`), so every element with an id is kept.
function exportTable(xctrace, trace, schema, onRow) {
  return new Promise((resolve, reject) => {
    const xpath = `/trace-toc/run[@number="1"]/data/table[@schema="${schema}"]`;
    const child = spawn(xctrace, ['export', '--input', trace, '--xpath', xpath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new CountersError(`gpu-counters: export of ${schema} timed out`)); }, EXPORT_TIMEOUT_MS);
    const ids = new Map();
    let cols = null, buf = '', err = '', rows = 0;
    child.stderr.on('data', d => { err += d; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      if (!cols) {
        const end = buf.indexOf('</schema>');
        if (end < 0) return;
        cols = [...buf.slice(0, end).matchAll(/<mnemonic>([^<]*)<\/mnemonic>/g)].map(m => m[1]);
        buf = buf.slice(end + 9);
      }
      let at = 0;
      for (;;) {
        const s = buf.indexOf('<row>', at);
        if (s < 0) break;
        const e = buf.indexOf('</row>', s);
        if (e < 0) { at = s; break; }
        onRow(parseRow(buf.slice(s + 5, e), cols, ids)); rows++;
        at = e + 6;
      }
      buf = buf.slice(at);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new CountersError(`gpu-counters: export of ${schema} failed (${code}): ${err.trim().slice(-300)}`));
      else resolve(rows);
    });
  });
}

const TOKEN = /<(\/?)([\w-]+)((?:\s+[\w-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
const ATTR = /([\w-]+)="([^"]*)"/g;
const unescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
// A row's top-level elements, one per column: { tag, fmt, text, kids }.
function parseRow(xml, cols, ids) {
  const top = [], stack = [];
  for (const m of xml.matchAll(TOKEN)) {
    if (m[5] !== undefined) { if (stack.length) stack.at(-1).text += unescape(m[5]); continue; }
    if (m[1]) { const node = stack.pop(); if (!stack.length) top.push(node); continue; }
    const attrs = Object.fromEntries([...m[3].matchAll(ATTR)].map(a => [a[1], unescape(a[2])]));
    let node;
    if (attrs.ref) node = ids.get(attrs.ref) ?? { tag: m[2], fmt: '', text: '', kids: [] };
    else {
      node = { tag: m[2], fmt: attrs.fmt ?? '', text: '', kids: [] };
      if (attrs.id) ids.set(attrs.id, node);
    }
    if (stack.length) stack.at(-1).kids.push(node);
    if (m[4] || attrs.ref) { if (!stack.length) top.push(node); } else stack.push(node);
  }
  const row = {};
  cols.forEach((c, i) => { row[c] = top[i] ?? null; });
  return row;
}
const pidOf = node => {
  if (!node) return null;
  const p = node.tag === 'pid' ? node : node.kids.find(k => k.tag === 'pid');
  return p ? Number(p.text) : null;
};
const num = node => (node ? Number(node.text) : NaN);

async function parseTrace(xctrace, trace, pid) {
  // encoder id -> its label and kind, from the app-side encoder list
  const encoders = new Map();
  await exportTable(xctrace, trace, TABLES.encoders, r => {
    if (pid && pidOf(r.process) !== pid) return;
    const id = r['encoder-id']?.text;
    if (id) encoders.set(id, { label: r['encoder-label']?.fmt || '', cmdbuffer: r['cmdbuffer-label']?.fmt || '' });
  });
  // GPU work per encoder per channel
  const work = new Map(); // encoder id -> { channels: {name: ns}, spans: [[start,end]], label }
  let first = Infinity, last = -Infinity;
  await exportTable(xctrace, trace, TABLES.intervals, r => {
    if (pid && pidOf(r.process) !== pid) return;
    const id = r['encoder-id']?.text; if (!id) return;
    const start = num(r.start), dur = num(r.duration), ch = r['channel-name']?.fmt || '?';
    if (!Number.isFinite(start) || !Number.isFinite(dur)) return;
    let w = work.get(id);
    if (!w) {
      // "CommandBuffer:Encoder  (process (pid)) 0xid": the label part as a fallback
      const raw = r['event-label']?.kids.find(k => k.tag === 'string')?.text ?? '';
      work.set(id, w = { channels: {}, spans: [], fallback: raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw });
    }
    w.channels[ch] = (w.channels[ch] ?? 0) + dur;
    w.spans.push([start, start + dur]);
    first = Math.min(first, start); last = Math.max(last, start + dur);
  });
  // compiler register spills reported per encoder (one event per spilling pipeline use)
  const spills = new Map();
  await exportTable(xctrace, trace, TABLES.spills, r => {
    if (pid && pidOf(r.process) !== pid) return;
    const id = r['encoder-id']?.text; const bytes = num(r['spilled-bytes']);
    if (!id || !Number.isFinite(bytes)) return;
    const s = spills.get(id) ?? { events: 0, total: 0, max: 0 };
    s.events++; s.total += bytes; s.max = Math.max(s.max, bytes);
    spills.set(id, s);
  });
  // counters: names, then values attributed to the encoder running when sampled
  const counterNames = new Map();
  await exportTable(xctrace, trace, TABLES.counterInfo, r => {
    counterNames.set(r['counter-id']?.text, { name: r.name?.fmt || r.name?.text, description: r.description?.text, type: r.type?.text });
  });
  let epochNs = 0;
  await exportTable(xctrace, trace, TABLES.timeInfo, r => {
    const tb = r['timebase-info']?.kids.map(k => Number(k.text)) ?? [1, 1];
    epochNs = num(r['mabs-epoch']) * (tb[0] / (tb[1] || 1));
  });
  const spans = [];
  for (const [id, w] of work) for (const [s, e] of w.spans) spans.push([s, e, id]);
  spans.sort((a, b) => a[0] - b[0]);
  const findEncoder = t => { // binary search: last span starting at or before t that covers it
    let lo = 0, hi = spans.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (spans[mid][0] <= t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    for (let i = best; i >= 0 && i > best - 8; i--) if (spans[i][1] >= t) return spans[i][2];
    return null;
  };
  const counterTotals = new Map(); // counter id -> { all: [sum, n, max], byEncoder: Map(id -> [sum, n]) }
  let samples = 0;
  // the value table is ~300k rows/s; read it only when a counter worth attributing exists
  if ([...counterNames.values()].some(c => USEFUL_COUNTER.test(c.name))) {
    await exportTable(xctrace, trace, TABLES.counterValues, r => {
      const cid = r['counter-id']?.text, v = num(r.value);
      if (!Number.isFinite(v)) return;
      samples++;
      const t = num(r.timestamp) - epochNs;
      let c = counterTotals.get(cid);
      if (!c) counterTotals.set(cid, c = { all: [0, 0, -Infinity], byEncoder: new Map() });
      c.all[0] += v; c.all[1]++; c.all[2] = Math.max(c.all[2], v);
      const enc = t >= first && t <= last ? findEncoder(t) : null;
      if (enc) { const e = c.byEncoder.get(enc) ?? [0, 0]; e[0] += v; e[1]++; c.byEncoder.set(enc, e); }
    });
  }
  return { encoders, work, spills, counterNames, counterTotals, samples, windowNs: last > first ? last - first : 0 };
}

const LIMITER_NAMES = /limiter|utilization/i;
export const DAWN_PREFIX = /^Dawn_(?:Compute|Render)PassEncoder_?/;
const USEFUL_COUNTER = /limiter|utilization|occupancy|bandwidth|spill|cache|miss/i;
const OCCUPANCY_NAMES = /occupancy/i;

function summarize({ encoders, work, spills, counterNames, counterTotals, samples, windowNs }, meta) {
  const groups = new Map();
  for (const [id, w] of work) {
    const e = encoders.get(id);
    // Dawn names a labelled encoder "Dawn_ComputePassEncoder_<WebGPU label>"
    const label = (e?.label || w.fallback || `encoder ${id}`).replace(DAWN_PREFIX, '') || '(unlabelled)';
    const g = groups.get(label) ?? { label, count: 0, totalNs: 0, channels: {}, spillEvents: 0, spilledBytesMax: 0, spilledBytesPerEncoder: 0, ids: [] };
    g.count++; g.ids.push(id);
    let busy = 0;
    for (const [ch, ns] of Object.entries(w.channels)) { g.channels[ch] = (g.channels[ch] ?? 0) + ns; busy = Math.max(busy, ns); }
    // vertex and fragment of one render encoder overlap on a tiler: count the longer one
    g.totalNs += busy;
    const s = spills.get(id);
    if (s) { g.spillEvents += s.events; g.spilledBytesMax = Math.max(g.spilledBytesMax, s.max); g.spilledBytesPerEncoder = Math.max(g.spilledBytesPerEncoder, s.total); }
    groups.set(label, g);
  }
  const counterList = [...counterNames.entries()].map(([id, c]) => {
    const t = counterTotals.get(id);
    return { id, ...c, mean: t?.all[1] ? t.all[0] / t.all[1] : null, max: t?.all[1] ? t.all[2] : null };
  });
  const usable = counterList.filter(c => c.max);
  const byEncoder = [...groups.values()].map(g => {
    const counters = {};
    for (const c of usable) {
      let sum = 0, n = 0;
      for (const id of g.ids) { const v = counterTotals.get(c.id)?.byEncoder.get(id); if (v) { sum += v[0]; n += v[1]; } }
      if (n) counters[c.name] = sum / n;
    }
    const limiters = Object.fromEntries(Object.entries(counters).filter(([k]) => LIMITER_NAMES.test(k)));
    const occ = Object.entries(counters).filter(([k]) => OCCUPANCY_NAMES.test(k));
    return {
      label: g.label,
      count: g.count,
      gpuMs: g.totalNs / g.count / NS_PER_MS,      // mean per encoder (≈ per frame for once-a-frame passes)
      totalMs: g.totalNs / NS_PER_MS,
      channels: Object.fromEntries(Object.entries(g.channels).map(([k, ns]) => [k, ns / g.count / NS_PER_MS])),
      spills: g.spillEvents ? { bytesMax: g.spilledBytesMax, bytesPerEncoder: g.spilledBytesPerEncoder, pipelinesPerEncoder: g.spillEvents / g.count } : null,
      occupancy: occ.length ? Object.fromEntries(occ) : null,
      limiters,
      counters,
    };
  }).sort((a, b) => b.totalMs - a.totalMs);
  const busyMs = byEncoder.reduce((s, e) => s + e.totalMs, 0);
  const windowMs = windowNs / NS_PER_MS;
  return {
    byEncoder,
    summary: {
      ...meta,
      windowMs,
      gpuBusyMs: busyMs,
      encoders: work.size,
      labelled: [...encoders.values()].some(e => DAWN_PREFIX.test(e.label) && e.label.replace(DAWN_PREFIX, '')),
      top: byEncoder.slice(0, 5).map(e => ({ label: e.label, gpuMs: +e.gpuMs.toFixed(3), shareOfGpu: busyMs ? +(e.totalMs / busyMs).toFixed(3) : null })),
      spilling: byEncoder.filter(e => e.spills).sort((a, b) => b.spills.bytesMax - a.spills.bytesMax).slice(0, 10)
        .map(e => ({ label: e.label, bytesMax: e.spills.bytesMax, bytesPerEncoder: e.spills.bytesPerEncoder, gpuMs: +e.gpuMs.toFixed(3) })),
      counters: counterList.map(c => ({ name: c.name, mean: c.mean, max: c.max })),
      counterSamples: samples,
      counterNote: usable.some(c => LIMITER_NAMES.test(c.name) || OCCUPANCY_NAMES.test(c.name)) ? null
        : `This Mac's xctrace streamed ${counterList.length ? 'only ' + counterList.map(c => `"${c.name}"`).join(', ') : 'no GPU counters'}`
          + ': no occupancy or limiter counters, though the template asked for Performance Limiters. Use Instruments.app'
          + ' (Metal System Trace, GPU > Counter Set: Performance Limiters) or an Xcode GPU capture for those; spills and channel times above are real.',
    },
  };
}

// ---------- public API ----------

/**
 * Starts a Metal System Trace of `pid` (Chrome's GPU process). Resolves once
 * xctrace is recording. Attaches to the pid; if macOS refuses (hardened
 * runtime), records all processes and keeps only that pid's rows.
 * @param {{ pid: number, seconds?: number, dir?: string, keep?: boolean, allProcesses?: boolean, log?: (line: string) => void }} opts
 * @returns {Promise<{ pid: number, mode: string, trace: string, stop: () => Promise<{ byEncoder: object[], summary: object }> }>}
 */
export async function startCounters({ pid, seconds = DEFAULT_SECONDS, dir = process.env.TPT_XCTRACE_DIR || DEFAULT_DIR, keep = false, allProcesses = false, log } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) fail('startCounters needs { pid } of the Chrome GPU process (findGpuProcess() finds it)');
  if (!(seconds > 0 && seconds <= MAX_SECONDS)) fail(`seconds must be in (0, ${MAX_SECONDS}]`);
  const xctrace = xctracePath();
  try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') fail(`process ${pid} is not running`); }
  const busy = otherRecording();
  if (busy) fail(`another xctrace recording is running (pid ${busy.pid}); only one GPU trace at a time. Wait for it or stop it.`);
  fs.mkdirSync(dir, { recursive: true });
  const template = makeTemplate(dir, COUNTER_PROFILE_LIMITERS);
  const trace = path.join(dir, `gpu-${pid}-${Date.now()}.trace`);
  // the hard limit is a backstop: stop() normally ends the recording first
  const common = ['--template', template, '--output', trace, '--time-limit', `${Math.ceil(seconds)}s`];
  let mode = allProcesses ? 'all-processes' : 'attach';
  let rec = record(xctrace, [...common, ...(allProcesses ? ['--all-processes'] : ['--attach', String(pid)])], log);
  try {
    await rec.ready;
  } catch (e) {
    const out = e.output ?? '';
    if (PERMISSION.test(out)) fail(`xctrace was refused permission: ${out.trim().slice(-300)}\nRun "sudo DevToolsSecurity -enable", allow your terminal under System Settings > Privacy & Security > Developer Tools, then retry.`);
    if (mode === 'attach' && ATTACH.test(out)) {
      fs.rmSync(trace, { recursive: true, force: true });
      mode = 'all-processes';
      log?.(`gpu-counters: attach to ${pid} refused (${out.trim().split('\n').pop()}); recording all processes, filtered to ${pid}`);
      rec = record(xctrace, [...common, '--all-processes'], log);
      await rec.ready;
    } else throw e;
  }
  const kill = () => { try { rec.child.kill('SIGKILL'); } catch {} };
  process.once('exit', kill);
  const startedAt = Date.now();
  let stopping = null;
  const stop = () => stopping ??= (async () => {
    if (rec.child.exitCode === null) rec.child.kill('SIGINT');
    const saved = await Promise.race([rec.exited, new Promise(r => setTimeout(r, SAVE_TIMEOUT_MS, 'timeout'))]);
    if (saved === 'timeout') { kill(); fail(`xctrace did not finish saving within ${SAVE_TIMEOUT_MS / 1000}s (killed)`); }
    process.off('exit', kill);
    const recordedMs = Date.now() - startedAt;
    try {
      if (!fs.existsSync(trace)) fail(`xctrace saved no trace (exit ${saved}): ${rec.output().trim().slice(-400)}`);
      // Metal tables are system-wide even when attached: always keep only this pid
      const parsed = await parseTrace(xctrace, trace, pid);
      return summarize(parsed, { pid, mode, recordedMs, trace: keep ? trace : null, device: os.cpus()[0]?.model });
    } finally {
      if (!keep) fs.rmSync(trace, { recursive: true, force: true });
      fs.rmSync(template, { force: true });
    }
  })();
  return { pid, mode, trace, stop };
}

// ---------- CLI ----------

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
  const main = async () => {
    const pid = opt('pid') ? Number(opt('pid')) : findGpuProcess({ browserPid: opt('browser-pid') ? Number(opt('browser-pid')) : undefined });
    const seconds = Number(opt('seconds', DEFAULT_SECONDS));
    const c = await startCounters({ pid, seconds, dir: opt('dir'), keep: args.includes('--keep'), allProcesses: args.includes('--all-processes'), log: l => console.error(l) });
    console.error(`recording GPU process ${pid} (${c.mode}) for ${seconds}s...`);
    const onSig = () => c.stop();
    process.once('SIGINT', onSig);
    await new Promise(r => setTimeout(r, seconds * 1000));
    const result = await c.stop();
    const json = opt('json');
    if (json) fs.writeFileSync(json, JSON.stringify(result, null, 2));
    printReport(result);
  };
  main().catch(e => { console.error(e instanceof CountersError ? e.message : e); process.exit(1); });
}

export function printReport({ byEncoder, summary }) {
  const ms = v => (v == null ? '-' : v.toFixed(3));
  console.log(`GPU counters: pid ${summary.pid} (${summary.mode}), ${summary.encoders} encoders over ${ms(summary.windowMs)} ms, GPU busy ${ms(summary.gpuBusyMs)} ms${summary.labelled ? '' : ' — encoders unlabelled: add ' + COUNTER_CHROME_ARGS.join(' ')}`);
  console.log('label'.padEnd(36), 'count'.padStart(6), 'gpuMs'.padStart(9), 'vertex'.padStart(8), 'fragment'.padStart(9), 'compute'.padStart(8), 'spill B'.padStart(8));
  for (const e of byEncoder.slice(0, 25)) {
    console.log(e.label.slice(0, 36).padEnd(36), String(e.count).padStart(6), ms(e.gpuMs).padStart(9),
      ms(e.channels.Vertex).padStart(8), ms(e.channels.Fragment).padStart(9), ms(e.channels.Compute).padStart(8),
      String(e.spills?.bytesMax ?? '').padStart(8));
  }
  if (summary.counterNote) console.log(`note: ${summary.counterNote}`);
}
