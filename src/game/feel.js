import * as THREE from 'three';
import { povEvents } from '../pov/events.js';
import { PLAYER } from '../pov/targets.js';
import * as R from './rules.js';
import { createMedalBook } from './medals.js';
import { createMedalHud } from './medalHud.js';
import { createTracker } from './tracker.js';
import { createPowerups } from './powerups.js';

// Halo's layer of reward and awareness over a Halo-style match (rules.js
// style 'halo'; Siege plays without it): medals and sprees (medals.js, shown
// by medalHud.js), the motion tracker (tracker.js) and the shrines' power-ups
// (powerups.js). It listens to the match's events and reads the roster;
// game/index.js creates it, calls update() every frame and show() with its own
// visibility. docs/modes.md, "Medals, tracker, power-ups".
//
// Events it emits on povEvents: 'game:medal' { id, key, name, kind, mine, order }
// (every body's; audio.js plays the player's stings) and 'game:powerup'
// { id, kind, point, mine } (audio.js). Every roster entry carries
// entry.medals (its count this match) and entry.medalCounts ({ key: n }) for
// the scoreboard.

const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const SHOT = 'Shot';   // a round's cause of death (ballistics.js)
const HEADING_MIN = 0.05;   // the view's level share below which (looking straight up or down) the tracker turns by the camera's up instead

// game: { shell, roster() → Map(id → entry), bodyOf(entry), alive(entry), clock() → game s }
export function createFeel({ shell, roster, bodyOf, alive, clock }) {
  const wall = () => performance.now() / 1000;
  let halo = false, mode = null, visible = false, hill = null;
  const entry = (id) => roster().get(id) ?? null;
  // King of the Hill's zone, as game/index.js measures it (inZone)
  const inZone = (b, z) => !!z && hdist(b.pos, z) < z.r && b.pos.y - z.y > -1 && b.pos.y - z.y < R.ZONE_UP;
  const book = createMedalBook({
    alive: (id) => { const e = entry(id); return !!e && alive(e); },
    members: (team) => [...roster().values()].filter((e) => e.team === team).map((e) => e.id),
    inHill: (id) => { const e = entry(id), b = e && bodyOf(e); return !!b && inZone(b, hill); },
  });
  const hud = createMedalHud();
  const tracker = createTracker();
  const powerups = createPowerups({ app: shell.app, scene: shell.scene });
  const dir = new THREE.Vector3(), quat = new THREE.Quaternion();
  // the view's heading on the ground: its direction, or (looking straight down or up) its up, which points ahead (or behind)
  function heading() {
    shell.camera.getWorldDirection(dir);
    if (Math.hypot(dir.x, dir.z) >= HEADING_MIN) return dir;
    const down = dir.y < 0;
    return dir.set(0, 1, 0).applyQuaternion(shell.camera.getWorldQuaternion(quat)).multiplyScalar(down ? 1 : -1);
  }

  function awarded(list) {
    if (!list.length) return;
    const mine = [];
    list.forEach((m, order) => {
      const e = entry(m.id);
      if (e) { e.medals = book.count(m.id); e.medalCounts = book.counts(m.id); }
      const me = m.id === PLAYER;
      if (me) mine.push(m);
      povEvents.emit('game:medal', { id: m.id, key: m.key, name: m.name, kind: m.kind, mine: me, order: me ? mine.length - 1 : 0 });
    });
    if (mine.length) hud.award(mine, wall());
  }

  povEvents.on('game:start', (e) => {
    mode = e.mode; halo = R.isHalo(mode); hill = null;
    book.start(mode);
    hud.clear(); tracker.clear();
    if (halo) powerups.begin(clock());
    show(visible);
  });
  povEvents.on('game:stop', () => {   // (the medals on screen fade on their own: game:end's Perfection is one)
    halo = false; mode = null; hill = null;
    powerups.end();
    tracker.update(null);
    show(visible);
  });
  // a gunshot's cause is just 'Shot': the gun in the killer's hands names it (a sniper's kill is a Sniper Kill)
  const held = (e) => (e?.bot ? e.bot.agent?.intent?.tool : e ? shell.toolbelt?.selectedKey : null) ?? null;
  povEvents.on('game:kill', (e) => {
    if (!halo) return;
    const gun = e.cause === SHOT ? held(entry(e.by)) : null;
    awarded(book.kill(gun ? { ...e, cause: `${e.cause} (${String(gun).toLowerCase()})` } : e, clock()));
  });
  povEvents.on('game:flag', (e) => { if (halo) awarded(book.flag(e)); });
  povEvents.on('game:hill', (e) => { hill = e.at ?? null; book.hillMoved(); });
  povEvents.on('game:end', (r) => { if (halo) awarded(book.end(r)); });

  function show(v) {
    visible = v;
    hud.show(v);
    powerups.setVisible(v && halo);
    if (!(v && halo)) tracker.update(null);
  }

  // every frame (game/index.js update): the tracker and the power-ups
  function update() {
    if (!visible) return;
    hud.update(wall());
    if (!halo) return;
    const me = entry(PLAYER), body = shell.player;
    const living = [...roster().values()].filter((e) => e.team && bodyOf(e) && alive(e));
    for (const p of powerups.update(clock(), living.map((e) => ({ id: e.id, body: bodyOf(e) })), PLAYER)) {
      const mine = p.id === PLAYER;
      povEvents.emit('game:powerup', { ...p, mine });
      if (mine) hud.note('Overshield', wall());
    }
    // the tracker: yours while you're up and on a side
    if (!me?.team || !body || body.dead || !shell.active()) { tracker.update(null); return; }
    const humansLeft = mode === 'infection' ? living.filter((e) => e.team === R.HUMANS).length : 0;
    tracker.update({
      me: { pos: body.pos },
      dir: heading(),
      bodies: living.filter((e) => e !== me).map((e) => {
        const b = bodyOf(e);
        return {
          id: e.id, pos: b.pos, vel: b.vel, ally: e.team === me.team,
          // Halo's Infection: the last survivor shows on every zombie's tracker
          reveal: R.LAST_HUMAN_REVEAL && me.team === R.INFECTED && e.team === R.HUMANS && humansLeft === 1,
        };
      }),
    });
  }

  return {
    update, show,
    medalsOf: (id) => ({ total: book.count(id), counts: book.counts(id) }),
    get powerups() { return powerups.pads; },   // checks
  };
}
