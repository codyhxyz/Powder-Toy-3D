import { E } from '../elements.js';
import { povEvents } from './events.js';

// Status effects: Noita's stains and conditions, on a first-person body (the
// player's and every NPC's: createPlayer builds a set for each). A status is
// on or off, with the seconds it has left and a strength. Most come from what
// the body touches: a stain (registerStain) builds a status from the share of
// the body's contact cells that hold its element, times the time spent there,
// and every status fades with time once the source is gone, as Noita's do.
// The built-in ones (Wet, Oily, Burning, Frozen, Toxic, Slimy, Bloody) are in
// stains.js; other modules add their own through the same calls (docs/pov.md,
// "Status effects").
//
// Rules between statuses are data on the definitions:
//   cancels: [keys]  either one coming on clears the other (symmetric: listing it on one side is enough)
//   blocks:  [keys]  while this is on, those can't build or be added (Wet blocks Burning)
//   wash:    × fade  while Wet: water rinses the stain off this many times faster (1: it doesn't wash off)
//   move:    × speed on foot while on (one hook for every status: player.js multiplies by moveScale)
//   damage:  × damage the body's weapons deal to bodies while on (targets.js dealtScale: Berserk)
//   noTools: true while on, the body can't use its tools (tools/index.js: Polymorph)
//   full:    it comes on at its whole duration (a fire, once lit, burns its fuel), not at what built it
//   refresh: false: while on, its stains don't add to it (Burning burns its own budget down)
//
// A stain builds at rate × share and wears off at 1 s/s (× fade) all the while, so it only
// ever shows where rate × share > 1: a share under 1/rate never stains.
//
// Events (pov/events.js): 'status:on' { key, cause } and 'status:off' { key, cause }.
// cause: what did it ('WATER' an element key, 'BURNING' the status that cancelled it,
// 'add' a direct add, 'faded', 'cleared', 'died'). An NPC's carry by/from as every NPC emit does.
//
// Pure data and bookkeeping (no three.js): tools/status-check.mjs runs it in node.

// ---- tuning
export const STAIN_SHOW_S = 0.5;        // s of stain built before a stain shows and acts (a splash on a boot doesn't count)
// Electricity (branch el-elec): a live cell the body touches shocks it. How a probe tells a
// live cell is el-elec's (docs/electricity.md, "Telling a live cell"): the probe's 4th channel
// holds its spark, 0..1. player.js puts that in env.contactSpark; until el-elec lands it's 0.
const SHOCK_DAMAGE = 0.5;               // health/s from a full-strength (1) live cell touching dry skin (game tuning: 2 s to die)
export const WET_SHOCK = 3;             // × shock damage while Wet: wet skin's resistance is a few times lower (IEC 60479-1: ~1 kΩ wet vs a few kΩ dry)

const DEFS = new Map();                 // key → definition, in registration order
const STAINS = [];                      // { elementKey, statusKey, rate, seconds }
let byId = null;                        // element id → its stains, rebuilt after a registration

// A status: { key, name, icon, color, cancels?, blocks?, wash?, move?, show?, tint?, screen?,
//   buildRate?(set), duration?(set), fade?(body, set), when?(body, env, set),
//   onStart?(body, ctx), onTick?(body, dt, ctx), onEnd?(body, ctx) }
// color: the HUD icon's; tint: [r, g, b, a] over the figure's albedo (linear); screen: a CSS
// colour for the first-person tint (none: no tint). buildRate/duration: × every stain's rate and
// seconds (Oily lets fire catch faster and burn longer). fade: × the rate it wears off.
// when: seconds to add this frame (0: none), for a status a body starts by itself (heat, cold).
export function registerStatus(def) {
  const d = { cancels: [], blocks: [], wash: 1, move: 1, show: STAIN_SHOW_S, ...def };
  DEFS.set(d.key, d);
  return d;
}

// Touching element `elementKey` builds status `statusKey`: rate s of stain per s with the
// whole skin in it (× the share of contact cells that hold it), up to `seconds`. An element
// that doesn't exist (yet: another branch adds it) is no source: E.KEY ?? -1.
export function registerStain(elementKey, statusKey, { rate, seconds }) {
  STAINS.push({ elementKey, statusKey, rate, seconds });
  byId = null;
}

export const statusDef = (key) => DEFS.get(key);
export const statusDefs = () => [...DEFS.values()];
const cancelling = (a, b) => !!(DEFS.get(a)?.cancels.includes(b) || DEFS.get(b)?.cancels.includes(a));

function stainsById() {
  if (byId) return byId;
  byId = new Map();
  for (const s of STAINS) {
    const id = E[s.elementKey] ?? -1;
    if (id < 0) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(s);
  }
  return byId;
}

// The shock from live cells touching the body, as health/s: SHOCK_DAMAGE × the strongest
// spark it touches (one live conductor is enough to put a current through it), × WET_SHOCK
// while Wet. sparkAt(i) → 0..1 for contact cell i; by default the player's env.contactSpark.
export function shock(env, wet, sparkAt = (i) => env.contactSpark?.[i] ?? 0) {
  let strength = 0;
  for (let i = 0; i < env.contactN; i++) strength = Math.max(strength, sparkAt(i));
  return strength > 0 ? SHOCK_DAMAGE * Math.min(1, strength) * (wet ? WET_SHOCK : 1) : 0;
}

// One body's statuses. body: the player object (pos, skinT, perks, dead, ...).
// ctx: handed to the definitions' hooks, plus { set, env }; the player adds
// hurt(amount, cause, opts) (damage that isn't a blow: no shield, no bleeding)
// and world (stains.js: the body's reach into the grid: fire, blood).
export function createStatusSet(body, ctx = {}) {
  const st = new Map();   // key → { left (s), strength, on }
  let version = 0;        // bumps when a status comes on or goes off (the HUD redraws on it)
  const counts = new Map();
  const set = ctx.set = {
    actor: null,          // an NPC's { id, at }: its events carry by/from (npc.js sets it)
    get version() { return version; },
    has: (key) => !!st.get(key)?.on,
    time: (key) => st.get(key)?.left ?? 0,
    strength: (key) => (st.get(key)?.on ? st.get(key).strength : 0),
    // [{ key, def, left, strength }] of the statuses on, in registration order
    list() {
      const out = [];
      for (const [key, def] of DEFS) {
        const s = st.get(key);
        if (s?.on) out.push({ key, def, left: s.left, strength: s.strength });
      }
      return out;
    },
    // is `key` held off by a status that's on?
    blocked(key) {
      for (const [k, s] of st) if (s.on && DEFS.get(k)?.blocks.includes(key)) return true;
      return false;
    },
    // Put `key` on for at least `seconds` (a longer time left stays), at `strength`.
    // Returns false if it's unknown or blocked.
    add(key, seconds, strength = 1, cause = 'add') {
      const def = DEFS.get(key);
      if (!def || set.blocked(key) || body.dead) return false;
      const s = entry(key);
      s.left = Math.max(s.left, seconds);
      s.strength = Math.max(s.strength, strength);
      if (!s.on) start(key, def, s, cause);
      return true;
    },
    clear(key, cause = 'cleared') {
      const s = st.get(key);
      if (!s) return;
      st.delete(key);
      if (s.on) end(key, cause);
    },
    clearAll(cause = 'cleared') { for (const key of [...st.keys()]) set.clear(key, cause); },
    // × speed on foot from every status on (Frozen, Slimy, and anyone's that sets `move`)
    get moveScale() {
      let m = 1;
      for (const [k, s] of st) if (s.on) m *= DEFS.get(k)?.move ?? 1;
      return m;
    },
    // × damage dealt to bodies from every status on (Berserk's `damage`: potions.js)
    get damageScale() {
      let m = 1;
      for (const [k, s] of st) if (s.on) m *= DEFS.get(k)?.damage ?? 1;
      return m;
    },
    // a status on that leaves the body no hands for tools (Polymorph)
    get noTools() {
      for (const [k, s] of st) if (s.on && DEFS.get(k)?.noTools) return true;
      return false;
    },
    // the figure's tint: the statuses' tints mixed by strength, [r, g, b, a]
    tint(out = [0, 0, 0, 0]) {
      out.fill(0);
      let w = 0;
      for (const [k, s] of st) {
        const t = s.on && DEFS.get(k)?.tint;
        if (!t) continue;
        for (let i = 0; i < 3; i++) out[i] += t[i] * t[3];
        out[3] = Math.max(out[3], t[3]);
        w += t[3];
      }
      if (w > 0) for (let i = 0; i < 3; i++) out[i] /= w;
      return out;
    },
    // the first-person tint: the screen colour of the latest status on that has one, or null
    get screen() {
      let c = null;
      for (const [k, s] of st) if (s.on && DEFS.get(k)?.screen) c = DEFS.get(k).screen;
      return c;
    },

    // Every frame, after vitals: env is the player's (contactId, contactT, contactLife, contactN).
    update(dt, env) {
      if (body.dead) { if (st.size) set.clearAll('died'); return; }
      ctx.env = env;
      // stains: each element's share of the contact cells builds its statuses
      const map = stainsById();
      counts.clear();
      const n = env.contactN;
      for (let i = 0; i < n; i++) {
        const id = env.contactId[i];
        if (map.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      for (const [id, c] of counts) {
        for (const stain of map.get(id)) {
          const def = DEFS.get(stain.statusKey);
          if (!def || set.blocked(def.key)) continue;
          const s = entry(def.key);
          if (s.on && def.refresh === false) continue;   // a status that burns its own budget (Burning)
          const cap = stain.seconds * (def.duration?.(set) ?? 1);
          if (s.left < cap) s.left = Math.min(cap, s.left + stain.rate * (def.buildRate?.(set) ?? 1) * (c / n) * dt);
          if (!s.on && s.left >= def.show) {
            if (def.full) s.left = cap;
            start(def.key, def, s, ELEMENT_KEY[id] ?? 'contact');
          }
        }
      }
      // statuses a body starts by itself (heat, cold)
      for (const def of DEFS.values()) {
        if (!def.when || set.has(def.key) || set.blocked(def.key)) continue;
        const add = def.when(body, env, set);
        if (add > 0) set.add(def.key, add, 1, 'body');
      }
      // tick and fade
      const wet = set.has('WET');
      for (const [key, s] of [...st]) {
        const def = DEFS.get(key);
        if (s.on) def.onTick?.(body, dt, ctx);
        if (!st.has(key)) continue;   // its tick cleared it
        const rate = (def.fade?.(body, set) ?? 1) * (wet && key !== 'WET' ? def.wash : 1);
        s.left -= dt * rate;
        if (s.left <= 0) set.clear(key, 'faded');
      }
      // electricity (see shock)
      const zap = shock(env, wet);
      if (zap > 0) ctx.hurt?.(zap * dt, 'Electrocuted');
    },
  };

  function entry(key) {
    let s = st.get(key);
    if (!s) st.set(key, (s = { left: 0, strength: 1, on: false }));
    return s;
  }
  function start(key, def, s, cause) {
    // either one coming on clears the other
    for (const [k, o] of [...st]) if (k !== key && o.on && cancelling(key, k)) set.clear(k, key);
    s.on = true;
    version++;
    announce('status:on', { key, cause });
    def.onStart?.(body, ctx);
  }
  function end(key, cause) {
    version++;
    announce('status:off', { key, cause });
    DEFS.get(key)?.onEnd?.(body, ctx);
  }
  function announce(name, payload) {
    if (set.actor) povEvents.as(set.actor, () => povEvents.emit(name, payload));
    else povEvents.emit(name, payload);
  }
  return set;
}

// element id → key, for the events' cause
const ELEMENT_KEY = Object.fromEntries(Object.entries(E).map(([k, id]) => [id, k]));
