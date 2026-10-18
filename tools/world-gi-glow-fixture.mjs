// Fake native resource/ordering/lifetime fixture, NOT shader/GPU execution.
export const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
export function lightingFixture(g = { nx: 64, ny: 128, nz: 64 }) {
  const events = [], buffers = [], textures = [], tickets = [];
  const state = { current: 1, epoch: 1, pins: 0, previousTick: -1, resetSeed: true, missing: false, encodeFailure: false, readFailure: false, historyFailure: false };
  const device = {
    limits: { maxTextureArrayLayers: 256, maxTextureDimension2D: 8192, maxStorageBufferBindingSize: 128 * 1024 ** 2 },
    queue: { submit() { events.push('atlas-submit'); }, onSubmittedWorkDone() { events.push('completion-boundary'); return tickets.at(-1)?.done.promise ?? Promise.resolve(); } },
    createBuffer(desc) { const data = new ArrayBuffer(desc.size); const b = { ...desc, bytes: new Uint8Array(data), words: new Uint32Array(data), dead: false,
      getMappedRange() { return data; }, unmap() {}, destroy() { if (this.dead) throw new Error(`double destroy ${desc.label}`); this.dead = true; events.push(`destroy:${desc.label}`); } }; buffers.push(b); return b; },
    createTexture(desc) { const t = { ...desc, dead: false, createView(options) { return { texture: t, ...options }; }, destroy() { if (t.dead) throw new Error('double texture destroy'); t.dead = true; } }; textures.push(t); return t; },
    createBindGroupLayout(desc) { return desc; }, createPipelineLayout(desc) { return desc; }, createShaderModule(desc) { return desc; },
    async createComputePipelineAsync(desc) { return desc; },
    createBindGroup(desc) {
      const want = desc.layout.entries.map(e => e.binding).sort((a, b) => a - b), got = desc.entries.map(e => e.binding).sort((a, b) => a - b);
      if (JSON.stringify(want) !== JSON.stringify(got)) throw new Error(`native group entries ${got} != ${want}`);
      for (const e of desc.layout.entries) { const b = desc.entries.find(x => x.binding === e.binding).resource.buffer; if (e.buffer && (!b || b.dead || b.size < (e.buffer.minBindingSize ?? 0))) throw new Error('native buffer extent'); }
      return desc;
    },
  };
  const resource = label => device.createBuffer({ label, size: 65536 });
  const borrowed = Array.from({ length: 16 }, (_, i) => device.createBuffer({ label: `borrowed${i}`, size: i === 0 ? 131072 : 65536 }));
  const bindingEntries = [
    Array.from({ length: 6 }, (_, binding) => ({ binding, resource: { buffer: borrowed[binding] } })),
    Array.from({ length: 6 }, (_, binding) => ({ binding, resource: { view: binding } })),
    Array.from({ length: 10 }, (_, binding) => ({ binding, resource: { view: binding } })),
    [0, 1, 2, 3, 4, 5].map(binding => ({ binding, resource: [0, 1, 4, 5].includes(binding) ? { buffer: borrowed[6 + binding] } : { sampler: binding } })),
  ];
  function pass() {
    const groups = []; let pipe;
    return { setPipeline(p) { pipe = p; }, setBindGroup(i, g) { groups[i] = g; }, end() {},
      dispatchWorkgroups(x, y, z) {
        const label = pipe.label; events.push(`dispatch:${label}`);
        if (state.encodeFailure && label === 'world GI gather') throw new Error('partial encoding failure');
        if (label === 'world GI source' || label === 'world GI gather') {
          const entry = b => groups[3].entries.find(e => e.binding === b).resource.buffer;
          const p = entry(7).words, f = entry(1).words;
          const start = label === 'world GI source' ? 0 : p[0], n = label === 'world GI source' ? p[0] : p[1];
          for (let i = start; i < start + n; i++) f[p[2] + i] = state.missing && label === 'world GI gather' ? 3 : 1;
        } else if (label.startsWith('world glow ')) {
          const entry = b => groups[0].entries.find(e => e.binding === b).resource.buffer;
          const p = entry(0).words; entry(3).words[p[20]] = state.missing ? 3 : 1;
        }
      },
    };
  }
  const encoder = { copyBufferToBuffer(src, from, dst, to, size) { events.push('native-copy'); dst.bytes.set(src.bytes.subarray(from, from + size), to); }, clearBuffer(b, offset=0, size=b.size-offset) { events.push('history-seed'); b.bytes.fill(0,offset,offset+size); }, beginComputePass: pass };
  const frame = { direct() { return encoder; }, _command() {}, _commandDone() {}, compute: pass };
  const gpu = { device, frame };
  function publication() {
    state.pins++;
    return Object.freeze({ worldSize: Object.freeze([g.nx, g.ny, g.nz]), epoch: state.epoch,
      source: Object.freeze({ contentToken: state.current, sourceRevision: state.current }),
      field: Object.freeze({ complete: true, publishedToken: `field${state.current}`, sourceRevision: state.current, logicalFieldTick: 17 }),
      dependencySetID: 7, dependencyVersion: state.current,
      previous: Object.freeze({ complete: true, token: `previous${state.previousTick}`, lightingTick: state.previousTick, resetSeed: state.resetSeed,
        recordHistory(f, { destination }) { events.push('previous-history-record'); if (state.historyFailure) throw new Error('history encode failure'); f.direct().clearBuffer(destination); } }),
      release() { state.pins--; },
    });
  }
  const snapshotProvider = { acquire: async () => publication(), isCurrent: p => p.epoch === state.epoch && p.source.contentToken === state.current };
  const emissionProvider = { async acquire({ plan }) {
    const p = publication(), n = plan.input.size.reduce((a, n) => a * n, 1), buffer = resource('borrowed emission');
    // Real provider owns this exact f32 emission allocation; fixture releases it
    // together with its pin, never delegates ownership to the producer.
    return Object.freeze({ ...p, emission: Object.freeze({ buffer, byteOffset: 0, byteLength: n * 16, format: 'xyz-linear-f32-vec4-emission-div64', complete: true, min: plan.input.min, size: plan.input.size }), release() { buffer.destroy(); p.release(); } });
  }, isCurrent: snapshotProvider.isCurrent };
  const submissionProvider = { reserve() {
    const t = { submitted: deferred(), done: deferred(), read: deferred() }; tickets.push(t);
    return { submitted: t.submitted.promise, record(f, buffer, words) { events.push('readback-boundary'); t.buffer = buffer; t.wordCount = words; if (state.readFailure) throw new Error('feedback encoding failure'); t.read.resolve(new Uint32Array(buffer.words.subarray(0, words))); return t.read.promise; } };
  } };
  const typed = 6 * Math.ceil(g.nx / 4 * (g.ny / 4) * (g.nz / 4) / 32) + 1;
  const feedbackProvider = { ...submissionProvider, layout({ jobCount }) { return { reservedWords: typed + 4, jobStatusWordOffset: typed + 4, wordCount: typed + 4 + jobCount, decode() { return { incomplete: false, requirements: state.missing ? [{ index: 99, channels: 8 }] : [] }; } }; } };
  const readerBindingProvider = () => bindingEntries;
  async function complete() { const t = tickets.at(-1); t.submitted.resolve(); await Promise.resolve(); t.done.resolve(); }
  return { g, gpu, device, state, events, buffers, textures, tickets, frame, encoder, snapshotProvider, emissionProvider, feedbackProvider, submissionProvider, readerBindingProvider, complete };
}
