// A command-counting GPU that does no work: the World CELL path's own JS cost
// (tools/world-cell-cost-cpu-check.mjs, scratch profiles), not its GPU cost. The
// byte-backed fakes (cell-adapter-test-gpu.mjs) execute every copy on the CPU,
// which dominated a profile of the code they host. Only buffers mapped at
// creation get bytes (the code writes them); everything else is a handle.
export class NullGPU {
  constructor() {
    globalThis.GPUBufferUsage ??= { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 256, UNIFORM: 64 };
    globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, STORAGE_BINDING: 8, COPY_SRC: 1, COPY_DST: 2 };
    this.counts = { buffers: 0, textures: 0, submits: 0, commands: 0, dispatches: 0, writes: 0, flushes: 0, bindGroups: 0 };
    this.L = {}; this.open = 0; this.testMode = true;
    const c = this.counts, self = this;
    const encoder = () => ({
      copyTextureToBuffer() { c.commands++; }, copyBufferToTexture() { c.commands++; }, copyTextureToTexture() { c.commands++; },
      copyBufferToBuffer() { c.commands++; }, clearBuffer() { c.commands++; },
      beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() { c.dispatches++; }, end() {} }),
      finish: () => ({}),
    });
    this.queue = {
      writeBuffer() { c.writes++; }, writeTexture() { c.writes++; }, submit() { c.submits++; },
      onSubmittedWorkDone: () => Promise.resolve(),
    };
    this.device = { queue: this.queue, limits: {},
      createBuffer: (d) => this.createBuffer(d), createTexture: (d) => this.createTexture(d),
      createBindGroupLayout: (d) => d, createBindGroup: (d) => { c.bindGroups++; return d; }, createPipelineLayout: (d) => d,
      createShaderModule: (d) => d, createComputePipelineAsync: async (d) => d, createCommandEncoder: encoder, createSampler: (d) => d };
    this.frame = {
      get open() { return self.open > 0; },
      copy() { c.commands++; self.open++; }, clear() { c.commands++; self.open++; },
      direct: () => { self.open++; return encoder(); },
    };
    this.L.EMPTY = this.layout('EMPTY', []);
    this.emptyGroup = this.bindGroup(this.L.EMPTY, [], 'empty');
  }
  createBuffer(d) {
    this.counts.buffers++;
    const bytes = d.mappedAtCreation ? new ArrayBuffer(d.size) : null;
    return { ...d, getMappedRange: () => bytes, unmap() {}, destroy() { this.destroyed = true; }, mapAsync: () => Promise.resolve() };
  }
  createTexture(d) { this.counts.textures++; return { ...d, createView() { return { texture: this }; }, destroy() { this.destroyed = true; } }; }
  layout(name, entries) { return this.L[name] ??= { name, entries }; }
  bindGroup(layout, entries, name) { this.counts.bindGroups++; return { layout, entries, name }; }
  kernel(desc) {
    const self = this;
    // Params pack into one reused view, as the real ring's push does (gpu/params.js
    // ParamRing): a new ArrayBuffer a dispatch cost more than the code it hosts.
    self.paramView ??= new DataView(new ArrayBuffer(64 * 1024));
    return { ...desc, state: 'ready', ready: Promise.resolve(), dispatch(frame, size, opts = {}) { if (opts.params) desc.params?.pack?.(opts.params, self.paramView); self.counts.dispatches++; self.open++; } };
  }
  flush() { if (this.open) { this.counts.flushes++; this.counts.submits++; this.open = 0; } }
  retire(b) { b.destroy?.(); }
}
