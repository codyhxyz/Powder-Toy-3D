// Per-cell state hash over a fixed scenario, for proving a refactor bit-exact:
// run it against two builds and compare the printed lines (they must match).
//
// Each scene loads from a seeded Math.random, then steps, with the state
// writers in between: every brush tool, a stamp, the first-person passes (the
// body's coupling, the physgun, the axe, the gun's handoff, a transfer), an
// undo, a codec pack/unpack, a readState/load round trip, and painting
// between single steps. After each stage it prints:
//   state  a hash of every cell's state in the D5 float layout (sim.readState():
//          A = id, °C, life, ctype + seed; B = velocity, pressure), taken in
//          cell order through sim.cellTexel, so builds with different texel
//          layouts compare too
//   flow   the renderer's flow field (sim.flowV), where the build has one
//   copies both state copies, texel for texel, their activity flags included
//          (where the build has them, sim.stateF): for builds with the same
//          layout. A copy the steps skip must hold what they would write
//   maps   every activity map built since the last line (the inert and quiet
//          bricks), chained, and how many
// --world runs the massive world instead (?size=world): a load, edits, then
// the window walked out and back (shift, fill, stored edits, trees, syncCopies).
// usage: node tools/state-hash.mjs [--port 5191] [--scenes lab,volcano,island] [--sizes 128]
//          [--steps 200] [--noskip] [--nosleep] [--world]
// --nosleep draws every supertile (sim.skipSleeping = false): its lines must match a normal run's
import { launchBrowser, newTestContext } from './browser.mjs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5191');
const world = args.includes('--world');
const scenes = world ? ['world'] : opt('scenes', 'lab,volcano,island').split(',');
const sizes = world ? ['world'] : opt('sizes', '128').split(',');
const STEPS = +opt('steps', '200');   // steps per stretch
const SEED = 12345;                   // Math.random seed (mulberry32, as tools/regress.mjs)
const PAINT_STEPS = 24;               // strokes in the stretch that paints between single steps
const TRANSFER_TAKES = 40;            // cells the transfer stage takes at most (a tool's load)
const WORLD_MOVES = 6;                // window moves out along x, then as many back
const WIN_STEP = 16;                  // cells per move (world/window.js)

const browser = await launchBrowser();
const errors = [];
for (const size of sizes) {
  const ctx = await newTestContext(browser, { mode: 'manual', viewport: { width: 1280, height: 800 } });
  await ctx.routeWebSocket(/.*/, () => {});   // no multiplayer relay
  await ctx.addInitScript((seed) => {
    let s = seed;
    Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    window.__reseed = () => { s = seed; };
    window.requestAnimationFrame = () => 0;   // legacy builds lack manual mode: keep cross-build hashes comparable
  }, SEED);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  // errors, and WebGL's own complaints (GL errors arrive as warnings)
  page.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'error' && !t.startsWith('Failed to load resource')) || /GL_INVALID|WebGL:/.test(t)) errors.push(t.slice(0, 300));
  });
  await page.goto(`http://localhost:${port}/?size=${size}&preset=empty`);
  await page.waitForFunction(() => window.__app?.sim, null, { timeout: 60000 });
  for (const scene of scenes) {
    const lines = await page.evaluate(async ({ scene, steps, noskip, nosleep, paintSteps, worldMoves, winStep, TRANSFER_TAKES }) => {
      const a = window.__app, sim = a.sim, R = a.renderer, g = sim.g, gl = R.getContext(), THREE = a.THREE;
      a.settings.paused = true;
      const { createPacker, createUnpacker } = await import('/src/net/codec.js');
      const { E } = await import('/src/elements.js');
      const out = [];
      const fnv = (h, w) => Math.imul(h ^ w, 0x01000193);
      const hex = (h) => (h >>> 0).toString(16).padStart(8, '0');
      // a texture's texels as 32-bit words, read straight from GL (the flags are
      // an integer format readRenderTargetPixels won't read)
      const fb = gl.createFramebuffer();
      const readWords = (target, j) => {
        R.initRenderTarget(target);   // (a copy nothing has drawn into yet reads as zeros)
        const tex = target.textures[j], int = tex.format === THREE.RedIntegerFormat;
        const prev = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, R.properties.get(tex).__webglTexture, 0);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        const buf = int ? new Uint32Array(g.width * g.height * 4) : new Float32Array(g.width * g.height * 4);
        gl.readPixels(0, 0, g.width, g.height, int ? gl.RGBA_INTEGER : gl.RGBA, int ? gl.UNSIGNED_INT : gl.FLOAT, buf);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prev);
        return new Uint32Array(buf.buffer);
      };
      // every activity map built: its inert and quiet bricks, chained
      let maps = 0, mapHash = 0x811c9dc5;
      const brickBuf = new Uint8Array(g.bwidth * g.bheight * 4);
      const build = sim.updateActivity.bind(sim);
      sim.updateActivity = () => {
        build();
        for (const t of [sim.actInert, sim.actQuiet]) {
          R.readRenderTargetPixels(t, 0, 0, g.bwidth, g.bheight, brickBuf);
          for (let i = 0; i < brickBuf.length; i += 4) mapHash = fnv(mapHash, brickBuf[i]);
        }
        maps++;
      };
      // FNV-1a over the 32-bit words of every cell's A and B, in cell order
      const hash = (label) => {
        const [A, B] = sim.readState();
        const ua = new Uint32Array(A.buffer), ub = new Uint32Array(B.buffer);
        let h = 0x811c9dc5;
        const mix = (w) => { for (let k = 0; k < 4; k++) { h ^= (w >>> (8 * k)) & 0xff; h = Math.imul(h, 0x01000193); } };
        for (let y = 0; y < g.ny; y++)
          for (let z = 0; z < g.nz; z++)
            for (let x = 0; x < g.nx; x++) {
              const i = sim.cellTexel(x, y, z) * 4;
              for (let k = 0; k < 4; k++) mix(ua[i + k]);
              for (let k = 0; k < 4; k++) mix(ub[i + k]);
            }
        // the renderer's flow field (sim.flowV: half floats, state atlas), where the build has one
        let flow = '';
        if (sim.flowV) {
          const t = sim.flowV, f = new Uint16Array(t.width * t.height * 4);
          R.readRenderTargetPixels(t, 0, 0, t.width, t.height, f);
          let hf = 0x811c9dc5;
          for (let y = 0; y < g.ny; y++)
            for (let z = 0; z < g.nz; z++)
              for (let x = 0; x < g.nx; x++) {
                const i = sim.cellTexel(x, y, z) * 4;
                for (let k = 0; k < 4; k++) { hf ^= f[i + k]; hf = Math.imul(hf, 0x01000193); }
              }
          flow = `  flow ${hex(hf)}`;
        }
        // both copies, texel for texel: the current one first, flags included where there are any
        let hc = 0x811c9dc5;
        for (const k of [sim.cur, 1 - sim.cur]) {
          const t = sim.targets[k];
          for (let j = 0; j < t.textures.length; j++) for (const w of readWords(t, j)) hc = fnv(hc, w);
        }
        out.push(`${label.padEnd(10)} ${hex(h)}${flow}  copies ${hex(hc)}  maps ${maps} ${hex(mapHash)}  frame ${sim.frame}`);
        maps = 0;
        mapHash = 0x811c9dc5;
      };
      const V3 = THREE.Vector3;
      const run = (n) => { for (let i = 0; i < n; i++) sim.step(); };
      const stroke = (tool, at, radius = 5, replace = false, shape = 0) => sim.paint({ center: new V3(...at), radius, shape, tool, rate: 1, replace });
      sim.skipQuiet = !noskip;
      sim.skipSleeping = !nosleep;

      if (scene === 'world') {
        // ---- the massive world: a load, edits, a walk out and back ----
        const w = a.win, start = w.centre();
        window.__reseed();
        a.worldLoad(start);
        sim.frame = 0;
        hash('load');
        run(steps); hash('steps');
        const c = [g.nx / 2, g.ny * 0.6, g.nz / 2];
        stroke(E.SAND, c); stroke(E.WATER, [c[0] + 12, c[1], c[2]]); stroke(E.WALL, [c[0] - 12, c[1] - 10, c[2] + 6], 3, true, 1);
        hash('edits');
        run(steps); hash('steps');
        const walk = async (dx, label) => {
          for (let k = 0; k < worldMoves; k++) {
            await w.pending;
            w.shift(dx, 0);
            run(steps / 8);
            if (k % 2) hash(`${label}${k}`);
          }
          await w.pending;
        };
        await walk(winStep, 'out');
        await walk(-winStep, 'back');
        run(steps); hash('steps');
        return out;
      }

      // ---- a scene of the app's: every state writer between stretches of steps ----
      const { rawMat } = await import('/src/sim.js');
      const { stateUniforms } = await import('/src/shaders/common.js');
      const { povCouplingFrag } = await import('/src/shaders/povBody.js');
      const { axeFrag, physgunFrag, physgunComFrag, toolPass, PHYS: GUN, PHYS_MODE } = await import('/src/shaders/povTools.js');
      const { strikeFrag } = await import('/src/shaders/povTrace.js');
      const { createTransfer, Load } = await import('/src/pov/tools/transfer.js');
      const { generatorFor } = await import('/src/world/gpu.js');
      const { runGenerator, bake } = await import('/src/constructions/runtime.js');
      const { BUILTINS } = await import('/src/constructions/builtins.js');
      const { K } = await import('/src/elements.js');
      const c = [g.nx / 2, g.ny * 0.6, g.nz / 2];
      window.__reseed();
      a.loadPreset(scene, false);
      sim.frame = 0;
      hash('load');
      run(steps); hash('steps');
      stroke(E.SAND, c); stroke(E.WATER, [c[0] + 12, c[1], c[2]]); stroke(E.LAVA, [c[0] - 12, c[1], c[2]], 3);
      stroke(E.ERASE, [c[0], 4, c[2]], 6); stroke(E.HEAT, [c[0], 6, c[2]], 8); stroke(E.COOL, [c[0] - 14, 6, c[2] + 6], 6);
      stroke(E.BLAST, [c[0] + 8, 8, c[2] - 8], 6);
      hash('brush');
      run(steps); hash('steps');
      sim.snapshot(); stroke(E.STONE, [c[0], c[1] + 6, c[2]], 4, true); hash('replace'); sim.undo(); hash('undo');
      run(steps / 2); hash('steps');
      const shot = await createPacker(R).pack(sim);
      createUnpacker().unpack(sim, shot.bytes); shot.release();
      hash('codec');
      run(steps / 2); hash('steps');
      const [A, B] = sim.readState(); sim.load(A, B); hash('reload');
      run(steps / 2); hash('steps');
      // a stamp (constructions and the world's trees use the same pass)
      const tree = bake(runGenerator(BUILTINS.TREE, { size: 4, seed: 7, variant: 'oak' }), 0);
      generatorFor(sim).stamp(tree, [Math.floor(c[0]) - 20, 2, Math.floor(c[2]) + 10], 7);
      hash('stamp');
      run(steps / 2); hash('steps');
      // the first-person passes, as their call sites run them (src/pov/): the
      // body's coupling and the physgun declare the box they write
      const touchCentres = (lo, hi) => sim.touch(lo.map((x) => Math.floor(x) - 1), hi.map((x) => Math.floor(x) + 1));
      const couple = rawMat(povCouplingFrag(g), {
        ...stateUniforms(), uFrame: { value: sim.frame },
        uMin: { value: new V3(c[0] + 10, 2, c[2] - 1) }, uMax: { value: new V3(c[0] + 11.6, 9, c[2] + 0.6) },
        uVel: { value: new V3(0.2, 0, 0.1) }, uPushFluid: { value: 0.2 }, uPushPowder: { value: 0.1 }, uLift: { value: 0.3 },
        uAhead: { value: new THREE.Vector2(0.5, 0.2) },
      });
      for (let k = 0; k < 3; k++) {
        const u = couple.uniforms;
        u.uMin.value.x += k; u.uMax.value.x += k;
        touchCentres(u.uMin.value.toArray(), u.uMax.value.toArray());
        sim.pass(couple);
        run(1);
      }
      const hold = new V3(c[0], 8, c[2]);
      const com = toolPass(physgunComFrag, () => ({ uHold: { value: hold } }))(sim);
      const comTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
      const gun = toolPass(physgunFrag, () => ({
        tCom: { value: comTarget.texture }, uHold: { value: hold }, uCarry: { value: new V3(0.05, 0, 0) },
        uSteps: { value: 1 }, uGravity: { value: sim.gravity }, uMode: { value: PHYS_MODE.HOLD }, uFling: { value: new V3(0, 0.5, 0.9) },
      }))(sim);
      for (let k = 0; k < 3; k++) {
        com.uniforms.tA.value = sim.stateA;
        sim.run(com, comTarget);
        if (k === 2) gun.uniforms.uMode.value = PHYS_MODE.FLING;
        const at = hold.toArray();
        touchCentres(at.map((x) => x - GUN.RADIUS), at.map((x) => x + GUN.RADIUS));
        sim.pass(gun);
        run(1);
      }
      const axe = toolPass(axeFrag, () => ({ uCenter: { value: new V3(c[0] - 20.5, 4.5, c[2] + 10.5) }, uDir: { value: new V3(1, 0, 0) } }))(sim);
      sim.pass(axe);
      const strike = rawMat(strikeFrag(g), {
        ...stateUniforms(), uEntry: { value: new V3(c[0] + 0.5, 5.2, c[2] - 6) }, uDir: { value: new V3(0, -0.6, 0.8).normalize() },
        uEnergy: { value: 39 }, uDepth: { value: 8 }, uLo: { value: new V3(c[0] - 1, -2, c[2] - 7) }, uHi: { value: new V3(c[0] + 2, 6, c[2] + 2) },
      });
      sim.pass(strike);
      hash('pov');
      // the pack and trowel: take loose matter and solids out of a patch, put it back higher up
      const transfer = createTransfer({ renderer: R, getSim: () => sim });
      const load = new Load(TRANSFER_TAKES);
      const cells = [];
      for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = 1; y <= 4; y++) cells.push([Math.floor(c[0]) + x, y, Math.floor(c[2]) + z]);
      await transfer.take(load, { cells, kinds: [K.POWDER, K.LIQUID, K.SOLID] });
      if (load.cells.length) await transfer.put(load, { cells: cells.map(([x, y, z]) => [x, y + 20, z]), vel: new V3(0, -0.2, 0) });
      transfer.dispose();
      hash('transfer');
      run(steps / 2); hash('steps');
      // painting between single steps: every map but the first has one step and a write before it
      for (let k = 0; k < paintSteps; k++) {
        stroke(k % 3 ? E.SAND : E.WATER, [c[0] + (k % 5) * 3 - 6, c[1] + 4, c[2] + (k % 7) - 3], 2);
        run(1 + (k % 2));
      }
      hash('painting');
      run(steps); hash('steps');
      comTarget.dispose();
      return out;
    }, { scene, steps: STEPS, noskip: args.includes('--noskip'), nosleep: args.includes('--nosleep'), paintSteps: PAINT_STEPS, worldMoves: WORLD_MOVES, winStep: WIN_STEP, TRANSFER_TAKES });
    console.log(`# ${scene} ${size}${args.includes('--noskip') ? ' noskip' : ''}`);
    for (const l of lines) console.log(l);
  }
  await ctx.close();
}
console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
