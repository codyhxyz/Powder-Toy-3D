// The activity map against its reference (tools/activity-check.mjs, docs/webgpu.md
// I1): after every map the simulation builds (incrementally, from the activity
// flags its writers leave), the reference kernel rebuilds the inert map from
// the state alone (sim.inertRef), and the quiet map follows from it on the CPU
// (enabled, and every brick of the 3³ around inert); the bricks where the two
// differ are counted. Between stretches of steps it runs the state writers
// (every brush tool, TPT's air tools and Mix included, the editing tools' line,
// box and PROP, an undo, a readState/load, an in-place edit kernel), so their
// flags are checked too. Runs in the harness (sim-check.html) and in
// the app (window.__app.sim), the same code.

/**
 * @param {object} sim a Simulation
 * @param {{ load: (sim: object) => void, steps?: number, stretches?: number, noskip?: boolean, E: object }} opts
 *   load: puts the scene in (a preset); the check counts maps from there
 */
export async function activityCheck(sim, { load, steps = 600, stretches = 6, noskip = false, E }) {
  const g = sim.g;
  await sim.prepare('inertRef');
  const stat = { builds: 0, inertDiff: 0, quietDiff: 0, permissive: 0, strict: 0, inertShare: 0, quietShare: 0, firstDiff: null };
  const pending = [];
  // after every map build, the reference from the same state (recorded right
  // after the build, before the step that uses it moves anything)
  const build = sim.updateActivity.bind(sim);
  sim.updateActivity = () => {
    build();
    const frame = sim.frame, enabled = sim.quietOk ?? sim.skipQuiet;
    pending.push(Promise.all([sim.readMaps(), sim.inertRef()]).then(([m, ref]) => {
      let di = 0, dq = 0, ni = 0, nq = 0;
      for (let i = 0; i < ref.length; i++) {
        const bx = i % g.bx, by = Math.floor(i / g.bx) % g.by, bz = Math.floor(i / (g.bx * g.by));
        let q = enabled;
        for (let z = -1; z <= 1 && q; z++) for (let y = -1; y <= 1 && q; y++) for (let x = -1; x <= 1 && q; x++) {
          const nx = bx + x, ny = by + y, nz = bz + z;
          if (nx < 0 || ny < 0 || nz < 0 || nx >= g.bx || ny >= g.by || nz >= g.bz) continue;
          if (!ref[nx + g.bx * (ny + g.by * nz)]) q = false;
        }
        if (m.inert[i] !== ref[i]) { di++; if (m.inert[i]) stat.permissive++; else stat.strict++; }
        if (m.quiet[i] !== (q ? 1 : 0)) dq++;
        ni += ref[i]; nq += q;
      }
      stat.builds++;
      stat.inertDiff += di; stat.quietDiff += dq;
      stat.inertShare += ni / ref.length; stat.quietShare += nq / ref.length;
      if ((di || dq) && !stat.firstDiff) stat.firstDiff = { frame, inert: di, quiet: dq };
    }));
  };
  // the state writers, between stretches of steps
  const c = [g.nx / 2, g.ny * 0.6, g.nz / 2];
  const T = { erase: -1, heat: -2, cool: -3, blast: -4, vacuum: -50, wind: -51, mix: -52, cyclone: -53, gravIn: -54, ambHeat: -56, prop: -60 };   // elements.js tool ids
  const PROP_TEMP = 2;   // src/editing.js PROP.TEMP
  const V = (x, y, z) => ({ x, y, z });
  const stroke = (tool, at, radius = 5, replace = false, wind = null, more = {}) => sim.paint({ center: V(...at), radius, shape: 0, tool, rate: 1, replace, wind, ...more });
  const settle = sim.editKernel('settleCheck', {
    // an in-place edit of its own: a layer of sand where there is air near the floor
    update: /* wgsl */ `fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  if (eid(a) == E_EMPTY && p.y == 1) { *oA = vec4f(f32(E_SAND), AMBIENT, 0.0, fract(a.w)); }
}`,
  });
  await settle.ready;
  const writers = [
    () => { stroke(E.SAND, [c[0], c[1], c[2]]); stroke(E.WATER, [c[0] + 12, c[1], c[2]]); },
    () => {
      stroke(T.heat, [c[0], 6, c[2]], 8); stroke(T.cool, [c[0] - 14, 6, c[2] + 6], 6);
      stroke(T.mix, [c[0], 4, c[2]], 8); stroke(T.ambHeat, [c[0] + 10, 10, c[2]], 6); stroke(T.cyclone, [c[0], 8, c[2] + 10], 8);
    },
    () => {
      stroke(T.erase, [c[0], 4, c[2]], 6); stroke(T.blast, [c[0] + 8, 8, c[2] - 8], 6);
      stroke(T.vacuum, [c[0] - 8, 8, c[2] + 8], 6); stroke(T.wind, [c[0], 6, c[2] - 10], 6, false, [2, 0, 1]);
      stroke(T.gravIn, [c[0] + 10, 6, c[2] + 10], 6);
      // the editing tools (src/editing.js): a line of sand, a box of water, PROP setting a temperature
      stroke(E.SAND, [c[0] - 10, c[1], c[2] - 6], 2, false, null, { end: V(c[0] + 10, c[1], c[2] - 6) });
      stroke(E.WATER, [c[0], c[1] + 4, c[2] + 6], 2, false, null, { grow: [4, 0, 3] });
      stroke(T.prop, [c[0], 3, c[2]], 6, false, null, { prop: { field: PROP_TEMP, value: 150 } });
    },
    () => { sim.snapshot(); stroke(E.STONE, [c[0], c[1] + 6, c[2]], 4, true); sim.undo(); },
    async () => { const [A, B] = await sim.readState(); sim.load(A, B); },
    () => sim.edit(settle, { lo: [0, 0, 0], hi: [g.nx / 2, 2, g.nz - 1] }),
  ];
  sim.skipQuiet = !noskip;
  try {
    load(sim);
    const per = Math.round(steps / stretches);
    for (let k = 0; k < stretches; k++) {
      for (let i = 0; i < per; i++) sim.step();
      if (k < stretches - 1) await writers[k % writers.length]();
      await sim.gpuSync();
    }
    await Promise.all(pending);
  } finally {
    sim.updateActivity = build;
  }
  stat.inertShare /= stat.builds;
  stat.quietShare /= stat.builds;
  stat.dbg = await sim.readDebug();
  return stat;
}
