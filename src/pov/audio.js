import * as THREE from 'three';
import { ELEMENTS, E, K } from '../elements.js';
import { povEvents } from './events.js';
import { CELL_METERS } from './vitals.js';
import { MELEE_SOURCES } from './constants.js';

// POV sound. Every noise in first person comes from an event (docs/pov.md,
// "Gunplay v2"): the gun, the tools and the shell announce what happened on
// povEvents, the body on player.on(...), and this module turns each into a
// ZzFX sound. Presets are rendered to AudioBuffers once (a few randomised
// variants each, so repeats don't sound identical) and played through pooled
// THREE.PositionalAudio voices at the event's world position, or a plain
// THREE.Audio for sounds that come from you (your shot, your feet, your tools).
//
// The AudioListener rides on the POV camera. It is created on the first user
// gesture in POV (browsers won't start audio before one), and everything is
// silent outside POV and while the tab is hidden.
//
// Chain: voices → listener gain (master) → low-pass (muffled under liquid) →
// limiter → speakers.

// ---- master
const MASTER_VOLUME = 0.8;              // 0..1, overall loudness of POV sound
const MASTER_FADE_S = 0.06;             // s, time constant of mute/unmute fades
const LIMITER = {                       // a gentle brick wall so stacked hits never clip
  threshold: -6,                        // dB where limiting starts
  knee: 4,                              // dB of soft knee
  ratio: 12,                            // :1 above the threshold
  attack: 0.002,                        // s
  release: 0.2,                         // s
};

// ---- underwater: one low-pass on the listener's input
const OPEN_HZ = 20000;                  // Hz: the filter's cutoff in air (wide open)
const UNDERWATER_HZ = 420;              // Hz: cutoff with the head under liquid (thick and muffled)
const FILTER_FADE_S = 0.05;             // s, time constant of the cutoff change

// ---- voices and space
const POSITIONAL_VOICES = 16;           // world sounds playing at once; the oldest is cut for a new one
const FLAT_VOICES = 10;                 // your own sounds playing at once
const REF_CELLS = 6;                    // cells (≈ 1.8 m): full volume this close, then inverse-distance falloff
const ROLLOFF = 0.8;                    // inverse-distance rolloff: −5 dB per doubling (a bit gentler than open air's −6)
const SPEED_OF_SOUND = 343;             // m/s: far sounds arrive late (40 cells ≈ 35 ms)
const SAME_SOUND_GAP_S = 0.025;         // s: the same sound at the same spot within this is one sound
const SAME_SOUND_CELLS = 2;             // cells: "the same spot" for SAME_SOUND_GAP_S

// ---- rendering presets to buffers
const VARIANTS = 4;                     // renders per preset (ZzFX's randomness differs each time)
const RATE_JITTER = 0.04;               // ± playback-rate spread on top of the variants
const PEAK_CEILING = 0.9;               // a rendered buffer louder than this is scaled down to it
const LOOP_XFADE_S = 0.05;              // s, crossfade that makes a loop buffer seamless
const LOOP_FADE_S = 0.05;               // s, time constant of a loop's fade in and out
const LOOP_STOP_AFTER = 5;              // × LOOP_FADE_S: a fading loop stops this long after its fade starts
const IDLE_POLL_MS = 250;               // ms between state checks outside POV (inside, every frame)

// ---- how events shape sounds
const ENERGY_REF = 0.5 * ELEMENTS[E.SCRAP].dens;   // sim KE units: a slug at V_MAX (½·78·1² = 39) plays at gain 1
const IMPACT_GAIN_MIN = 0.12;           // the softest impact still heard
const IMPACT_GAIN_MAX = 1.4;            // the hardest impact's gain
const HARD_PITCH_EXP = 0.25;            // rate = (hard / family reference)^this: stiffer rings higher
const DENS_PITCH_EXP = 0.3;             // rate = (family reference / dens)^this for loose matter: heavier is lower
const RATE_MIN = 0.6, RATE_MAX = 1.6;   // material pitch is kept to this range
const SPLASH_ENERGY = 0.25 * ENERGY_REF;   // a liquid hit above this splashes, below it plops
const CRUNCH_GAIN = 0.8;                // the crunch layer on a hit that broke something
const RICOCHET_GAIN = 0.7;              // the whine of a round glancing off metal
const ECHO_DELAY_S = 0.14;              // s after a shot: its echo off the far walls (~24 m round trip)
const ECHO_GAIN = 0.55;                 // the echo's gain
const TOOL_HIT_GAIN = 0.45;             // a tool's material knock (shovel into wood) next to its own sound
const LOAD_REF_CELLS = 16;              // cells moved in one tool action that play at gain 1
const LOAD_GAIN_MIN = 0.4, LOAD_GAIN_MAX = 1.2;
const POUR_TAIL_S = 0.2;                // s: the pour loop fades once no 'pour' came for this long...
const POUR_TAIL_FRAMES = 3;             // ...or for this many frames, on a slow machine
const POUR_SIZZLE_GAP_S = 0.35;         // s between sizzles while pouring lava
const HUM_GRACE_S = 0.25;               // s after a grab before the hum checks that the physgun really holds
const STEP_LOUD_SPEED = 9;              // cells/s: a footfall at sprinting speed plays at gain 1
const STEP_GAIN_MIN = 0.35;             // a slow step's gain
const LAND_LOUD_SPEED = 25;             // cells/s: a landing this fast plays at gain 1 (≈ a 2 m drop)
const LAND_GAIN_MIN = 0.3;
const LAND_PITCH_DROP = 0.25;           // a full-speed landing plays this much lower (heavier)
const SPLASH_LOUD_SPEED = 20;           // cells/s into liquid for a full splash
const SPLASH_GAIN_MIN = 0.3;
const HURT_GAP_S = 0.3;                 // s between hurt sounds (continuous damage reports often)
const HURT_FULL = 0.15;                 // health lost (0..1) in one report for a full-volume hurt sound
const HURT_GAIN_MIN = 0.35;
const LOG_SIZE = 16;                    // recent plays kept for stats()

// ---- presets
// ZzFX parameter order (paste any of these into https://killedbyapixel.github.io/ZzFX/ to retune):
// [volume, randomness, frequency, attack, sustain, release, shape, shapeCurve, slide, deltaSlide,
//  pitchJump, pitchJumpTime, repeatTime, noise, modulation, bitCrush, delay, sustainVolume, decay,
//  tremolo, filter]
// shape: 0 sine, 1 triangle, 2 saw, 3 tan, 4 noise, 5 square. slide is Hz/s ÷ 500.
// filter: > 0 high-pass, < 0 low-pass (cutoff ≈ 2 × |value| Hz). Empty slots are ZzFX defaults.
const PRESETS = {
  // -- perks
  // a perk taken: a bright sine arpeggio climbing in steps (pitch jumps every 70 ms), Noita's pickup sparkle
  perk: [.7, .05, 520, .01, .16, .4, 0, 1.5, , , 260, .07, .07, , , , , .7, .05],
  // -- the gun
  // a hard crack-boom: a noise burst sliding down with a crushed, 0.3 s tail
  shot: [1.6, .05, 140, .003, .03, .28, 4, 2.4, -0.6, , , , , 1.8, , .25, , .55, .07],
  // the chest-thump under the crack: a 60 Hz sine drop, over in 0.15 s
  shotThump: [1.2, .05, 62, , .02, .14, 0, 1, -0.4, , , , , , , , , .7, .02],
  // the shot coming back off far walls: dull, low-passed, smeared with a slapback delay
  shotEcho: [1.2, .1, 110, .02, .06, .55, 4, 1.6, -0.3, , , , , 2, , .15, .09, .45, .08, , -900],
  // dry fire: a small metallic double click (hammer on nothing)
  dryClick: [.5, .05, 1600, , .003, .025, 5, .4, , , -700, .015, , 2, , , , .4],

  // -- impacts, by material family (pitch follows hardness, gain follows energy)
  // glass: a bright, tinkling burst that keeps scattering for a fifth of a second
  shatter: [.8, .3, 2400, , .02, .25, 4, .6, , , , , .04, 5, , , .04, .45, , .3, 1200],
  // wood and plant: a hollow knock, a short triangle drop with a little grain
  thunk: [1, .1, 190, , .015, .12, 1, 1.5, -2.5, , , , , 1.2, , , , .6, .01],
  // metal: a struck bar, a sine FM'd into an inharmonic ring with a shimmer delay
  ping: [1.2, .03, 1350, , .02, .5, 0, 1, , , , , , , 18, , .08, .55],
  // a round glancing off metal: the classic "pyeeww", a sine whining down from 2.6 kHz
  ricochet: [.45, .08, 2600, .01, .06, .4, 0, 1, -4, , , , , , , , , .7, , .15],
  // rock, stone and ice: a sharp, gritty crack with a short low body
  crack: [1, .1, 320, , .01, .14, 4, 2.2, -1, , , , , 2.5, , .1, , .5, .02],
  // powders: a soft, low-passed puff of grains
  puff: [.55, .2, 120, .01, .03, .18, 4, 1, , , , , , 4, , , , .6, , , -700],
  // liquids, a light hit: a single rising bubble "plop"
  plop: [.6, .1, 260, , .02, .08, 0, 1, 12, , , , , , , , , .7],
  // liquids, a hard hit: a wet burst of low-passed noise with a little spray delay
  splash: [.8, .2, 180, .01, .08, .35, 4, 1, , , , , , 5, , , .05, .6, , , -1800],
  // lava: a high, crackling hiss (tremolo gives the spit)
  sizzle: [.5, .2, 2000, .02, .22, .3, 4, 1, , , , , .03, 8, , , , .6, , .5, 1500],
  // the extra layer when the hit broke the cell: a crushed, gritty crunch
  crunch: [.7, .2, 400, , .03, .12, 4, 2, -1, , , , , 3, , .3, , .5],

  // -- tools
  // shovel into loose matter: a scraping crunch of grains (tremolo makes the grit)
  shovelScrape: [.55, .2, 160, .02, .06, .12, 4, 1, , , , , .015, 4, , , , .6, , .4, -1200],
  // shovel load landing: a soft, low whump (a sine sliding down, low-passed; no tremolo or echo, which
  // made the first version warble)...
  shovelDump: [.9, .1, 75, .005, .03, .2, 0, 1, -4, , , , , 1, , , , .5, , , -400],
  // ...and the grains settling after it: a short, quiet patter of low-passed noise
  shovelPatter: [.35, .2, 300, .01, .1, .2, 4, 1, , , , , .03, 2, , , , .4, , , -900],
  // bucket dipped: a hollow slosh with a rising gloop
  bucketScoop: [.6, .15, 180, .02, .08, .2, 0, 1, 6, , , , , 2, , , .04, .6, , , -1500],
  // bucket pouring (loops while pouring): a steady burbling stream of low-passed noise
  pourLoop: [.45, 0, 300, , 1, 0, 4, 1, , , , , .07, 6, , , , .7, , .25, -1600],
  // axe or pickaxe swing: an airy whoosh that rises through the swing
  swoosh: [.5, .1, 140, .06, .04, .14, 4, 1, 4, , , , , 6, , , , .7, , , -900],
  // flamethrower burning (loops): a steady, deep roar of noise with a slight flutter
  torchLoop: [.5, 0, 120, , 1, 0, 4, 1, , , , , , 16, , , , .9, , .1, 600],
  // the jetpack firing: a low, rumbling roar under the torch's hiss
  jetLoop: [.45, 0, 90, , 1, 0, 4, 1, , , , , , 20, , , , .9, , .15, 500],
  // a bomb going off: a deep noise burst sliding down, a long crushed tail
  boom: [2, .1, 70, .01, .25, 1.3, 4, 1.5, -0.3, , , , , 1.2, , .4, , .4, .15, , -700],
  // a tool that can't (WALL, a full bucket): a dull, dead clunk
  refuse: [.7, .05, 110, , .02, .09, 1, 2, -2, , , , , .5, , , , .5],
  // physgun grab: a rising electric zap
  physGrab: [.35, .05, 180, .01, .06, .12, 2, 1, 12, , , , , , , , , .7, , , -2500],
  // physgun holding (loops): a low saw hum throbbing eight times a second
  physHum: [.3, 0, 72, , 1, 0, 2, 1, , , , , .125, , , , , .8, , .3, -900],
  // physgun fling: a falling zap with a thrown whoosh
  physFling: [.6, .05, 900, , .05, .25, 2, 1, -12, , , , , 1, , , , .6, , , -3000],
  // physgun let go: a small, soft blip down
  physRelease: [.25, .05, 400, , .02, .08, 0, 1, -8],

  // -- the body
  // a footfall on dry ground: a short, low, padded thud
  step: [.55, .25, 80, , .01, .06, 4, 1.5, , , , , , 2.5, , , , .5, , , -500],
  // a footfall in liquid: a splashy slap
  stepWet: [.7, .25, 220, , .02, .1, 4, 1, 4, , , , , 5, , , .03, .5, , , -1600],
  // landing from a jump or fall: a heavy body thud
  land: [.9, .1, 70, , .02, .18, 4, 2, -1, , , , , 1.5, , , , .5, .01, , -400],
  // the body falling into liquid: a big, deep splash
  splashBig: [1, .15, 140, .01, .15, .5, 4, 1, , , , , , 6, , , .06, .6, , , -1500],
  // hurt by a blow or a fall: a dull body hit
  hurtThud: [.8, .1, 90, , .02, .12, 1, 2, -3, , , , , 1, , .1, , .5],
  // hurt by heat: skin sizzle, short and close
  hurtBurn: [.5, .2, 1500, .01, .12, .2, 4, 1, , , , , .02, 8, , , , .6, , .6, 1200],
  // hurt by acid: a fizzing, bubbling hiss
  hurtAcid: [.45, .3, 900, .01, .15, .2, 4, 1, 6, , , , .03, 6, , , , .6, , .5, 800],
  // hurt by cold: a brittle frost crackle
  hurtFrost: [.4, .3, 1800, , .05, .12, 4, .5, , , , , .02, 4, , , , .5, , .6, 1500],
  // drowning: a string of rising bubbles
  hurtDrown: [.45, .3, 260, , .2, .1, 0, 1, 10, , , , .05, , , , , .7],
  // death: a long, falling, crushed tone
  death: [.8, 0, 220, .02, .3, .6, 2, 1, -2, , , , , , , .2, , .6, , , -1200],
  // eating cooked meat (meat.js): two quick, wet, low-passed bites (the repeat makes the second)
  eat: [.6, .2, 260, , .03, .07, 4, 1.5, -1, , , , .09, 3, , , , .55, , , -1100],
  // a body bursting into meat: a heavy, wet splat sliding down
  gib: [1.2, .15, 110, , .05, .35, 4, 1.8, -2, , , , , 4, , .15, .03, .5, .05, , -900],
};
// presets that play as seamless loops (one render each)
const LOOPS = new Set(['pourLoop', 'physHum', 'torchLoop', 'jetLoop']);

// ---- material families: which sound a struck element makes. An element's
// own (elements.js sound: glass shatters, wood thunks, metal pings), else its
// kind's: any rock or other solid cracks.
const FAMILY_BY_KIND = { [K.SOLID]: 'crack', [K.POWDER]: 'puff', [K.LIQUID]: 'splash' };
// Where each family plays at its own pitch: the reference element's hardness
// (for solids) and density (for loose matter). Elements stiffer than the
// reference ring higher, heavier loose matter sounds lower, so a new member
// of a family (sandstone, coal) pitches itself from its own hard or dens.
const FAMILY_REF = {
  shatter: { hard: E.GLASS, dens: E.SHARDS },
  thunk: { hard: E.WOOD, dens: E.SAWDUST },
  ping: { hard: E.METAL, dens: E.SCRAP },
  crack: { hard: E.ROCK, dens: E.STONE },
  puff: { dens: E.SAND },
  splash: { dens: E.WATER },
  sizzle: { dens: E.LAVA },
};
// the shovel's dump of a load adds the pieces' own sound (glass tinkles, scrap clanks)
const DUMP_RINGS = new Set(['shatter', 'ping']);
// hurt sound by cause text (vitals.js causes); anything else is a thud
const HURT_BY_CAUSE = [
  [/lava|burn/i, 'hurtBurn'],
  [/acid/i, 'hurtAcid'],
  [/froze/i, 'hurtFrost'],
  [/drown/i, 'hurtDrown'],
];

const clamp = THREE.MathUtils.clamp;

export function familyOf(id) {
  const el = ELEMENTS[id];
  if (!el) return null;
  return el.sound ?? FAMILY_BY_KIND[el.kind] ?? null;
}

// playback rate for a material within its family
export function materialRate(id, family) {
  const el = ELEMENTS[id], ref = FAMILY_REF[family];
  if (!el || !ref) return 1;
  let r = 1;
  if (el.hard > 0 && ref.hard !== undefined) r = (el.hard / ELEMENTS[ref.hard].hard) ** HARD_PITCH_EXP;
  else if (el.kind !== K.SOLID && ref.dens !== undefined) r = (ELEMENTS[ref.dens].dens / el.dens) ** DENS_PITCH_EXP;
  return clamp(r, RATE_MIN, RATE_MAX);
}

const energyGain = (energy) => (energy == null ? 1 : clamp(Math.sqrt(Math.max(0, energy) / ENERGY_REF), IMPACT_GAIN_MIN, IMPACT_GAIN_MAX));
const loadGain = (amount) => (amount == null ? 1 : clamp(Math.sqrt(Math.max(0, amount) / LOAD_REF_CELLS), LOAD_GAIN_MIN, LOAD_GAIN_MAX));

// Turn samples (longer than the loop by the crossfade) into a seamless loop:
// the tail past the loop length is faded into the head, equal-power.
function makeLoopable(s, sampleRate) {
  const x = Math.min(Math.round(LOOP_XFADE_S * sampleRate), s.length >> 2);
  const n = s.length - x, out = s.slice(0, n);
  for (let i = 0; i < x; i++) {
    const w = i / x;
    out[i] = s[i] * Math.sin(w * Math.PI / 2) + s[n + i] * Math.cos(w * Math.PI / 2);
  }
  return out;
}

// ---- module state (one POV, one sound system), read by stats()
const S = {
  started: false, ctx: null, listener: null, lowpass: null,
  buffers: new Map(),            // preset → AudioBuffer[]
  positional: [], flat: [],      // voice pools: { audio, at: Vector3|null, name, t }
  loops: {},                     // name → { audio, on }
  stolen: 0, played: 0, seq: 0, log: [],   // log: recent plays, each with a running seq
  underwater: false, filterHz: OPEN_HZ, master: 0,
};

// (camera, grid → world) are the app's; state() → { active, player, toolbelt } is the shell's.
export function createPovAudio({ camera, getVolume, getScale, state }) {
  let starting = false, gestured = false;
  let zz = null;
  let boundPlayer = null, unbindPlayer = [];
  let lastPour = -Infinity, frameDt = 0, lastTick = 0, lastSizzle = -Infinity, humSince = 0, lastHurt = -Infinity;
  const lastStart = new Map();   // preset → { t, at }
  const vWorld = new THREE.Vector3(), vEar = new THREE.Vector3();

  const now = () => S.ctx.currentTime;              // the audio clock: for scheduling audio params
  const clock = () => performance.now() / 1000;     // s, wall clock: for this module's own timers (the audio clock can stall or race)
  const toWorld = (g, out) => out.copy(g).multiplyScalar(getScale()).add(getVolume().position);

  // ---- start-up, on a user gesture in POV
  async function start() {
    if (S.started || starting) return;
    starting = true;
    try {
      // zzfx makes its own AudioContext when imported; share it with three
      ({ ZZFX: zz } = await import('zzfx'));
      THREE.AudioContext.setContext(zz.audioContext);
      const listener = new THREE.AudioListener();
      const ctx = listener.context;
      camera.add(listener);
      // master gain → low-pass → limiter → speakers
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = OPEN_HZ;
      const limiter = ctx.createDynamicsCompressor();
      for (const k in LIMITER) limiter[k].value = LIMITER[k];
      listener.gain.disconnect();
      listener.gain.connect(lowpass).connect(limiter).connect(ctx.destination);
      listener.gain.gain.value = 0;
      Object.assign(S, { ctx, listener, lowpass });
      for (let i = 0; i < POSITIONAL_VOICES; i++) {
        const audio = new THREE.PositionalAudio(listener);
        audio.setDistanceModel('inverse');
        audio.setRolloffFactor(ROLLOFF);
        S.positional.push({ audio, at: null, name: '', t: -Infinity });
      }
      for (let i = 0; i < FLAT_VOICES; i++) S.flat.push({ audio: new THREE.Audio(listener), at: null, name: '', t: -Infinity });
      for (const name of LOOPS) {
        const audio = new THREE.Audio(listener);
        audio.setLoop(true);
        audio.gain.gain.value = 0;
        S.loops[name] = { audio, on: false };
      }
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
      S.started = true;
      warmUp();
    } catch (err) {
      console.error('POV audio failed to start', err);
    } finally {
      starting = false;
    }
  }

  // render every preset in the background, one per task, so first plays don't stall
  function warmUp() {
    const names = Object.keys(PRESETS).filter((n) => !S.buffers.has(n));
    const next = () => { const n = names.shift(); if (n === undefined) return; buffersFor(n); setTimeout(next, 0); };
    setTimeout(next, 0);
  }

  function buffersFor(name) {
    let list = S.buffers.get(name);
    if (list) return list;
    const params = PRESETS[name], loop = LOOPS.has(name), sr = zz.sampleRate;
    list = [];
    for (let v = 0; v < (loop ? 1 : VARIANTS); v++) {
      let s = zz.buildSamples(...params);
      if (loop) s = makeLoopable(s, sr);
      let peak = 0;
      for (let i = 0; i < s.length; i++) peak = Math.max(peak, Math.abs(s[i]));
      if (peak > PEAK_CEILING) for (let i = 0; i < s.length; i++) s[i] *= PEAK_CEILING / peak;
      const buf = S.ctx.createBuffer(1, s.length, sr);
      buf.getChannelData(0).set(s);
      list.push(buf);
    }
    S.buffers.set(name, list);
    return list;
  }

  // ---- playing
  function grabVoice(pool) {
    let v = pool.find((x) => !x.audio.isPlaying);
    if (!v) {
      v = pool.reduce((a, b) => (b.t < a.t ? b : a));
      v.audio.stop();
      S.stolen++;
    }
    return v;
  }

  // at: grid position (Vector3) for a sound in the world, or null for one of your own
  function play(name, { at = null, gain = 1, rate = 1, delay = 0 } = {}) {
    if (!S.started || !PRESETS[name]) return null;
    const t = now(), wall = clock();
    const prev = lastStart.get(name);
    if (prev && wall - prev.t < SAME_SOUND_GAP_S
      && (at && prev.at ? at.distanceTo(prev.at) < SAME_SOUND_CELLS : !at && !prev.at)) return null;
    lastStart.set(name, { t: wall, at: at?.clone() ?? null });

    const list = buffersFor(name);
    const v = grabVoice(at ? S.positional : S.flat);
    const audio = v.audio;
    audio.setBuffer(list[Math.floor(Math.random() * list.length)]);
    if (at) {
      const scale = getScale(), p = audio.panner;
      toWorld(at, vWorld);
      p.refDistance = REF_CELLS * scale;
      for (const [param, value] of [[p.positionX, vWorld.x], [p.positionY, vWorld.y], [p.positionZ, vWorld.z]]) {
        param.cancelScheduledValues(t);
        param.setValueAtTime(value, t);
      }
      // sound takes time to get here
      S.listener.getWorldPosition(vEar);
      delay += vWorld.distanceTo(vEar) / scale * CELL_METERS / SPEED_OF_SOUND;
    }
    audio.gain.gain.cancelScheduledValues(t);
    audio.gain.gain.setValueAtTime(gain, t);
    audio.playbackRate = rate * (1 + RATE_JITTER * (2 * Math.random() - 1));
    audio.play(delay);
    audio.source.playbackRate.cancelScheduledValues(0);
    audio.source.playbackRate.value = audio.playbackRate;
    v.name = name; v.at = at?.clone() ?? null; v.t = t;
    S.played++;
    S.log.push({ seq: ++S.seq, name, at: at ? [at.x, at.y, at.z] : null, gain: +gain.toFixed(3), rate: +audio.playbackRate.toFixed(3), delay: +delay.toFixed(4), t: +t.toFixed(3) });
    if (S.log.length > LOG_SIZE) S.log.shift();
    return v;
  }

  function loop(name, on, { gain = 1, rate = 1 } = {}) {
    const l = S.started && S.loops[name];
    if (!l || l.on === on) return;
    const a = l.audio, t = now();
    l.on = on;
    a.gain.gain.cancelScheduledValues(t);
    a.gain.gain.setValueAtTime(a.gain.gain.value, t);
    if (on) {
      if (a.isPlaying) a.stop();
      a.setBuffer(buffersFor(name)[0]);
      a.playbackRate = rate;
      a.play();
      a.gain.gain.setTargetAtTime(gain, t, LOOP_FADE_S);
      S.log.push({ seq: ++S.seq, name, at: null, gain, rate, delay: 0, t: +t.toFixed(3), loop: true });
      if (S.log.length > LOG_SIZE) S.log.shift();
    } else {
      a.gain.gain.setTargetAtTime(0, t, LOOP_FADE_S);
      a.stop(LOOP_FADE_S * LOOP_STOP_AFTER);
    }
  }
  const stopLoops = () => { for (const name of LOOPS) loop(name, false); };

  // ---- events
  const live = () => S.started && state().active;

  // each gun's shot is the pistol's, pitched and scaled by its sound ({ rate, gain, thump, voice }: tools/firearm.js)
  povEvents.on('gun:fire', ({ by, origin, sound }) => {
    if (!live()) return;
    const { rate = 1, gain = 1, thump = 1, voice = 'shot' } = sound ?? {};
    if (by) { play(voice, { at: origin ?? null, rate, gain }); play('shotEcho', { at: origin ?? null, gain: ECHO_GAIN * gain, delay: ECHO_DELAY_S, rate }); return; }   // an NPC's: where it is
    play(voice, { rate, gain });
    play('shotThump', { rate, gain: thump });
    play('shotEcho', { gain: ECHO_GAIN * gain, delay: ECHO_DELAY_S, rate });
  });
  povEvents.on('gun:dry', ({ by }) => { if (live() && !by) play('dryClick'); });
  // a bomb's charge went off: the boom where it is, and its echo off the far walls
  povEvents.on('blast', ({ point }) => {
    if (!live()) return;
    play('boom', { at: point ?? null });
    play('shotEcho', { at: point ?? null, delay: ECHO_DELAY_S });
  });

  // a perk taken (pov/index.js), yours up close, an NPC's where it stands; an Extra Life spent sounds the same
  povEvents.on('perk:take', ({ point, by }) => { if (live()) play('perk', { at: by ? point ?? null : null }); });
  // gibs and eating (meat.js): the player's own bite is close, an NPC's (by) and every burst at the body
  povEvents.on('body:eat', ({ point, by }) => { if (live()) play('eat', { at: by ? point ?? null : null }); });
  povEvents.on('body:gib', ({ point }) => { if (live()) play('gib', { at: point ?? null }); });
  povEvents.on('perk:revive', () => { if (live()) play('perk'); });

  povEvents.on('impact', ({ source, point, id, energy, broke }) => {
    if (!live()) return;
    const family = familyOf(id);
    if (!family) return;
    const gain = energyGain(energy), rate = materialRate(id, family), at = point ?? null;
    let name = family;
    if (family === 'splash' && energy != null && energy < SPLASH_ENERGY) name = 'plop';
    play(name, { at, gain, rate });
    if (broke === true) play('crunch', { at, gain: gain * CRUNCH_GAIN, rate });
    if (broke === false && family === 'ping' && !MELEE_SOURCES.has(source)) play('ricochet', { at, gain: gain * RICOCHET_GAIN });
  });

  // an NPC's tool sounds that are held loops for the player: a one-shot each where it is
  const NPC_ONE_SHOT = { 'bucket:pour': 'shovelPatter', 'blowtorch:on': 'swoosh', 'physgun:grab': 'physGrab', 'physgun:fling': 'physFling', 'physgun:release': 'physRelease', 'physgun:blast': 'physFling' };
  povEvents.on('tool:action', ({ tool, action, id, point, amount, by, from }) => {
    if (!live()) return;
    const at = point ?? (by ? from : null), family = id != null && id >= 0 ? familyOf(id) : null;
    // an NPC's tools: one-shots where it is (the held loops below are the player's own)
    if (by && `${tool}:${action}` in NPC_ONE_SHOT) { play(NPC_ONE_SHOT[`${tool}:${action}`], { at }); return; }
    if (by && action === 'off') return;
    const rate = family ? materialRate(id, family) : 1, gain = loadGain(amount);
    if (action === 'refuse') { play('refuse', { at }); return; }
    switch (`${tool}:${action}`) {
      case 'shovel:dig':
        play('shovelScrape', { at, gain, rate });
        if (family && ELEMENTS[id].kind === K.SOLID) play(family, { at, gain: TOOL_HIT_GAIN, rate });
        break;
      case 'shovel:dump':
        // the load's own pitch stays put: shifting a thump by material made it sound wrong
        play('shovelDump', { at, gain });
        play('shovelPatter', { at, gain });
        if (DUMP_RINGS.has(family)) play(family, { at, gain: TOOL_HIT_GAIN, rate });
        break;
      case 'trowel:place':   // a block set down: the shovel's thud, with a knock if it's a solid
        play('shovelDump', { at, gain });
        if (family && ELEMENTS[id].kind === K.SOLID) play(family, { at, gain: TOOL_HIT_GAIN, rate });
        break;
      case 'bucket:scoop':
        play('bucketScoop', { at, gain, rate });
        if (id === E.LAVA) play('sizzle', { at, gain: TOOL_HIT_GAIN });
        break;
      case 'bucket:pour': {
        lastPour = clock();
        loop('pourLoop', true, { rate });
        if (id === E.LAVA && clock() - lastSizzle > POUR_SIZZLE_GAP_S) { lastSizzle = clock(); play('sizzle', { at, gain: TOOL_HIT_GAIN }); }
        break;
      }
      case 'axe:swing': case 'pickaxe:swing': play('swoosh', { at }); break;
      case 'bomb:throw': case 'torch:throw': case 'lantern:throw': play('swoosh', { at }); break;
      case 'torch:land': case 'lantern:land': play('thunk', { at, gain: TOOL_HIT_GAIN }); break;
      case 'lantern:toggle': play('dryClick', { at }); break;
      case 'blowtorch:on': loop('torchLoop', true); break;
      case 'blowtorch:off': loop('torchLoop', false); break;
      case 'physgun:grab': play('physGrab'); loop('physHum', true); humSince = clock(); break;
      case 'physgun:fling': play('physFling'); loop('physHum', false); break;
      case 'physgun:release': play('physRelease'); loop('physHum', false); break;
      case 'physgun:blast': play('physFling'); break;
      default: break;
    }
  });

  povEvents.on('player:jet', ({ on }) => loop('jetLoop', !!on && live()));

  povEvents.on('player:step', ({ speed = STEP_LOUD_SPEED, inLiquid } = {}) => {
    if (!live()) return;
    play(inLiquid ? 'stepWet' : 'step', { gain: clamp(speed / STEP_LOUD_SPEED, STEP_GAIN_MIN, 1) });
  });

  function bindPlayer(player) {
    if (player === boundPlayer) return;
    unbindPlayer.forEach((off) => off?.());
    unbindPlayer = [];
    boundPlayer = player;
    if (!player?.on) return;
    unbindPlayer.push(
      player.on('land', ({ speed }) => {
        if (!live()) return;
        const k = clamp(speed / LAND_LOUD_SPEED, LAND_GAIN_MIN, 1);
        play('land', { gain: k, rate: 1 - LAND_PITCH_DROP * k });
      }),
      player.on('splash', ({ speed }) => {
        if (live()) play('splashBig', { gain: clamp(speed / SPLASH_LOUD_SPEED, SPLASH_GAIN_MIN, 1) });
      }),
      player.on('hurt', ({ amount, cause }) => {
        if (!live() || clock() - lastHurt < HURT_GAP_S) return;
        lastHurt = clock();
        const name = HURT_BY_CAUSE.find(([re]) => re.test(cause ?? ''))?.[1] ?? 'hurtThud';
        play(name, { gain: clamp(amount / HURT_FULL, HURT_GAIN_MIN, 1) });
      }),
      player.on('death', () => {
        if (!live()) return;
        stopLoops();
        play('death');
      }),
    );
  }

  // ---- state that isn't an event: muting, the underwater filter, loops that outlive their events
  function setMaster(on) {
    const target = on ? MASTER_VOLUME : 0;
    if (S.master === target) return;
    S.master = target;
    const g = S.listener.gain.gain, t = now();
    g.cancelScheduledValues(t);
    g.setTargetAtTime(target, t, MASTER_FADE_S);
  }
  function setUnderwater(on) {
    if (S.underwater === on) return;
    S.underwater = on;
    S.filterHz = on ? UNDERWATER_HZ : OPEN_HZ;
    const f = S.lowpass.frequency, t = now();
    f.cancelScheduledValues(t);
    f.setTargetAtTime(S.filterHz, t, FILTER_FADE_S);
  }
  function physgunHolds(toolbelt) {
    const tool = toolbelt?.tool?.(toolbelt.selected);
    return !!tool && 'hold' in tool && tool.hold !== null;
  }

  function tick() {
    const s = state(), t = clock();
    frameDt = t - lastTick;
    lastTick = t;
    bindPlayer(s.player);
    if (!S.started && s.active && (gestured || navigator.userActivation?.hasBeenActive)) start();
    if (S.started) {
      setMaster(s.active && !document.hidden);
      setUnderwater(!!(s.active && s.player?.headInLiquid));
      if (!s.active || s.player?.dead) stopLoops();
      if (S.loops.pourLoop.on && clock() - lastPour > Math.max(POUR_TAIL_S, POUR_TAIL_FRAMES * frameDt)) loop('pourLoop', false);
      if (S.loops.physHum.on && clock() - humSince > HUM_GRACE_S && !physgunHolds(s.toolbelt)) loop('physHum', false);
    }
    if (s.active && !document.hidden) requestAnimationFrame(tick);
    else setTimeout(tick, IDLE_POLL_MS);
  }

  function onGesture() {
    gestured = true;
    if (!state().active) return;
    if (!S.started) start();
    else if (S.ctx.state !== 'running') S.ctx.resume().catch(() => {});
  }
  addEventListener('pointerdown', onGesture, { capture: true, passive: true });
  addEventListener('keydown', onGesture, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!S.started) return;
    setMaster(state().active && !document.hidden);
    if (document.hidden) stopLoops();
    else tick();
  });
  tick();

  return { play, stats };
}

// Debug state for checks: what's built, what's playing, what played last.
export function stats() {
  const playing = (pool) => pool.filter((v) => v.audio.isPlaying).length;
  let buffers = 0;
  for (const list of S.buffers.values()) buffers += list.length;
  return {
    started: S.started,
    context: S.ctx?.state ?? 'none',
    sampleRate: S.ctx?.sampleRate ?? 0,
    presets: Object.keys(PRESETS).length,
    presetsBuilt: S.buffers.size,
    buffers,
    voices: { positional: playing(S.positional), flat: playing(S.flat), maxPositional: POSITIONAL_VOICES, maxFlat: FLAT_VOICES },
    stolen: S.stolen,
    played: S.played,
    seq: S.seq,
    loops: Object.fromEntries(Object.entries(S.loops).map(([k, l]) => [k, l.on])),
    underwater: S.underwater,
    filterHz: S.filterHz,
    filterNowHz: S.lowpass ? Math.round(S.lowpass.frequency.value) : 0,
    master: S.master,
    last: S.log.slice(),
  };
}

// For checks: the rendered buffers of a preset (null before start-up).
export const debugBuffers = (name) => S.buffers.get(name) ?? null;
export const PRESET_NAMES = Object.keys(PRESETS);
