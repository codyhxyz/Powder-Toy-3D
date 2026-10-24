// tools/check-wgsl.mjs's page: Tint validation of module text (a) and timed
// pipeline creation (b) on this page's device, which has our requested limits
// (8 storage buffers, 4 storage textures), so a layout that fits SwiftShader's
// 10 but not a user's 8 fails here. Raw device calls, not gpu.kernel: a
// failure is a result to report, not a reason to stop graphics.

import { compilationInfo, withVisibility, hoistDirectives } from '/src/gpu/index.js';
import { boot, ready, test } from './harness.js';

const h = await boot({ label: 'check-wgsl' });
const device = h.gpu.device;
const PARAMS = [
  { binding: 0, buffer: { type: 'uniform', hasDynamicOffset: true } },
  { binding: 1, buffer: { type: 'uniform', hasDynamicOffset: true } },
];

const messages = (info) => info.messages.map((m) => ({ type: m.type, line: m.lineNum, col: m.linePos, text: m.message }));

// (a) every distinct module text: errors and warnings, Tint's time
test('validate', async (items) => {
  const out = [];
  for (const { key, code } of items) {
    const t0 = performance.now();
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ label: key, code: hoistDirectives(code) });
    const scope = await device.popErrorScope();
    const info = await compilationInfo(module);
    out.push({ key, ms: performance.now() - t0, messages: messages(info), scope: scope?.message ?? null });
  }
  return out;
});

// group layouts: entry arrays, or 'EMPTY' / 'PARAMS'; group 3 is PARAMS unless given
function groupLayouts(groups, label) {
  const g = [...groups];
  while (g.length < 4) g.push(undefined);
  g[3] ??= 'PARAMS';
  return g.map((entries, i) => {
    const list = entries === 'PARAMS' ? PARAMS : entries === 'EMPTY' || !entries ? [] : entries;
    return device.createBindGroupLayout({ label: `${label} group ${i}`, entries: list.map(withVisibility) });
  });
}

// (b) one pipeline: its creation time against the budget
test('build', async (item, budgetMs) => {
  const t0 = performance.now();
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ label: item.name, code: hoistDirectives(item.code) });
  const layouts = groupLayouts(item.groups, item.name);
  const layout = device.createPipelineLayout({ label: item.name, bindGroupLayouts: layouts });
  const setup = await device.popErrorScope();
  const validateMs = performance.now() - t0;
  if (setup) {
    const info = await compilationInfo(module);
    return { status: 'error', validateMs, ms: 0, message: [setup.message, ...messages(info).map((m) => `${m.line}:${m.col} ${m.text}`)].join('\n') };
  }
  const constants = item.constants ?? {};
  const t1 = performance.now();
  const pipeline = item.kind === 'render'
    ? device.createRenderPipelineAsync({
      label: item.name, layout,
      vertex: { module, entryPoint: item.vertex?.entry ?? 'vs', buffers: item.vertex?.buffers ?? [], constants },
      ...(item.fragment === null ? {} : { fragment: { module, entryPoint: item.fragment?.entry ?? 'fs', targets: item.fragment?.targets ?? [], constants } }),
      primitive: item.primitive ?? { topology: 'triangle-list' },
      ...(item.depthStencil ? { depthStencil: item.depthStencil } : {}),
      ...(item.multisample ? { multisample: item.multisample } : {}),
    })
    : device.createComputePipelineAsync({ label: item.name, layout, compute: { module, entryPoint: item.entry ?? 'main', constants } });
  let timer;
  const result = await Promise.race([
    pipeline.then(() => ({ status: 'ok' }), (e) => ({ status: 'error', message: e.message })),
    new Promise((r) => { timer = setTimeout(() => r({ status: 'timeout' }), budgetMs); }),
  ]);
  clearTimeout(timer);
  const ms = performance.now() - t1;
  if (result.status !== 'ok') await new Promise((r) => setTimeout(r, 100));   // a loss reports a moment later
  if (h.gpu.lost) return { status: 'lost', validateMs, ms, message: h.failures.at(-1) ?? 'device lost' };
  return { ...result, validateMs, ms };
});

ready();
