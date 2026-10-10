import { CELL_METERS } from '../pov/vitals.js';

// The rules of the team games, each borrowed from the game that made it
// (Halo for Slayer, CTF, King of the Hill and Infection; TF2's attack/defend
// with a halftime swap for Siege). Tuning values live here as constants, not
// settings. Distances are grid cells (CELL_METERS a cell), times seconds.

export const TEAMS = ['red', 'blue'];
export const INFECTED = 'infected';
export const TEAM_NAME = { red: 'Red', blue: 'Blue', infected: 'Infected' };
export const TEAM_CSS = { red: '#e8483d', blue: '#3d8bff', infected: '#86d64a' };
export const HUMANS = 'blue';        // Infection's humans: one side, so they can't hurt each other (Halo's survivors)

// The bots' robes and eyes per team (linear albedo; eyes HDR, unlit), the
// wizard's red (npc.js) recoloured.
export const TEAM_LOOK = {
  red: { colors: { robe: [0.32, 0.02, 0.02], hood: [0.22, 0.015, 0.015] }, eyes: [4, 0.35, 0.15] },
  blue: { colors: { robe: [0.02, 0.07, 0.36], hood: [0.015, 0.045, 0.26] }, eyes: [0.35, 1.4, 4] },
  infected: { colors: { robe: [0.07, 0.3, 0.03], hood: [0.045, 0.2, 0.02] }, eyes: [1.2, 4, 0.3] },
};

// ---- the roster
// Bots per team, the player counted in theirs: 4v4, Halo 3's Team Slayer
// size. Measured on an M-series MacBook (tools/modes-check.mjs, docs/modes.md):
// seven NPC bodies (each with its own GPU probe and brain) keep the lab playable.
export const TEAM_SIZE = 4;
export const BOT_NAMES = ['Ash', 'Birch', 'Cedar', 'Dune', 'Ember', 'Flint', 'Grove', 'Haze', 'Iris', 'Jade', 'Kestrel', 'Lark', 'Moss', 'Nova', 'Onyx', 'Pike'];

// ---- life and death
export const RESPAWN_S = 5;          // s dead before a respawn: Halo's matchmaking default
export const SPAWN_PROTECT_S = 2;    // s a fresh spawn takes no blows (long enough to see where you are, too short to farm)
export const SPAWN_JITTER = 2;       // cells: a spawn lands this far around its point at most, so bodies don't stack
// Who gets the kill: the last enemy who hurt the body within this long (a burn
// or a fall after a blow still counts, as TF2's "finished off"). Our pick.
export const KILL_CREDIT_S = 8;
export const BLAST_CREDIT_R = 10;    // cells: a bomb's blast this near a body marks its thrower as the last to hurt it
export const TORCH_CREDIT_R = 8;     // cells: a lit torch this near a body does too
export const SUICIDE_PENALTY = 1;    // Halo: a death no enemy is credited with takes a point off the team (Slayer)

// ---- what bots sense
// Halo's motion tracker: 25 m (Halo 3, Reach); an enemy moving inside it shows up.
export const RADAR_M = 25;
export const RADAR = RADAR_M / CELL_METERS;

// ---- objectives
export const TOUCH_R = 3;            // cells (horizontal): a body this near a flag touches it
export const TOUCH_UP = 6;           // cells: ...within this height of it
export const FLAG_RESET_S = 30;      // s a dropped flag lies before it goes home on its own (Halo's flag reset)
export const ZONE_UP = 8;            // cells: a body this far above a zone's floor is still in it (a hill, the core)
export const CARRIER_WEAPONS = ['AXE'];      // Halo: the flag carrier can only melee (bots; the player keeps the hotbar)
export const INFECTED_WEAPONS = ['AXE', 'PICKAXE'];   // Infection: the infected melee only
export const INFECTED_SPEED = 1.25;  // × run speed: Halo's zombies outrun the survivors
export const INFECTED_MELEE = 3;     // × a melee blow's damage from an infected: two blows kill (Halo's zombie sword one-hits)
export const LAST_HUMAN_REVEAL = true;  // Halo: the last survivor shows on every zombie's tracker

// ---- the modes (Halo's defaults where Halo has one; the time limits fit a lab-sized map)
export const MODES = {
  slayer: {
    name: 'Team Slayer', short: 'Slayer',
    desc: 'First team to the kill limit, or the most kills when time runs out.',
    scoreToWin: 50, timeLimit: 12 * 60,      // Halo 3 Team Slayer: 50 kills, 12 min
  },
  ctf: {
    name: 'Capture the Flag', short: 'CTF',
    desc: 'Take their flag from its stand and bring it to yours while yours is home.',
    scoreToWin: 3, timeLimit: 15 * 60,       // Halo: 3 captures
  },
  koth: {
    name: 'King of the Hill', short: 'KOTH',
    desc: 'Hold the hill alone to score a point a second. It moves every minute.',
    scoreToWin: 100, timeLimit: 12 * 60,     // Halo 3: 100 points (seconds held)
    hillMoveS: 60,                           // s the hill stays put (Halo's moving hill; Crazy King moves it every 30 s)
  },
  infection: {
    name: 'Infection', short: 'Infection',
    desc: 'One starts infected. Whoever they kill joins them. Survive the clock.',
    timeLimit: 3 * 60,                       // a Halo round's length
    alphas: 1,                               // Halo's alpha zombies at the start
  },
  siege: {
    name: 'Siege', short: 'Siege',
    desc: 'Attackers hold the core; then the teams swap sides. Faster capture wins.',
    holdToWin: 30,                           // s the attackers must hold the core in all (a TF2 point's capture, slowed for one zone)
    timeLimit: 4 * 60,                       // s a half lasts (TF2's attack/defend round timer, shortened)
  },
};
export const MODE_KEYS = Object.keys(MODES);

export const END_SCREEN_S = 10;      // s the result stays up (Halo's post-game carnage report, briefly)
export const KILLFEED_S = 6;         // s a killfeed line stays
export const KILLFEED_MAX = 5;       // lines at most
