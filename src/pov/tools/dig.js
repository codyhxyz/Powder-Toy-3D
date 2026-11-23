import * as THREE from 'three';
import { ELEMENTS, K } from '../../elements.js';
import { aimInReach } from './transfer.js';
import { gfxUniforms } from '../../gfx/uniforms.js';
import { BLOCK, BITE_MIN, BITE_MAX, BITE_NOTCHES, biteLabel } from '../constants.js';

// Digging, for every tool that digs (the shovel, the pickaxe): Minecraft's block
// breaking (minecraft.wiki/w/Breaking) on the trowel's lattice.
//
//   - A blow takes a whole bite: BLOCK cells deep into the face you hit, and
//     across it the BLOCK × BLOCK square of the lattice the trowel builds on,
//     so holes have straight walls and flat floors that line up with built
//     blocks, and every bite is a full one wherever the surface stands (a bite
//     of the lattice block alone came up a few grains where the sand had
//     already gone). Sized down with the wheel (the bite's size, below) it
//     leaves the lattice and sits on the crosshair.
//   - The aim the tools get is a GPU pick a frame or two behind, and still sees
//     a bite just dug: a bite dug in the last STALE_S is taken as gone, and the
//     aim goes on to the bite behind it (Minecraft breaks a block on the client
//     at once, without waiting for the server), so a held dig keeps biting.
//   - Each tool digs its own elements, the ones whose `tool` (elements.js) it
//     answers to, Minecraft's mineable/<tool> block tags: the shovel loose ground
//     and grass, the pickaxe stone and the like (and loose ground), never wood (the
//     axe's). A bite takes only its tool's elements (transfer.js ids), so a shovel
//     bite leaves the rock and roots in it. A new element sets `tool`; nothing here.
//   - Hardness is hits, never a trickle (Deep Rock Galactic's terrain, Minecraft's
//     break time ∝ hardness / tool speed): a tool of `power` breaks an element in
//     ceil(hard / power) blows, and loose powder always in one; nothing harder
//     than its `limit` ever (the pickaxe still bounces off metal). The blows land on
//     the block you aim at; aim at another and it starts over (Minecraft).
//   - What you'd dig is outlined before you swing (Minecraft's block outline), and
//     a block that takes more than one blow cracks as they land (Minecraft's 10
//     destroy stages), both drawn on the surface itself by the renderer
//     (FrameUniforms digMin/digMax, shaders/gfx/surface.js digMark), so they
//     follow a trunk or a slope; a box drawn around the bite hung in the air
//     wherever the bite wasn't full.
//   - What comes up is the cells themselves (solids as their debris: ROCK →
//     STONE), into the pack, so matter is conserved. A blow takes only the solids
//     it has beaten (transfer.js maxHard): rock in a sand block stays put.
//
//   const d = digger(env, { power, limit, tools, reach });   // tools: the elements.js `tool` values it digs
//   const t = d.target(ctx);           // once a frame: the aimed bite (and its mark on the surface), or null
//   const r = d.blow(ctx, t, load);    // a blow landed: { id, need, hits, taken: promise | null } or null

export { BLOCK };                    // cells a side (0.9 m at 30 cm cells: Minecraft's 1 m block); the trowel's lattice (constants.js)

// The bite's size is the player's to set with the wheel while one of these
// tools is in hand: any size from one cell (0.3 m: the smallest piece the world
// holds) up to the block, sliding, not stepping (the user, 2026-11-22: "why is
// it not continuous"; three whole-cell sizes were rejected). Wheel up is
// bigger, The Powder Toy's brush size. The tool in hand owns the wheel, as
// Valheim's hammer and Satisfactory's build gun do (and the physgun here while
// it holds something); the number keys switch tools from it. (The user's pick,
// 2026-11-22, over [ and ] and a mode key: "would scroll make any sense?")
// One size for every tool that digs or builds (the shovel and its throw, the
// pickaxe, the jackhammer, the trowel), so a hole dug at a size is filled by a
// block of that size.
//   - At the block (the default) a bite is the lattice's, as above.
//   - Smaller, it is a box of that side on the crosshair: across the aimed face
//     it is centred where you look (free of the lattice, so it goes exactly
//     where you point), and it runs its side deep behind the face (a build:
//     out from it). The outline is that box, growing and sliding smoothly.
//     What comes up is the cells whose centres are in it, and always the cell
//     aimed at: the world holds whole cells, so the box is as fine as the
//     outline and the matter follows it to the nearest cell.
// Intentional (user request, 2026-11-22: "we need a finer resolution for eg
// digging. i need to be able to be precise with it"): the block stays the
// default (the user's "fast refire + big bites", 2026-10-13) and keeps its
// lattice, and an NPC's tools always take the block (brain.js plans in blocks).
const BITE_NOTCH = (BITE_MAX - BITE_MIN) / BITE_NOTCHES;   // cells a wheel notch
const BITE_SNAP = BITE_NOTCH / 2;    // cells: this near an end of the range the size is the end (the block is a detent: a smooth wheel lands on it, and sums of notches do)
let playerBite = BLOCK;              // cells: the player's chosen size
// the bite size of `owner`'s tools (null: the player's)
export const biteSize = (owner = null) => (owner == null ? playerBite : BLOCK);
// cells in a bite of `owner`'s size (the shovel's throw)
export const biteCells = (owner = null) => Math.max(1, Math.round(biteSize(owner) ** 3));
// Grow the player's bite by `by` cells (negative: shrink). Returns the new size, or null at an end of the range.
export function resizeBite(by) {
  let next = Math.max(BITE_MIN, Math.min(BITE_MAX, playerBite + by));
  if (BITE_MAX - next < BITE_SNAP) next = BITE_MAX;
  else if (next - BITE_MIN < BITE_SNAP) next = BITE_MIN;
  if (next === playerBite) return null;
  playerBite = next;
  return next;
}
// A dig or build tool's wheel (the tool contract's wantsWheel and wheelUse): the player's tools take it, to size the bite.
export const WHEEL_USE = 'size';     // what the wheel does with these in hand (touch.js labels its two buttons by it)
export const bitesByWheel = (env) => env.owner == null;
// Once a frame from the tool's update (ctx.wheelTurn: notches and parts of one, + rolled toward you):
// away from you is bigger, toward you smaller, as far as the wheel turned.
let sizeToast = null;                // the one notice that reads the size out while it changes
export function wheelBite(env, ctx) {
  if (!ctx.wheelTurn || !bitesByWheel(env)) return;
  const s = resizeBite(-ctx.wheelTurn * BITE_NOTCH);
  if (s != null) sizeToast = env.feedback?.toast?.(`Dig and build size: ${biteLabel(s)}`, { replace: sizeToast }) ?? null;
}
// A dig or build tool's status with a finer size marked ('SAND ×12 · 0.45 m'); the block, the default, says nothing.
export function biteStatus(env, status) {
  const s = biteSize(env.owner);
  return s === BLOCK ? status : [status, biteLabel(s)].filter(Boolean).join(' · ');
}

// the kinds a dig takes: powder as it is, breakable solids as their debris
const DIG_KINDS = [K.POWDER, K.SOLID];
const STALE_S = 0.25;                // s a bite dug is taken as gone while the aim (a GPU pick) catches up

// Keep the existing highlight clearance around a smooth surface hit.
const SURFACE_CLEAR = 0.25;          // cells

// The block of the lattice holding `cell`: its minimum corner.
export const blockMin = (cell, out = new THREE.Vector3()) => out.copy(cell).divideScalar(BLOCK).floor().multiplyScalar(BLOCK);

// The lattice bite behind face `face` (transfer.js faceNormal: axis face >> 1, + for even) of
// `cell`: its minimum corner. BLOCK cells inward from the cell along the face's axis,
// the lattice's square across it.
export function biteMin(cell, face, out = new THREE.Vector3()) {
  blockMin(cell, out);
  const axis = face >> 1, c = cell.getComponent(axis);
  out.setComponent(axis, face % 2 === 0 ? c - (BLOCK - 1) : c);
  return out;
}

// The bite of side `s` cells at face `face` of `cell`, aimed along the ray eye + t·dir:
// { lo, hi } its box (cells; what the outline shows) and { min, max } the cells in it
// (whole cells, max exclusive). A dig's runs behind the face; a build's (`build`) out from it.
// At the block it is the lattice's; smaller, a box centred across the face where the ray
// meets it (kept on the aimed cell's face: the pick is the cell, not the point), whose
// cells are the ones with their centres in it, and always the aimed cell (a build: the
// one against it).
const nextTo = new THREE.Vector3();
export function biteBox(cell, face, s, eye, dir, build = false) {
  const axis = face >> 1, out = face % 2 === 0 ? 1 : -1;
  const lo = new THREE.Vector3(), hi = new THREE.Vector3();
  if (s === BLOCK) {
    if (build) blockMin(nextTo.copy(cell).setComponent(axis, cell.getComponent(axis) + out), lo);
    else biteMin(cell, face, lo);
    hi.copy(lo).addScalar(BLOCK);
    return { lo, hi, min: lo.clone(), max: hi.clone() };
  }
  const plane = cell.getComponent(axis) + (out > 0 ? 1 : 0);   // the aimed face
  const t = (plane - eye.getComponent(axis)) / dir.getComponent(axis);
  const min = new THREE.Vector3(), max = new THREE.Vector3();
  for (let a = 0; a < 3; a++) {
    const c = cell.getComponent(a);
    if (a === axis) {
      const far = plane + (build ? out : -out) * s;
      lo.setComponent(a, Math.min(plane, far));
      hi.setComponent(a, Math.max(plane, far));
    } else {
      // (a ray along the face never meets it: the cell's middle)
      const at = Number.isFinite(t) ? THREE.MathUtils.clamp(eye.getComponent(a) + dir.getComponent(a) * t, c, c + 1) : c + 0.5;
      lo.setComponent(a, at - s / 2);
      hi.setComponent(a, at + s / 2);
    }
    // the cells whose centres are in [lo, hi)
    let i0 = Math.ceil(lo.getComponent(a) - 0.5), i1 = Math.ceil(hi.getComponent(a) - 0.5);
    if (a !== axis && i1 <= c) { i0++; i1++; }   // a one-cell box on the cell's low edge still takes the aimed cell
    min.setComponent(a, i0);
    max.setComponent(a, i1);
  }
  return { lo, hi, min, max };
}

// The cells of [min, max) inside the grid: nearest `from` first (so a full pack takes the ones you aimed at), or bottom up.
export function boxCells(min, max, g, from) {
  const cells = [];
  for (let y = min.y; y < max.y; y++) for (let z = min.z; z < max.z; z++) for (let x = min.x; x < max.x; x++) {
    if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) continue;
    cells.push([x, y, z]);
  }
  if (!from) return cells;
  const d2 = ([x, y, z]) => (x + 0.5 - from.x) ** 2 + (y + 0.5 - from.y) ** 2 + (z + 0.5 - from.z) ** 2;
  return cells.sort((a, b) => d2(a) - d2(b));
}

// The mark on the surface (FrameUniforms digMin/digMax, surface.js digMark): the outline of
// box { lo, hi } where its side walls cut the surface around face `face`, cracked 0..1.
// One at a time: the tool in hand's.
let marked = false;
export function markBite(box, face, cracked = 0) {
  const u = gfxUniforms;
  const axis = face >> 1;
  u.uDigMin.value = [box.lo.x, box.lo.y, box.lo.z, cracked];
  u.uDigMax.value = [box.hi.x, box.hi.y, box.hi.z, 1 + axis];
  marked = true;
  globalThis.__app?.requestRender?.();
}
export function clearMark() {
  if (!marked) return;
  gfxUniforms.uDigMax.value[3] = 0;
  marked = false;
  globalThis.__app?.requestRender?.();
}
// box with the aimed surface inside it: SURFACE_CLEAR further along `sign` on the face's axis
export function withSurface(box, face, sign) {
  const axis = face >> 1, lo = box.lo.clone(), hi = box.hi.clone();
  if (sign > 0) hi.setComponent(axis, hi.getComponent(axis) + SURFACE_CLEAR);
  else lo.setComponent(axis, lo.getComponent(axis) - SURFACE_CLEAR);
  return { lo, hi };
}

// Blows a tool of `power` that digs the elements of `tools` (their `tool` field, elements.js)
// needs for element `id`: powder 1, a breakable solid no harder than `limit` ceil(hard / power),
// anything else (another tool's, a liquid, a solid that won't break) never.
export function blowsFor(id, power, limit = Infinity, tools = ['pickaxe', 'shovel']) {
  const el = ELEMENTS[id];
  if (!el || !tools.includes(el.tool)) return Infinity;
  if (el.kind === K.POWDER) return 1;
  if (el.kind !== K.SOLID || !el.breakInto || (el.hard ?? 0) > limit) return Infinity;
  return Math.max(1, Math.ceil((el.hard ?? 0) / power));
}

export function digger(env, { power, limit = Infinity, tools, reach }) {
  let hits = 0, hitKey = '';
  // the elements a bite may take: its tools' (and its limit, through the take's maxHard)
  const ids = ELEMENTS.flatMap((el, id) => (tools.includes(el.tool) ? [id] : []));
  let lastBlow = null;   // for checks: { min, max, size, id, need, hits, taken }
  let dug = [];          // bites dug lately: { min, max, at } (their cells, and when: s, performance.now)
  const front = new THREE.Vector3();
  const holds = (d, c) => c.x >= d.min.x && c.y >= d.min.y && c.z >= d.min.z && c.x < d.max.x && c.y < d.max.y && c.z < d.max.z;

  // the mark on the surface: the player's tools only (an NPC's are its own, unseen)
  const mine = env.owner == null;
  let shown = false;
  function show(t) {
    if (!mine) return;
    if (!t) {
      if (shown) { clearMark(); shown = false; }
      return;
    }
    const cracked = t.need > 1 && t.key === hitKey ? hits / t.need : 0;
    markBite(withSurface(t, t.aim.face, t.aim.face % 2 === 0 ? 1 : -1), t.aim.face, cracked);   // out to the surface it is dug from
    shown = true;
  }

  return {
    // The aimed bite within reach, outlined: { aim, lo, hi, min, max, size, id, need, key }, or null (air, the floor, out of reach).
    target(ctx) {
      const aim = aimInReach(ctx, reach);
      if (!aim || aim.id < 0 || aim.cell.y < 0) { show(null); return null; }
      // the bite behind the aimed face; past the ones just dug (the aim hasn't seen them go yet)
      const now = performance.now() / 1000;
      dug = dug.filter((d) => now - d.at <= STALE_S);
      const size = biteSize(env.owner);
      const axis = aim.face >> 1, inward = aim.face % 2 === 0 ? -1 : 1;
      front.copy(aim.cell);
      let advanced = false;
      for (let d; (d = dug.find((b) => holds(b, front)));) {
        front.setComponent(axis, inward < 0 ? d.min.getComponent(axis) - 1 : d.max.getComponent(axis));
        advanced = true;
      }
      if (advanced) {
        // A rapid tool can pass several stale bites before the GPU pick catches
        // up. Its reach ends at the new face, not the original pick's distance.
        const faceAt = front.getComponent(axis) + (inward < 0 ? 1 : 0);
        const distance = (faceAt - ctx.eye.getComponent(axis)) / ctx.dir.getComponent(axis) * ctx.dir.length();
        if (!(distance >= 0 && distance <= reach)) { show(null); return null; }
      }
      const box = biteBox(front, aim.face, size, ctx.eye, ctx.dir);
      const need = blowsFor(aim.id, power, limit, tools);
      const t = { aim, ...box, size, id: aim.id, need, key: `${box.min.toArray()}:${box.max.toArray()}:${aim.id}` };
      if (t.key !== hitKey) { hits = 0; hitKey = t.key; }
      show(Number.isFinite(need) ? t : null);
      return t;
    },

    // A blow on target t. Returns null when it can't dig there (t.need is Infinity),
    // else { id, need, hits, taken }: taken is the take's promise of the cells that
    // came up, or null when this blow only cracked it (or the pack is full / busy).
    blow(ctx, t, load, transfer) {
      if (!t || !Number.isFinite(t.need)) return null;
      hits = Math.min(hits + 1, t.need);
      let taken = null;
      if (hits >= t.need) {
        const cells = boxCells(t.min, t.max, ctx.sim.g, t.aim.cell.clone().addScalar(0.5));
        // (limit: the take reserves room for that many in the pack, so the next bite isn't refused while this one's in flight)
        taken = transfer?.take(load, {
          cells, kinds: DIG_KINDS, breakDebris: true, maxHard: Math.min(t.need * power, limit), ids, limit: cells.length,
        }) ?? null;
        if (taken) { hits = 0; hitKey = ''; dug.push({ min: t.min, max: t.max, at: performance.now() / 1000 }); }   // the next blow starts on the bite behind
      }
      lastBlow = { min: t.min.clone(), max: t.max.clone(), size: t.size, id: t.id, need: t.need, hits, taken };
      show(t);
      return { id: t.id, need: t.need, hits, taken };
    },

    // Why this tool won't dig element id (a toast), or null: nothing to say (a liquid runs off it).
    refusal(id, toolName) {
      const el = ELEMENTS[id];
      if (!el || el.kind !== K.SOLID) return null;
      if (!el.tool || !el.breakInto) return `${el.name} won't break`;
      if (!tools.includes(el.tool)) return `${el.name}: use the ${el.tool}`;
      return `${el.name} is too hard for the ${toolName}`;
    },

    hide() { show(null); hits = 0; hitKey = ''; },
    get lastBlow() { return lastBlow; },
    dispose() { show(null); },
  };
}
