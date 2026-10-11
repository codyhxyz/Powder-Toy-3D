import { povEvents } from './events.js';
import { PLAYER } from './targets.js';
import './killfeed.css';

// The killfeed: Garry's Mod's death notices (its base gamemode's cl_deathnotice.lua,
// drawn from cl_init.lua's HUDPaint), top right. The layout, timing and colours are
// GMod's own numbers; the code is a rewrite (Facepunch's Lua carries no licence), and
// the icons are game-icons.net's (killicons.js, tools/killicons.mjs) in place of
// Half-Life 2's kill icon font, which is Valve's.
//
//   Attacker [icon] Victim   the icon centred at 85% of the width, the names 16 px
//                            either side, the newest notice at the bottom
//   [icon] Victim            no attacker: a suicide (GMod's skull), or the world did it
//
// A notice holds 6 s and fades out over its last second. When the top one goes, the
// rest ease up into its place.
//
// Who killed whom: the last body to hurt the victim within KILL_CREDIT_S (a blow, or a
// blast near it), the same book src/game keeps. The icon is that killer's weapon
// (GMod: "convert the inflictor to the weapon that they're holding"), taken when the
// blow landed, else what the death's cause names (vitals.js: 'Drowned in water' →
// the drowning icon). A team game posts its own notices (src/game/index.js died: it
// knows the teams), so the watch here stands down while a match runs.
//
// Every death the feed shows is also announced on povEvents as 'kill' (the
// scoreboard and the medals listen), from here and from src/game alike:
//   { id, victim, by, killer, cause, icon, held, self, team }   by/killer null: the
//   world did it; self: a suicide; team: true from a team game (src/game/index.js)

// ---- GMod's numbers
const HOLD_S = 6;              // s a notice shows (hud_deathnotice_time)
const FADE_S = 1;              // alpha = seconds left × 255: the last second fades
const ANCHOR_X = 0.85;         // the icon's centre, a share of the width (GM:HUDPaint: DrawDeathNotice(0.85, 0.04))
const ANCHOR_Y = 0.04;         // the first row's top, a share of the height (here under the toolbar: killfeed.css)
const CELL_PX = 64;            // a kill icon's cell: ClientScheme.res HL2MPTypeDeath tall 64
const ROW_STEP = 0.75;         // rows step 0.75 × the cell (DrawDeath returns y + h × 0.75)
const ICON_SCALE = 0.5;        // HL2's weapon glyphs are about half the cell tall (their heightScale 0.35–0.6)
const NAME_GAP_PX = 16;        // each name sits this far from the icon's side
const LERP_KEEP = 0.7;         // a row keeps 0.7 of where it was each frame, easing to its place...
const LERP_HZ = 60;            // ...per frame at this rate (GMod's is per frame drawn)
export const KF_COLOR = {
  icon: 'rgb(255, 80, 0)',     // Color_Icon
  player: 'rgb(255, 255, 100)', // team.lua DefaultColor: a player in no team (Sandbox)
  npc: 'rgb(250, 50, 50)',     // NPC_Color_Enemy
  friend: 'rgb(50, 200, 50)',  // NPC_Color_Friendly (a charmed NPC: potions.js)
};

// ---- ours
const KILL_CREDIT_S = 8;       // s a blow still earns the kill (src/game/rules.js KILL_CREDIT_S, TF2's "finished off")
const BLAST_CREDIT_R = 10;     // cells: a blast this near a body marks its thrower (src/game/rules.js BLAST_CREDIT_R)
const NAMES = { [PLAYER]: 'You', axeman: 'Axeman', gunner: 'Gunner', worm: 'Worm', bird: 'Bird' };   // 'You': the scoreboard's name for the player

// the icon for a death: the killer's held tool when it explains the cause, else the cause's
const GUNS = ['GUN', 'SMG', 'SNIPER'];
const EXPLAINS = { Shot: GUNS, 'Blown up': ['ROCKET', 'BOMB'], Burned: ['BLOWTORCH', 'TORCH'] };
const CAUSES = [   // [cause prefix, icon]: vitals.js, status.js, stains.js, ingest.js and the tools' hurt() causes
  ['Backstabbed', 'backstab'], ['Stabbed', 'KNIFE'], ['Axed', 'AXE'], ['Picked apart', 'PICKAXE'],
  ['Lasered', 'LASER'], ['Bored', 'BURROWER'], ['Kicked', 'kick'], ['Eaten by a worm', 'worm'], ['Wand', 'WAND'],
  ['Run over by a hoverbike', 'hoverbike'], ['Run over', 'jeep'], ['Killed when the', 'explosion'], ['Blown up', 'explosion'],
  ['Shot', 'shot'], ['Killed by lava', 'lava'], ['Drank lava', 'lava'], ['Burned', 'fire'], ['Dissolved', 'acid'],
  ['Froze', 'cold'], ['Drowned', 'drowned'], ['Buried', 'buried'], ['Fell', 'fall'], ['Slammed', 'impact'],
  ['Electrocuted', 'shock'], ['Poisoned', 'poison'], ['Sick', 'poison'],
];
export function iconFor(cause = '', held = null) {
  const base = Object.keys(EXPLAINS).find((k) => cause.startsWith(k));
  if (held && EXPLAINS[base]?.includes(held)) return held;
  const hit = CAUSES.find(([p]) => cause.startsWith(p));
  return hit ? hit[1] : held ?? 'default';
}

// ---- the feed (made on the first notice)
let root = null, icons = null, raf = 0;
const rows = [];   // oldest first: { el, at, y }
const iconsLoading = import('./killicons.js').then((m) => { icons = m; });

function svg(key) {
  const icon = icons.KILLICONS[key] ?? icons.KILLICONS.default;
  const ns = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(ns, 'svg');
  el.setAttribute('viewBox', `0 0 ${icons.KILLICON_BOX} ${icons.KILLICON_BOX}`);
  el.setAttribute('class', 'kf-icon');
  el.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', icon.d);
  el.append(path);
  return el;
}

function name(text, color, side) {
  const el = document.createElement('span');
  el.className = `kf-name kf-${side}`;
  el.textContent = text;
  el.style.color = color;
  return el;
}

function frame() {
  raf = 0;
  const now = performance.now() / 1000;
  const dt = Math.min(now - (frame.last ?? now), 1);
  frame.last = now;
  const keep = LERP_KEEP ** (dt * LERP_HZ);
  let y = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], left = r.at + HOLD_S - now;
    if (left <= 0) { r.el.remove(); rows.splice(i--, 1); continue; }
    if (r.y != null) y = y * (1 - keep) + r.y * keep;   // a new row starts where it belongs
    r.y = y;
    r.el.style.transform = `translateY(${y.toFixed(1)}px)`;
    r.el.style.opacity = String(Math.min(1, left / FADE_S));
    y += CELL_PX * ROW_STEP;
  }
  if (rows.length) raf = requestAnimationFrame(frame);
  else frame.last = undefined;
}

// a notice: { attacker?, attackerColor?, icon, victim, victimColor? }
export async function deathNotice(n) {
  if (typeof document === 'undefined') return;
  const at = performance.now() / 1000;
  await iconsLoading;
  if (!root) {
    root = document.createElement('div');
    root.className = 'killfeed';
    root.setAttribute('aria-live', 'polite');
    root.style.setProperty('--kf-x', `${ANCHOR_X * 100}vw`);
    root.style.setProperty('--kf-y', `${ANCHOR_Y * 100}vh`);
    root.style.setProperty('--kf-cell', `${CELL_PX}px`);
    root.style.setProperty('--kf-icon-h', `${CELL_PX * ICON_SCALE}px`);
    root.style.setProperty('--kf-gap', `${NAME_GAP_PX}px`);
    root.style.setProperty('--kf-icon-color', KF_COLOR.icon);
    document.body.append(root);
  }
  const el = document.createElement('div');
  el.className = 'kf-row';
  if (n.attacker) el.append(name(n.attacker, n.attackerColor ?? KF_COLOR.player, 'left'));
  el.append(svg(n.icon), name(n.victim, n.victimColor ?? KF_COLOR.player, 'right'));
  root.append(el);
  rows.push({ el, at, y: null });
  if (!raf) raf = requestAnimationFrame(frame);
}

// ---- who killed whom, outside a team game
// opts: heldBy(id) the tool key a body holds (or null); bodies() [[id, body, kind]] of
// everything that can die this frame; quiet() true while a team game posts its own.
export function createDeathWatch({ heldBy, bodies, quiet }) {
  const last = new Map();      // victim id → { by, at, held }: what hurt it last
  const was = new Map();       // id → dead last frame
  const now = () => performance.now() / 1000;
  const mark = (id, by) => last.set(id, { by, at: now(), held: heldBy(by) });
  const color = (id, body) => (id === PLAYER ? KF_COLOR.player : body?.status?.has?.('CHARMED') ? KF_COLOR.friend : KF_COLOR.npc);
  const kinds = new Map();     // id → kind, for names
  const bodyOf = new Map();
  const nameOf = (id) => NAMES[id] ?? NAMES[kinds.get(id)] ?? id;

  povEvents.on('body:hit', (e) => {
    const by = e.by ?? PLAYER;
    if (by === e.id) return;
    if (String(e.id).startsWith('bird:')) {   // a bird dies to any blow (birds/index.js): its notice now
      if (quiet() || last.has(e.id)) return;
      last.set(e.id, { by, at: now(), held: null });
      setTimeout(() => last.delete(e.id), HOLD_S * 1000);
      const icon = iconFor(e.cause, heldBy(by));
      deathNotice({ attacker: nameOf(by), attackerColor: color(by, bodyOf.get(by)), icon, victim: NAMES.bird, victimColor: KF_COLOR.npc });
      povEvents.emit('kill', { id: e.id, victim: NAMES.bird, by, killer: nameOf(by), cause: e.cause ?? '', icon, held: heldBy(by), self: false, team: false });
      return;
    }
    mark(e.id, by);
  });
  // a blast marks every body near it, its thrower too (a suicide: GMod's skull)
  povEvents.on('blast', (e) => {
    if (!e.point) return;
    for (const [id, b] of bodyOf) if (b?.pos && !b.dead && b.pos.distanceTo(e.point) < BLAST_CREDIT_R) mark(id, e.by ?? PLAYER);
  });

  function died(id, body) {
    if (quiet()) return;   // (its hits stay for src/game's heldOn)
    const h = last.get(id);
    last.delete(id);
    const credited = h && now() - h.at <= KILL_CREDIT_S ? h : null;
    const cause = body.cause ?? '';
    const self = credited?.by === id;   // its own blast: GMod's PlayerKilledSelf, the skull and no attacker
    const by = self ? null : credited?.by ?? null;
    const icon = self ? 'default' : iconFor(cause, credited?.held ?? null);
    deathNotice({
      attacker: by ? nameOf(by) : null, attackerColor: by ? color(by, bodyOf.get(by)) : null,
      icon, victim: nameOf(id), victimColor: color(id, body),
    });
    povEvents.emit('kill', { id, victim: nameOf(id), by, killer: by ? nameOf(by) : null, cause, icon, held: credited?.held ?? null, self, team: false });
  }

  return {
    // each frame, after the bodies have moved
    update() {
      bodyOf.clear();
      for (const [id, body, kind] of bodies()) {
        bodyOf.set(id, body);
        if (kind) kinds.set(id, kind);
        const dead = !!body.dead;
        if (dead && was.get(id) === false) died(id, body);
        was.set(id, dead);
      }
    },
    // the tool the body that last hurt `id` held then (src/game's notices)
    heldOn(id, by) { const h = last.get(id); return h && h.by === by ? h.held : heldBy(by); },
  };
}
