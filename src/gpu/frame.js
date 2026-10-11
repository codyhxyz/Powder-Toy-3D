// The frame model (docs/webgpu.md B3, W8): at most one open command encoder,
// gpu.frame, that every module records into. Modules never create encoders
// and never call queue.submit; the frame submits on flush.
//
//   const f = gpu.frame;                      // opens an encoder lazily
//   kernel.dispatch(f, size, { bind, header, params });   // into f.compute()
//   const rp = f.render(descriptor, 'scene'); // ends an open compute pass, begins a render pass
//   pipe.draw(rp, { bind });  rp.end();
//   gpu.flush('before three');                // finish + submit
//   gpu.endFrame();                           // flush, then count the frame in flight
//
// Work recorded outside a tick (tools calling sim.step(), promise callbacks)
// is flushed by a microtask the first record schedules: a synchronous tick
// flushes in endFrame first, so then the microtask finds nothing to do. A
// frame that has recorded FLUSH_DISPATCHES commands, or whose params ring is
// nearly full, flushes before the next one, so test.step(10000) becomes a few
// hundred-step submits and the ring never overflows. Inside a render pass
// nothing flushes: the pass couldn't be resumed without reloading its
// attachments.

import { FLUSH_DISPATCHES, ParamRing, PARAM_SLOT } from './params.js';

/** Ring bytes kept free for a render pass's draws: a pass begins on a flushed frame when fewer are left. */
export const RING_RESERVE = 64 * 1024;

/** The open command encoder and its passes. Reach it through gpu.frame. */
export class GpuFrame {
  /** @param {object} gpu */
  constructor(gpu) {
    this.gpu = gpu;
    /** @type {GPUCommandEncoder | null} */
    this.encoder = null;
    this._pass = null;
    this._passKind = null;
    this._passName = null;
    /** dispatches and draws recorded since the last flush */
    this.commands = 0;
    this._reads = new Set();
    this._scheduled = false;
    this._flushNo = 0;
    this._submitsAtEnd = 0;
    this._last = '';
  }

  /** True while an encoder holds commands not yet submitted. */
  get open() { return this.encoder !== null; }

  // The encoder, opened on first use; the first record schedules the microtask flush.
  _encoder() {
    if (!this.encoder) {
      const gpu = this.gpu;
      this.encoder = gpu.device.createCommandEncoder({ label: `${gpu.label} frame ${gpu.frameNo}.${this._flushNo}` });
      if (!this._scheduled) {
        this._scheduled = true;
        queueMicrotask(() => {
          this._scheduled = false;
          if (!this.encoder) return;
          if (this._passKind === 'render') {
            console.warn(`gpu: render pass "${this._passName}" left open past its task; not flushed`);
            return;
          }
          this.flush('outside a tick');
        });
      }
    }
    return this.encoder;
  }

  /**
   * The open compute pass, whatever its name, or a new one named `name` (its
   * label and its name in gpu.timing.last). A dispatch with no pass open
   * begins one named after its kernel. In split mode (the profiler, with
   * timing on) every dispatch gets its own pass, named after its kernel.
   * @param {string} [name] the pass's label and profiler name
   * @param {{ dispatch?: boolean }} [opts] internal: the caller is a dispatch
   * @returns {GPUComputePassEncoder}
   */
  compute(name = 'compute', opts) {
    const timing = this.gpu.timing;
    if (this._passKind === 'compute' && !(opts?.dispatch && timing.split && timing.enabled)) return this._pass;
    if (this._passKind === 'render') throw new Error(`gpu.frame.compute("${name}") while render pass "${this._passName}" is open`);
    this._endPass();
    const desc = { label: name };
    const writes = timing._writes(name);
    if (writes) desc.timestampWrites = writes;
    this._pass = this._encoder().beginComputePass(desc);
    this._passKind = 'compute';
    this._passName = name;
    this.gpu.stats.computePasses++;
    return this._pass;
  }

  /**
   * Ends any open compute pass and begins a render pass. Draw into it with
   * renderPipeline.draw(rp, …); rp.end() returns to the frame.
   * @param {GPURenderPassDescriptor} descriptor
   * @param {string} [name] the pass's label and profiler name
   * @returns {GPURenderPassEncoder & { frame: GpuFrame, passName: string }}
   */
  render(descriptor, name = 'render') {
    if (this._passKind === 'render') throw new Error(`gpu.frame.render("${name}") while render pass "${this._passName}" is open`);
    this._endPass();
    if (this.commands >= FLUSH_DISPATCHES || this.gpu.paramRing.free < RING_RESERVE) this.gpu.flush('params ring');
    const timing = this.gpu.timing;
    const writes = timing._writes(name);
    const rp = this._encoder().beginRenderPass({ label: name, ...descriptor, ...(writes ? { timestampWrites: writes } : {}) });
    const end = rp.end.bind(rp);
    rp.frame = this;
    rp.passName = name;
    rp.end = () => {
      if (this._pass === rp) { this._pass = null; this._passKind = null; this._passName = null; }
      end();
    };
    this._pass = rp;
    this._passKind = 'render';
    this._passName = name;
    this.gpu.stats.renderPasses++;
    return rp;
  }

  /**
   * The encoder outside any pass, for copies, clears and query resolves: ends
   * an open compute pass (a render pass must be ended by its owner first).
   * @returns {GPUCommandEncoder}
   */
  direct() {
    if (this._passKind === 'render') throw new Error(`a copy recorded while render pass "${this._passName}" is open`);
    this._endPass();
    return this._encoder();
  }

  /**
   * Records copyBufferToBuffer now (ending an open compute pass).
   * @param {GPUBuffer} src
   * @param {number} srcOffset
   * @param {GPUBuffer} dst
   * @param {number} dstOffset
   * @param {number} size bytes, a multiple of 4
   */
  copy(src, srcOffset, dst, dstOffset, size) {
    this.direct().copyBufferToBuffer(src, srcOffset, dst, dstOffset, size);
  }

  /**
   * Records clearBuffer now (zeros; ending an open compute pass).
   * @param {GPUBuffer} buffer
   * @param {number} [offset]
   * @param {number} [size]
   */
  clear(buffer, offset = 0, size = buffer.size - offset) {
    this.direct().clearBuffer(buffer, offset, size);
  }

  _endPass() {
    const p = this._pass;
    if (!p) return;
    this._pass = null;
    this._passKind = null;
    this._passName = null;
    p.end();
  }

  // Before a dispatch or draw: flush a full frame, unless a render pass is open.
  _command() {
    if (this._passKind === 'render') {
      if (this.gpu.paramRing.free < 2 * PARAM_SLOT) throw new Error(`render pass "${this._passName}" ran out of params ring (${RING_RESERVE} bytes kept for a pass)`);
      return;
    }
    if (this.commands >= FLUSH_DISPATCHES || this.gpu.paramRing.free < RING_RESERVE) this.gpu.flush('params ring');
  }

  // After a dispatch or draw. With ?gpudebug=1 a compute command is flushed
  // alone, inside an error scope, so a validation error names its kernel
  // (encoding errors only surface at finish(), so a scope around the call
  // itself would catch nothing).
  _commandDone(name) {
    this.commands++;
    this._last = name;
    if (this.gpu.debug && this._passKind !== 'render') this.gpu.flush(`debug ${name}`);
  }

  // The params group and offsets for one command: the header's slot and the params' slot.
  _params(header, struct, values, name) {
    if (!struct && values && Object.keys(values).length) throw new Error(`${name}: params given, but it declares no params struct`);
    const ring = this.gpu.paramRing;
    const h = ring.header(header);
    const p = ring.push(struct, values);
    if (h < 0 || p < 0) throw new Error(`${name}: the params ring is full`);
    return { group: this.gpu._paramsGroup(struct ? ParamRing.slots(struct.size) : PARAM_SLOT), offsets: [h, p] };
  }

  // A bind group a command binds: remember the shared uniforms it reads.
  _noteGroup(group) {
    const reads = this.gpu._groupReads.get(group);
    if (reads) for (const u of reads) this._reads.add(u);
  }

  /**
   * True when the open encoder holds a command that reads these shared uniforms.
   * @param {object} uniforms a SharedUniforms
   */
  readsUniforms(uniforms) { return this.encoder !== null && this._reads.has(uniforms); }

  /**
   * Finishes and submits the open encoder (nothing when none is open): the
   * readback rings' copies and the timestamp resolves are recorded first, the
   * params ring is uploaded, and staging buffers are mapped after the submit.
   * @param {string} [reason] for the debug error text
   * @returns {boolean} whether anything was submitted
   */
  flush(reason = 'flush') {
    if (!this.encoder) return false;
    if (this._passKind === 'render') throw new Error(`gpu.flush (${reason}) while render pass "${this._passName}" is open`);
    this._endPass();
    const gpu = this.gpu;
    const enc = this.encoder;
    gpu.timing._beforeSubmit(enc);
    gpu.readback._beforeSubmit(enc);
    gpu.stats.bytesUploaded += gpu.paramRing.upload(gpu.queue);
    this.encoder = null;
    this.commands = 0;
    this._reads.clear();
    this._flushNo++;
    const last = this._last;
    if (gpu.debug) gpu.device.pushErrorScope('validation');
    gpu.queue.submit([enc.finish()]);
    if (gpu.debug) {
      gpu.device.popErrorScope().then((e) => {
        if (e) gpu.fail(new Error(`GPU validation error in ${reason} (last command: ${last}): ${e.message}`));
      }, () => {});
    }
    gpu.readback._afterSubmit();
    return true;
  }

  /**
   * Ends a presented (or derived-only) tick: flushes, counts the frame in
   * flight until the queue has done its work (gpu.inFlight), and closes the
   * timing frame. A tick that submitted nothing adds nothing in flight.
   */
  endFrame() {
    const gpu = this.gpu;
    this.flush('end of frame');
    gpu.frameNo++;
    if (gpu.stats.submits !== this._submitsAtEnd) {
      this._submitsAtEnd = gpu.stats.submits;
      gpu.inFlight++;
      gpu.queue.onSubmittedWorkDone().then(() => { gpu.inFlight--; }, () => { gpu.inFlight--; });
    }
    gpu.timing._endFrame(gpu.frameNo);
  }
}
