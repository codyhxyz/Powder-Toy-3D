// Headless check of the first-person body (src/pov/player.js) on a real GPU.
// Builds small scenes, drops a body into them and prints numbers.
// usage: node tools/pov-player-check.mjs [--port 5192] [--only name,name]
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5192');
const only = opt('only', '')?.split(',').filter(Boolean);

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await b.newPage({ viewport: { width: 640, height: 400 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 2000)); });
page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 2000)));
await page.goto(`http://localhost:${port}/?preset=empty`);
await page.waitForFunction(() => window.__app?.sim, null, { timeout: 30000 });
await page.waitForTimeout(1500);

await page.evaluate(async () => {
  const { createPlayer } = await import('/src/pov/player.js');
  const { ELEMENTS, E } = await import('/src/elements.js');
  const THREE = { Vector3: class { constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); } } };   // plain points do
  const a = window.__app;
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  window.__pt = {
    E, THREE,
    // Replace the world: build({ box(x0,y0,z0,x1,y1,z1,id,T) }) with exclusive upper bounds.
    scene(build) {
      const sim = a.sim, g = sim.g;
      const [A, B] = sim.blankState();
      const idx = (x, y, z) => ((Math.floor(y / g.tx) * g.nz + z) * g.width + (y % g.tx) * g.nx + x) * 4;
      const box = (x0, y0, z0, x1, y1, z1, id, T) => {
        for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
          if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) continue;
          const i = idx(x, y, z), e = ELEMENTS[id];
          A[i] = id; A[i + 1] = T ?? e.temp; A[i + 2] = e.life; A[i + 3] = Math.random() * 0.999;
        }
      };
      build({ box, g });
      sim.load(A, B);
    },
    player() {
      window.__pt.p?.dispose();
      const p = createPlayer({ renderer: a.renderer, getSim: () => a.sim });
      p.events = [];
      for (const n of ['hurt', 'death', 'land', 'splash']) p.on(n, (d) => p.events.push([n, JSON.stringify(d)]));
      window.__pt.p = p;
      return p;
    },
    // Step the body for `secs` of its own time (frames longer than its 0.1 s
    // cap run in slow motion, so a loaded GPU doesn't cut tests short).
    async run(p, secs, input = {}, each) {
      let last = performance.now(), t = 0;
      while (t < secs) {
        await frame();
        const now = performance.now(), dt = (now - last) / 1000;
        p.update(dt, typeof input === 'function' ? input(p) : input);
        last = now;
        t += Math.min(dt, 0.1);
        p.t = t;
        each?.(p);
      }
    },
    async settle(secs) { const t0 = performance.now(); while (performance.now() - t0 < secs * 1000) await frame(); },
    v: (p) => [p.pos.x, p.pos.y, p.pos.z].map((n) => +n.toFixed(2)),
    state: (p) => ({
      pos: window.__pt.v(p), vel: [p.vel.x, p.vel.y, p.vel.z].map((n) => +n.toFixed(1)), onGround: p.onGround,
      inLiquid: p.inLiquid, headInLiquid: p.headInLiquid, liquidId: p.liquidId, sub: +p.submerged.toFixed(2),
      health: +p.health.toFixed(3), breath: +p.breath.toFixed(3), dead: p.dead, cause: p.cause, skinT: +p.skinT.toFixed(1),
      stepRate: Math.round(p.stepRate),
    }),
  };
});

const tests = {
  async floor() {
    return page.evaluate(async () => {
      const t = window.__pt;
      t.scene(() => {});
      await t.settle(0.3);
      const p = t.player();
      p.spawn(new t.THREE.Vector3(64, 8, 64));
      await t.run(p, 1.5);
      const low = t.state(p);
      p.spawn(new t.THREE.Vector3(64, 40, 64));   // 12 m: lands unhurt (no fall damage, as in Noita)
      await t.run(p, 2.5);
      return { from8: low, from40: t.state(p), events: p.events.slice(0, 6) };
    });
  },
  async sandPile() {
    return page.evaluate(async () => {
      const t = window.__pt;
      t.scene(({ box }) => box(54, 0, 54, 74, 8, 74, t.E.SAND));
      await t.settle(2);
      const p = t.player();
      p.spawn(new t.THREE.Vector3(64, 20, 64));
      await t.run(p, 2.5);
      return t.state(p);
    });
  },
  async stepUp() {
    return page.evaluate(async () => {
      const t = window.__pt;
      t.scene(({ box }) => {
        box(70, 0, 40, 128, 1, 90, t.E.ROCK);   // a 1-cell ledge at x = 70
        box(80, 1, 40, 128, 2, 90, t.E.ROCK);   // and a second one at x = 80
        box(90, 2, 40, 128, 4, 90, t.E.ROCK);   // then a 2-cell wall at x = 90
      });
      await t.settle(0.3);
      const p = t.player();
      p.spawn(new t.THREE.Vector3(62, 0, 64));
      const trace = [];
      await t.run(p, 6, { move: { x: 1, z: 0 } }, (p) => trace.push(p.pos.x));
      return { end: t.state(p), maxX: +Math.max(...trace).toFixed(2) };
    });
  },
  async wall() {
    return page.evaluate(async () => {
      const t = window.__pt;
      t.scene(({ box }) => box(70, 0, 40, 72, 30, 90, t.E.WALL));
      await t.settle(0.3);
      const p = t.player();
      p.spawn(new t.THREE.Vector3(62, 0, 64));
      let maxX = 0;
      await t.run(p, 3, { move: { x: 1, z: 0 }, sprint: true }, (p) => { maxX = Math.max(maxX, p.pos.x); });
      // then jump into it while sprinting
      await t.run(p, 1.5, { move: { x: 1, z: 0.2 }, sprint: true, jump: true }, (p) => { maxX = Math.max(maxX, p.pos.x); });
      return { end: t.state(p), maxX: +maxX.toFixed(3), wallFace: 70 - 0.8 };
    });
  },
  async water() {
    return page.evaluate(async () => {
      const t = window.__pt;
      t.scene(({ box }) => {
        box(40, 0, 40, 90, 22, 90, t.E.GLASS);
        box(41, 1, 41, 89, 22, 89, t.E.EMPTY);
        box(41, 1, 41, 89, 16, 89, t.E.WATER);   // surface at y = 16
      });
      await t.settle(1.5);
      const p = t.player();
      p.spawn(new t.THREE.Vector3(64, 26, 64));
      let minY = 99;
      await t.run(p, 4, {}, (p) => { minY = Math.min(minY, p.pos.y); });
      const plunge = { minFeetY: +minY.toFixed(2), riseAfter4s: +p.pos.y.toFixed(2) };
      // float: start with the head just under the surface and let it settle
      p.spawn(new t.THREE.Vector3(64, 9, 64));
      const ys = [];
      await t.run(p, 10, {}, (p) => ys.push(p.pos.y));
      const tail = ys.slice(-120);
      const mean = tail.reduce((s, y) => s + y, 0) / tail.length;
      const out = { plunge, state: t.state(p), meanFeetY: +mean.toFixed(2), headTopMinusSurface: +(mean + 5.5 - 16).toFixed(2),
        range: +(Math.max(...tail) - Math.min(...tail)).toFixed(2), events: p.events.slice(0, 4) };
      // swim up (hold jump): the head should come out
      await t.run(p, 3, { jump: true });
      out.swimUp = { feetY: +p.pos.y.toFixed(2), headInLiquid: p.headInLiquid };
      return out;
    });
  },
  async oil() {
    return page.evaluate(async () => {
      const t = window.__pt;
      t.scene(({ box }) => {
        box(40, 0, 40, 90, 22, 90, t.E.GLASS);
        box(41, 1, 41, 89, 22, 89, t.E.EMPTY);
        box(41, 1, 41, 89, 16, 89, t.E.OIL);
      });
      await t.settle(1.5);
      const p = t.player();
      p.spawn(new t.THREE.Vector3(64, 17, 64));
      await t.run(p, 6);
      return t.state(p);
    });
  },
  async drown() {
    return page.evaluate(async () => {
      const t = window.__pt;
      t.scene(({ box }) => {
        box(40, 0, 40, 90, 30, 90, t.E.GLASS);
        box(41, 1, 41, 89, 30, 89, t.E.EMPTY);
        box(41, 1, 41, 89, 24, 89, t.E.WATER);
      });
      await t.settle(1.5);
      const p = t.player();
      p.spawn(new t.THREE.Vector3(64, 5, 64));
      let firstHurt = null, breath10 = null;
      await t.run(p, 24, { down: true }, (p) => {
        const s = p.t;
        if (breath10 === null && s > 10) breath10 = +p.breath.toFixed(3);
        if (firstHurt === null && p.health < 1) firstHurt = +s.toFixed(1);
      });
      return { state: t.state(p), breathAt10s: breath10, firstHurtAt: firstHurt, events: p.events.slice(-3) };
    });
  },
  async lava() {
    return page.evaluate(async () => {
      const t = window.__pt;
      t.scene(({ box }) => {
        box(40, 0, 40, 90, 10, 90, t.E.WALL);
        box(42, 1, 42, 88, 10, 88, t.E.EMPTY);
        box(42, 1, 42, 88, 8, 88, t.E.LAVA);
      });
      await t.settle(1);
      const p = t.player();
      p.spawn(new t.THREE.Vector3(64, 14, 64));
      let deathAt = null;
      await t.run(p, 6, {}, (p) => { if (p.dead && deathAt === null) deathAt = +p.t.toFixed(2); });
      return { state: t.state(p), deathAt, events: p.events.slice(-3) };
    });
  },
  async blast() {
    return page.evaluate(async () => {
      const t = window.__pt;
      t.scene(({ box }) => box(72, 0, 63, 75, 3, 66, t.E.GUNPOWDER));
      await t.settle(0.5);
      const p = t.player();
      p.spawn(new t.THREE.Vector3(62, 0, 64));
      await t.run(p, 0.5);
      // light it
      window.__app.sim.paint({ center: new t.THREE.Vector3(73.5, 3.5, 64.5), radius: 1.5, shape: 0, tool: t.E.FIRE, rate: 10, replace: false });
      let maxSpeed = 0, maxP = 0, minX = p.pos.x, maxY = 0;
      await t.run(p, 3, {}, (p) => {
        maxSpeed = Math.max(maxSpeed, p.vel.length());
        minX = Math.min(minX, p.pos.x); maxY = Math.max(maxY, p.pos.y);
      });
      return { state: t.state(p), maxSpeed: +maxSpeed.toFixed(1), thrownX: +(62 - minX).toFixed(2), maxY: +maxY.toFixed(2),
        events: p.events.slice(0, 6) };
    });
  },
  async fire() {
    // standing next to a burning wooden block: how hard does the fire's own
    // pressure push, and how hot does it get?
    return page.evaluate(async () => {
      const t = window.__pt;
      t.scene(({ box }) => box(66, 0, 61, 72, 10, 67, t.E.WOOD, 400));
      await t.settle(3);
      const p = t.player();
      p.spawn(new t.THREE.Vector3(63, 0, 64));
      let maxSpeed = 0;
      await t.run(p, 5, {}, (p) => { maxSpeed = Math.max(maxSpeed, p.vel.length()); });
      const c = window.__app.sim.census();
      return { state: t.state(p), maxSpeed: +maxSpeed.toFixed(1), drift: +(p.pos.x - 63).toFixed(2), fire: c[t.E.FIRE]?.n ?? 0 };
    });
  },
  async coupling() {
    return page.evaluate(async () => {
      const t = window.__pt, a = window.__app;
      t.scene(({ box }) => {
        box(30, 0, 30, 100, 12, 100, t.E.GLASS);
        box(31, 1, 31, 99, 12, 99, t.E.EMPTY);
        box(31, 1, 31, 99, 4, 99, t.E.WATER);   // wading depth: 3 cells
        box(31, 4, 60, 40, 6, 70, t.E.SAND);
      });
      await t.settle(1.5);
      const census0 = a.sim.census();
      const p = t.player();
      p.spawn(new t.THREE.Vector3(40, 1, 64));
      // Velocity of water cells whose centres are inside a body-sized box at
      // (x, z), read right after the frame's coupling pass: mean speed along
      // +x (the walking direction) and outward from the box's axis.
      const g = a.sim.g;
      const W = g.width, Hh = g.height, A = new Float32Array(W * Hh * 4), B = new Float32Array(W * Hh * 4);
      const idx = (x, y, z) => ((Math.floor(y / g.tx) * g.nz + z) * g.width + (y % g.tx) * g.nx + x) * 4;
      const readV = (cx, cz) => {
        const sim = a.sim;
        a.renderer.readRenderTargetPixels(sim.targets[sim.cur], 0, 0, W, Hh, A, undefined, 0);
        a.renderer.readRenderTargetPixels(sim.targets[sim.cur], 0, 0, W, Hh, B, undefined, 1);
        let n = 0, fwd = 0, out = 0;
        for (let y = 1; y < 4; y++) for (let z = Math.floor(cz - 1); z <= cz + 1; z++) for (let x = Math.floor(cx - 1); x <= cx + 1; x++) {
          if (Math.abs(x + 0.5 - cx) > 0.8 || Math.abs(z + 0.5 - cz) > 0.8) continue;
          const i = idx(x, y, z);
          if (Math.round(A[i]) !== t.E.WATER) continue;
          const rx = x + 0.5 - cx, rz = z + 0.5 - cz, r = Math.hypot(rx, rz) || 1;
          n++; fwd += B[i]; out += (B[i] * rx + B[i + 2] * rz) / r;
        }
        return { n, fwd: +(fwd / Math.max(n, 1)).toFixed(3), out: +(out / Math.max(n, 1)).toFixed(3) };
      };
      const body = [], control = [];
      await t.run(p, 4, { move: { x: 1, z: 0 }, sprint: true }, (p) => {
        if (p.pos.x > 45 && p.pos.x < 80 && body.length < 20) {
          body.push(readV(p.pos.x, p.pos.z));
          control.push(readV(p.pos.x, p.pos.z + 15));
        }
      });
      const avg = (arr, k) => +(arr.reduce((s, r) => s + r[k], 0) / Math.max(arr.length, 1)).toFixed(3);
      const samples = { frames: body.length, body: { fwd: avg(body, 'fwd'), out: avg(body, 'out'), n: avg(body, 'n') },
        control: { fwd: avg(control, 'fwd'), out: avg(control, 'out'), n: avg(control, 'n') } };
      await t.settle(1);
      const census1 = a.sim.census();
      const diff = {};
      for (const k of new Set([...Object.keys(census0), ...Object.keys(census1)])) {
        const d = (census1[k]?.n ?? 0) - (census0[k]?.n ?? 0);
        if (d) diff[k] = d;
      }
      return { state: t.state(p), samples, censusDiff: diff, water: census1[t.E.WATER]?.n, sand: census1[t.E.SAND]?.n };
    });
  },
};

for (const [name, fn] of Object.entries(tests)) {
  if (only.length && !only.includes(name)) continue;
  try {
    const r = await fn();
    console.log(`\n## ${name}\n${JSON.stringify(r)}`);
  } catch (e) {
    console.log(`\n## ${name} FAILED\n${String(e).slice(0, 1500)}`);
  }
}
if (errs.length) console.log('\nconsole errors:\n' + errs.slice(0, 10).join('\n'));
await b.close();
