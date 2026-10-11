import { MEDALS } from '../game/medals.js';
import { povEvents } from './events.js';
import { PLAYER } from './targets.js';

// The announcer: Halo's voice that names the medals and calls the match
// ("Double Kill!", "Flag taken"). LINES is every line it can say, key → the
// exact words: each medal (src/game/medals.js MEDALS, same keys) and the
// match's lines. The clips are recorded from it (tools/announcer-lines.mjs
// prints it for the voice generator) and live at public/announcer/<KEY>.mp3.
//
//   play(key, fallback?)  queue a line. Lines play one at a time in order, as
//                Halo's announcer queues its medals, and a line still waiting
//                after STALE_S is dropped: news that late is wrong. A clip that
//                isn't there (no file, or the host's page in its place) is asked
//                for once a session; then fallback() runs instead (the medal
//                stack's speechSynthesis, game/medalHud.js), or nothing does.
//   connectAnnouncer(getBus)   where the voice goes: getBus() → { ctx, input } or
//                null (pov/audio.js voiceBus: the first-person chain's input, so
//                the voice rides its master gain, underwater low-pass and limiter).
//                Flat, not positional: the announcer is in your ears.
//   announceMatches()     call the match's moments from its events (game:start,
//                game:flag, game:hill, game:infected, game:overtime, game:end);
//                src/game/index.js plays ONE_MINUTE itself (the clock isn't an event).
//
// Node can import this file (no DOM or audio at import time).

const BASE = '/announcer/';      // public/announcer/<KEY>.mp3
const GAP_S = 0.12;              // s of quiet between two queued lines (Halo runs "Double Kill! Killing Spree!" close together)
const STALE_S = 5;               // s a queued line may wait before it's dropped
const QUEUE_MAX = 8;             // lines waiting at most; the oldest go first
const VOICE_GAIN = 1;            // the clips' gain into the chain (they're normalised when generated)
const ENDED_GRACE_S = 1;         // s past a clip's length to stop waiting for its 'ended' (a suspended context never sends it)

// the match's lines: the mode as a match starts (MODE_ + a rules.js MODES key), the
// objectives, the clock and the result. Flag Returned is the medal's own line.
const MATCH_LINES = {
  MODE_SLAYER: 'Team Slayer',
  MODE_CTF: 'Capture the Flag',
  MODE_KOTH: 'King of the Hill',
  MODE_INFECTION: 'Infection',
  MODE_SIEGE: 'Siege',
  FLAG_TAKEN: 'Flag taken',
  FLAG_DROPPED: 'Flag dropped',
  FLAG_CAPTURED: 'Flag captured',
  HILL_MOVED: 'Hill moved',
  YOU_ARE_INFECTED: 'You are infected',
  OVERTIME: 'Overtime!',
  ONE_MINUTE: 'One minute remaining',
  GAME_OVER: 'Game over',
  RED_WINS: 'Red team wins',
  BLUE_WINS: 'Blue team wins',
  INFECTED_WIN: 'The infected win',
  SURVIVORS_WIN: 'The survivors win',
  DRAW: 'Draw',
};

// key → the exact words: every medal's name, then the match's lines
export const LINES = {
  ...Object.fromEntries(Object.entries(MEDALS).map(([k, m]) => [k, `${m.name}!`])),
  ...MATCH_LINES,
};

let getBus = null;
const clips = new Map();         // key → Promise<AudioBuffer | null>
const queue = [];                // { key, at, fallback }
let busy = false;
const stats = { played: 0, dropped: 0, fellBack: 0, missing: new Set(), last: null };
const clock = () => performance.now() / 1000;

export function connectAnnouncer(fn) { getBus = fn; }

export function play(key, fallback = null) {
  const bus = key in LINES ? getBus?.() : null;
  if (!bus) { back(fallback); return false; }   // an unknown line, or no sound yet (first person not entered, no gesture so far)
  load(key, bus.ctx);
  queue.push({ key, at: clock(), fallback });
  while (queue.length > QUEUE_MAX) { queue.shift(); stats.dropped++; }
  pump();
  return true;
}

function back(fallback) {
  if (!fallback) return;
  stats.fellBack++;
  try { fallback(); } catch { /* silent */ }
}

// the host answers a missing file with its page (an SPA fallback: 200, text/html): that's no clip either
const isClip = (res) => res.ok && !/^text\//.test(res.headers.get('content-type') ?? '');
function load(key, ctx) {
  let p = clips.get(key);
  if (!p) {
    p = fetch(`${BASE}${key}.mp3`)
      .then((res) => (isClip(res) ? res.arrayBuffer() : null))
      .then((data) => (data ? ctx.decodeAudioData(data) : null))
      .catch(() => null)
      .then((buf) => { if (!buf) stats.missing.add(key); return buf; });
    clips.set(key, p);
  }
  return p;
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const { key, at, fallback } = queue.shift();
      const bus = getBus?.();
      if (!bus) { stats.dropped += queue.length + 1; queue.length = 0; break; }
      const buf = await load(key, bus.ctx);
      if (clock() - at > STALE_S) { stats.dropped++; continue; }
      if (!buf) { back(fallback); continue; }
      await say(buf, bus);
      stats.played++;
      stats.last = key;
      await new Promise((r) => setTimeout(r, GAP_S * 1000));
    }
  } finally {
    busy = false;
  }
}

function say(buf, { ctx, input }) {
  return new Promise((resolve) => {
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = buf;
    gain.gain.value = VOICE_GAIN;
    src.connect(gain).connect(input);
    let done = false;
    const end = () => { if (done) return; done = true; src.disconnect(); gain.disconnect(); resolve(); };
    src.onended = end;
    setTimeout(end, (buf.duration + ENDED_GRACE_S) * 1000);
    src.start();
  });
}

// ---- the match's moments, from its events (src/game/index.js, siege.js)
const FLAG_LINES = { taken: 'FLAG_TAKEN', dropped: 'FLAG_DROPPED', captured: 'FLAG_CAPTURED', returned: 'FLAG_RETURNED' };
let listening = false;
export function announceMatches() {
  if (listening) return;
  listening = true;
  let hillSeen = false;   // the first hill of a match is where it starts, not a move
  povEvents.on('game:start', ({ mode, teams }) => {
    play(`MODE_${String(mode).toUpperCase()}`);
    if (teams?.infected?.includes(PLAYER)) play('YOU_ARE_INFECTED');   // an alpha zombie
  });
  povEvents.on('game:stop', () => { hillSeen = false; });
  // your own capture or return is your medal's line (Flag Score, Flag Returned: medalHud.js says it)
  povEvents.on('game:flag', ({ action, by }) => { if (!(by === PLAYER && (action === 'captured' || action === 'returned'))) play(FLAG_LINES[action]); });
  povEvents.on('game:hill', () => { if (hillSeen) play('HILL_MOVED'); hillSeen = true; });
  povEvents.on('game:infected', ({ id }) => { if (id === PLAYER) play('YOU_ARE_INFECTED'); });
  povEvents.on('game:overtime', () => play('OVERTIME'));
  povEvents.on('game:end', ({ mode, winner, why }) => {
    if (!winner && !why) return;   // stopped by hand: no result to call
    play('GAME_OVER');
    play(!winner ? 'DRAW' : winner === 'infected' ? 'INFECTED_WIN' : mode === 'infection' ? 'SURVIVORS_WIN' : `${String(winner).toUpperCase()}_WINS`);
  });
}

// for checks: what it has said and couldn't
export const announcerStats = () => ({ queued: queue.length, played: stats.played, dropped: stats.dropped, fellBack: stats.fellBack, missing: [...stats.missing], last: stats.last });
