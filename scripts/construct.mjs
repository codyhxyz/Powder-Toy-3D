#!/usr/bin/env node
// Construction CLI for coding agents: run construction code headlessly, print the
// physics lint, and write an isometric PNG preview. CPU only: no browser, no GPU.
//
//   npm run construct -- my-thing.js [--size 5] [--seed 1] [--png out.png] [--view 0-3] [--json]
//   npm run construct -- --builtin TREE:oak --png oak.png
//   npm run construct -- --builtins          lint every built-in variant
//   npm run construct -- --prompt            print the AI system prompt
//   npm run construct -- --selftest          run the agent loop against a scripted provider
//
// Construction code is the body of a function that uses the runtime API as
// globals (see docs/constructions.md). Exit code 1 means lint found errors.

import fs from 'node:fs';
import { lint, formatReport } from '../src/constructions/lint.js';
import { buildSystemPrompt } from '../src/ai/prompt.js';
import { runAgent } from '../src/ai/agent.js';
import { scriptedProvider } from '../src/ai/providers.js';
import { BUILDS } from '../src/elements.js';
import { DEFAULT_SIZE, DEFAULT_SEED, DEFAULT_MAX_SPAN, BUILT_IN_KEYS, runCode, pngOf, builtinsSource, builtinCells } from './construct-lib.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));

const size = Number(opt('size', DEFAULT_SIZE));
const seed = Number(opt('seed', DEFAULT_SEED));
const maxSpan = Number(opt('max-span', DEFAULT_MAX_SPAN));


// The agent loop end to end, with no model: a scripted provider first writes a
// tank whose one-cell round wall leaks diagonally, then fixes it, then finishes.
async function selftest() {
  const tank = (band) => `for (let y = 0; y < 6; y++) for (let z = -6; z <= 6; z++) for (let x = -6; x <= 6; x++) {
  const d = Math.hypot(x, z);
  if (d > 5.3) continue;
  put(x, y, z, y === 0 || d > 5.3 - ${band} ? 'GLASS' : 'WATER');
}`;
  const call = (id, name, input) => ({ type: 'tool_call', id, name, input });
  const provider = scriptedProvider([
    [{ type: 'text', text: 'A round glass tank.' }, call('a', 'construct_exec', { code: tank(0.8) })],
    [call('b', 'construct_exec', { code: tank(1.6) })],
    [call('c', 'finish', { name: 'Round tank', description: 'A sealed glass tank of water.' })],
  ]);
  const events = [];
  const result = await runAgent({
    provider, system: buildSystemPrompt({ examples: builtinsSource() }), request: 'a round fish tank',
    exec: async (code) => { const cells = runCode(code); return { cells, report: lint(cells, { maxSpan }) }; },
    onEvent: (e) => events.push(e.type === 'report' ? `report:${e.report.ok ? 'clean' : e.report.issues.map((i) => i.code).join('+')}` : e.type),
  });
  const leakFirst = events.includes('report:leak'), clean = events.includes('report:clean');
  console.log(events.join(' → '));
  console.log(`finished=${result.finished} name="${result.name}" attempt=${result.attempt} errors=${result.report.issues.filter((i) => i.severity === 'error').length}`);
  const pass = leakFirst && clean && result.finished && result.report.ok;
  console.log(pass ? 'selftest passed' : 'selftest FAILED');
  return pass;
}

// Lint every variant of every built-in, one line each.
function lintBuiltins() {
  let failed = 0;
  for (const b of BUILDS.filter((x) => BUILT_IN_KEYS.includes(x.key))) {
    for (const [variant] of b.variants ?? [[undefined]]) {
      const r = lint(builtinCells(b.key, variant, { size, seed }), { maxSpan });
      const tally = (sev) => r.issues.filter((i) => i.severity === sev).map((i) => `${i.code}(${i.count})`).join(' ');
      if (!r.ok) failed++;
      console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${`${b.key}${variant ? `:${variant}` : ''}`.padEnd(20)} ${String(r.cells).padStart(6)} cells  ${r.size.join('×').padEnd(10)} ${tally('error')} ${tally('warning')}`);
    }
  }
  return !failed;
}

// One construction (a file or --builtin): print its lint, optionally draw it.
function checkOne() {
  const spec = opt('builtin');
  if (!spec && !positional[0]) throw new Error('Give a construction file, --builtin KEY[:variant], --builtins, --prompt or --selftest');
  const [key, variant] = spec?.split(':') ?? [];
  const cells = spec ? builtinCells(key, variant, { size, seed }) : runCode(fs.readFileSync(positional[0], 'utf8'), { size, seed });
  const report = lint(cells, { maxSpan });
  console.log(flag('json') ? JSON.stringify(report, null, 2) : formatReport(report));
  const png = opt('png');
  if (png) { fs.writeFileSync(png, pngOf(cells, Number(opt('view', 0)) & 3)); console.log(`Preview written to ${png}`); }
  return report.ok;
}

try {
  if (flag('prompt')) process.stdout.write(buildSystemPrompt({ examples: builtinsSource() }) + '\n');
  else process.exitCode = (flag('selftest') ? await selftest() : flag('builtins') ? lintBuiltins() : checkOne()) ? 0 : 1;
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 2;
}
