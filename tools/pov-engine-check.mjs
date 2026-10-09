// Headless GPU checks for hardness and breaking (POV engine work): impact
// breaking, impact heat, blast breaking and mass conservation, on a 64³ grid.
// Each scene is built on the CPU, uploaded with sim.load and stepped by hand.
// usage: node tools/pov-engine-check.mjs [--port 5191] [scene ...]
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args.splice(i, 2)[1] : d; };
const port = opt('port', '5191');
const only = args;

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 480, height: 320 } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 2000)); else if (m.type() === 'log') console.log('  [page]', m.text()); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 2000)));
await p.addInitScript(() => {
  localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ autoRes: false, res: 0.5, liveTiles: false }));
});
await p.goto(`http://localhost:${port}/?preset=empty&size=64`);
await p.waitForFunction(() => window.__app?.sim, null, { timeout: 30000 });
await p.waitForTimeout(1500);

// ---- helpers, installed in the page ----
await p.evaluate(async () => {
  const { E, ELEMENTS } = await import('/src/elements.js');
  const a = window.__app;
  a.settings.paused = true;
  const sim = a.sim;
  const g = sim.g;
  const idx = (x, y, z) => ((Math.floor(y / g.tx) * g.nz + z) * g.width + (y % g.tx) * g.nx + x) * 4;
  const t = {
    E, ELEMENTS, g,
    fresh() { [t.A, t.B] = sim.blankState(); },
    set(x, y, z, key, o = {}) {
      const id = E[key], i = idx(x, y, z), e = ELEMENTS[id];
      t.A[i] = id; t.A[i + 1] = o.T ?? e.temp; t.A[i + 2] = o.life ?? e.life; t.A[i + 3] = (o.ctype ?? 0) + (t.A[i + 3] % 1);
      t.B[i] = o.vx ?? 0; t.B[i + 1] = o.vy ?? 0; t.B[i + 2] = o.vz ?? 0; t.B[i + 3] = o.P ?? 0;
    },
    box(x0, x1, y0, y1, z0, z1, key, o) {
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) t.set(x, y, z, key, o);
    },
    load() { sim.frame = 0; sim.load(t.A, t.B); },
    step(n = 1) { for (let i = 0; i < n; i++) sim.step(); },
    read() {
      const n = g.width * g.height * 4;
      t.rA = new Float32Array(n); t.rB = new Float32Array(n);
      const tgt = sim.targets[sim.cur];
      a.renderer.readRenderTargetPixels(tgt, 0, 0, g.width, g.height, t.rA, undefined, 0);
      a.renderer.readRenderTargetPixels(tgt, 0, 0, g.width, g.height, t.rB, undefined, 1);
    },
    cell(x, y, z) {
      const i = idx(x, y, z);
      return { id: Math.round(t.rA[i]), key: ELEMENTS[Math.round(t.rA[i])].key, T: +t.rA[i + 1].toFixed(1),
        life: +t.rA[i + 2].toFixed(3), ctype: Math.floor(t.rA[i + 3]), v: [t.rB[i], t.rB[i + 1], t.rB[i + 2]].map((v) => +v.toFixed(3)), P: +t.rB[i + 3].toFixed(2) };
    },
    // per-element counts, and the hottest cell of each
    counts() {
      const c = {};
      for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
        const i = idx(x, y, z), k = ELEMENTS[Math.round(t.rA[i])].key;
        const o = (c[k] ??= { n: 0, Tmax: -1e9 });
        o.n++; o.Tmax = Math.max(o.Tmax, +t.rA[i + 1].toFixed(1));
      }
      delete c.EMPTY;
      return c;
    },
    // every cell of an element (x, y, z, T)
    where(key) {
      const out = [], id = E[key];
      for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
        const i = idx(x, y, z);
        if (Math.round(t.rA[i]) === id) out.push([x, y, z, +t.rA[i + 1].toFixed(1)]);
      }
      return out;
    },
    // read the state, change it, and put it back (keeps the step counter)
    edit(fn) {
      t.read();
      fn((x, y, z) => idx(x, y, z));
      sim.load(t.rA, t.rB);
    },
    total() { return Object.values(t.counts()).reduce((s, c) => s + c.n, 0); },
    maxP(cells) { return Math.max(...cells.map(([x, y, z]) => t.rB[idx(x, y, z) + 3])); },
  };
  window.__t = t;
});

const scenes = {
  // Probe: peak blast pressure in open air at distance d from a gunpowder ball.
  async blastProfile() {
    return p.evaluate(() => {
      const t = window.__t, out = {};
      for (const r of [1, 2]) {
        t.fresh();
        t.box(20 - r, 20 + r, 30 - r, 30 + r, 32 - r, 32 + r, 'GUNPOWDER', { T: 250 });
        t.load();
        const peak = {};
        for (let s = 0; s < 40; s++) {
          t.step();
          t.read();
          for (const d of [1, 2, 3, 4, 6, 8, 10, 14, 18]) {
            const x = 20 + r + d;
            peak[d] = Math.max(peak[d] ?? -1e9, t.cell(x, 30, 32).P);
          }
        }
        out[`ball ${2 * r + 1}³`] = peak;
      }
      // a 9³ pile lit by one flame at a corner: it goes off in a wave, and each
      // cell's blast lands on the pressure its neighbours already made
      t.fresh();
      t.box(10, 18, 2, 10, 28, 36, 'GUNPOWDER');
      t.set(9, 2, 28, 'FIRE');
      t.load();
      const peak = {};
      let pin = 0;
      for (let s = 0; s < 120; s++) {
        t.step();
        t.read();
        for (let x = 10; x <= 18; x++) pin = Math.max(pin, t.cell(x, 6, 32).P);
        for (const d of [1, 2, 3, 4, 6, 8, 10, 14]) peak[d] = Math.max(peak[d] ?? -1e9, t.cell(18 + d, 6, 32).P);
      }
      out['9³ pile, lit at a corner'] = { inside: pin, ...peak };
      return out;
    });
  },

  // Peak pressure on a WALL pane's face at distance d from lit piles (what a pane there would feel).
  async paneLoad() {
    return p.evaluate(() => {
      const t = window.__t, out = {};
      for (const n of [1, 3, 5, 7]) for (const lit of ['flame', 'heat']) {
        const res = {};
        for (const [da, db] of [[1, 2], [3, 4], [6, 8]]) {
          t.fresh();
          const a0 = 32 - (n >> 1), a1 = a0 + n - 1, y0 = 10, y1 = y0 + n - 1;
          t.box(a0, a1, y0, y1, a0, a1, 'GUNPOWDER', lit === 'heat' ? { T: 250 } : {});
          if (lit === 'flame') t.set(a0 - 1, y0, a0, 'FIRE');
          const yc = (y0 + y1) >> 1;
          t.box(a1 + da, a1 + da, y0 - 6, y1 + 6, a0 - 6, a1 + 6, 'WALL');   // +x, distance da
          t.box(a0 - db, a0 - db, y0 - 6, y1 + 6, a0 - 6, a1 + 6, 'WALL');   // -x, distance db
          t.load();
          let pa = 0, pb = 0;
          for (let s = 0; s < 60; s++) {
            t.step(); t.read();
            pa = Math.max(pa, t.cell(a1 + da - 1, yc, 32).P);
            pb = Math.max(pb, t.cell(a0 - db + 1, yc, 32).P);
          }
          res[da] = +pa.toFixed(0); res[db] = +pb.toFixed(0);
        }
        out[`${n}³ ${lit === 'flame' ? 'lit by a flame' : 'all at once'}`] = res;
      }
      return out;
    });
  },

  // A SCRAP slug at vx = 1 into a pane or block of each material.
  async slugs() {
    return p.evaluate(() => {
      const t = window.__t, out = {};
      const shoot = (target, thick, gap, steps = 40, v = { vx: 1 }, extra) => {
        const x0 = 40;
        t.fresh();
        t.box(x0, x0 + thick - 1, 28, 52, 22, 42, target);
        extra?.();
        t.set(x0 - 1 - gap, 40, 32, 'SCRAP', v);
        t.load(); t.read();
        const before = t.counts(), debris = t.ELEMENTS[t.E[target]].breakInto;
        // the slug is the SCRAP cell with the largest x-speed until it hits, then the one furthest along
        const slug = () => t.where('SCRAP').map((c) => [c, t.cell(c[0], c[1], c[2])]).sort((a, b) => b[1].v[0] - a[1].v[0])[0];
        const peak = {};
        let prev = slug(), hit = null;
        for (let s = 1; s <= steps; s++) {
          t.step(); t.read();
          for (const [k, v] of Object.entries(t.counts())) peak[k] = Math.max(peak[k] ?? -1e9, v.Tmax);
          const cur = slug();
          if (!hit && cur[1].v[0] < prev[1].v[0] - 0.05) hit = { step: s, vxBefore: prev[1].v[0], vxAfter: cur[1].v[0], debrisV: debris && t.where(debris).map((c) => t.cell(c[0], c[1], c[2]).v[0]) };
          prev = cur;
        }
        const after = t.counts();
        return {
          before: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.n])),
          after: Object.fromEntries(Object.entries(after).map(([k, v]) => [k, `${v.n} (peak T ${peak[k]})`])),
          hit, Ehit: hit && +(0.5 * 78 * hit.vxBefore ** 2).toFixed(1),
          conserved: t.total() === Object.values(before).reduce((s, v) => s + v.n, 0),
        };
      };
      out['GLASS pane, 1 thick, gap 5'] = shoot('GLASS', 1, 5);
      out['GLASS pane, 3 thick, gap 5'] = shoot('GLASS', 3, 5);
      out['METAL plate, 2 thick, gap 5'] = shoot('METAL', 2, 5);
      out['ROCK block, 6 thick, gap 2'] = shoot('ROCK', 6, 2);
      out['ROCK block, 6 thick, gap 12'] = shoot('ROCK', 6, 12);
      out['WOOD plank, 2 thick, gap 5'] = shoot('WOOD', 2, 5);
      out['WALL, gap 5'] = shoot('WALL', 2, 5);
      // the pane starts out in quiet bricks (shaders/activity.js) and has to wake up in time
      out['GLASS pane, gap 20'] = shoot('GLASS', 1, 20);
      // diagonal in xz, and diagonal down into a corner of glass (pane + floor)
      out['GLASS pane, diagonal xz'] = shoot('GLASS', 1, 5, 40, { vx: 0.8, vz: 0.6 });
      out['GLASS corner, diagonal down'] = shoot('GLASS', 1, 3, 40, { vx: 0.75, vy: -0.75 }, () => t.box(20, 39, 35, 35, 22, 42, 'GLASS'));
      return out;
    });
  },

  // A slug into a powder keg (constructions/builtins.js barrel 'keg') from several ranges.
  async keg() {
    return p.evaluate(async () => {
      const t = window.__t, out = {};
      const { barrel } = await import('/src/constructions/builtins.js');
      for (const gap of [1, 6, 14, 24]) {
        const res = [];
        // aim higher from further out: the slug drops ~g·n²/2 on the way
        const y0 = 6 + Math.round(0.0125 * (gap + 1) ** 2);
        for (const trial of [-3, -2, -1, 0, 1, 2, 3]) {
          t.fresh();
          t.box(0, 63, 0, 0, 0, 63, 'ROCK');
          barrel({ put: (x, y, z, key) => key !== 'AIR' && t.set(32 + x, 1 + y, 32 + z, key), T: 1 }, 'keg');
          t.set(32 - 5 - gap, y0, 32 + trial, 'SCRAP', { vx: 1 });
          t.load();
          t.read();
          const gp0 = t.where('GUNPOWDER').length;
          let boom = null, broke = null, sawMax = -1e9;
          for (let s = 1; s <= 90 && boom === null; s++) {
            t.sim ??= null;
            t.step(); t.read();
            const saw = t.where('SAWDUST');
            if (saw.length && broke === null) broke = s;
            for (const c of saw) sawMax = Math.max(sawMax, c[3]);
            if (t.where('GUNPOWDER').length < gp0) boom = s;
          }
          res.push(`z${trial}: ${broke === null ? 'shell held' : `shell broke at step ${broke}`}, ${boom === null ? 'no boom' : `BOOM at ${boom}`}`);
        }
        out[`gap ${gap}`] = res;
      }
      return out;
    });
  },

  // Gunpowder blasts next to panes: touching on +x, 3 cells off on -x, 6 off on +z.
  async blast() {
    return p.evaluate(() => {
      const t = window.__t, out = {};
      const run = (mat, pile) => {
        t.fresh();
        const [a0, a1] = pile === 'small' ? [31, 33] : [29, 35];
        const y0 = 10, y1 = y0 + a1 - a0;
        t.box(a0, a1, y0, y1, a0, a1, 'GUNPOWDER', pile === 'small' ? { T: 250 } : {});
        if (pile !== 'small') t.set(a0 - 1, y0, a0, 'FIRE');
        const panes = {
          touching: [a1 + 1, a1 + 1, y0 - 4, y1 + 4, a0 - 4, a1 + 4],
          'gap 3': [a0 - 4, a0 - 4, y0 - 4, y1 + 4, a0 - 4, a1 + 4],
          'gap 6': [a0 - 2, a1 + 2, y0 - 4, y1 + 4, a1 + 7, a1 + 7],
        };
        for (const b of Object.values(panes)) t.box(...b, mat);
        t.load();
        const n0 = {};
        t.read();
        const inPane = (b) => { let n = 0; for (let x = b[0]; x <= b[1]; x++) for (let y = b[2]; y <= b[3]; y++) for (let z = b[4]; z <= b[5]; z++) if (t.cell(x, y, z).key === mat) n++; return n; };
        for (const [k, b] of Object.entries(panes)) n0[k] = inPane(b);
        t.step(80); t.read();
        return Object.fromEntries(Object.entries(panes).map(([k, b]) => [k, `${n0[k] - inPane(b)}/${n0[k]} broken`]));
      };
      for (const pile of ['small', 'big']) for (const mat of ['GLASS', 'ICE', 'PLANT', 'WOOD', 'ROCK', 'METAL']) out[`${pile} ${mat}`] = run(mat, pile);
      return out;
    });
  },

  // Sand dropped onto a rock floor and onto the box floor: how warm does it get?
  async sandDrop() {
    return p.evaluate(() => {
      const t = window.__t, out = {};
      for (const floor of ['ROCK', 'box']) for (const h of [10, 30, 55]) {
        t.fresh();
        if (floor === 'ROCK') t.box(0, 63, 0, 1, 0, 63, 'ROCK');
        const y = (floor === 'ROCK' ? 2 : 0) + h;
        t.box(30, 34, y, y + 1, 30, 34, 'SAND');
        t.load();
        let sMax = -1e9, rMax = -1e9;
        for (let s = 0; s < 160; s++) {
          t.step(); t.read();
          for (const c of t.where('SAND')) sMax = Math.max(sMax, c[3]);
          if (floor === 'ROCK') for (let x = 30; x <= 34; x++) for (let z = 30; z <= 34; z++) rMax = Math.max(rMax, t.cell(x, 1, z).T);
        }
        out[`${floor} floor, drop ${h}`] = { sandTmax: sMax, floorTmax: floor === 'ROCK' ? rMax : null, sandCount: t.where('SAND').length };
      }
      return out;
    });
  },

  // Debris: shards resist acid, sawdust burns, shards and scrap melt and recast.
  async debris() {
    return p.evaluate(() => {
      const t = window.__t, out = {};
      // acid on a bed of shards next to a bed of sand
      t.fresh();
      t.box(10, 20, 0, 1, 10, 20, 'SHARDS');
      t.box(30, 40, 0, 1, 10, 20, 'SAND');
      t.box(10, 20, 2, 4, 10, 20, 'ACID');
      t.box(30, 40, 2, 4, 10, 20, 'ACID');
      t.load();
      t.step(200); t.read();
      out.acid = { shardsLeft: `${t.where('SHARDS').length}/242`, sandLeft: `${t.where('SAND').length}/242` };
      // hot sawdust in air
      t.fresh();
      t.box(20, 24, 0, 1, 20, 24, 'SAWDUST', { T: 300 });
      t.load();
      t.step(300); t.read();
      const c = t.counts();
      out.sawdust = { SAWDUST: c.SAWDUST?.n ?? 0, ASH: c.ASH?.n ?? 0, FIRE: c.FIRE?.n ?? 0, SMOKE: c.SMOKE?.n ?? 0 };
      // shards and scrap melted, then cooled
      for (const key of ['SHARDS', 'SCRAP']) {
        t.fresh();
        t.box(0, 63, 0, 0, 0, 63, 'WALL');
        t.set(32, 1, 32, key, { T: key === 'SHARDS' ? 1450 : 1550 });
        t.load();
        t.step(2); t.read();
        const melted = t.cell(32, 1, 32);
        t.edit((idx) => { t.rA[idx(32, 1, 32) + 1] = 1000; });
        t.step(2); t.read();
        out[key] = { melted: `${melted.key}, remembers ${t.ELEMENTS[melted.ctype].key}`, cooled: t.cell(32, 1, 32).key };
      }
      return out;
    });
  },
};

for (const [name, fn] of Object.entries(scenes)) {
  if (only.length && !only.includes(name)) continue;
  console.log(`== ${name}`);
  console.log(JSON.stringify(await fn(), null, 1));
}
console.log(errs.length ? errs.join('\n') : 'no console errors');
await b.close();
