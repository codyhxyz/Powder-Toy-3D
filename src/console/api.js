import { ELEMENTS, E, K, TOOLS, toolById, isBuild, isSpawnerTool, isGearTool, LIGHTNING_TOOL } from '../elements.js';
import { registerConsoleApi as fn, registerConsoleValue as value, multi } from './registry.js';
import { EDIT, FIELDS } from './world.js';
import { physicalCtype } from '../appearance.js';

// The console's built-in API (docs/console.md): The Powder Toy's Lua names
// (src/lua/LuaSimulation.cpp, LuaElements.cpp, LuaMisc.cpp, and the
// compatibility layer src/lua/luascripts/compat.lua), with a z added to every
// position. TPT's particle index is a cell index here: i = (z · YRES + y) · XRES + x.
//
// installBuiltins(host) registers them against a host (console/index.js wires
// the app; scripts/check-console.mjs a mock):
//   world                       a ScriptWorld (console/world.js)
//   paused(), setPaused(p)
//   step(n)                     run n simulation steps now
//   gravity(), setGravity(g)    in multiples of the default gravity
//   brushRadius(), setBrushRadius(r), brushShape(), setBrushShape(s)
//   selected(), select(id)      the selected element or tool id
//   paint({ x, y, z, radius, shape, tool })   one dab of the brush pass
//   origin()                    the window's world cell (0, 0, 0 outside World)

// Most simulation steps one sim.step call runs: about a second of the
// simulation at its usual ~240 steps/s (README), queued on the GPU at once.
export const MAX_SCRIPT_STEPS = 240;
// Largest brush radius createParts takes (the dock's slider max, app.js setRadius).
const MAX_BRUSH_RADIUS = 24;

const KINDS = Object.fromEntries(Object.entries(K).map(([k, v]) => [v, k]));
const PAINT_TOOL_KEYS = new Set(['ERASE', 'HEAT', 'COOL', 'BLAST', 'SPARK', 'PHOTON', 'NEUTRON']);

// TPT's identifiers: DEFAULT_PT_<name> for elements (DEFAULT_PT_SAND), and
// for tools DEFAULT_TOOL_<name> (tools.index in TPT).
export const identifier = (id) => {
  const it = toolById(id);
  if (!it) return null;
  return id >= 0 ? `DEFAULT_PT_${it.abbr}` : `DEFAULT_TOOL_${it.abbr}`;
};
const BY_NAME = new Map();
for (const e of ELEMENTS) for (const n of [e.abbr, e.key, e.name, identifier(e.id)]) if (!BY_NAME.has(n.toUpperCase())) BY_NAME.set(n.toUpperCase(), e.id);
for (const t of TOOLS) for (const n of [`DEFAULT_TOOL_${t.abbr}`, t.key]) if (!BY_NAME.has(n.toUpperCase())) BY_NAME.set(n.toUpperCase(), t.id);
BY_NAME.set('NONE', E.EMPTY);

// An element (or tool, with tools) given as an id, a TPT identifier, an
// abbreviation (WATR), a key (WATER) or a name (Water).
export function elementId(v, { tools = false } = {}) {
  let id = typeof v === 'number' ? v : typeof v === 'string' ? BY_NAME.get(v.trim().toUpperCase()) : undefined;
  if (id === undefined || !Number.isInteger(id) || !toolById(id) || (id < 0 && !tools)) {
    throw new Error(`Unknown ${tools ? 'element or tool' : 'element'} ${JSON.stringify(v)}`);
  }
  return id;
}
const paintable = (id) => id >= 0 || PAINT_TOOL_KEYS.has(toolById(id)?.key);
const selectable = (id) => id >= 0 || !(isBuild(id) || isSpawnerTool(id) || isGearTool(id) || id === LIGHTNING_TOOL || toolById(id)?.key === 'SIGN');

const num = (v, what) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what} must be a number`);
  return v;
};
const int = (v, what) => Math.floor(num(v, what));

export function installBuiltins(host) {
  const w = () => host.world;
  const sync = (ctx) => ctx?.mode === 'command';
  const size = () => w().size;
  const pos = (i) => {
    const [nx, ny, nz] = size();
    if (!Number.isInteger(i) || i < 0 || i >= nx * ny * nz) return null;
    return w().cellOf(i);
  };
  const xyz = (x, y, z) => [int(x, 'x'), int(y, 'y'), int(z, 'z')];
  // V2's matter in flight (console/world.js flyingAt): a V1 flying cell is a cell, its index the cell's; a
  // V2 packet holds no cell, so it takes an index no cell has, the grid's cell count plus its pool slot
  // (stable while it flies). Its fields as a cell's (console/gpu.js flyingMatter), the air's pressure there.
  // Intentional (decided under the user's delegation, 2026-10-22): that index, not its cell's key (which the
  // grid's cell there owns); sim.parts() still visits it in V1's order, at its cell's key.
  const packetOf = (ctx, i) => {
    const [nx, ny, nz] = size(), n = nx * ny * nz;
    if (!Number.isInteger(i) || i < n || !w().readFlying(sync(ctx))) return null;
    return w().flyingAt(i - n);
  };
  const packetField = (ctx, f, key, i) => {
    const p = [f.x, f.y, f.z];
    if (key === 'pressure') return w().read(...p, sync(ctx))?.pressure ?? null;
    return getField(f, key, p, i);
  };
  // a cell holding matter, or null (air, outside, or not read yet in a handler)
  const matter = (ctx, x, y, z) => {
    const c = w().read(x, y, z, sync(ctx));
    return c && c.id !== E.EMPTY ? c : null;
  };
  const field = (name) => {
    const key = String(name).toLowerCase();
    if (key in FIELDS || ['x', 'y', 'z', 'id'].includes(key)) return key;
    throw new Error(`Unknown field ${JSON.stringify(name)}: use type, temp, life, ctype, vx, vy, vz, pressure (x, y, z read only)`);
  };
  const getField = (c, key, [x, y, z], i) => {
    if (key === 'type') return c.id;
    if (key === 'x') return x;
    if (key === 'y') return y;
    if (key === 'z') return z;
    if (key === 'id') return i;
    if (key === 'ctype') return physicalCtype(c.id, c.ctype);
    return c[key];
  };
  // a write of one field: TPT's partProperty (IF_MATTER) or a cell's (unconditional)
  const setField = (x, y, z, key, v, cond) => {
    if (['x', 'y', 'z', 'id'].includes(key)) throw new Error(`${key} is read only`);
    if (key === 'type') {
      const id = elementId(v);
      // TPT: changing a particle's type to NONE kills it
      if (id === E.EMPTY) return w().edit(x, y, z, EDIT.SPAWN | cond, { type: E.EMPTY });
      return w().edit(x, y, z, (cond ? EDIT.TYPE : EDIT.SPAWN) | cond, { type: id });
    }
    return w().edit(x, y, z, FIELDS[key].bit | cond, { [key]: num(v, key) });
  };
  // the same write to a packet (console/world.js editFlying: V1's partProperty on a flying cell, which is a
  // cell, natively on V2's pool): its pressure is the air's where it flies, the cell's write there
  const setPacketField = (f, key, v) => {
    if (['x', 'y', 'z', 'id'].includes(key)) throw new Error(`${key} is read only`);
    if (key === 'pressure') return w().edit(f.x, f.y, f.z, EDIT.PRESSURE, { pressure: num(v, key) });
    if (key === 'type') {
      const id = elementId(v);
      if (id === E.EMPTY) return w().editFlying(f.slot, EDIT.SPAWN | EDIT.IF_MATTER, { type: E.EMPTY });
      return w().editFlying(f.slot, EDIT.TYPE | EDIT.IF_MATTER, { type: id });
    }
    return w().editFlying(f.slot, FIELDS[key].bit | EDIT.IF_MATTER, { [key]: num(v, key) });
  };

  // ------------------------------------------------------------ sim
  value('sim', 'PT_NUM', ELEMENTS.length, { doc: 'Number of elements (ids 0 to PT_NUM - 1).' });

  fn('sim', 'size', () => multi(...size()), { doc: 'The grid: XRES, YRES (up), ZRES. Also sim.XRES, sim.YRES, sim.ZRES.' });
  fn('sim', 'origin', () => multi(...host.origin()), { doc: 'World cell of grid cell (0, 0, 0): it moves with World\'s window, 0 in a box.' });

  fn('sim', 'partCreate', function (i, x, y, z, type) {
    i = int(i, 'index');
    const id = elementId(type);
    if (i >= 0) {   // replace particle i where it is (TPT: only if it exists)
      const p = pos(i);
      if (!p) return -1;
      return w().edit(...p, EDIT.SPAWN | EDIT.IF_MATTER, { type: id }) ? i : -1;
    }
    if (i < -3) return -1;
    [x, y, z] = xyz(x, y, z);
    if (!w().inBounds(x, y, z) || id === E.EMPTY) return -1;
    // -1 and -2 only into air (TPT's create_part: -2 is the brush's), -3 anywhere
    if (i === -3) return w().edit(x, y, z, EDIT.SPAWN, { type: id }) ? w().key(x, y, z) : -1;
    const known = w().read(x, y, z, sync(this), sync(this));
    if (known && known.id !== E.EMPTY) return -1;
    return w().edit(x, y, z, EDIT.SPAWN | EDIT.IF_EMPTY, { type: id }) ? w().key(x, y, z) : -1;
  }, { args: 'i, x, y, z, type', writes: true,
    doc: 'Makes a particle: i = -1 only into air, -3 anywhere, an index replaces that particle. Returns its index or -1.' });

  fn('sim', 'partKill', function (...a) {
    const p = a.length >= 3 ? xyz(...a) : pos(int(a[0], 'index'));
    if (p && w().inBounds(...p)) w().edit(...p, EDIT.SPAWN | EDIT.IF_MATTER, { type: E.EMPTY });
    const f = !p && a.length < 3 ? packetOf(this, int(a[0], 'index')) : null;
    if (f) w().editFlying(f.slot, EDIT.SPAWN | EDIT.IF_MATTER, { type: E.EMPTY });
    return null;
  }, { args: 'i | x, y, z', writes: true, doc: 'Removes a particle (leaves air at room temperature).' });

  fn('sim', 'partExists', function (i) {
    const p = pos(i);
    return !!(p ? matter(this, ...p) : packetOf(this, i));
  }, { args: 'i', doc: 'Is there a particle at index i?' });

  fn('sim', 'partID', function (x, y, z) {
    [x, y, z] = xyz(x, y, z);
    return matter(this, x, y, z) ? w().key(x, y, z) : null;
  }, { args: 'x, y, z', doc: 'Index of the particle at (x, y, z), or nil.' });

  fn('sim', 'partPosition', function (i) {
    const p = pos(int(i, 'index'));
    const f = p ? null : packetOf(this, int(i, 'index'));
    if (f) return multi(f.x, f.y, f.z);
    if (!p || !matter(this, ...p)) return multi(null, null, null);
    return multi(...p);
  }, { args: 'i', doc: 'x, y, z of particle i (cells don\'t move between whole cells, so integers).' });

  fn('sim', 'partProperty', function (i, name, v) {
    const p = pos(int(i, 'index'));
    const key = field(name);
    if (arguments.length >= 3) {
      if (p) setField(...p, key, v, EDIT.IF_MATTER);
      else { const f = packetOf(this, int(i, 'index')); if (f) setPacketField(f, key, v); }
      return null;
    }
    const c = p && matter(this, ...p);
    if (!p) { const f = packetOf(this, int(i, 'index')); return f ? packetField(this, f, key, int(i, 'index')) : null; }
    return c ? getField(c, key, p, i) : null;
  }, { args: 'i, field[, value]', writes: true,
    doc: 'Gets or sets type, temp, life, ctype, vx, vy, vz or pressure of particle i (nil if there is none).' });

  fn('sim', 'partChangeType', function (i, type) {
    const p = pos(int(i, 'index'));
    if (p) setField(...p, 'type', type, EDIT.IF_MATTER);
    else { const f = packetOf(this, int(i, 'index')); if (f) setPacketField(f, 'type', type); }
    return null;
  }, { args: 'i, type', writes: true, doc: 'Changes particle i\'s element, keeping its temperature and the rest.' });

  fn('sim', 'cellProperty', function (x, y, z, name, v) {
    [x, y, z] = xyz(x, y, z);
    const key = field(name);
    if (arguments.length >= 5) {
      if (w().inBounds(x, y, z)) setField(x, y, z, key, v, 0);
      return null;
    }
    const c = w().read(x, y, z, sync(this));
    return c ? getField(c, key, [x, y, z], w().key(x, y, z)) : null;
  }, { args: 'x, y, z, field[, value]', writes: true,
    doc: 'Like partProperty for any cell, air included (air has a temperature and pressure). Setting type makes a fresh cell.' });

  // the next particle after index i (sim.parts in Lua walks it), or nil: the grid's cells in key order, and
  // V2's matter in flight where V1's flying cell would be, at its cell's key after the cell (V1 visits a
  // flying cell as the cell it is in), so both engines walk the same matter in the same order
  fn('sim', 'partNext', function (i) {
    const [nx, ny, nz] = size();
    const n = nx * ny * nz;
    i = Math.max(-1, int(i ?? -1, 'index'));
    if (i < 0) w().readAll(sync(this), { flying: true });
    let key = i, slot = -1;
    if (i >= n) { const p = w().flyingAt(i - n); if (!p) return null; key = p.key; slot = p.slot; }
    const packet = w().flyingAfter(key, slot);
    // a cell before the next packet's, or at it (the cell comes first)
    for (let k = key + 1, last = packet ? packet.key : n - 1; k <= last; k++) {
      const [x, y, z] = w().cellOf(k);
      const c = w().read(x, y, z, false, false);
      if (c && c.id !== E.EMPTY) return k;
    }
    return packet ? n + packet.slot : null;
  }, { args: 'i', doc: 'Index of the next particle after i (-1 for the first), or nil. for i in sim.parts() uses it.' });

  // The grid's matter and what flies beside it: a V1 flying cell is a cell, a V2 one a packet in
  // flight (console/world.js forEachFlying), so both engines count all the matter there is.
  const census = (ctx) => {
    const done = w().readAll(sync(ctx), { flying: true });
    const counts = new Array(ELEMENTS.length).fill(0);
    w().forEachMatter((x, y, z, c) => { counts[c.id]++; });
    w().forEachFlying((id) => { if (id < counts.length) counts[id]++; });
    return { counts, done };
  };
  fn('sim', 'elementCount', function (type) {
    return census(this).counts[elementId(type)];
  }, { args: 'type', doc: 'How many cells hold an element, flying ones too (in a handler: of the snapshot read so far).' });
  fn('sim', 'partCount', function () {
    return census(this).counts.reduce((s, n) => s + n, 0);
  }, { doc: 'How many cells hold matter, flying ones too.' });

  fn('sim', 'pressure', function (...a) {
    const [x, y, z] = xyz(a[0], a[1], a[2]);
    if (a.length <= 3) return w().read(x, y, z, sync(this))?.pressure ?? null;
    // (x, y, z, value), or a box (x, y, z, w, h, d, value): TPT's LuaBlockMap
    const [bw, bh, bd, v] = a.length >= 7 ? [int(a[3], 'w'), int(a[4], 'h'), int(a[5], 'd'), num(a[6], 'pressure')] : [1, 1, 1, num(a[3], 'pressure')];
    for (let k = z; k < z + bd; k++)
      for (let j = y; j < y + bh; j++)
        for (let i = x; i < x + bw; i++) w().edit(i, j, k, EDIT.PRESSURE, { pressure: v });
    return null;
  }, { args: 'x, y, z[, w, h, d][, value]', writes: true, doc: 'Gets or sets the air pressure of a cell (or sets a box of them).' });

  fn('sim', 'gravity', function (g) {
    if (g == null) return host.gravity();
    host.setGravity(num(g, 'gravity'));
    return null;
  }, { args: '[g]', writes: true, doc: 'Gets or sets gravity, in multiples of normal (0 = off).' });

  fn('sim', 'paused', function (p) {
    if (p == null) return host.paused();
    host.setPaused(!!p);
    return null;
  }, { args: '[paused]', writes: true, doc: 'Gets or sets the pause (TPT: sim.paused). tpt.set_pause(0|1) too.' });

  fn('sim', 'step', function (n = 1) {
    n = int(n, 'steps');
    if (this.mode !== 'command') throw new Error('sim.step runs from the console, not from an event handler');
    if (n < 1 || n > MAX_SCRIPT_STEPS) throw new Error(`steps must be 1 to ${MAX_SCRIPT_STEPS}`);
    host.step(n);
    return null;
  }, { args: '[n]', writes: true, doc: `Runs n simulation steps now (1 to ${MAX_SCRIPT_STEPS}), paused or not.` });

  fn('sim', 'createParts', function (x, y, z, r = 5, type = host.selected(), shape = 0) {
    [x, y, z] = xyz(x, y, z);
    const id = elementId(type, { tools: true });
    if (!paintable(id)) throw new Error(`${toolById(id).name} doesn't paint`);
    host.paint({ x, y, z, radius: Math.max(1, Math.min(MAX_BRUSH_RADIUS, num(r, 'radius'))), shape: shape ? 1 : 0, tool: id });
    return null;
  }, { args: 'x, y, z[, r, type, shape]', writes: true,
    doc: 'One dab of the brush: an element (into air) or a tool (ERASE, HEAT, COOL, PRES, SPRK...); shape 0 sphere, 1 cube.' });

  // ------------------------------------------------------------ tpt
  fn('tpt', 'log', function (...a) {
    this.log(a.map((v) => (v == null ? 'nil' : String(v))).join(', '));
    return null;
  }, { args: '...', doc: 'Prints to the console (print does too).' });

  // ------------------------------------------------------------ ui
  fn('ui', 'activeTool', function (index, ident) {
    if (index != null && int(index, 'index') !== 0) throw new Error('only tool 0 (the left mouse button) is selectable');
    if (ident == null) return identifier(host.selected());
    const id = elementId(ident, { tools: true });
    if (!selectable(id)) throw new Error(`${toolById(id).name} can't be selected from the console`);
    host.select(id);
    return null;
  }, { args: '[0, identifier]', writes: true, doc: 'Gets or sets the selected element or tool (tpt.selectedl too).' });

  fn('ui', 'brushRadius', function (r) {
    if (r == null) return host.brushRadius();
    host.setBrushRadius(int(r, 'radius'));
    return null;
  }, { args: '[r]', writes: true, doc: 'Gets or sets the brush radius (tpt.brushx too).' });

  fn('ui', 'brushID', function (s) {
    if (s == null) return host.brushShape();
    host.setBrushShape(int(s, 'shape') ? 1 : 0);
    return null;
  }, { args: '[0|1]', writes: true, doc: 'Gets or sets the brush shape: 0 sphere, 1 cube (B).' });

  // ------------------------------------------------------------ elem
  for (const e of ELEMENTS) value('elem', identifier(e.id), e.id);
  for (const t of TOOLS) if (paintable(t.id)) value('elem', identifier(t.id), t.id);

  fn('elem', 'getByName', (name) => {
    try { return elementId(String(name), { tools: true }); } catch { return -1; }
  }, { args: 'name', doc: 'Id of an element (or tool) by TPT name (WATR), key (WATER), name or identifier; -1 if none.' });

  fn('elem', 'exists', (id) => typeof id === 'number' && id >= 0 && !!ELEMENTS[id], { args: 'id', doc: 'Is there an element with this id?' });

  const PROPS = {
    name: (e) => e.abbr, description: (e) => e.desc, color: (e) => parseInt(e.color.slice(1), 16), colour: (e) => parseInt(e.color.slice(1), 16),
    temperature: (e) => e.temp, weight: (e) => e.dens, density: (e) => e.dens, state: (e) => KINDS[e.kind], hardness: (e) => e.hard,
    fullname: (e) => e.name, identifier: (e) => identifier(e.id),
  };
  fn('elem', 'property', (id, prop, v) => {
    const e = ELEMENTS[elementId(id)];
    if (v !== undefined) throw new Error('Element properties are baked into the shaders and can\'t change at run time');
    const get = PROPS[String(prop).toLowerCase()];
    if (!get) throw new Error(`Unknown element property ${JSON.stringify(prop)}: use ${Object.keys(PROPS).join(', ')}`);
    return get(e);
  }, { args: 'id, property', doc: 'Reads Name, Description, Color, Temperature, Weight, State, Hardness, FullName or Identifier (read only).' });
}
