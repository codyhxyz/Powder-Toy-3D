// Concrete native reader/submission providers for the owned world transaction.
// No Simulation, private encoder, queue submission, or texture-view unwrapping.
import { uniformStruct } from '../gpu/params.js';
import { FRAME_UNIFORM_FIELDS } from '../shaders/bindings.js';
import { Header } from '../shaders/common.js';
import { VolumeParams } from '../shaders/render.js';
import { WorldSunParams } from '../world/worldSun.js';
import { decodeWorldFeedback, worldFrameValues } from './worldVolume.js';
const FrameUniforms = uniformStruct('FrameUniforms', FRAME_UNIFORM_FIELDS);
const b = (binding, buffer) => ({ binding, resource: { buffer } });

// The final boundary is closed synchronously by record(), after all commands
// and the readback copy. Automatic earlier submits never settle this ticket.
// Producers ALWAYS fence the queue on either submission outcome.
export function createWorldFeedbackProvider(gpu, { book, sunTileCount }) {
  const device = gpu.device ?? gpu, blocked = new Set();
  return Object.freeze({
    get failure() { return blocked.values().next().value?.error ?? null; },
    layout({ tileCount = 0, jobCount = tileCount, sunTileCount: count = sunTileCount } = {}) {
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(jobCount) || jobCount < 0) throw new RangeError('explicit feedback extent');
      const requestWordOffset = book.sunWord;
      const reservedWords = requestWordOffset + Math.ceil(count / 32);
      return Object.freeze({ wordCount: reservedWords + jobCount, reservedWords, requestWordOffset,
        jobStatusWordOffset: reservedWords, decode: words => decodeWorldFeedback(words, book, count) });
    },
    reserve(frame) {
      if (blocked.size) throw new Error('world feedback blocked by recordable graphics-error suffix');
      if (frame !== gpu.frame || frame._passKind === 'render') throw new Error('normal Frame outside render pass required');
      let resolve, reject, recorded = false, status = 'reserved', error = null;
      const submitted = new Promise((a, z) => { resolve = a; reject = z; });
      submitted.catch(() => {});
      return Object.freeze({ submitted, get status() { return status; }, get error() { return error; },
        record(target, buffer, wordCount = buffer.size / 4) {
          if (recorded || target !== frame) throw new Error('final ticket already consumed or foreign Frame');
          recorded = true;
          let staging, encodingError, readResolve, readReject;
          const read = new Promise((a,z) => { readResolve=a; readReject=z; }); read.catch(() => {});
          const retire = () => { if (staging) Promise.resolve(device.queue.onSubmittedWorkDone()).then(() => staging.destroy(), () => staging.destroy()); };
          try {
            if (!Number.isSafeInteger(wordCount) || wordCount < 1 || wordCount*4 > buffer.size) throw new RangeError('feedback readback extent');
            staging = device.createBuffer({ label: 'owned world feedback staging', size: wordCount*4, usage: 9 });
            frame.direct().copyBufferToBuffer(buffer,0,staging,0,wordCount*4);
          } catch (e) { encodingError=e; }
          // Always close the normal boundary, including partial encode errors.
          // This private staging never registers an uncancellable global job.
          try { gpu.flush('world final feedback boundary'); }
          catch (e) {
            error=e;
            if (frame.open) {
              status='blocked'; blocked.add({error,staging,submitted,read});
              // Unknown disposition: do not settle, map, destroy, poll or admit
              // a retry over this still-recordable orphan. Owner must retire
              // graphics before it can reclaim this deliberately retained pin.
              return read;
            }
            status='rejected'; reject(e); readReject(e); retire(); return read;
          }
          status='submitted'; resolve();
          if (encodingError) { readReject(encodingError); retire(); return read; }
          Promise.resolve().then(() => staging.mapAsync(1,0,wordCount*4)).then(() => {
            const words = new Uint32Array(staging.getMappedRange(0,wordCount*4).slice(0));
            staging.unmap(); staging.destroy(); status='complete'; readResolve(words);
          }).catch(e => { error=e; status='failed'; readReject(e); retire(); });
          return read;
        },
      });
    },
  });
}

// One immutable global uniform allocation per input transaction. The owner
// keeps this handle and all passed snapshot/noise/artwork/mesh pins alive until
// the last consumer's final boundary AND queue completion.
export function createWorldLightingInputs(gpu, { atlas, tables, frameValues, physicsOrigin, appearance, external, params = {} }) {
  const device = gpu.device ?? gpu, owned = [];
  let released = false;
  const live = () => { if (released) throw new Error('released world lighting inputs'); };
  const buffer = (label, bytes, usage = 64) => {
    const out = device.createBuffer({ label, size: bytes.byteLength, usage, mappedAtCreation: true });
    try { new Uint8Array(out.getMappedRange()).set(new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength)); out.unmap(); owned.push(out); return out; }
    catch (error) { out.destroy(); throw error; }
  };
  try {
    const values = worldFrameValues(frameValues, physicsOrigin);
    if (appearance) values.sourceAppearance = appearance.uniform;
    const fu = buffer('owned world frame', FrameUniforms.pack(values));
    const headerBytes = new ArrayBuffer(Header.size);
    Header.write(new DataView(headerBytes), 0, { origin: [0, 0, 0] });
    const header = buffer('owned world zero origin', headerBytes);
    const volume = buffer('owned world volume params', VolumeParams.pack(params));
    const linear = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    const repeat = device.createSampler({ minFilter: 'linear', magFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
    const first = snapshot => {
      live();
      // textures() validates snapshot epoch/release even for lean Sun bindings.
      snapshot.textures();
      return [[b(0, tables), b(1, header), b(2, fu), b(3, snapshot.params), b(4, snapshot.book)],
        ['stateA', 'stateB', 'field0', 'field1', 'field2', 'aux'].map((name, binding) => ({ binding, resource: snapshot.views[name] }))];
    };
    return Object.freeze({
      sun(input) { return first(input.atlas); },
      reader(input) {
        live();
        const light = input.sun.bindings();
        const native = { ...external, sunDepth: light.sun1, sunOptical: light.sun0, sourceAppearance: appearance?.view ?? external?.sourceAppearance };
        const groups = input.previousAtlas
          ? atlas.producerBindings(input.atlas, input.previousAtlas, native, input.feedback)
          : input.atlas.bindings(native, input.feedback);
        groups[0] = [...first(input.atlas)[0], { binding: 5, resource: { buffer: input.previousAtlas?.lightBook ?? input.atlas.lightBook } }];
        const packed = new ArrayBuffer(WorldSunParams.size);
        WorldSunParams.write(new DataView(packed), 0, light.params);
        const params = buffer('owned world Sun reader params', packed);
        groups[3] = [b(0, volume), b(1, input.feedback), { binding: 2, resource: linear }, { binding: 3, resource: repeat }, b(4, params), b(5, light.book)];
        return groups;
      },
      release() {
        if (released) return; released = true;
        const retire = () => {
          if (gpu.failure || gpu.pipelines?.failure) return;
          if (gpu.frame.open) { setTimeout(retire,0); return; }
          const drop = () => owned.splice(0).forEach(r => r.destroy());
          Promise.resolve(device.queue.onSubmittedWorkDone()).then(drop,drop);
        };
        queueMicrotask(retire);
      },
    });
  } catch (error) { owned.forEach(r => r.destroy()); throw error; }
}
