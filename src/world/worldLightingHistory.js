// World-owned GI clock/packed-history attachments. Does not generate cold
// history, mutate physics, or advance on allocation/draw/ownership transfers.
import { GI_BG_EVERY, GI_SRC_EVERY, GI_SETTLE } from '../shaders/gi.js';
import { GI_NEAR_DILATE, GI_RECENT } from '../shaders/fields.js';
import { uint, frozenArray, worldLightingIndex } from '../gfx/worldLightingBatch.js';
const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const copyLamp = l => ({ pos: Array.from(l.pos, Math.fround), col: Array.from(l.col, Math.fround), shape: Array.from(l.shape, Math.fround) });
const lampEqual = (a, b) => !!a && !!b && ['pos', 'col', 'shape'].every(k => same(a[k], b[k]));

/** Pure original giSelect policy. Inputs must be actual world age/matter/near
 * declarations, not physics-distance tiers. Unknown ages/matter are rejected.
 */
export function selectWorldGI({ records, lightingTick, mode = 0, settle = 0, lampSpheres = [], allSources = false }) {
  if (!uint(lightingTick) || ![0, 1, 2].includes(mode) || !uint(settle)) throw new TypeError('world GI selection clock/mode');
  const sourceBricks = [], gatherBricks = [];
  for (const r of records) {
    if (!Array.isArray(r.brick) || r.brick.length !== 3 || r.brick.some(n => !uint(n)) || !uint(r.age) || typeof r.matter !== 'boolean' || typeof r.near !== 'boolean') throw new TypeError('complete world GI age/matter/near record required');
    const [x, y, z] = r.brick, board = ((x + y + z + lightingTick % 2) & 1) === 1;
    const lampNear = lampSpheres.some(s => { const d = s.pos.map((v, k) => v - Math.max(r.brick[k] * 4, Math.min(r.brick[k] * 4 + 4, v))); return d.reduce((a, v) => a + v * v, 0) <= s.radius * s.radius; });
    const near = r.near || lampNear;
    let source, probe, background = false;
    if (mode === 2) { source = true; probe = true; }
    else if (mode !== 0 || settle !== 0) { source = true; probe = board; }
    else {
      source = r.age === 0 || r.matter && (near || ((x & 1) | ((z & 1) << 1)) === lightingTick % GI_SRC_EVERY);
      probe = near ? board : ((x & 1) | ((y & 1) << 1) | ((z & 1) << 2)) === lightingTick % GI_BG_EVERY;
      background = !near;
    }
    if (source || allSources) sourceBricks.push(frozenArray(r.brick));
    if (probe) gatherBricks.push(Object.freeze({ brick: frozenArray(r.brick), background }));
  }
  return Object.freeze({ sourceBricks: frozenArray(sourceBricks), gatherBricks: frozenArray(gatherBricks) });
}

export function createWorldLightingHistory({ worldSize, epoch } = {}) {
  if (!Array.isArray(worldSize) || worldSize.length !== 3 || worldSize.some(n => !uint(n) || !n || n % 4) || !uint(epoch) || !epoch) throw new TypeError('world history epoch/size');
  const size = frozenArray(worldSize), probes = new Map(), changed = new Map();
  let tick = -1, revision = 0, settle = 0, key = [], lamps = [], pending = null, dead = false;
  let publicationToken = Object.freeze({ epoch, lightingTick: tick, revision });
  const alive = () => { if (dead) throw new Error('world lighting history disposed'); };
  const checkTick = n => { if (!uint(n) || n !== tick + 1) throw new Error('logical lighting tick must advance exactly once; retry same uncommitted plan'); };
  function begin({ lightingTick, globalKey, records, mode = 0, currentLamps = [], allSources = false }) {
    alive(); checkTick(lightingTick);
    if (mode === 2 && lightingTick !== 0) throw new Error('original reset only at scene epoch tick0, never on arrival');
    if (pending) throw new Error('world lighting tick already planned');
    if (!Array.isArray(globalKey) && !(globalKey instanceof Uint32Array)) throw new TypeError('immutable global light key words required');
    const nextKey = Array.from(globalKey); if (!nextKey.every(uint)) throw new TypeError('global light key bits');
    const nextLamps = currentLamps.map(copyLamp), spheres = [];
    for (let i = 0; i < Math.max(lamps.length, nextLamps.length); i++) if (!lampEqual(lamps[i], nextLamps[i])) for (const l of [lamps[i], nextLamps[i]]) if (l) spheres.push({ pos: l.pos.slice(0, 3), radius: l.pos[3] + l.shape[0] + .5 * l.shape[1] + 2 });
    const nextSettle = mode !== 0 || !same(key, nextKey) ? GI_SETTLE : settle;
    const effective = records.map(r => {
      worldLightingIndex(size, r.brick);
      const near = r.near || [...changed.values()].some(c => c.tick <= lightingTick && lightingTick - c.tick < GI_RECENT && Math.max(...c.brick.map((n, k) => Math.abs(n - r.brick[k]))) <= GI_NEAR_DILATE);
      return { ...r, near: !!near };
    });
    const selection = selectWorldGI({ records: effective, lightingTick, mode, settle: nextSettle, lampSpheres: spheres, allSources });
    let consumed = false;
    const plan = Object.freeze({ ...selection, epoch, lightingTick,
      commit(outputOrSlabs) {
        alive(); if (consumed || pending !== plan) throw new Error('stale/duplicate world history commit');
        const outputs = Array.isArray(outputOrSlabs) ? outputOrSlabs : [outputOrSlabs];
        const reference = outputs[0]?.token;
        if (!outputs.length || outputs.some(output => output?.token.epoch !== epoch || output.token.lightingTick !== lightingTick || typeof output.retain !== 'function' || ['sourceRevision', 'sourceContentToken', 'fieldPublishedToken', 'logicalFieldTick', 'previousToken', 'configVersion'].some(k => output.token[k] !== reference[k]))) throw new Error('completed compatible exact GI outputs for this clock required');
        const expected = selection.gatherBricks.map(r => worldLightingIndex(size, r.brick)).sort((a, b) => a - b);
        const expectedSources = selection.sourceBricks.map(b => worldLightingIndex(size, b)).sort((a, b) => a - b);
        const actual = outputs.flatMap(o => Array.from(o.probes)).sort((a, b) => a - b), actualSources = outputs.flatMap(o => Array.from(o.sources)).sort((a, b) => a - b);
        if (!same(actual, expected) || !same(actualSources, expectedSources)) throw new Error('completed outputs must cover the entire world selection exactly once');
        const additions = [];
        try { for (const output of outputs) for (let slot = 0; slot < output.probes.length; slot++) additions.push([output.probes[slot], { output: output.retain(), slot, count: output.probes.length }]); }
        catch (e) { additions.forEach(([, p]) => p.output.release()); throw e; }
        for (const [index, p] of additions) { probes.get(index)?.output.release(); probes.set(index, p); }
        tick = lightingTick; revision++; publicationToken = Object.freeze({ epoch, lightingTick: tick, revision }); settle = Math.max(0, nextSettle - 1); key = nextKey; lamps = nextLamps;
        consumed = true; pending = null;
        for (const [index, c] of changed) if (lightingTick - c.tick >= GI_RECENT) changed.delete(index);
      },
      abort() { if (!consumed && pending === plan) { consumed = true; pending = null; } },
    });
    pending = plan; return plan;
  }
  function capture({ lightingTick, indices }) {
    alive(); if (lightingTick !== tick) throw new Error('history capture must name the exact previous world clock');
    const held = new Map();
    try { for (const index of indices) {
      const p = probes.get(index); if (!p) throw new Error(`unknown world GI history ${index}: explicit reset seed or exact replay required`);
      if (!held.has(index)) held.set(index, { ...p, output: p.output.retain() });
    } } catch (e) { held.forEach(p => p.output.release()); throw e; }
    let released = false;
    return Object.freeze({ complete: true, token: publicationToken, lightingTick: tick,
      recordHistory(frame, { indices: requested, destination, format }) {
        if (released || format !== 'band-major-4x-vec2u' || requested.some(i => !held.has(i))) throw new Error('uncaptured/released exact previous history');
        const encoder = frame.direct();
        requested.forEach((index, slot) => { const p = held.get(index), source = p.output.bindings().history; for (let k = 0; k < 4; k++) encoder.copyBufferToBuffer(source, (k * p.count + p.slot) * 8, destination, (k * requested.length + slot) * 8, 8); });
      },
      release() { if (!released) { released = true; held.forEach(p => p.output.release()); } },
    });
  }
  return Object.freeze({ begin, capture, get lightingTick() { return tick; }, get epoch() { return epoch; },
    noteChanged(bricks, atTick) { alive(); if (!uint(atTick) || atTick < tick) throw new Error('world change tick regression'); for (const brick of bricks) changed.set(worldLightingIndex(size, brick), { brick: frozenArray(brick), tick: atTick }); },
    // Reset seed is deliberately NOT manufactured here. Initial tick0 producer
    // requires a caller-pinned original all-zero previous atlas (tick -1).
    dispose() { if (dead) return; dead = true; probes.forEach(p => p.output.release()); probes.clear(); pending = null; },
  });
}
