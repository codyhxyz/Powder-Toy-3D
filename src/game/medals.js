// Halo 3's medals and sprees, as a bookkeeper: fed a match's events (game:start,
// game:kill, game:flag, game:infected, game:end), it says who earned what. Pure
// data and logic (no DOM, no three.js), so tools/medals-check.mjs runs it in node;
// medalHud.js shows and plays the player's own, feel.js wires it to the match.
//
// Every body is tracked, bots too: medal counts per roster entry are what a
// scoreboard can show (feel.js writes entry.medals). Names and rules are Halo 3's
// (Halopedia, "List of Halo 3 and Halo 3: ODST medals"); four the brief asked for
// that Halo 3 doesn't have are borrowed from the Halo that does, and say so.
// The cause strings come from the combat module (docs/halo-contract.md).

// ---- multi-kills: each kill within this long of the last one chains (Halo 3:
// "within four seconds of each other", Halopedia "Multikill")
export const MULTI_KILL_S = 4;
// Halo 3's ten, from two kills up; past the last, every further kill earns it again
export const MULTI_KILLS = ['DOUBLE_KILL', 'TRIPLE_KILL', 'OVERKILL', 'KILLTACULAR', 'KILLTROCITY',
  'KILLIMANJARO', 'KILLTASTROPHE', 'KILLPOCALYPSE', 'KILLIONAIRE'];

// ---- sprees: kills in a row without dying, one medal every SPREE_STEP (Halo 3's six, 5 to 30;
// past the last, every SPREE_STEP more earns it again)
export const SPREE_STEP = 5;
export const SPREES = ['KILLING_SPREE', 'KILLING_FRENZY', 'RUNNING_RIOT', 'RAMPAGE', 'UNTOUCHABLE', 'INVINCIBLE'];
// Halo 3's other sprees, 5 and 10 in one life: a zombie's infections, a survivor's zombie
// kills (Infection), kills with the sniper and with a vehicle
export const INFECTION_SPREES = ['INFECTION_SPREE', 'MMM_BRAINS'];
export const ZOMBIE_SPREES = ['ZOMBIE_KILLING_SPREE', 'HELLS_JANITOR'];
export const WEAPON_SPREES = { SNIPER_KILL: ['SNIPER_SPREE', 'SHARPSHOOTER'], SPLATTER: ['SPLATTER_SPREE', 'VEHICULAR_MANSLAUGHTER'] };

// ---- the rest
// Halo 3's Extermination: the whole enemy team dead at once, "with at least an Overkill" (four)
export const EXTERMINATION_MIN = 4;
// Halo 3's Perfection: win a Slayer game with at least this many kills and no deaths
export const PERFECTION_KILLS = 15;
// Halo 3's Hail to the King: this many kills in a row in one life from inside the hill, before it moves
export const HILL_KILLS = 5;

// key → { name, kind, tier }. kind picks the badge's colour and the sting
// (medalHud.js, audio.js); tier ranks the medals of one kill (the highest is
// announced). The names are Halo 3's (Halopedia), the glyphs ours.
export const MEDALS = {
  DOUBLE_KILL: { name: 'Double Kill', kind: 'multi', glyph: '2' },
  TRIPLE_KILL: { name: 'Triple Kill', kind: 'multi', glyph: '3' },
  OVERKILL: { name: 'Overkill', kind: 'multi', glyph: '4' },
  KILLTACULAR: { name: 'Killtacular', kind: 'multi', glyph: '5' },
  KILLTROCITY: { name: 'Killtrocity', kind: 'multi', glyph: '6' },
  KILLIMANJARO: { name: 'Killimanjaro', kind: 'multi', glyph: '7' },
  KILLTASTROPHE: { name: 'Killtastrophe', kind: 'multi', glyph: '8' },
  KILLPOCALYPSE: { name: 'Killpocalypse', kind: 'multi', glyph: '9' },
  KILLIONAIRE: { name: 'Killionaire', kind: 'multi', glyph: '10' },
  KILLING_SPREE: { name: 'Killing Spree', kind: 'spree', glyph: '5' },
  KILLING_FRENZY: { name: 'Killing Frenzy', kind: 'spree', glyph: '10' },
  RUNNING_RIOT: { name: 'Running Riot', kind: 'spree', glyph: '15' },
  RAMPAGE: { name: 'Rampage', kind: 'spree', glyph: '20' },
  UNTOUCHABLE: { name: 'Untouchable', kind: 'spree', glyph: '25' },
  INVINCIBLE: { name: 'Invincible', kind: 'spree', glyph: '30' },
  INFECTION_SPREE: { name: 'Infection Spree', kind: 'spree', glyph: '5' },
  MMM_BRAINS: { name: 'Mmmm... Brains', kind: 'spree', glyph: '10' },
  ZOMBIE_KILLING_SPREE: { name: 'Zombie Killing Spree', kind: 'spree', glyph: '5' },
  HELLS_JANITOR: { name: "Hell's Janitor", kind: 'spree', glyph: '10' },
  SNIPER_SPREE: { name: 'Sniper Spree', kind: 'spree', glyph: '5' },
  SHARPSHOOTER: { name: 'Sharpshooter', kind: 'spree', glyph: '10' },
  SPLATTER_SPREE: { name: 'Splatter Spree', kind: 'spree', glyph: '5' },
  VEHICULAR_MANSLAUGHTER: { name: 'Vehicular Manslaughter', kind: 'spree', glyph: '10' },
  KILLJOY: { name: 'Killjoy', kind: 'style', glyph: '✕' },
  BEAT_DOWN: { name: 'Beat Down', kind: 'style', glyph: '✊' },
  ASSASSIN: { name: 'Assassin', kind: 'style', glyph: '†' },
  GRENADE_STICK: { name: 'Grenade Stick', kind: 'style', glyph: '✱' },
  GRENADE_KILL: { name: 'Grenade Kill', kind: 'style', glyph: '◉' },   // Halo 4's (Halo 3 has only the Stick)
  SPLATTER: { name: 'Splatter', kind: 'style', glyph: '⇶' },
  SNIPER_KILL: { name: 'Sniper Kill', kind: 'style', glyph: '⌖' },     // Halo 3's wants a headshot; ours, any sniper kill
  LASER_KILL: { name: 'Laser Kill', kind: 'style', glyph: '⟿' },
  INCINERATION: { name: 'Incineration', kind: 'style', glyph: '♨' },
  DEATH_FROM_THE_GRAVE: { name: 'Death from the Grave', kind: 'style', glyph: '✝' },
  FIRST_STRIKE: { name: 'First Strike', kind: 'style', glyph: '1' },  // Reach's: the match's first kill
  EXTERMINATION: { name: 'Extermination', kind: 'style', glyph: '☠' },
  PERFECTION: { name: 'Perfection', kind: 'style', glyph: '★' },
  LAST_MAN_STANDING: { name: 'Last Man Standing', kind: 'objective', glyph: '!' },
  FLAG_SCORE: { name: 'Flag Score', kind: 'objective', glyph: '⚑' },
  KILLED_FLAG_CARRIER: { name: 'Killed Flag Carrier', kind: 'objective', glyph: '⚐' },
  FLAG_KILL: { name: 'Flag Kill', kind: 'objective', glyph: '⚔' },     // Halo 3's: a melee kill with the flag in hand
  FLAG_RETURNED: { name: 'Flag Returned', kind: 'objective', glyph: '↺' },   // Halo 2's (Halo 3 has none)
  HAIL_TO_THE_KING: { name: 'Hail to the King', kind: 'objective', glyph: '♛' },
};
// a kind's rank, for the headline of one kill's medals: the rarest wins (then the higher in its table)
const KIND_RANK = { objective: 1, style: 2, spree: 3, multi: 4 };
const tableRank = Object.fromEntries([MULTI_KILLS, SPREES, INFECTION_SPREES, ZOMBIE_SPREES, ...Object.values(WEAPON_SPREES)].flatMap((t) => t.map((k, i) => [k, i])));
export const rankOf = (key) => (KIND_RANK[MEDALS[key]?.kind] ?? 0) * 100 + (tableRank[key] ?? 0);

// A kill's cause (vitals' cause of death, or the combat module's tag) → its style medal.
// The combat module names melee, assassination, grenade and stick kills; the
// rest are the sandbox's own causes ('Run over by a jeep', 'Burned', a gun's name).
const CAUSE_MEDALS = [
  [/assassinat|backstab/i, 'ASSASSIN'],
  [/^melee$|beat ?down|bludgeon/i, 'BEAT_DOWN'],
  [/stick|stuck/i, 'GRENADE_STICK'],
  [/grenade|\bfrag\b/i, 'GRENADE_KILL'],
  [/run over|splatter/i, 'SPLATTER'],
  [/sniper/i, 'SNIPER_KILL'],
  [/laser/i, 'LASER_KILL'],
  [/burn|flame|incinerat|torch/i, 'INCINERATION'],
];
export const causeMedal = (cause) => CAUSE_MEDALS.find(([re]) => re.test(cause ?? ''))?.[1] ?? null;

const tier = (table, n) => table[Math.min(n, table.length) - 1];   // the n-th medal of a table, the last past its end

// world: what the book can't see from events alone (feel.js supplies it):
//   alive(id) → is the body up; members(team) → the ids on a side;
//   inHill(id) → is the body in King of the Hill's zone now
export function createMedalBook(world = {}) {
  const alive = world.alive ?? (() => true);
  const members = world.members ?? (() => []);
  const inHill = world.inHill ?? (() => false);
  // id → what one body has done: this life's runs (streak, the kill chain, Infection's and the weapons'
  // sprees, kills in the hill) and the match's totals (kills, deaths, medals)
  const bodies = new Map();
  let mode = null, firstStrike = false;
  const carriers = new Map();   // CTF: carrier id → the flag's team

  const life = () => ({ streak: 0, chain: 0, lastKill: -Infinity, infections: 0, zombieKills: 0, hillKills: 0, runs: new Map() });
  const of = (id) => {
    let b = bodies.get(id);
    if (!b) bodies.set(id, (b = { ...life(), kills: 0, deaths: 0, medals: new Map(), total: 0 }));
    return b;
  };
  function give(out, id, key) {
    const b = of(id);
    b.medals.set(key, (b.medals.get(key) ?? 0) + 1);
    b.total++;
    out.push({ id, key, ...MEDALS[key] });
  }
  // a spree table's medal on every SPREE_STEP-th
  const spree = (out, id, n, table) => { if (n > 0 && n % SPREE_STEP === 0) give(out, id, tier(table, n / SPREE_STEP)); };

  return {
    // a new match: everything back to nothing
    start(m) { mode = m; firstStrike = false; bodies.clear(); carriers.clear(); },

    // game:kill { by, id, cause, killerTeam, victimTeam } at game time t (s): the awards, [{ id, key, name, kind, glyph }]
    kill(e, t) {
      const out = [];
      const v = of(e.id);
      const k = e.by != null && e.by !== e.id ? of(e.by) : null;
      v.deaths++;
      const ended = Math.max(v.streak, v.infections, v.zombieKills);
      Object.assign(v, life());   // death ends every run
      if (!k) return out;         // a suicide or a betrayal: nothing for anyone
      k.kills++;
      if (!firstStrike) { firstStrike = true; give(out, e.by, 'FIRST_STRIKE'); }
      if (ended >= SPREE_STEP) give(out, e.by, 'KILLJOY');   // ended someone's spree (Halo 3)
      // the kill chain: a multi-kill from the second kill within MULTI_KILL_S of the one before
      k.chain = t - k.lastKill <= MULTI_KILL_S ? k.chain + 1 : 1;
      k.lastKill = t;
      if (k.chain >= 2) give(out, e.by, tier(MULTI_KILLS, k.chain - 1));
      spree(out, e.by, ++k.streak, SPREES);
      if (mode === 'infection') {
        if (e.killerTeam === 'infected') spree(out, e.by, ++k.infections, INFECTION_SPREES);
        else if (e.victimTeam === 'infected') spree(out, e.by, ++k.zombieKills, ZOMBIE_SPREES);
      }
      const style = causeMedal(e.cause);
      if (style) {
        give(out, e.by, style);
        if (WEAPON_SPREES[style]) { const n = (k.runs.get(style) ?? 0) + 1; k.runs.set(style, n); spree(out, e.by, n, WEAPON_SPREES[style]); }
      }
      if (!alive(e.by)) give(out, e.by, 'DEATH_FROM_THE_GRAVE');   // its grenade or rocket landed after it died
      if (carriers.has(e.id)) give(out, e.by, 'KILLED_FLAG_CARRIER');
      if (carriers.has(e.by) && style === 'BEAT_DOWN') give(out, e.by, 'FLAG_KILL');
      if (mode === 'koth' && inHill(e.by) && ++k.hillKills % HILL_KILLS === 0) give(out, e.by, 'HAIL_TO_THE_KING');
      // the whole other side down at once (each member dead, the victim just now)
      const foes = mode !== 'infection' && e.victimTeam ? members(e.victimTeam) : [];
      if (foes.length >= EXTERMINATION_MIN && foes.every((id) => id === e.id || !alive(id))) give(out, e.by, 'EXTERMINATION');
      return out;
    },

    // game:flag { team, action, by }: who carries what, and the flag medals
    flag(e) {
      const out = [];
      if (e.action === 'taken' && e.by != null) carriers.set(e.by, e.team);
      else for (const [id, team] of carriers) if (team === e.team) carriers.delete(id);   // dropped, returned, captured
      if (e.by == null) return out;
      if (e.action === 'captured') give(out, e.by, 'FLAG_SCORE');
      if (e.action === 'returned') give(out, e.by, 'FLAG_RETURNED');
      return out;
    },

    // game:hill: the hill moved, so the kills in it start over (Hail to the King's "before it moves")
    hillMoved() { for (const b of bodies.values()) b.hillKills = 0; },

    // game:end { mode, winner, roster: [{ id, team }] }: Perfection for a flawless Slayer winner;
    // Infection's Last Man Standing for a lone survivor of the clock (Halo 3: at the round's end)
    end(result) {
      const out = [];
      if (!result?.winner) return out;
      const roster = result.roster ?? [];
      if (result.mode === 'slayer') {
        for (const r of roster) {
          const b = bodies.get(r.id);
          if (b && r.team === result.winner && b.kills >= PERFECTION_KILLS && b.deaths === 0) give(out, r.id, 'PERFECTION');
        }
      }
      if (result.mode === 'infection' && result.winner !== 'infected') {
        const left = roster.filter((r) => r.team === result.winner);
        if (left.length === 1) give(out, left[0].id, 'LAST_MAN_STANDING');
      }
      return out;
    },

    count: (id) => bodies.get(id)?.total ?? 0,
    counts: (id) => Object.fromEntries(bodies.get(id)?.medals ?? []),
    streak: (id) => bodies.get(id)?.streak ?? 0,
  };
}
