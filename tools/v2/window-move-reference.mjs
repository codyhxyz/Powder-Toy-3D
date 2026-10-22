// CPU-only: an independent coordinate reference for shaders/v2/windowMove.js (a World window
// move's dynamics, and an undo merge across a move), for the fake GPUs of the CPU checks.
// Not WGSL emulation: it restates what each mode does in slot/cell terms (src/shaders/common.js).
import { cellSlot, slotCell } from '../../src/shaders/common.js';
import { v2ActLayout, LEGACY_WORD } from '../../src/shaders/v2.js';
import { shockBase, heldBase, setOffBase } from '../../src/shaders/v2/particles.js';
import { auxLayout } from '../../src/shaders/v2/state.js';
import { PARTICLE_CAP } from '../../src/v2/dynamics-reference.js';
import { windowWork, WINDOW_MODE } from '../../src/shaders/v2/windowMove.js';

const buffersOf = group => (Array.isArray(group) ? group : group?.entries ?? []).reduce((out, e) => { out[e.binding] = e.resource.buffer; return out; }, []);

// words(buffer) -> Uint32Array over the buffer's bytes; bind: the dispatch's [group0, group1]; P: its params.
export function windowMoveReference(g, words, bind, P) {
  const [, auxBuf, actBuf] = buffersOf(bind[0]), [eventsBuf, airBuf, controlBuf, workBuf, particlesBuf] = buffersOf(bind[1]);
  const events = words(eventsBuf), air = words(airBuf), control = words(controlBuf), work = words(workBuf);
  const act = actBuf ? words(actBuf) : null, aux = auxBuf ? words(auxBuf) : null, particles = particlesBuf ? words(particlesBuf) : null;
  const W = windowWork(g), A = v2ActLayout(g), dims = [g.nx, g.ny, g.nz];
  const inside = p => p.every((v, a) => v >= 0 && v < dims[a]);
  const preserve = !!P.blastBounded, bricks = P.boxSize ?? [0, 0, 0], n = bricks[0] * bricks[1] * bricks[2];
  const slabCell = i => {
    const b = Math.floor(i / 64), l = i % 64;
    return [P.boxStart[0] + 4 * (b % bricks[0]) + l % 4, P.boxStart[1] + 4 * (Math.floor(b / bricks[0]) % bricks[1]) + Math.floor(l / 4) % 4,
      P.boxStart[2] + 4 * Math.floor(b / (bricks[0] * bricks[1])) + Math.floor(l / 16)];
  };
  if (P.mode === WINDOW_MODE.SHIFT) {
    for (let t = 0; t < g.slots; t++) {
      const q = slotCell(g, t).map((v, a) => v + P.shift[a]), held = inside(q);
      if (held) work[W.events + t] = events[cellSlot(g, ...q)]; else if (!preserve) work[W.events + t] = 0;
      if (t % 64) continue;
      const b = t / 64;
      if (held) {
        const source = Math.floor(cellSlot(g, ...q) / 64);
        work.set(air.subarray(source * 8, source * 8 + 8), W.air + b * 8);
        if (preserve) work[W.legacy + b] = LEGACY_WORD.STALE;
        else { work[W.legacy + b] = act ? act[A.legacy + source] : 0; work[W.shocks + b] = control[shockBase(g) + source]; }
      } else if (!preserve) {
        const r = slotCell(g, t).map((v, a) => (v - P.boxStart[a]) / 4), e = r[0] + bricks[0] * (r[1] + bricks[1] * r[2]);
        work.set(work.subarray(W.io + e * 8, W.io + e * 8 + 8), W.air + b * 8);
        work[W.legacy + b] = LEGACY_WORD.STALE; work[W.shocks + b] = 0;
      }
    }
  } else if (P.mode === WINDOW_MODE.GATHER) {
    for (let t = 0; t < n * 64; t++) {
      const s = cellSlot(g, ...slabCell(t));
      work[W.io + 8 * n + t] = events[s];
      if (t % 64 === 0) work.set(air.subarray(Math.floor(s / 64) * 8, Math.floor(s / 64) * 8 + 8), W.io + 72 * n + (t / 64) * 8);
    }
  } else if (P.mode === WINDOW_MODE.EVENTS) {
    for (let t = 0; t < P.substep; t++) { const at = W.io + 80 * n + 2 * t; events[work[at]] |= work[at + 1]; }
  } else if (P.mode === WINDOW_MODE.PARTICLES) {
    const f = new Float32Array(particles.buffer, particles.byteOffset, particles.length);
    const fw = new Float32Array(work.buffer, work.byteOffset, work.length);
    const within = (fa, at) => [0, 1, 2].every(a => { const c = Math.floor(fa[at + a]); return c >= P.blastLo[a] && c < P.blastHi[a]; });
    const deco = auxLayout(g.slots, PARTICLE_CAP).particleDeco;
    for (let t = 0; t < PARTICLE_CAP; t++) {
      const at = t * 12, snap = W.io + at, live = particles[at + 3] !== 0;
      if (!(live && !within(f, at))) {
        if (work[snap + 3] !== 0 && within(fw, snap)) {
          particles.set(work.subarray(snap, snap + 12), at);
          control[heldBase(g) + t] = 0; control[setOffBase(g) + t] = work[W.pool.setOff + t];
          if (aux) aux[deco + t] = work[W.pool.deco + t];
        } else if (live) {
          particles.fill(0, at, at + 12); control[heldBase(g) + t] = 0; control[setOffBase(g) + t] = 0; if (aux) aux[deco + t] = 0;
        }
      }
      if (particles[at + 3] !== 0) control[0]++;
    }
  }
}
