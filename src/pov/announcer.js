import { MEDALS } from './medaldefs.js';

// The announcer: Halo's voice that names every medal and calls the match
// ("Double Kill!", "Flag taken"). LINES is every line it can say, key → the
// exact words; the clips are recorded from it (tools/announcer-lines.mjs prints
// it for the voice generator) and live at public/announcer/<key>.mp3.
//
//   play(key)    queue a line. Lines play one at a time in order, as Halo's
//                announcer queues its medals, and a line still waiting after
//                STALE_S is dropped: news that late is wrong. A clip that isn't
//                there (no file, or the host's page in its place) stays silent,
//                and is asked for once a session.
//   connectAnnouncer(getBus)   where the voice goes: getBus() → { ctx, input } or
//                null (pov/audio.js voiceBus: the first-person chain's input, so
//                the voice rides its master gain, underwater low-pass and limiter).
//                Flat, not positional: the announcer is in your ears.
//
// Node can import this file (no DOM or audio at import time).

const BASE = '/announcer/';      // public/announcer/<key>.mp3
const GAP_S = 0.12;              // s of quiet between two queued lines (Halo runs "Double Kill! Killing Spree!" close together)
const STALE_S = 5;               // s a queued line may wait before it's dropped
const QUEUE_MAX = 8;             // lines waiting at most; the oldest go first
const VOICE_GAIN = 1;            // the clips' gain into the chain (they're normalised when generated)
const ENDED_GRACE_S = 1;         // s past a clip's length to stop waiting for its 'ended' (a suspended context never sends it)

// the match's lines (src/game/index.js): the mode as a match starts (keys are
// src/game/rules.js MODES keys), the objectives, the clock and the result
const MATCH_LINES = {
  slayer: 'Team Slayer',
  ctf: 'Capture the Flag',
  koth: 'King of the Hill',
  infection: 'Infection',
  siege: 'Siege',
  flagTaken: 'Flag taken',
  flagDropped: 'Flag dropped',
  flagReturned: 'Flag returned',
  flagCaptured: 'Flag captured',
  hillMoved: 'Hill moved',
  youAreInfected: 'You are infected',
  halftime: 'Halftime. Switch sides',
  oneMinute: 'One minute remaining',
  gameOver: 'Game over',
  redWins: 'Red team wins',
  blueWins: 'Blue team wins',
  infectedWin: 'The infected win',
  survivorsWin: 'The survivors win',
  draw: 'Draw',
};

// key → the exact words: every medal's name (but the quiet ones), then the match's
export const LINES = {
  ...Object.fromEntries(Object.entries(MEDALS).filter(([, m]) => !m.quiet).map(([k, m]) => [k, `${m.name}!`])),
  ...MATCH_LINES,
};

let getBus = null;
const clips = new Map();         // key → Promise<AudioBuffer | null>
const queue = [];                // { key, at }
let busy = false;
const stats = { played: 0, dropped: 0, missing: new Set(), last: null };
const clock = () => performance.now() / 1000;

export function connectAnnouncer(fn) { getBus = fn; }

export function play(key) {
  if (!(key in LINES)) return false;
  const bus = getBus?.();
  if (!bus) return false;        // no sound yet (first person not entered, or no gesture so far)
  load(key, bus.ctx);
  queue.push({ key, at: clock() });
  while (queue.length > QUEUE_MAX) { queue.shift(); stats.dropped++; }
  pump();
  return true;
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
      const { key, at } = queue.shift();
      const bus = getBus?.();
      if (!bus) { stats.dropped += queue.length + 1; queue.length = 0; break; }
      const buf = await load(key, bus.ctx);
      if (!buf) continue;
      if (clock() - at > STALE_S) { stats.dropped++; continue; }
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

// for checks: what it has said and couldn't
export const announcerStats = () => ({ queued: queue.length, played: stats.played, dropped: stats.dropped, missing: [...stats.missing], last: stats.last });
