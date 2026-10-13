import * as THREE from 'three';
import { ELEMENTS, K } from '../../elements.js';
import { aimInReach } from './transfer.js';

// Digging, for every tool that digs (the shovel, the pickaxe): Minecraft's block
// breaking (minecraft.wiki/w/Breaking) on the trowel's lattice.
//
//   - A blow takes a whole bite: BLOCK cells deep into the face you hit, and
//     across it the BLOCK × BLOCK square of the lattice the trowel builds on, so
//     holes have straight walls and flat floors that line up with built blocks,
//     and every bite is a full one wherever the surface stands (a bite of the
//     lattice block alone came up a few grains where the sand had already gone).
//   - The aim the tools get is a GPU pick a frame or two behind, and still sees
//     a bite just dug: a bite dug in the last STALE_S is taken as gone, and the
//     aim goes on to the bite behind it (Minecraft breaks a block on the client
//     at once, without waiting for the server), so a held dig keeps biting.
//   - Hardness is hits, never a trickle (Deep Rock Galactic's terrain, Minecraft's
//     break time ∝ hardness / tool speed): a tool of `power` breaks an element in
//     ceil(hard / power) blows, and loose powder always in one; nothing harder
//     than its `limit` ever (the pickaxe still bounces off metal). The blows land on
//     the block you aim at; aim at another and it starts over (Minecraft).
//   - What you'd dig is outlined before you swing (Minecraft's block outline), and
//     a block that takes more than one blow cracks as they land (Minecraft's 10
//     destroy stages).
//   - What comes up is the cells themselves (solids as their debris: ROCK →
//     STONE), into the pack, so matter is conserved. A blow takes only the solids
//     it has beaten (transfer.js maxHard): rock in a sand block stays put.
//
//   const d = digger(env, { power, limit, reach });
//   const t = d.target(ctx);           // once a frame: the aimed block (and its outline), or null
//   const r = d.blow(ctx, t, load);    // a blow landed: { id, need, hits, taken: promise | null } or null

export const BLOCK = 3;              // cells a side (0.9 m at 30 cm cells: Minecraft's 1 m block); the trowel's lattice
export const CRACK_STAGES = 10;      // Minecraft's destroy_stage_0..9

// the kinds a dig takes: powder as it is, breakable solids as their debris
const DIG_KINDS = [K.POWDER, K.SOLID];
const STALE_S = 0.25;                // s a bite dug is taken as gone while the aim (a GPU pick) catches up

// Outline and cracks (world space)
// The outline and the cracks stand this far out from the bite's faces: past the tallest
// surface relief up close (gfx/detail.js: rock crags 7 cm ≈ 0.23 cells), which hid them on rock.
const RELIEF_CLEAR = 0.25;           // cells
const SHELL_GROW = (BLOCK + 2 * RELIEF_CLEAR) / BLOCK;
const OUTLINE_COLOR = 0x000000;      // Minecraft's block outline: black at 40 % (LevelRenderer.renderHitOutline)
const OUTLINE_OPACITY = 0.4;
const CRACK_INSET = 0.998;           // the crack shell, just inside the outline
const CRACK_SIZE = 128;              // px, one face's crack texture
const CRACK_SEED = 0x9e3779b9;       // the crack pattern's seed (the same cracks every time, as Minecraft's)
const CRACK_BRANCHES = 7;            // crack lines from the face's middle
const CRACK_STEPS = 9;               // segments per crack line
const CRACK_STEP_PX = 9;             // px per segment
const CRACK_TURN = 0.9;              // rad: how far a crack wanders per segment
const CRACK_WIDTH = 2.5;             // px
const CRACK_COLOR = 'rgba(20, 14, 10, 0.85)';
const CRACK_EDGE = 'rgba(255, 245, 225, 0.45)';   // a lit lip beside each crack, so it reads on dark rock as on pale sand
const CRACK_EDGE_PX = 1.5;           // px the lip sits off the crack

// The lattice block holding `cell`: its minimum corner.
export const blockMin = (cell, out = new THREE.Vector3()) => out.copy(cell).divideScalar(BLOCK).floor().multiplyScalar(BLOCK);

// The bite behind face `face` (transfer.js faceNormal: axis face >> 1, + for even) of
// `cell`: its minimum corner. BLOCK cells inward from the cell along the face's axis,
// the lattice's BLOCK across it.
export function biteMin(cell, face, out = new THREE.Vector3()) {
  blockMin(cell, out);
  const axis = face >> 1, c = cell.getComponent(axis);
  out.setComponent(axis, face % 2 === 0 ? c - (BLOCK - 1) : c);
  return out;
}

// The block's cells inside the grid, nearest `from` first (so a full pack takes the ones you aimed at).
export function blockCells(min, g, from) {
  const cells = [];
  for (let y = 0; y < BLOCK; y++) for (let z = 0; z < BLOCK; z++) for (let x = 0; x < BLOCK; x++) {
    const c = [min.x + x, min.y + y, min.z + z];
    if (c[0] < 0 || c[1] < 0 || c[2] < 0 || c[0] >= g.nx || c[1] >= g.ny || c[2] >= g.nz) continue;
    cells.push(c);
  }
  const d2 = ([x, y, z]) => (x + 0.5 - from.x) ** 2 + (y + 0.5 - from.y) ** 2 + (z + 0.5 - from.z) ** 2;
  return cells.sort((a, b) => d2(a) - d2(b));
}

// Blows a tool of `power` needs to dig element `id`: powder 1, a breakable solid
// no harder than `limit` ceil(hard / power), anything else (liquid, gas, a solid
// that won't break or is too hard) never.
export function blowsFor(id, power, limit = Infinity) {
  const el = ELEMENTS[id];
  if (!el) return Infinity;
  if (el.kind === K.POWDER) return 1;
  if (el.kind === K.SOLID && el.breakInto && (el.hard ?? 0) <= limit) return Math.max(1, Math.ceil((el.hard ?? 0) / power));
  return Infinity;
}

// The crack textures, one per stage, each with more of the same cracks drawn (made once, shared).
let crackTextures = null;
function cracks() {
  if (crackTextures || typeof document === 'undefined') return crackTextures;
  let seed = CRACK_SEED;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };   // an LCG: the same pattern every run
  // every crack line's segments, in the order they appear
  const segs = [];
  for (let b = 0; b < CRACK_BRANCHES; b++) {
    let x = CRACK_SIZE / 2 + (rand() - 0.5) * CRACK_SIZE * 0.3, y = CRACK_SIZE / 2 + (rand() - 0.5) * CRACK_SIZE * 0.3;
    let a = (b / CRACK_BRANCHES) * Math.PI * 2 + rand();
    for (let s = 0; s < CRACK_STEPS; s++) {
      a += (rand() - 0.5) * CRACK_TURN * 2;
      const nx = x + Math.cos(a) * CRACK_STEP_PX, ny = y + Math.sin(a) * CRACK_STEP_PX;
      segs.push({ x, y, nx, ny, order: s + rand() });   // inner segments first, branch by branch interleaved
      x = nx; y = ny;
    }
  }
  segs.sort((p, q) => p.order - q.order);
  crackTextures = [];
  for (let stage = 0; stage < CRACK_STAGES; stage++) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = CRACK_SIZE;
    const g = canvas.getContext('2d');
    g.lineWidth = CRACK_WIDTH;
    g.lineCap = 'round';
    const n = Math.ceil(segs.length * (stage + 1) / CRACK_STAGES);
    for (const [style, off] of [[CRACK_EDGE, CRACK_EDGE_PX], [CRACK_COLOR, 0]]) {
      g.strokeStyle = style;
      g.beginPath();
      for (const s of segs.slice(0, n)) { g.moveTo(s.x + off, s.y + off); g.lineTo(s.nx + off, s.ny + off); }
      g.stroke();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    crackTextures.push(tex);
  }
  return crackTextures;
}

export function digger(env, { power, limit = Infinity, reach }) {
  let hits = 0, hitKey = '';
  let lastBlow = null;   // for checks: { min, id, need, hits, taken }
  const dug = new Map();   // bites dug lately, 'x,y,z' of their corner → when (s, performance.now)
  const cornerKey = (m) => `${m.x},${m.y},${m.z}`;

  // the outline and the crack shell, in the world (an NPC's toolbelt has no scene: no visuals)
  const scene = env.scene;
  const world = scene ? new THREE.Group() : null;
  let outline = null, crack = null;
  if (world) {
    world.name = 'pov-dig';
    world.visible = false;
    const box = new THREE.BoxGeometry(1, 1, 1);
    outline = new THREE.LineSegments(new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: OUTLINE_COLOR, transparent: true, opacity: OUTLINE_OPACITY, depthWrite: false }));
    outline.scale.setScalar(SHELL_GROW);
    crack = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    crack.scale.setScalar(SHELL_GROW * CRACK_INSET);
    crack.visible = false;
    world.add(outline, crack);
    scene.add(world);
  }

  function show(t) {
    if (!world) return;
    const was = world.visible;
    world.visible = !!t;
    if (t) {
      const s = env.getScale();
      world.scale.setScalar(s * BLOCK);
      world.position.copy(t.min).addScalar(BLOCK / 2).multiplyScalar(s).add(env.getVolume().position);
      const stage = t.need > 1 && t.key === hitKey && hits > 0 ? Math.min(CRACK_STAGES - 1, Math.floor((hits / t.need) * CRACK_STAGES)) : -1;
      const tex = stage >= 0 ? cracks()?.[stage] : null;
      crack.visible = !!tex;
      if (tex && crack.material.map !== tex) { crack.material.map = tex; crack.material.needsUpdate = true; }
    }
    if (was !== world.visible || t) globalThis.__app?.requestRender?.();
  }

  return {
    // The aimed block within reach, outlined: { aim, min, id, need, key }, or null (air, the floor, out of reach).
    target(ctx) {
      const aim = aimInReach(ctx, reach);
      if (!aim || aim.id < 0 || aim.cell.y < 0) { show(null); return null; }
      // the bite behind the aimed face; past the ones just dug (the aim hasn't seen them go yet)
      const now = performance.now() / 1000;
      for (const [k, at] of dug) if (now - at > STALE_S) dug.delete(k);
      const min = biteMin(aim.cell, aim.face);
      const inward = (aim.face % 2 === 0 ? -1 : 1) * BLOCK, axis = aim.face >> 1;
      while (dug.has(cornerKey(min))) min.setComponent(axis, min.getComponent(axis) + inward);
      const need = blowsFor(aim.id, power, limit);
      const t = { aim, min, id: aim.id, need, key: `${min.x},${min.y},${min.z}:${aim.id}` };
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
        const cells = blockCells(t.min, ctx.sim.g, t.aim.cell.clone().addScalar(0.5));
        // (limit: the take reserves room for that many in the pack, so the next bite isn't refused while this one's in flight)
        taken = transfer?.take(load, {
          cells, kinds: DIG_KINDS, breakDebris: true, maxHard: Math.min(t.need * power, limit), limit: cells.length,
        }) ?? null;
        if (taken) { hits = 0; hitKey = ''; dug.set(cornerKey(t.min), performance.now() / 1000); }   // the next blow starts on the bite behind
      }
      lastBlow = { min: t.min.clone(), id: t.id, need: t.need, hits, taken };
      show(t);
      return { id: t.id, need: t.need, hits, taken };
    },

    hide() { show(null); hits = 0; hitKey = ''; },
    get lastBlow() { return lastBlow; },
    dispose() {
      if (!world) return;
      world.removeFromParent();
      outline.geometry.dispose(); outline.material.dispose();
      crack.geometry.dispose(); crack.material.dispose();
    },
  };
}
