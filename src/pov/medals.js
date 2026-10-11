import { povEvents } from './events.js';
import { PLAYER } from './targets.js';
import {
  MEDALS, MULTIKILLS, SPREES, MULTIKILL_S, SPREE_STEP, WEAPON_SPREE, ZOMBIE_SPREE, KILLJOY_SPREE,
  PERFECTION_KILLS, CHAIN_BLASTS, CHAIN_GAP_S,
} from './medaldefs.js';
import { play } from './announcer.js';
import './medals.css';

// Halo 3's medals for the player, and a few for the sim's chaos (medaldefs.js
// has the list, the rules and Halo 3's numbers). They hang off the killfeed's
// 'kill' (killfeed.js: every death it shows, sandbox and team games alike) and
// the match's events (src/game/index.js: game:start/end/team/flag/infected),
// plus 'blast' for Chain Reaction. Only the player earns them: a kill counts
// when its credit is the player's (by === PLAYER); Own Goal is the one about
// your own death. A team game's credit already leaves out teammates (a
// betrayal is nobody's kill there).
//
// An award pops its badge into the medal row (medalbadge.js), says its name
// (announcer.js) and is announced as povEvents 'medal' { key, name }.
//
//   createMedals({ isPlayerDead, now })   isPlayerDead() → the player is dead
//   now: s, the clock the rules run on (performance's by default; checks pass their own)

// ---- the row: Halo 3's medals pop in one after another, the name under each,
// then fade. Its timings aren't published; these are ours, by eye.
const HOLD_S = 3;              // s a medal shows before it fades
const FADE_S = 0.6;            // s its fade lasts
const POP_S = 0.35;            // s its pop-in lasts (medals.css medal-pop)
const POP_GAP_S = 0.3;         // s between two medals earned at once: one after another, not all together
const MAX_SHOWN = 6;           // medals in the row at once: a new one pushes the oldest out

// ---- what a kill was (its cause: vitals.js and the tools' hurt() causes, as killfeed.js CAUSES reads them)
const MELEE = ['Axed', 'Stabbed', 'Picked apart', 'Kicked'];   // axe, knife, pickaxe, kick
const KINDS = [   // [medal, test(kill, cause)]: each kill gets every one that fits
  ['assassin', (e, c) => c.startsWith('Backstabbed')],
  ['beatDown', (e, c) => MELEE.some((p) => c.startsWith(p))],
  ['splatter', (e, c) => c.startsWith('Run over')],
  ['incineration', (e) => e.icon === 'BLOWTORCH'],   // burned while the killer held the blowtorch (killfeed.js iconFor)
  ['sniperKill', (e) => e.icon === 'SNIPER'],        // shot while the killer held the sniper rifle
  ['laserKill', (e, c) => c.startsWith('Lasered')],
  ['bored', (e, c) => c.startsWith('Bored')],
  ['heavyParticles', (e, c) => c.startsWith('Buried')],
  ['flooded', (e, c) => c.startsWith('Drowned')],
];
const WEAPON_SPREES = [   // kills with one weapon in one life: [test, medal per WEAPON_SPREE step]
  [(e) => e.icon === 'SNIPER', ['sniperSpree', 'sharpshooter']],
  [(e, c) => c.startsWith('Run over'), ['splatterSpree', 'vehicularManslaughter']],
];
const ZOMBIE_MEDALS = { infect: ['infectionSpree', 'mmmBrains'], kill: ['zombieKillingSpree', 'hellsJanitor'] };
const HUMANS = 'blue', INFECTED = 'infected';   // src/game/rules.js HUMANS, INFECTED
const ORDER = Object.keys(MEDALS);               // a kill's medals pop in the table's order

const badgeLoading = import('./medalbadge.js');   // its icons load in the background, as the killfeed's do

export function createMedals({ isPlayerDead = () => false, now = () => performance.now() / 1000 } = {}) {
  // the player's books
  let multi = 0, lastKill = -Infinity, spree = 0, infections = 0, zombieKills = 0;
  const weapon = WEAPON_SPREES.map(() => 0);
  const others = new Map();      // anyone else → kills without dying (Killjoy)
  // the match's
  let match = null;              // { mode } while a team game runs
  const teamOf = new Map();      // id → team
  const carrier = {};            // flag's team → who carries it
  let lastMan = false;
  let chain = null;              // { last, links, done }: a Chain Reaction under way
  const awarded = [];            // keys, in order (checks)

  function reset() {
    multi = 0; lastKill = -Infinity; spree = 0; infections = 0; zombieKills = 0;
    weapon.fill(0);
    others.clear();
    for (const k in carrier) delete carrier[k];
    lastMan = false;
    chain = null;
  }
  // a life ends: its sprees with it (Halo: "without dying"); a multi-kill only runs on the clock
  function diedSelf() { spree = 0; weapon.fill(0); infections = 0; zombieKills = 0; }
  const step = (count, steps, medals, got) => { const i = steps.indexOf(count); if (i >= 0) got.push(medals[i]); };

  povEvents.on('kill', (e) => {
    if (String(e.id).startsWith('bird:')) return;   // birds are scenery: Halo's medals count players
    const cause = e.cause ?? '';
    const ended = others.get(e.id) ?? 0;            // the victim's spree, now over
    others.delete(e.id);
    if (e.by && e.by !== PLAYER) others.set(e.by, (others.get(e.by) ?? 0) + 1);
    if (e.id === PLAYER) {
      if (e.self) award(['ownGoal']);
      diedSelf();
      return;
    }
    if (e.by !== PLAYER) return;
    const got = KINDS.filter(([, test]) => test(e, cause)).map(([k]) => k);
    if (ended >= KILLJOY_SPREE) got.push('killjoy');
    if (isPlayerDead()) got.push('deathFromTheGrave');
    if (match && teamOf.has(PLAYER) && carrier[teamOf.get(PLAYER)] === e.id) got.push('killedFlagCarrier');
    // multi-kills: each within MULTIKILL_S of the last; Halo 3 stops at Killionaire (no repeat past it)
    const t = now();
    multi = t - lastKill <= MULTIKILL_S ? multi + 1 : 1;
    lastKill = t;
    if (MULTIKILLS[multi - 2]) got.push(MULTIKILLS[multi - 2]);
    spree++;
    if (spree % SPREE_STEP === 0 && SPREES[spree / SPREE_STEP - 1]) got.push(SPREES[spree / SPREE_STEP - 1]);
    WEAPON_SPREES.forEach(([test, medals], i) => { if (test(e, cause)) step(++weapon[i], WEAPON_SPREE, medals, got); });
    if (match?.mode === 'infection' && teamOf.get(PLAYER) === HUMANS && teamOf.get(e.id) === INFECTED) step(++zombieKills, ZOMBIE_SPREE, ZOMBIE_MEDALS.kill, got);
    award(got.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)));
  });

  // Chain Reaction: your blast, then others set off by it, each soon after the one before.
  // While a chain runs your own next blasts neither count nor keep it going: the world has to.
  povEvents.on('blast', (e) => {
    const t = now(), mine = !e.by || e.by === PLAYER;
    if (chain && t - chain.last > CHAIN_GAP_S) chain = null;
    if (!chain) { if (mine) chain = { last: t, links: 1, done: false }; return; }
    if (mine) return;
    chain.last = t;
    if (++chain.links >= CHAIN_BLASTS && !chain.done) { chain.done = true; award(['chainReaction']); }
  });

  // the match
  povEvents.on('game:start', ({ mode, teams }) => {
    reset();
    match = { mode };
    teamOf.clear();
    for (const [team, ids] of Object.entries(teams ?? {})) for (const id of ids) teamOf.set(id, team);
  });
  povEvents.on('game:end', (r) => {
    const me = r.roster?.find((x) => x.me);
    if (r.mode === 'slayer' && me && r.winner === me.team && me.kills >= PERFECTION_KILLS && me.deaths === 0) award(['perfection']);
    reset();
    match = null;
    teamOf.clear();
  });
  povEvents.on('game:team', ({ id, team }) => {
    teamOf.set(id, team);
    if (match?.mode !== 'infection' || lastMan) return;
    const humans = [...teamOf].filter(([, t]) => t === HUMANS);
    if (humans.length === 1 && humans[0][0] === PLAYER) { lastMan = true; award(['lastManStanding']); }
  });
  povEvents.on('game:flag', ({ team, action, by }) => {
    carrier[team] = action === 'taken' ? by : null;
    if (action === 'captured' && by === PLAYER) award(['flagScore']);
  });
  povEvents.on('game:infected', ({ by }) => {
    if (by !== PLAYER) return;
    const got = [];
    step(++infections, ZOMBIE_SPREE, ZOMBIE_MEDALS.infect, got);
    award(got);
  });

  // ---- awarding: the event now, the badge and the voice one after another
  let nextPop = 0;
  const wall = () => performance.now() / 1000;
  function award(keys) {
    for (const key of keys) {
      awarded.push(key);
      povEvents.as(null, () => povEvents.emit('medal', { key, name: MEDALS[key].name }));   // the player's, whatever was acting
      const t = wall(), at = Math.max(t, nextPop);
      nextPop = at + POP_GAP_S;
      setTimeout(() => { pop(key); play(key); }, (at - t) * 1000);
    }
  }

  let row = null;
  async function pop(key) {
    if (typeof document === 'undefined') return;
    const { badgeSvg } = await badgeLoading;
    if (!row) {
      row = document.createElement('div');
      row.className = 'medal-row';
      row.setAttribute('aria-live', 'polite');
      row.style.setProperty('--medal-pop', `${POP_S}s`);
      row.style.setProperty('--medal-fade', `${FADE_S}s`);
      document.body.append(row);
    }
    const el = document.createElement('div');
    el.className = 'medal';
    el.innerHTML = badgeSvg(key, { label: false });
    const name = document.createElement('span');
    name.className = 'medal-name';
    name.textContent = MEDALS[key].name;
    el.append(name);
    row.append(el);
    while (row.children.length > MAX_SHOWN) row.firstElementChild.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), FADE_S * 1000); }, HOLD_S * 1000);
  }

  return {
    get awarded() { return awarded.slice(); },
    award: (key) => { if (MEDALS[key]) award([key]); },   // checks: show one
  };
}
