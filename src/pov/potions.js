import { E, ELEMENTS, K } from '../elements.js';
import { BODY_WIDTH, BODY_HEIGHT } from './constants.js';
import { registerStatus, registerStain } from './status.js';
import { registerIngestion } from './ingest.js';
import { PX as NOITA_PX } from './player.js';
import { povEvents } from './events.js';
import { createWorldModel } from './ai/world.js';

// Noita's potions on a first-person body: each magical liquid (branch nt-mat's
// elements) gives its status by touch, a stain (status.js registerStain), and
// by drinking (ingest.js registerIngestion: a full drink, Noita's 10% of a
// flask, gives the status's submerge time, and drinks add up as Noita's do).
// Durations are the Noita wiki's submerge times (noita.wiki.gg, read 2026-10-10).
//
// | Status      | Element       | What it does here                                                      |
// |-------------|---------------|------------------------------------------------------------------------|
// | Levitating  | LEVITATIUM    | the jetpack flies on no fuel, climbing 75% faster (player.js)          |
// | Teleportitis| TELEPORTATIUM | every few seconds a jump to a safe open spot (feet on solid ground)    |
// | Regeneration| HEALTHIUM     | heals 10% of a life per second                                         |
// | Berserk     | BERSERKIUM    | the body's weapons hurt bodies 2× (status `damage`, targets.js)        |
// | Charmed     | PHEROMONE     | NPCs stop hunting the player: a charmed NPC, or a charmed player       |
// | Polymorph   | POLYMORPHINE  | helpless: no tools (tools/index.js `noTools`); the sheep is a follow-up |
// | Toxic       | TOXIC (drunk) | nt-status's Toxic; touching sludge already gives it (stains.js)        |
//
// Events: 'teleport' { from, to } (grid feet; an NPC's carry by) when Teleportitis moves a body.

// ---- how the potions stain and how much a drink gives
const POTION_STAIN_RATE = 20;   // s of status per s with the whole skin in the potion (stains.js's Toxic, Oily and Slimy rate)
const LEVITATE_S = 20;          // s: Noita's Faster Levitation from submerging in Levitatium
const TELEPORT_S = 5;           // s: Teleportitis from submerging in Teleportatium (and from 10% of a flask)
const REGEN_S = 7.5;            // s: Regeneration from submerging in Healthium (and from a drink)
const BERSERK_S = 15;           // s: Berserk from submerging in Berserkium
const CHARM_S = 20;             // s: Charmed from submerging in Pheromone
const POLYMORPH_S = 20;         // s: Polymorph from submerging in Polymorphine
const TOXIC_DRINK_S = 6;        // s of Toxic per full drink of sludge: the stain's own time (stains.js TOXIC_S)

// ---- what they do
const REGEN_RATE = 0.1;         // health/s: Noita's Regeneration heals 10% of max HP a second
export const BERSERK_DAMAGE = 2;   // × damage dealt: Noita's Berserk doubles it
// Teleportitis: Noita's jumps are 128 to 1024 px (64 to 512 cells here) and a 5 s stain makes 1 to 3 of them.
// A box is 64 to 128 cells across, so here a jump is a short one: up to Noita's shortest.
const TELEPORT_MIN = 16;                                        // cells: the shortest jump...
const TELEPORT_MAX = Math.round(128 * NOITA_PX);                // ...and the longest (Noita's 128 px minimum: 64 cells)
const TELEPORT_EVERY = [1.5, 3.5];                              // s between jumps (uniform): 1 to 3 in a 5 s stain
const TELEPORT_TRIES = 48;                                      // candidate spots tried per jump; none safe: no jump (Noita)
const TELEPORT_EDGE = BODY_WIDTH;                               // cells kept clear of the box's sides
const TELEPORT_HOT_REACH = 3;                                   // cells around a spot with nothing hot enough to burn

const KIND = ELEMENTS.map((e) => e.kind);

// one picture of the world per renderer for Teleportitis's safe spots (ai/world.js, the NPCs'
// readback), made when a body first gets it and refreshed only while some body has it
const models = new WeakMap();
function worldFor(ctx) {
  if (!ctx.renderer || !ctx.getSim) return null;
  if (!models.has(ctx.renderer)) models.set(ctx.renderer, createWorldModel({ renderer: ctx.renderer, getSim: ctx.getSim }));
  return models.get(ctx.renderer);
}

// A safe open spot for a body's feet within [TELEPORT_MIN, TELEPORT_MAX] of `from`: the topmost
// surface in a column, on solid or powder (not a liquid), with the body's box clear of solids,
// powders and liquids, and nothing burning hot near it. null if no try finds one.
export function safeSpot(world, from, rand = Math.random) {
  const [nx, ny, nz] = world.dims;
  const hw = BODY_WIDTH / 2;
  for (let i = 0; i < TELEPORT_TRIES; i++) {
    const a = rand() * 2 * Math.PI, d = TELEPORT_MIN + rand() * (TELEPORT_MAX - TELEPORT_MIN);
    const x = from.x + Math.cos(a) * d, z = from.z + Math.sin(a) * d;
    if (x < TELEPORT_EDGE || z < TELEPORT_EDGE || x > nx - TELEPORT_EDGE || z > nz - TELEPORT_EDGE) continue;
    const y = world.standAt(x, z, ny);
    if (y + BODY_HEIGHT >= ny) continue;
    if (y > 0) {
      const under = world.id(x, y - 1, z);
      if (under === E.EMPTY || KIND[under] === K.LIQUID || KIND[under] === K.GAS) continue;
    }
    let clear = true;
    for (let yy = y; clear && yy < y + BODY_HEIGHT; yy++)
      for (const [dx, dz] of [[-hw, -hw], [hw, -hw], [-hw, hw], [hw, hw], [0, 0]]) {
        if (world.blocks(x + dx, yy, z + dz) || world.isLiquid(x + dx, yy, z + dz)) { clear = false; break; }
      }
    if (!clear || world.hotNear({ x, y: y + BODY_HEIGHT / 2, z }, TELEPORT_HOT_REACH)) continue;
    return { x, y, z };
  }
  return null;
}

registerStatus({
  key: 'LEVITATING', name: 'Levitating', icon: '🪶', color: '#a7ad7a',
  tint: [0.5, 0.52, 0.32, 0.35], screen: 'rgba(170, 175, 110, 0.45)',
});
registerStatus({
  key: 'TELEPORTITIS', name: 'Teleportitis', icon: '🌀', color: '#3cc6e8',
  onStart(body, ctx) { ctx.teleportIn = TELEPORT_EVERY[0]; },
  onTick(body, dt, ctx) {
    const world = worldFor(ctx);
    if (!world) return;
    world.update(dt);
    ctx.teleportIn = (ctx.teleportIn ?? TELEPORT_EVERY[0]) - dt;
    if (ctx.teleportIn > 0 || !world.ready || !body.teleport) return;
    ctx.teleportIn = TELEPORT_EVERY[0] + Math.random() * (TELEPORT_EVERY[1] - TELEPORT_EVERY[0]);
    const to = safeSpot(world, body.pos);
    if (!to) return;
    const from = body.pos.clone();
    body.teleport(from.clone().set(to.x, to.y, to.z));
    const payload = { from, to: body.pos.clone() };
    if (ctx.set?.actor) povEvents.as(ctx.set.actor, () => povEvents.emit('teleport', payload));
    else povEvents.emit('teleport', payload);
  },
  tint: [0.2, 0.62, 0.75, 0.4], screen: 'rgba(60, 200, 240, 0.45)',
});
registerStatus({
  key: 'REGENERATION', name: 'Regeneration', icon: '💚', color: '#c8f26a',
  onTick(body, dt) { body.heal?.(REGEN_RATE * dt); },
  tint: [0.55, 0.8, 0.3, 0.35], screen: 'rgba(190, 240, 100, 0.4)',
});
registerStatus({
  key: 'BERSERK', name: 'Berserk', icon: '💢', color: '#ef5a26', damage: BERSERK_DAMAGE,
  tint: [0.8, 0.25, 0.1, 0.4], screen: 'rgba(240, 80, 30, 0.45)',
});
registerStatus({
  key: 'CHARMED', name: 'Charmed', icon: '💕', color: '#ff3d62',
  tint: [0.9, 0.3, 0.45, 0.35], screen: 'rgba(255, 70, 110, 0.4)',
});
registerStatus({
  key: 'POLYMORPH', name: 'Polymorph', icon: '🐑', color: '#ee6fcf', noTools: true,
  tint: [0.85, 0.45, 0.75, 0.45], screen: 'rgba(240, 110, 210, 0.45)',
});

// [element key, status key, its submerge time]
const POTIONS = [
  ['LEVITATIUM', 'LEVITATING', LEVITATE_S],
  ['TELEPORTATIUM', 'TELEPORTITIS', TELEPORT_S],
  ['HEALTHIUM', 'REGENERATION', REGEN_S],
  ['BERSERKIUM', 'BERSERK', BERSERK_S],
  ['PHEROMONE', 'CHARMED', CHARM_S],
  ['POLYMORPHINE', 'POLYMORPH', POLYMORPH_S],
];
// a drink adds its seconds to what's left (Noita's ingestion adds up)
const drinkGives = (statusKey, seconds) => (body, d) => body.status?.add(statusKey, (body.status.time(statusKey) ?? 0) + seconds * d.share, 1, d.key);
for (const [element, status, seconds] of POTIONS) {
  registerStain(element, status, { rate: POTION_STAIN_RATE, seconds });
  registerIngestion(element, drinkGives(status, seconds));
}
registerIngestion('TOXIC', drinkGives('TOXIC', TOXIC_DRINK_S));

export const POTION_STATUS = Object.fromEntries(POTIONS.map(([element, status]) => [element, status]));
export const POTION_TIMES = { LEVITATE_S, TELEPORT_S, REGEN_S, BERSERK_S, CHARM_S, POLYMORPH_S, TOXIC_DRINK_S, REGEN_RATE, TELEPORT_MIN, TELEPORT_MAX };
