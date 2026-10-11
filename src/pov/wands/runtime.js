import * as THREE from 'three';
import { compileWand } from './compiler.js';
import { createWandWorld } from './world.js';
import { createWandVisuals } from './visuals.js';
import { E, ELEMENTS, K } from '../../elements.js';
import { Load, sharedTransfer, cellsNear, outsideBody, toStepVelocity, TRANSFER_SLOTS } from '../tools/transfer.js';
import { areaTargets, segmentTarget, PLAYER } from '../targets.js';
import { povEvents } from '../events.js';
import { toolDt } from '../tools/action.js';
import { BODY_WIDTH, BODY_HEIGHT } from '../constants.js';

export const WAND_LIMITS = Object.freeze({
  casts: 4, nodes: 128, events: 512, projectiles: 256, fields: 64,
  rays: 128, traceBatches: 2, commands: 64, transfers: 2, transferQueue: 128,
  lights: 8, beamSamples: 16, inventory: 4096, dt: 0.1, flightStep: 0.25, traceFailures: 8,
});
const stores = new WeakMap();
const finite = (x, fallback = 0) => Number.isFinite(x) ? x : fallback;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const clone = (value) => structuredClone(value);
const zero = new THREE.Vector3();

// Every retained position is a world-cell position. Only adapter calls use grid
// coordinates. Async answers are consumed on a running simulation tick, never
// in a promise callback: pausing freezes impacts, timers, teleports and damage.
export function createWandRuntime(env) {
  const world = env.world ?? createWandWorld(env);
  const visuals = env.visuals ?? createWandVisuals(env);
  const transfer = env.transfer ?? sharedTransfer(env);
  const compile = env.compileWand ?? compileWand;
  const key = env.renderer ?? env;
  if (!stores.has(key)) stores.set(key, new Map());
  let inventories = stores.get(key);
  let definition = null, compiled = null, current = null, selected = false;
  let sim = env.getSim?.() ?? null, generation = 0, disposed = false, time = 0;
  const offset = new THREE.Vector3().copy(sim?.origin ?? zero);
  let ctx = null, nodesLeft = 0, tracePending = 0, transferPending = 0, clearancePending = 0;
  let frameCommands = 0, frameTransfers = 0, frameNodes = 0, frameCasts = 0, frameRays = 0;
  let projectiles = [], fields = [], events = [], rayJobs = [], answers = [], transfers = [];
  let lastError = '', lastScan = null;
  const totals = { casts: 0, rejected: 0, dropped: 0, traceErrors: 0, transferErrors: 0, teleports: 0 };
  const grid = (p) => p.clone().sub(offset);
  const absolute = (p) => p.clone().add(offset);
  const valid = (g, s) => !disposed && g === generation && s === sim && (!env.getSim || env.getSim() === s);
  const active = () => !!(projectiles.length || fields.length || events.length || rayJobs.length
    || answers.length || transfers.length || tracePending || transferPending || clearancePending || visuals.active);
  function error(message) { lastError = message; }
  function refund(cargo) {
    if (!cargo) return;
    cargo.home.cells.push(...cargo.load.cells.splice(0));
    cargo.home.out -= cargo.reserved ?? 0;
    cargo.reserved = 0;
    cargo.home.version++;
  }
  function enqueue(node, at, dir, cast, due = time) {
    if (events.length >= WAND_LIMITS.events) { totals.dropped++; return false; }
    events.push({ node, at: at.clone(), dir: dir.clone(), cast, due });
    return true;
  }
  function queue(command) {
    if (frameCommands >= WAND_LIMITS.commands || !world.queue(command)) { totals.dropped++; return false; }
    frameCommands++;
    return true;
  }
  function transferJob(job) {
    if (transfers.length >= WAND_LIMITS.transferQueue) { refund(job.cargo); totals.dropped++; return; }
    transfers.push(job);
  }
  function damage(node, at, dir, cast, direct = null, dt = 1) {
    const amount = clamp(finite(node.params.damage), 0, 100) / 100 * dt;
    if (!amount) return;
    const hits = direct ? [{ target: direct }] : areaTargets(grid(at), node.params.radius ?? 1, cast.owner);
    povEvents.as({ id: cast.owner, at: grid(cast.origin) }, () => {
      for (const { target } of hits) target.hurt(amount, `Wand: ${node.id ?? node.effect}`, dir.clone());
    });
  }
  function commandFor(node, at, dir, dt) {
    const p = node.params;
    return { effect: node.effect, center: grid(at), dir: dir.clone(),
      radius: clamp(finite(p.radius, 1), 0.1, 24), power: finite(p.power, 1),
      material: p.material, temperature: ELEMENTS[E[p.material]]?.temp,
      velocity: dir.clone().multiplyScalar(clamp(finite(p.speed), 0, 1200)), dt, shape: 'sphere' };
  }
  function addField(node, at, dir, cast) {
    if (fields.length >= WAND_LIMITS.fields) { totals.dropped++; return; }
    fields.push({ node, at: at.clone(), dir: dir.clone(), cast,
      until: time + clamp(finite(node.params.lifetime, 1), 0.02, 60), next: time });
  }
  function leaf(node, at, dir, cast, { hit = null, cargo = null, field = false, dt = 1 } = {}) {
    const p = node.params;
    if (!cast.payloadOrigin && (node.op === 'beam' || node.op === 'touch')
        && (node.effect === 'place' || node.effect === 'emit') && cast.player?.pos) {
      // Trim creation samples, not the eye-origin ray: nearby walls still block
      // the spell, while remote payloads deliberately keep their impact origin.
      const relative = grid(at).sub(cast.player.pos), hw = BODY_WIDTH / 2;
      const dx = Math.max(0, Math.abs(relative.x) - hw);
      const dy = Math.max(0, -relative.y, relative.y - BODY_HEIGHT);
      const dz = Math.max(0, Math.abs(relative.z) - hw);
      if (dx * dx + dy * dy + dz * dz <= clamp(finite(p.radius, 1), 0.5, 24) ** 2) return;
    }
    if (node.effect === 'teleport') {
      if (clearancePending || !cast.player?.teleport) return;
      const feet = at.clone();
      if (hit?.normal) feet.addScaledVector(hit.normal, BODY_WIDTH / 2 + 0.25);
      const g = generation, s = sim;
      clearancePending++;
      Promise.resolve().then(() => valid(g, s) ? world.clearance(grid(feet)) : false).then((clear) => {
        if (valid(g, s)) answers.push({ teleport: clear ? feet : null, cast });
      }).catch(() => { if (valid(g, s)) error('Teleport clearance unavailable'); }).finally(() => {
        if (g === generation) clearancePending--;
      });
      return;
    }
    if (node.effect === 'scan') {
      lastScan = hit ? { id: hit.id, material: ELEMENTS[hit.id]?.name ?? 'Actor', point: grid(at) } : null;
      env.hud?.toast?.(lastScan ? lastScan.material : 'No material in range');
      return;
    }
    if (node.effect === 'light') {
      if (!field) addField({ ...node, op: 'field' }, at, dir, cast);
      return;
    }
    if (node.effect === 'absorb' || p.stored && (node.effect === 'emit' || node.effect === 'place')) {
      transferJob({ node, at: at.clone(), dir: dir.clone(), cast, cargo,
        take: node.effect === 'absorb', debris: node.id === 'vacuum', expires: time + 1 });
      damage(node, at, dir, cast, hit?.target, dt);
      return;
    }
    const command = commandFor(node, at, dir, dt);
    // Spark is a short hot pressure impact, not synthetic stored matter.
    if (node.effect === 'spark') { command.effect = 'heat'; command.power = finite(p.power, 100); }
    if (queue(command)) {
      damage(node, at, dir, cast, hit?.target, dt);
      if (p.collect && node.effect === 'dig') {
        transferJob({ node, at: at.clone(), dir: dir.clone(), cast, take: true, debris: true, expires: time + 1 });
      }
      if (!field) visuals.pulse(grid(at), node.effect, Math.min(p.radius ?? 1, 3));
    }
    refund(cargo);
  }
  function reserveMatter(node, home) {
    const count = Math.min(TRANSFER_SLOTS, Math.max(1, Math.ceil(4 / 3 * Math.PI * (node.params.radius ?? 1) ** 3)));
    const load = new Load(count), id = E[node.params.material];
    for (let i = home.cells.length - 1; i >= 0 && load.cells.length < count; i--) {
      if (id === undefined || home.cells[i][0] === id) load.cells.push(...home.cells.splice(i, 1));
    }
    home.out += load.cells.length;
    home.version++;
    return { load, home, reserved: load.cells.length };
  }
  function execute({ node, at, dir, cast, apply, options }) {
    if (apply) { leaf(node, at, dir, cast, options); return; }
    const p = node.params ?? {};
    if (node.op === 'multi' || node.op === 'burst') {
      node.children?.forEach((child, i) => enqueue(child, at, dir, cast,
        time + (node.op === 'burst' ? i * Math.max(0.02, finite(p.interval, 0.1)) : 0)));
      return;
    }
    if (p.spread) {
      // Uniform disk in the plane perpendicular to aim; spread is in radians.
      const side = new THREE.Vector3(0, 1, 0).cross(dir);
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0); else side.normalize();
      const up = dir.clone().cross(side), a = Math.random() * Math.PI * 2;
      const r = Math.tan(clamp(p.spread, 0, 1.3)) * Math.sqrt(Math.random());
      dir = dir.clone().addScaledVector(side, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
    }
    if (p.recoil) cast.player?.applyImpulse?.(dir.clone().multiplyScalar(-clamp(p.recoil, -200, 200)));
    if (node.op === 'self') { leaf(node, at, dir, cast); return; }
    if (node.op === 'field') { addField(node, at, dir, cast); return; }
    if (node.op === 'projectile') {
      if (projectiles.length >= WAND_LIMITS.projectiles) { totals.dropped++; return; }
      const cargo = p.stored && (node.effect === 'emit' || node.effect === 'place') ? reserveMatter(node, cast.load) : null;
      if (cargo && !cargo.load.cells.length) { error('Stored material depleted'); return; }
      projectiles.push({ node, at: at.clone(), velocity: dir.clone().multiplyScalar(clamp(finite(p.speed, 60), 0, 1200)),
        cast, cargo, age: 0, started: time - clamp(finite(ctx.dt), 0, WAND_LIMITS.dt),
        pending: false, triggered: false, alive: true, traceFailures: 0,
        bounces: Math.max(0, finite(p.bounces)), pierce: Math.max(0, finite(p.pierce)), ignored: new Set() });
      return;
    }
    if (node.op === 'touch' && cast.payloadOrigin) {
      leaf(node, at, dir, cast, { hit: cast.payloadHit }); return;
    }
    if (node.op === 'beam' || node.op === 'touch') {
      if (rayJobs.length >= WAND_LIMITS.rays) { totals.dropped++; return; }
      const range = node.op === 'touch' ? 8 : clamp(finite(p.speed, 80) * finite(p.lifetime, 1), 8, 256);
      rayJobs.push({ node, from: at.clone(), to: at.clone().addScaledVector(dir, range), dir, cast });
    }
  }
  function triggerPayload(r, trigger, hit = null) {
    if (!r.triggered && r.node.payload && r.node.trigger === trigger) {
      r.triggered = true;
      enqueue(r.node.payload, r.at, r.velocity.clone().normalize(), { ...r.cast, payloadOrigin: true, payloadHit: hit });
    }
  }
  function endFlight(r, hit, expiry = false) {
    const dir = r.velocity.clone().normalize();
    leaf(r.node, r.at, dir, r.cast, { hit, cargo: r.cargo });
    r.cargo = null;
    triggerPayload(r, expiry ? 'expiry' : 'impact', hit);
    r.alive = false;
  }
  function consumeRay(job, terrain) {
    const from = grid(job.from), to = terrain ? grid(terrain.point) : grid(job.to);
    // Exclude pierced actors during the nearest-hit search, not afterward: an
    // overlapping previous hit must not hide the next actor along the segment.
    // The terrain-clipped segment still lets walls shield actors.
    const actor = segmentTarget(from, to, job.cast.owner, job.flight?.ignored);
    const hit = actor ? { target: actor.target, point: absolute(actor.point), normal: job.dir.clone().negate(), id: -1 } : terrain;
    if (job.flight) {
      const r = job.flight;
      if (!r.alive) return;
      r.traceFailures = 0;
      r.pending = false;
      r.age += job.dt;
      r.velocity.copy(job.velocity);
      r.at.copy(hit?.point ?? job.to);
      if (hit) {
        if (r.bounces > 0 && !actor) {
          r.bounces--; r.velocity.reflect(hit.normal); r.at.addScaledVector(hit.normal, 0.15);
        } else if (r.pierce > 0 && !r.cargo) {
          r.pierce--; leaf(r.node, r.at, job.dir, r.cast, { hit });
          triggerPayload(r, 'impact', hit);
          if (actor) r.ignored.add(actor.target.id);
          r.at.addScaledVector(job.dir, 0.6);
        } else { endFlight(r, hit); return; }
      }
      if (r.node.trigger === 'timer' && r.age + 1e-6 >= finite(r.node.params.delay, 0.5)) triggerPayload(r, 'timer');
      if (r.age + 1e-6 >= finite(r.node.params.lifetime, 2)) { endFlight(r, null, true); return; }
      if (r.node.params.trail) queue({ ...commandFor(r.node, r.at, job.dir, job.dt), effect: 'emit', radius: 0.6, material: r.node.params.trail });
      return;
    }
    const end = hit?.point ?? job.to;
    visuals.pulse(grid(end), job.node.effect, 0.3, grid(job.from));
    if (job.node.op === 'beam' && !['teleport', 'scan', 'absorb', 'light'].includes(job.node.effect) && !job.node.params.stored) {
      const length = end.distanceTo(job.from);
      const n = Math.min(WAND_LIMITS.beamSamples, Math.max(1, Math.ceil(length / Math.max(1, job.node.params.radius ?? 1))));
      for (let i = 1; i <= n; i++) {
        if (enqueue(job.node, job.from.clone().lerp(end, i / n), job.dir, job.cast)) {
          Object.assign(events.at(-1), { apply: true, options: { hit: i === n ? hit : null, dt: 1 / n } });
        }
      }
    } else leaf(job.node, end, job.dir, job.cast, { hit });
  }
  function trace() {
    if (tracePending >= WAND_LIMITS.traceBatches) return;
    const jobs = rayJobs.splice(0, WAND_LIMITS.rays);
    for (const r of projectiles) {
      if (jobs.length >= WAND_LIMITS.rays) break;
      if (r.pending || !r.alive) continue;
      const p = r.node.params;
      // Readback latency leaves simulation time owed, not discarded. Advance
      // only after a verified segment; cap catch-up work and split at timers.
      // ponytail: sustained reads slower than flightStep still lag; batched
      // substeps are the upgrade if that latency becomes common.
      let step = Math.min(WAND_LIMITS.flightStep, Math.max(0, time - r.started - r.age),
        Math.max(0, finite(p.lifetime, 2) - r.age));
      if (r.node.trigger === 'timer' && !r.triggered) step = Math.min(step, Math.max(0, finite(p.delay, 0.5) - r.age));
      const velocity = r.velocity.clone();
      if (p.homing) {
        const target = areaTargets(grid(r.at), 32, r.cast.owner)[0];
        if (target) velocity.lerp(absolute(target.point).sub(r.at).setLength(velocity.length()), clamp(p.homing * step, 0, 1));
      }
      const to = r.at.clone().addScaledVector(velocity, step);
      to.y -= finite(p.gravity) * step * step / 2;
      velocity.y -= finite(p.gravity) * step;
      r.pending = true;
      jobs.push({ flight: r, from: r.at.clone(), to, velocity, dir: velocity.clone().normalize(), dt: step, cast: r.cast });
    }
    if (!jobs.length) return;
    const g = generation, s = sim;
    frameRays += jobs.length; tracePending++;
    // Capture request vectors now; the adapter remaps returned hits into its
    // CURRENT grid after window shifts. Convert those to world positions here.
    let promise;
    try { promise = world.trace(jobs.map((j) => ({ from: grid(j.from), to: grid(j.to) }))); }
    catch (err) { promise = Promise.reject(err); }
    Promise.resolve(promise).then((hits) => {
      if (!valid(g, s)) return;
      if (!Array.isArray(hits) || hits.length !== jobs.length) throw new Error('Incomplete wand trace');
      jobs.forEach((job, i) => {
        const h = hits[i];
        answers.push({ job, hit: h ? { ...h, point: absolute(h.point), normal: h.normal.clone() } : null });
      });
    }).catch(() => {
      if (!valid(g, s)) return;
      totals.traceErrors++; error('Collision query unavailable');
      // Fail closed: a failed ray never advances a flight or fires its payload.
      for (const job of jobs) if (job.flight) {
        const r = job.flight;
        r.pending = false;
        if (++r.traceFailures >= WAND_LIMITS.traceFailures) {
          r.alive = false;
          refund(r.cargo); r.cargo = null;
          totals.dropped++;
        }
      }
    }).finally(() => { if (g === generation) tracePending--; });
  }
  function runTransfers() {
    const count = transfers.length;
    for (let i = 0; i < count && frameTransfers < WAND_LIMITS.transfers; i++) {
      const job = transfers.shift(), p = job.node.params;
      if (job.expires < time) { refund(job.cargo); continue; }
      const load = job.cargo?.load ?? job.cast.load;
      const center = grid(job.at), feet = job.cast.player?.pos;
      const radius = clamp(finite(p.radius, 2), 0.9, 8);
      const cells = cellsNear(center, radius, sim.g, feet ? outsideBody(feet, 0.1) : null);
      let promise;
      frameTransfers++; // bound attempted GPU transfers too, including failures
      try {
        promise = job.take
          ? transfer.take(load, { cells, kinds: job.debris ? [K.POWDER] : [K.LIQUID],
            want: job.debris ? -1 : E[p.material] ?? -1, limit: TRANSFER_SLOTS })
          : transfer.put(load, { cells, max: TRANSFER_SLOTS, id: E[p.material] ?? -1,
            vel: toStepVelocity(job.dir.clone().multiplyScalar(finite(p.speed)), ctx) });
      } catch (err) { error(String(err)); totals.transferErrors++; refund(job.cargo); continue; }
      if (!promise) {
        // Empty/full inventories are not deferred forever; busy engines retry.
        if (transfer.busy) transfers.push(job); else refund(job.cargo);
        continue;
      }
      transferPending++;
      const g = generation;
      Promise.resolve(promise).catch((err) => {
        if (g === generation) { error(`Transfer failed: ${err.message ?? err}`); totals.transferErrors++; }
      }).finally(() => {
        refund(job.cargo);
        if (g === generation) transferPending--;
      });
    }
  }
  function advanceEvents() {
    // Due events preserve insertion order (multicast siblings) and delayed
    // events cannot block immediate siblings. The queue and scan are bounded.
    for (let i = 0; i < events.length && nodesLeft > 0;) {
      if (events[i].due > time) { i++; continue; }
      const event = events.splice(i, 1)[0];
      nodesLeft--; frameNodes++; execute(event);
    }
  }
  function draw(dt) {
    const items = [], lights = [];
    for (const r of projectiles) if (r.alive) {
      items.push({ position: grid(r.at), effect: r.node.effect, radius: Math.min(r.node.params.radius ?? 0.3, 0.65) });
    }
    for (const f of fields) {
      items.push({ position: grid(f.at), effect: f.node.effect, radius: Math.min(f.node.params.radius ?? 1, 2) });
      if (f.node.effect === 'light' && lights.length < WAND_LIMITS.lights) lights.push({ position: grid(f.at),
        color: [1, 0.85, 0.55], radius: f.node.params.radius ?? 12, intensity: f.node.params.power ?? 2 });
    }
    world.setLights(lights);
    visuals.update(items, dt);
    if (active()) env.requestRender?.();
  }
  function advance(nextCtx, firing) {
    if (disposed) return;
    if (nextCtx.sim !== sim) { sim = nextCtx.sim; resetWorld(); }
    ctx = nextCtx;
    frameCommands = frameTransfers = frameNodes = frameCasts = frameRays = 0;
    world.begin(ctx);
    const dt = ctx.stepsPerFrame > 0 && !ctx.paused ? clamp(finite(ctx.dt), 0, WAND_LIMITS.dt) : 0;
    if (!sim || !dt) { draw(0); return; }
    time += dt; nodesLeft = WAND_LIMITS.nodes;
    // Cast delays and recharge count down on the tool clock: Faster Tools speeds
    // wands like Noita's Faster Wands (pov/perks.js). Mana regen stays on plain dt.
    const toolStep = toolDt({ dt, toolRate: ctx.toolRate });
    for (const state of inventories.values()) {
      state.mana = Math.min(state.manaMax, state.mana + state.manaRegen * dt);
      state.cooldown = Math.max(-WAND_LIMITS.dt, state.cooldown - toolStep);
    }
    while (answers.length && nodesLeft > 0) {
      const answer = answers.shift(); nodesLeft--; frameNodes++;
      if (answer.job) consumeRay(answer.job, answer.hit);
      else if (answer.teleport) { answer.cast.player.teleport(grid(answer.teleport)); totals.teleports++; }
    }
    projectiles = projectiles.filter((r) => r.alive);
    if (firing && selected && ctx.primary && current && !compiled.errors.length) {
      // Noita's actions_per_round: a cast draws up to spellsPerCast roots, stopping
      // at the deck's end (no wrap); shuffle reorders the deck every recharge.
      const perCast = Math.max(1, Math.floor(finite(compiled.config.spellsPerCast, 1)));
      while (current.cooldown <= 0 && frameCasts < WAND_LIMITS.casts && events.length < WAND_LIMITS.events) {
        const order = deckOrder(current);
        const picks = [];
        for (let k = current.index; k < compiled.casts.length && picks.length < perCast; k++) picks.push(order[k]);
        if (!picks.length) break;
        const cost = picks.reduce((sum, i) => sum + Math.max(0, finite(compiled.casts[i].params.mana)), 0);
        if (current.mana < cost) { totals.rejected++; error('Not enough mana'); break; }
        if (events.length + picks.length > WAND_LIMITS.events) break;
        const at = absolute(ctx.eye), dir = ctx.dir.clone().normalize();
        const cast = { owner: ctx.owner?.id ?? ctx.owner ?? env.owner ?? povEvents.actor?.id ?? PLAYER,
          player: ctx.player, load: current.load, origin: at.clone() };
        for (const i of picks) enqueue(clone(compiled.casts[i]), at, dir, cast);
        current.mana -= cost; frameCasts++; totals.casts++; lastError = '';
        current.cooldown += picks.length === 1
          ? Math.max(0.02, finite(compiled.stats.castDelays?.[picks[0]], compiled.config.castDelay))
          : clamp(finite(compiled.config.castDelay) + picks.reduce((sum, i) => sum + finite(compiled.casts[i].params.castDelay), 0), 0.02, 30);
        current.index += picks.length;
        if (current.index >= compiled.casts.length) {
          current.index = 0;
          current.order = null;   // reshuffled on the next draw
          current.cooldown += Math.max(0, finite(compiled.stats.recharge, compiled.config.recharge));
        }
      }
    } else if (current) current.cooldown = Math.max(0, current.cooldown);
    advanceEvents();
    for (const f of fields) if (f.until > time && f.next <= time && nodesLeft > 0) {
      nodesLeft--; frameNodes++;
      leaf(f.node, f.at, f.dir, f.cast, { field: true, dt: 0.1 });
      f.next = time + 0.1;
    }
    fields = fields.filter((f) => f.until > time);
    trace();
    world.flush(); // dig first, then exact collection reads the resulting debris
    runTransfers();
    draw(dt);
  }
  // the deck's draw order this cycle: in order, or (shuffle) a fresh permutation per recharge
  function deckOrder(state) {
    const n = compiled.casts.length;
    if (state.order?.length === n) return state.order;
    state.order = [...Array(n).keys()];
    if (compiled.config.shuffle) {
      const random = env.random ?? Math.random;
      for (let i = n - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [state.order[i], state.order[j]] = [state.order[j], state.order[i]]; }
    }
    return state.order;
  }
  function applyDefinition(def) {
    const next = clone(def);
    const result = compile(next.cards ?? [], next.config ?? {});
    definition = next; compiled = result;
    const id = `${env.owner ?? PLAYER}:${next.id ?? 'custom'}`;
    if (!inventories.has(id)) {
      const load = new Load(WAND_LIMITS.inventory), reservoir = next.sandboxReservoir;
      if (reservoir && E[reservoir.material] !== undefined) {
        const element = ELEMENTS[E[reservoir.material]];
        const count = clamp(Math.floor(finite(reservoir.count)), 0, load.capacity);
        for (let i = 0; i < count; i++) load.cells.push([E[reservoir.material], element.temp ?? 20, element.life ?? 0, 0]);
      }
      inventories.set(id, { load, mana: result.config.manaMax, manaMax: result.config.manaMax,
        manaRegen: result.config.manaRegen, cooldown: 0, index: 0 });
    }
    current = inventories.get(id);
    current.manaMax = result.config.manaMax; current.manaRegen = result.config.manaRegen;
    current.mana = Math.min(current.mana, current.manaMax);
    const signature = JSON.stringify([next.cards, result.config]);
    if (signature !== current.signature) { current.index = 0; current.order = null; current.signature = signature; }
    return result;
  }
  function cancelEffects() {
    for (const r of projectiles) refund(r.cargo);
    for (const job of transfers) refund(job.cargo);
    projectiles = []; fields = []; events = []; rayJobs = []; answers = []; transfers = [];
    generation++; tracePending = transferPending = clearancePending = 0;
    visuals.clear(); world.setLights([]);
  }
  function resetWorld() {
    cancelEffects();
    inventories = new Map(); stores.set(key, inventories);
    offset.copy(sim?.origin ?? zero);
    current = null; time = 0;
    if (definition) applyDefinition(definition);
  }
  return {
    equip(def) { const result = applyDefinition(def); selected = true; return result; },
    setDefinition: applyDefinition,
    update(nextCtx) { advance(nextCtx, true); },
    tick(nextCtx) { advance(nextCtx, false); },
    deselect() { selected = false; },
    // every wand this runtime has held back to full mana and ready to fire (Noita's spell refresher, Descent's temples)
    refill() { for (const state of inventories.values()) { state.mana = state.manaMax; state.cooldown = Math.min(state.cooldown, 0); } },
    resetWorld,
    windowShifted(dx, dz) { offset.x += dx; offset.z += dz; world.windowShifted(dx, dz); visuals.windowShifted(dx, dz); },
    dispose() { if (disposed) return; cancelEffects(); disposed = true; world.dispose(); visuals.dispose(); },
    get active() { return active(); },
    get definition() { return definition; },
    get compiled() { return compiled; },
    get stats() { return { ...totals, generation, time, mana: current?.mana ?? 0, manaMax: current?.manaMax ?? 0,
      castIndex: current?.index ?? 0, cooldown: current?.cooldown ?? 0, projectiles: projectiles.length,
      fields: fields.length, events: events.length, queuedRays: rayJobs.length, tracePending, transferPending, clearancePending,
      queuedTransfers: transfers.length, inventory: current?.load.count ?? 0, inventoryInFlight: current?.load.out ?? 0, inventoryTotals: current?.load.totals() ?? {},
      frameCommands, frameTransfers, frameNodes, frameCasts, frameRays, limits: WAND_LIMITS, lastError, lastScan,
      world: world.stats, visuals: visuals.stats }; },
    get mana() { return current ? { mana: current.mana, manaMax: current.manaMax } : null; },
    status() {
      if (!compiled) return 'No wand';
      if (compiled.errors.length) return 'Invalid wand';
      const storage = current.load.status();
      // mana is the HUD's bar (hud.js), not this note
      return [storage, lastError].filter(Boolean).join(' · ');
    },
  };
}
