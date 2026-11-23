import * as THREE from 'three';
import { ELEMENTS, K } from '../../elements.js';
import { aimInReach } from './transfer.js';
import { gfxUniforms } from '../../gfx/uniforms.js';
import { BLOCK, BITE_MIN, BITE_MAX, biteLabel } from '../constants.js';

// Digging, for every tool that digs (the shovel, the pickaxe): Minecraft's block
// breaking (minecraft.wiki/w/Breaking) on the trowel's lattice.
//
//   - A blow takes a whole bite: BLOCK cells deep into the face you hit, and
//     across it the BLOCK × BLOCK square of the lattice the trowel builds on
//     (or smaller, down to the one cell you aim at: the bite's size, below), so
//     holes have straight walls and flat floors that line up with built blocks,
//     and every bite is a full one wherever the surface stands (a bite of the
//     lattice block alone came up a few grains where the sand had already gone).
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
// tools is in hand, a notch a cell: from one cell (0.3 m: the smallest piece the
// world holds, so sizes go in whole cells) up to the block. Wheel up is bigger,
// The Powder Toy's brush size. The tool in hand owns the wheel, as Valheim's
// hammer and Satisfactory's build gun do (and the physgun here while it holds
// something); the number keys switch tools from it. (The user's pick,
// 2026-11-22, over [ and ] and a mode key: "would scroll make any sense?")
// One size for every tool that digs or builds on the lattice (the shovel and its
// throw, the pickaxe, the jackhammer, the trowel), so a hole dug at a size is
// filled by blocks of that size. A bite of n cells is n deep behind the aimed
// face and the n × n square of the n-cell lattice across it; at 1 it is the
// aimed cell itself.
// Intentional (user request, 2026-11-22: "we need a finer resolution for eg
// digging. i need to be able to be precise with it"): the block stays the
// default (the user's "fast refire + big bites", 2026-10-13), and an NPC's
// tools always take the block (brain.js plans in blocks).
let playerBite = BLOCK;              // cells: the player's chosen size
// the bite size of `owner`'s tools (null: the player's)
export const biteSize = (owner = null) => (owner == null ? playerBite : BLOCK);
// Step the player's bite size by `step` cells. Returns the new size, or null at an end of the range.
export function resizeBite(step) {
  const next = Math.max(BITE_MIN, Math.min(BITE_MAX, playerBite + Math.sign(step)));
  if (next === playerBite) return null;
  playerBite = next;
  return next;
}
// A lattice tool's wheel (the tool contract's wantsWheel and wheelUse; ctx.wheel: +1 a notch
// rolled toward you): the player's tools take it, to size the bite.
export const WHEEL_USE = 'size';     // what the wheel does with these in hand (touch.js labels its two buttons by it)
export const bitesByWheel = (env) => env.owner == null;
// Once a frame from the tool's update: a notch away from you is a cell bigger, toward you a cell smaller.
export function wheelBite(env, ctx) {
  if (!ctx.wheel || !bitesByWheel(env)) return;
  const n = resizeBite(-ctx.wheel);
  if (n != null) env.feedback?.toast?.(`Dig and build size: ${biteLabel(n)}`);
}
// A lattice tool's status with a finer size marked ('SAND ×12 · 0.3 m'); the block, the default, says nothing.
export function biteStatus(env, status) {
  const n = biteSize(env.owner);
  return n === BLOCK ? status : [status, biteLabel(n)].filter(Boolean).join(' · ');
}

// the kinds a dig takes: powder as it is, breakable solids as their debris
const DIG_KINDS = [K.POWDER, K.SOLID];
const STALE_S = 0.25;                // s a bite dug is taken as gone while the aim (a GPU pick) catches up

// Keep the existing highlight clearance around a smooth surface hit.
const SURFACE_CLEAR = 0.25;          // cells

// The block of the n-cell lattice holding `cell`: its minimum corner.
export const blockMin = (cell, out = new THREE.Vector3(), n = BLOCK) => out.copy(cell).divideScalar(n).floor().multiplyScalar(n);

// The bite behind face `face` (transfer.js faceNormal: axis face >> 1, + for even) of
// `cell`: its minimum corner. n cells inward from the cell along the face's axis,
// the n-cell lattice's square across it.
export function biteMin(cell, face, out = new THREE.Vector3(), n = BLOCK) {
  blockMin(cell, out, n);
  const axis = face >> 1, c = cell.getComponent(axis);
  out.setComponent(axis, face % 2 === 0 ? c - (n - 1) : c);
  return out;
}

// The n-cell block's cells inside the grid, nearest `from` first (so a full pack takes the ones you aimed at).
export function blockCells(min, g, from, n = BLOCK) {
  const cells = [];
  for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const c = [min.x + x, min.y + y, min.z + z];
    if (c[0] < 0 || c[1] < 0 || c[2] < 0 || c[0] >= g.nx || c[1] >= g.ny || c[2] >= g.nz) continue;
    cells.push(c);
  }
  const d2 = ([x, y, z]) => (x + 0.5 - from.x) ** 2 + (y + 0.5 - from.y) ** 2 + (z + 0.5 - from.z) ** 2;
  return cells.sort((a, b) => d2(a) - d2(b));
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
  let lastBlow = null;   // for checks: { min, id, need, hits, taken }
  const dug = new Map();   // bites dug lately, their size and 'x,y,z' of their corner → when (s, performance.now)
  const cornerKey = (m, n) => `${n}:${m.x},${m.y},${m.z}`;

  // the mark on the surface (FrameUniforms digMin/digMax): the player's tools only (an NPC's are its own, unseen)
  const mine = env.owner == null;
  let shown = false;
  function show(t) {
    if (!mine) return;
    const u = gfxUniforms;
    if (!t) {
      if (shown) { u.uDigMax.value[3] = 0; shown = false; globalThis.__app?.requestRender?.(); }
      return;
    }
    const axis = t.aim.face >> 1, out = t.aim.face % 2 === 0 ? 1 : -1;   // the aimed face's axis, and outward along it
    const lo = t.min.toArray(), hi = lo.map((v) => v + t.size);
    if (out > 0) hi[axis] += SURFACE_CLEAR; else lo[axis] -= SURFACE_CLEAR;
    const cracked = t.need > 1 && t.key === hitKey ? hits / t.need : 0;
    u.uDigMin.value = [...lo, cracked];
    u.uDigMax.value = [...hi, 1 + axis];
    shown = true;
    globalThis.__app?.requestRender?.();
  }

  return {
    // The aimed bite within reach, outlined: { aim, min, size, id, need, key }, or null (air, the floor, out of reach).
    target(ctx) {
      const aim = aimInReach(ctx, reach);
      if (!aim || aim.id < 0 || aim.cell.y < 0) { show(null); return null; }
      // the bite behind the aimed face; past the ones just dug (the aim hasn't seen them go yet)
      const now = performance.now() / 1000;
      for (const [k, at] of dug) if (now - at > STALE_S) dug.delete(k);
      const size = biteSize(env.owner);
      const min = biteMin(aim.cell, aim.face, undefined, size);
      const inward = (aim.face % 2 === 0 ? -1 : 1) * size, axis = aim.face >> 1;
      let advanced = false;
      while (dug.has(cornerKey(min, size))) {
        min.setComponent(axis, min.getComponent(axis) + inward);
        advanced = true;
      }
      if (advanced) {
        // A rapid tool can pass several stale bites before the GPU pick catches
        // up. Its reach ends at the new face, not the original pick's distance.
        const faceAt = min.getComponent(axis) + (inward < 0 ? size : 0);
        const distance = (faceAt - ctx.eye.getComponent(axis)) / ctx.dir.getComponent(axis) * ctx.dir.length();
        if (!(distance >= 0 && distance <= reach)) { show(null); return null; }
      }
      const need = blowsFor(aim.id, power, limit, tools);
      const t = { aim, min, size, id: aim.id, need, key: `${min.x},${min.y},${min.z}:${aim.id}` };
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
        const cells = blockCells(t.min, ctx.sim.g, t.aim.cell.clone().addScalar(0.5), t.size);
        // (limit: the take reserves room for that many in the pack, so the next bite isn't refused while this one's in flight)
        taken = transfer?.take(load, {
          cells, kinds: DIG_KINDS, breakDebris: true, maxHard: Math.min(t.need * power, limit), ids, limit: cells.length,
        }) ?? null;
        if (taken) { hits = 0; hitKey = ''; dug.set(cornerKey(t.min, t.size), performance.now() / 1000); }   // the next blow starts on the bite behind
      }
      lastBlow = { min: t.min.clone(), size: t.size, id: t.id, need: t.need, hits, taken };
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
