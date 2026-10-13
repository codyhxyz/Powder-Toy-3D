// The scripting console, ` (src/console; docs/webgpu.md Sync log S4, U12):
// TPT's Lua API on the simulation, its event.tick, and the Simulation options
// by TPT's names. Its writes are edits (sim.edit) and its reads block reads
// (src/console/gpu.js, sim.readStateRect), which a typed command waits for as
// a coroutine (src/console/lua.js) instead of stalling.
import * as THREE from 'three';
import { createConsole } from '../console/index.js';
import { registerConsoleApi } from '../console/registry.js';
import { EDGE, sanitizeModes } from '../simModes.js';
import { DAY } from '../gfx/daylight.js';

// The Simulation options in the console by TPT's Lua names and numbers
// (src/lua/LuaSimulation.cpp gravityMode, airMode, ambientHeatSim, edgeMode):
// no argument reads, one sets. TPT numbers its edges void 0, solid 1, loop 2
// (SimulationSettings.h EdgeMode); ours start at solid.
const TPT_EDGES = [EDGE.VOID, EDGE.SOLID, EDGE.LOOP];
// the most gravity a script may set (sim.gravity): the Gravity slider's top
const CONSOLE_GRAVITY_MAX = 0.06;

const console_ = {
  name: 'console',
  ready: true,

  boot(app) {
    const { settings } = app;
    function consoleMode(key, toOurs = (v) => v, toTpt = (v) => v) {
      return function (v) {
        if (v === undefined || v === null) return toTpt(settings[key]);
        const ours = toOurs(v);
        if (sanitizeModes({ ...settings, [key]: ours })[key] !== ours) throw new Error(`${key}: no mode ${v}`);
        const lock = app.simModeLock(key);
        if (lock) throw new Error(lock);
        app.setSimMode(key, ours);
        return toTpt(settings[key]);
      };
    }
    registerConsoleApi('sim', 'gravityMode', consoleMode('gravityMode'),
      { args: '[mode]', doc: 'Gravity: 0 vertical, 1 off, 2 radial (toward the box centre).', writes: true });
    registerConsoleApi('sim', 'airMode', consoleMode('airMode'),
      { args: '[mode]', doc: 'Air: 0 on, 1 pressure off, 2 velocity off, 3 off, 4 no update.', writes: true });
    registerConsoleApi('sim', 'ambientHeatSim', consoleMode('ambientHeat', (v) => !!v),
      { args: '[on]', doc: 'Ambient heat: whether air holds and trades heat.', writes: true });
    registerConsoleApi('sim', 'edgeMode', consoleMode('edgeMode', (v) => TPT_EDGES[v] ?? -1, (v) => TPT_EDGES.indexOf(v)),
      { args: '[mode]', doc: 'Box edges (TPT numbering): 0 void, 1 solid, 2 loop. World keeps solid.', writes: true });
  },
  // the console itself, once there is a grid (optional: the game runs without it)
  attach(app) {
    if (app.scripts) return;
    const { settings } = app;
    try {
      app.scripts = createConsole({
        getSim: () => app.sim, isGuest: () => app.mp.isGuest,
        paused: () => settings.paused, setPaused: app.setPaused,
        stepNow: (n) => { for (let i = 0; i < n; i++) app.sim.step(); if (DAY.running) app.day.clock += n; },
        gravity: () => settings.gravity / app.DEFAULTS.gravity,
        setGravity: (g) => {
          settings.gravity = THREE.MathUtils.clamp(g * app.DEFAULTS.gravity, 0, CONSOLE_GRAVITY_MAX);
          app.sim.gravity = settings.gravity;
          if (app.settingsPanel.isOpen) app.settingsPanel.sync();
          app.save();
        },
        brushRadius: () => settings.radius, setBrushRadius: app.setRadius,
        brushShape: () => settings.shape, setBrushShape: (v) => { settings.shape = v; app.dock.sync(); app.save(); },
        selected: () => settings.tool, select: app.selectTool,
        paint: ({ x, y, z, radius, shape, tool }) => app.sim.paint({
          center: new THREE.Vector3(x, y, z).addScalar(0.5), radius, shape, tool, rate: settings.rate, replace: false,
        }),
        snapshot: () => { app.sim.snapshot(); app.toolbar.setUndoEnabled(true); },
        requestRender: () => app.requestRender(),
        exitPointerLock: () => { if (document.pointerLockElement) document.exitPointerLock(); },
      });
    } catch (err) { console.error('Console unavailable', err); }
  },
};

export default console_;
