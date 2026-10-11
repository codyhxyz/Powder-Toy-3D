import { h } from '../ui/dom.js';
import { povEvents } from '../pov/events.js';
import { PLAYER } from '../pov/targets.js';
import { CROUCH_WALK_SPEED } from '../pov/player.js';
import { CELL_METERS } from '../pov/vitals.js';
import { RADAR, RADAR_M } from './rules.js';
import './feel.css';

// Halo 3's motion tracker, bottom left (beside the vitals; the medals stack
// above it): a disc 25 m across its radius (rules.js RADAR_M, the bots' own
// tracker), turned with the view so ahead is up. Teammates always show, as
// yellow dots; an enemy shows as a red dot only while it moves faster than a
// crouch-walk or fires a gun (Halopedia, "Motion tracker": standing still,
// crouching and crouch-walking don't register), and its dot fades a moment
// after. A ping sweeps out from the centre. Halo 3 doesn't mark height; ours
// turns a dot on another floor into a triangle pointing up or down (Halo 2
// tilted its tracker with the view for the same reason). Drawn on a 2D canvas
// at TRACKER_HZ, not every GPU frame. Styles in feel.css.

const TRACKER_PX = 132;         // CSS px across (feel.css sizes the box to match)
const TRACKER_HZ = 30;          // redraws a second at most
const SWEEP_S = 1.5;            // s per ping sweep, centre to rim (undocumented in Halo 3: ours)
const FIRE_SHOW_S = 1;          // s a shot keeps its shooter on the tracker (undocumented: ours)
const DOT_FADE_S = 0.6;         // s a dot takes to fade once its body stops showing
const MOVE_MARGIN = 1.15;       // × CROUCH_WALK_SPEED: faster than this shows (a crouch-walk at full pace doesn't)
const LEVEL_M = 3;              // m above or below: another floor (a storey), drawn as a triangle
const DOT_PX = 3.6;             // px, a dot's radius
const RIM_PX = 2;               // px between the disc's edge and the range's edge
const ENEMY = '#ff4b3e';        // Halo's red...
const ALLY = '#ffd84a';         // ...and yellow
const SWEEP_RGB = '120, 200, 255';
const DISC = 'rgba(12, 18, 26, 0.62)';
const RING = 'rgba(150, 200, 255, 0.28)';
const ME = 'rgba(220, 235, 255, 0.9)';
const SHOTS = ['gun:fire', 'wand:fire', 'flame', 'laser'];   // what counts as firing (the bots' too: their emits carry by)

export function createTracker() {
  const canvas = h('canvas.feel-tracker-canvas');
  const range = h('span.feel-tracker-range', { text: `${RADAR_M} m` });
  const root = h('div.feel-tracker', {}, canvas, range);
  document.body.append(root);
  const g = canvas.getContext('2d');
  let dpr = 0;
  const fit = () => {
    const d = Math.min(2, globalThis.devicePixelRatio || 1);
    if (d === dpr) return;
    dpr = d;
    canvas.width = canvas.height = Math.round(TRACKER_PX * d);
  };

  const fired = new Map();   // body id → wall time (s) of its last shot
  const seen = new Map();    // body id → wall time it last showed
  const now = () => performance.now() / 1000;
  const offs = SHOTS.map((name) => povEvents.on(name, (e) => fired.set(e.by ?? PLAYER, now())));
  let lastDraw = -Infinity, on = false;

  // a dot at canvas (x, y): a circle, or a triangle pointing up (above) or down (below)
  function dot(x, y, r, level) {
    g.beginPath();
    if (!level) g.arc(x, y, r, 0, Math.PI * 2);
    else {
      const s = level > 0 ? -1 : 1, k = r * 1.35;
      g.moveTo(x, y + s * k); g.lineTo(x + k, y - s * k * 0.75); g.lineTo(x - k, y - s * k * 0.75); g.closePath();
    }
    g.fill();
  }

  // view: { me: { pos }, dir: { x, z } (the view's heading), bodies: [{ id, pos, vel, ally, reveal }] }
  function draw(view, t) {
    fit();
    const W = canvas.width, c = W / 2, R = c - RIM_PX * dpr, k = R / RADAR;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, W);
    // the disc, its rings and the ping
    g.fillStyle = DISC;
    g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2); g.fill();
    g.strokeStyle = RING; g.lineWidth = dpr;
    for (const f of [1, 0.5]) { g.beginPath(); g.arc(c, c, R * f, 0, Math.PI * 2); g.stroke(); }
    g.beginPath(); g.moveTo(c, c - R); g.lineTo(c, c + R); g.moveTo(c - R, c); g.lineTo(c + R, c); g.stroke();
    const p = (t % SWEEP_S) / SWEEP_S;
    g.strokeStyle = `rgba(${SWEEP_RGB}, ${(0.55 * (1 - p)).toFixed(3)})`;
    g.lineWidth = 2 * dpr;
    g.beginPath(); g.arc(c, c, R * p, 0, Math.PI * 2); g.stroke();
    // you, at the centre, pointing ahead
    g.fillStyle = ME;
    g.beginPath(); g.moveTo(c, c - 5 * dpr); g.lineTo(c + 3.5 * dpr, c + 3.5 * dpr); g.lineTo(c - 3.5 * dpr, c + 3.5 * dpr); g.closePath(); g.fill();
    // the bodies: ahead (the view's heading) is up, its right is right
    const fx = view.dir.x, fz = view.dir.z, n = Math.hypot(fx, fz) || 1;
    const ax = fx / n, az = fz / n;
    const level = LEVEL_M / CELL_METERS;
    g.save();
    g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2); g.clip();
    for (const b of view.bodies) {
      const alpha = b.ally ? 1 : 1 - (t - (seen.get(b.id) ?? -Infinity)) / DOT_FADE_S;
      if (alpha <= 0) continue;
      const dx = b.pos.x - view.me.pos.x, dz = b.pos.z - view.me.pos.z;
      if (dx * dx + dz * dz > RADAR * RADAR) continue;
      const right = dx * -az + dz * ax, ahead = dx * ax + dz * az;
      const dy = b.pos.y - view.me.pos.y;
      g.globalAlpha = Math.min(1, alpha);
      g.fillStyle = b.ally ? ALLY : ENEMY;
      dot(c + right * k, c - ahead * k, DOT_PX * dpr, dy > level ? 1 : dy < -level ? -1 : 0);
    }
    g.restore();
    g.globalAlpha = 1;
  }

  return {
    show(v) { on = v; root.classList.toggle('on', v); },
    // every frame of a match (it draws at TRACKER_HZ); view as draw()'s, null hides it
    update(view) {
      if (!view) { if (on) this.show(false); return; }
      if (!on) this.show(true);
      const t = now();
      // an enemy shows while it moves faster than a crouch-walk, or for a moment after a shot
      for (const b of view.bodies) {
        if (b.ally) continue;
        const speed = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
        if (b.reveal || speed > CROUCH_WALK_SPEED * MOVE_MARGIN || t - (fired.get(b.id) ?? -Infinity) < FIRE_SHOW_S) seen.set(b.id, t);
      }
      if (t - lastDraw < 1 / TRACKER_HZ) return;
      lastDraw = t;
      draw(view, t);
    },
    clear() { fired.clear(); seen.clear(); },
    dispose() { offs.forEach((f) => f()); root.remove(); },
  };
}
