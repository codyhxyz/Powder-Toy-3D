// Simulation modes: The Powder Toy's Simulation Options (TPT src/gui/options/
// OptionsView.cpp: "Gravity simulation mode", "Air simulation mode", "Ambient
// heat simulation", "Edge mode"), as settings that belong to a world. A fresh
// scene or map starts them over at DEFAULTS (TPT GameModel.cpp ClearSimulation
// sets gravity vertical and air on the same way), unless the map says otherwise.
// The engine reads them as per-dispatch params (sim.js; WGSL below), so
// switching one builds nothing.
//
//   gravity  vertical: down is −y (today's world, TPT GRAV_VERTICAL)
//            off: nothing falls, topples, settles or flows downhill (GRAV_OFF)
//            radial: toward the centre of the box (GRAV_RADIAL; TPT
//            Simulation.cpp GetGravityField: the full strength, pointed at the
//            centre). The move's rules are written for down = −y, so each
//            2×2×2 block runs them turned so that −y is the dominant axis of
//            its pull (shaders/move.js); the react pass's forces use the full
//            vector, its normal force, friction and liquid flow the same axis.
//   air      TPT Air.cpp airMode: on; pressure off (pressure held at 0);
//            velocity off (still air, and matter isn't pushed by pressure: in
//            TPT particles feel pressure only through the air's velocity,
//            Simulation.cpp "parts[i].vx += Advection·vx"); off (both); no
//            update (pressure and wind stay as they are: no spreading, no decay).
//   ambient  heat in the air (TPT aheat_enable, Air.cpp update_airh). Off: air
//            holds AMBIENT and matter doesn't trade heat with it (TPT
//            Simulation.cpp: "Heat transfer with air" only with aheat_enable),
//            so convection carries no heat. TPT starts with it off; we start
//            with it on, as the world always was.
//   edge     what the box's sides are (TPT Simulation.cpp SetEdgeMode, do_move):
//            solid (walls, as always), void (matter leaving the box is gone,
//            and the air outside is still, at ambient and no pressure: TPT
//            Air.cpp relaxes its edges to edgePressure 0), loop (it comes back
//            in on the other side, on every axis, as TPT's loop wraps x and y).
//            World's window edge is the store's boundary, so World stays solid.
//            Unlike TPT's, our air loops too: it lives on the same cells as
//            matter and crosses the edge with them.

export const GRAV = { VERTICAL: 0, OFF: 1, RADIAL: 2 };
export const AIR = { ON: 0, PRESSURE_OFF: 1, VELOCITY_OFF: 2, OFF: 3, NO_UPDATE: 4 };
export const EDGE = { SOLID: 0, VOID: 1, LOOP: 2 };

// The settings keys that belong to a saved world (save/load stores these with it).
export const SIM_MODE_KEYS = ['gravityMode', 'airMode', 'ambientHeat', 'edgeMode'];
export const SIM_MODE_DEFAULTS = { gravityMode: GRAV.VERTICAL, airMode: AIR.ON, ambientHeat: true, edgeMode: EDGE.SOLID };

// labels, in TPT's order and words (GameController.cpp SwitchGravity, SwitchAir, SetEdgeMode)
export const GRAV_LABELS = [[GRAV.VERTICAL, 'Vertical'], [GRAV.OFF, 'Off'], [GRAV.RADIAL, 'Radial']];
export const AIR_LABELS = [[AIR.ON, 'On'], [AIR.PRESSURE_OFF, 'Pressure Off'], [AIR.VELOCITY_OFF, 'Velocity Off'], [AIR.OFF, 'Off'], [AIR.NO_UPDATE, 'No Update']];
export const EDGE_LABELS = [[EDGE.SOLID, 'Solid'], [EDGE.VOID, 'Void'], [EDGE.LOOP, 'Loop']];
const label = (list, v) => list.find(([k]) => k === v)?.[1] ?? '?';

// the toasts a change shows, as TPT's info tips say them
export const modeToast = {
  gravityMode: (v) => `Gravity: ${label(GRAV_LABELS, v)}`,
  airMode: (v) => `Air: ${label(AIR_LABELS, v)}`,
  ambientHeat: (v) => `Ambient Heat: ${v ? 'On' : 'Off'}`,
  edgeMode: (v) => `Edge Mode: ${label(EDGE_LABELS, v)}`,
};

// TPT's keys (GameView.cpp OnKeyPress): Y cycles the air mode, U toggles
// ambient heat. TPT's W (gravity mode) is our camera key: gravity is set in
// Settings only.
export const MODE_KEYS = { y: 'airMode', u: 'ambientHeat' };
// the next value a key gives the setting
export const nextMode = (key, v) => (key === 'ambientHeat' ? !v : (v + 1) % AIR_LABELS.length);

// A clean value for each key (a save from elsewhere, an old version): the default if unknown.
export function sanitizeModes(m) {
  const pick = (list, v, d) => (list.some(([k]) => k === v) ? v : d);
  return {
    gravityMode: pick(GRAV_LABELS, m.gravityMode, SIM_MODE_DEFAULTS.gravityMode),
    airMode: pick(AIR_LABELS, m.airMode, SIM_MODE_DEFAULTS.airMode),
    ambientHeat: typeof m.ambientHeat === 'boolean' ? m.ambientHeat : SIM_MODE_DEFAULTS.ambientHeat,
    edgeMode: pick(EDGE_LABELS, m.edgeMode, SIM_MODE_DEFAULTS.edgeMode),
  };
}

// The Settings drawer's rows (ui/settings.js), for its Simulation section:
// change(key, value) applies one, locked(key) says why it can't change now
// (a guest; World's edge), else falsy.
const AIR_COLS = 3;   // the air row's five options, in rows of this many
export function simModeRows({ change, locked }) {
  const seg = (key, name, list, extra = {}) => ({
    type: 'seg', key, options: list.map(([v, l], i) => [v, i ? l : `${name}: ${l}`]),
    onChange: (v) => change(key, v), disabled: () => locked(key), ...extra,
  });
  return [
    seg('gravityMode', 'Gravity', GRAV_LABELS),
    seg('airMode', 'Air', AIR_LABELS, { cols: AIR_COLS }),
    seg('ambientHeat', 'Ambient Heat', [[true, 'On'], [false, 'Off']]),
    seg('edgeMode', 'Edges', EDGE_LABELS),
  ];
}

// Hand the modes in settings to a simulation (sim.js keeps World solid).
export function applySimModes(sim, s) {
  sim.gravityMode = s.gravityMode;
  sim.airMode = s.airMode;
  sim.ambientHeat = s.ambientHeat;
  sim.edgeMode = s.edgeMode;
}

// The WGSL side (the move and react kernels, shaders/move.js and react.js;
// the name is the GLSL version's, docs/webgpu.md W2): the mode numbers, and
// where a cell outside the box comes from. The modes are per-dispatch params
// (docs/webgpu.md B4), so a kernel including this has SIM_MODE_FIELDS in its
// params struct P (sim.js sets them every step). Switching a mode builds nothing.
export const SIM_MODE_FIELDS = { gravMode: 'u32', edge: 'u32' };
export const simModesGLSL = /* wgsl */ `
${Object.entries(GRAV).map(([k, v]) => `const GRAV_${k}: u32 = ${v}u;`).join('\n')}
${Object.entries(AIR).map(([k, v]) => `const AIR_${k}: u32 = ${v}u;`).join('\n')}
${Object.entries(EDGE).map(([k, v]) => `const EDGE_${k}: u32 = ${v}u;`).join('\n')}
// a cell next to the box: in loop mode, the one on the far side (every axis;
// q is at most one box away, so q + N is never negative)
fn edgeCell(q: vec3i) -> vec3i {
  if (P.edge == EDGE_LOOP) { return (q + vec3i(NX, NY, NZ)) % vec3i(NX, NY, NZ); }
  return q;
}
// what a cell outside the box holds, past a void edge: still air at ambient
// (the scene's, common.js airT(): a function, as the GLSL's was a macro)
fn VOID_AIR_A() -> vec4f { return vec4f(f32(E_EMPTY), airT(), 0.0, 0.0); }
// Which way gravity pulls at x (grid cells): down, or with radial gravity
// toward the box's centre (none at the centre itself).
fn gravDir(x: vec3f) -> vec3f {
  if (P.gravMode != GRAV_RADIAL) { return vec3f(0.0, -1.0, 0.0); }
  let d = 0.5 * vec3f(f32(NX), f32(NY), f32(NZ)) - x;
  if (dot(d, d) > 0.0) { return normalize(d); }
  return vec3f(0.0);
}
// The frame the move rules are written in (down = −y), for a pull g: −y
// along g's dominant axis (ties go to y, then x). A signed axis permutation:
// frame = F · grid, grid = frame · F (a row vector times F, as in GLSL).
// Identity for vertical gravity.
fn gravFrame(g: vec3f) -> mat3x3f {
  let m = abs(g);
  if (m.x > m.y && m.x >= m.z) { return mat3x3f(0.0, select(1.0, -1.0, g.x > 0.0), 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0); }
  if (m.z > m.y && m.z > m.x) { return mat3x3f(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, select(1.0, -1.0, g.z > 0.0), 0.0); }
  return mat3x3f(1.0, 0.0, 0.0, 0.0, select(1.0, -1.0, g.y > 0.0), 0.0, 0.0, 0.0, 1.0);
}
`;
