import * as THREE from 'three';
import {
  BatchedRenderer, ParticleSystem, RenderMode, ConstantValue, ConstantColor, Vector4, Vector3 as QVector3,
  PointEmitter, Gradient, ColorOverLife, SizeOverLife, PiecewiseBezier, Bezier,
} from 'three.quarks';
import { ELEMENTS, E, K } from '../elements.js';
import { povEvents } from './events.js';
import { JET_NOZZLES } from './figure.js';
import { MELEE_SOURCES, BODY_WIDTH, BODY_HEIGHT } from './constants.js';
import { lookOf } from './wands/look.js';

// POV effects, with three.quarks: muzzle flash (and a short light), sparks,
// dust and chips, splash mist and tracers. Cosmetic only: the real debris,
// splashes and heat are sim cells the engine makes itself, so everything here
// is small, short and pooled. One BatchedRenderer in the main scene, one
// particle system per effect (one draw call each), all created on the first
// drop-in. Each system never emits on its own; bursts are spawned by hand at
// the event's point through a behaviour (Spawner) that sets each new
// particle's position, velocity, size, colour and life in world space.
//
// Effect constants are in grid cells, seconds and linear HDR radiance (the
// scene renders to an HDR target; above about 1.6 blooms). Positions in
// events are grid cells: world = volume.position + grid × scale.

// ---- pools: the most particles each effect has alive at once
const FLASH_MAX = 12;
const SPARK_MAX = 120;
const DEBRIS_MAX = 64;
const CHIP_MAX = 48;
const MIST_MAX = 96;
const TRACER_MAX = 48;
const JET_MAX = 90;
const JET_SMOKE_MAX = 120;
const FLAME_MAX = 200;            // the jetpack's and the rockets' smoke
const EMBER_MAX = 90;             // a torch's embers (held and lying)
const MOTE_MAX = 220;             // the laser's motes: drawn in while it charges, shed off the beam

// ---- muzzle flash
const FLASH_LIFE = 0.055;               // s
const FLASH_SIZE = 0.55;                // cells across, the main bloom
const FLASH_CORE_SIZE = 0.3;             // cells across, the hot core
const FLASH_FORWARD = 0.2;              // cells ahead of the muzzle the main bloom sits
const FLASH_COLOR = [7, 3.9, 1.5];      // HDR, the main bloom
const FLASH_CORE_COLOR = [12, 9, 6];    // HDR, the core
const FLASH_EMBERS = 5;                 // sparks thrown out of the muzzle
const FLASH_EMBER_SPEED = [18, 34];     // cells/s along the aim
const FLASH_EMBER_SPREAD = 0.35;        // share of the speed thrown sideways at most
const FLASH_SMOKE = 2;                  // puffs of smoke left at the muzzle
const FLASH_SMOKE_COLOR = [0.5, 0.5, 0.52];
const FLASH_LIGHT_COLOR = 0xffb35a;
const FLASH_LIGHT_TIME = 0.06;          // s, fading linearly
const FLASH_LIGHT_GAIN = 6;             // illuminance at one cell from the muzzle (scale-free)
const FLASH_LIGHT_RANGE = 14;           // cells: no light beyond this

// ---- sparks (metal, and strikes that didn't break what they hit)
const SPARKS_GUN = 14;
const SPARKS_AXE = 6;
const SPARK_SPEED = [8, 26];            // cells/s
const SPARK_LIFE = [0.15, 0.35];        // s
const SPARK_WIDTH = 0.09;               // cells
const SPARK_STREAK_S = 0.02;            // s of travel each streak shows (its length = speed × this)
const SPARK_GRAVITY = 40;               // cells/s²
const SPARK_DRAG = 2;                   // 1/s
const SPARK_COLOR = [6, 3.4, 1.1];      // HDR, hot orange-white
const SPARK_SPREAD = 0.8;               // how far from the normal the sparks scatter (0 = along it, 1 = a hemisphere)

// ---- dust and chips (powders, broken solids), tinted by the element hit
const DUST_GUN = 5;
const DUST_AXE = 3;
const DUST_GRAIN = 2;   // dust puffs a kicked clump of sand trails per frame of flight (kick:grain)
const CHIPS_GUN = 6;                    // only when a solid broke
const CHIPS_AXE = 4;
const DUST_SIZE = [0.5, 0.9];           // cells across at birth...
const DUST_GROW = 2.2;                  // ...growing to this many times that
const DUST_LIFE = [0.35, 0.6];          // s
const DUST_SPEED = [2, 6];              // cells/s, mostly along the normal
const DUST_GRAVITY = 6;                 // cells/s²
const DUST_DRAG = 5;                    // 1/s
const DUST_ALPHA = 0.55;
const CHIP_SIZE = [0.12, 0.24];         // cells
const CHIP_LIFE = [0.3, 0.55];          // s
const CHIP_SPEED = [6, 16];             // cells/s
const CHIP_GRAVITY = 45;                // cells/s²
const CHIP_DRAG = 1;                    // 1/s
const DEBRIS_LIGHT = 0.9;               // element colour × this (unlit particles in a lit world)

// ---- splash mist (strikes into liquid, the body falling in)
const MIST_GUN = 8;
const MIST_AXE = 5;
const MIST_SPLASH_PER_SPEED = 0.6;      // puffs per cell/s of the body's speed falling in...
const MIST_SPLASH_MAX = 18;             // ...at most
const MIST_SPLASH_RING = 1;             // cells: the body's splash starts this far out from the feet
const MIST_SIZE = [0.35, 0.7];          // cells across at birth
const MIST_GROW = 2.5;
const MIST_LIFE = [0.35, 0.7];          // s
const MIST_SPEED = [4, 11];             // cells/s, up and out
const MIST_GRAVITY = 25;                // cells/s²
const MIST_DRAG = 3;                    // 1/s
const MIST_WHITE = 0.6;                 // share of white mixed into the liquid's colour
const MIST_LIGHT = 1.1;
const MIST_ALPHA = 0.5;

// ---- tracers: one fading streak per round:move segment
const TRACER_LIFE = 0.07;               // s
const TRACER_WIDTH = 0.12;              // cells
const TRACER_COLOR = [5, 3.2, 1.4];     // HDR
const TRACER_NEAR = 2.5;                // cells: the part of a segment closer than this to the camera isn't drawn

// ---- jetpack exhaust: flame licks and a smoke trail out of each nozzle
const JET_RATE = 70;                    // flame particles/s per nozzle
const JET_SMOKE_RATE = 14;              // smoke puffs/s per nozzle
const JET_SPEED = [10, 18];             // cells/s, down out of the nozzle
const JET_SPREAD = 0.12;                // share of the speed thrown sideways at most
const JET_LIFE = [0.08, 0.16];          // s
const JET_SIZE = [0.35, 0.6];           // cells across
const JET_COLOR = [6, 2.6, 0.7];        // HDR, orange flame
const JET_SMOKE_COLOR = [0.42, 0.4, 0.4];
const JET_SMOKE_SPEED = [4, 8];         // cells/s, down
const JET_SMOKE_GRAVITY = -8;           // cells/s²: hot smoke rises once it slows
const JET_SMOKE_DRAG = 4;               // 1/s
const JET_SMOKE_SIZE = [0.4, 0.7];      // cells across at birth
const JET_SMOKE_GROW = 3;
const JET_SMOKE_LIFE = [0.5, 0.9];      // s
const JET_SMOKE_ALPHA = 0.4;

// ---- a burning body (status.js BURNING): flame licks rising off it, and a little smoke. Its
// fire in the grid is engine FIRE beside it (stains.js); these are the flames on the body itself.
const BURN_RATE = 50;                   // flame licks/s per body
const BURN_SMOKE_RATE = 6;              // smoke puffs/s per body
const BURN_RISE = [3, 7];               // cells/s, up
const BURN_LIFE = [0.2, 0.4];           // s
const BURN_SIZE = [0.5, 0.9];           // cells across
const BURN_REACH = 0.75;                // share of the body's height they start below (they rise past the head)

// ---- rockets (kind 'rocket' round:move): a smoke trail and a flame at the tail
const ROCKET_TRAIL_STEP = 1.5;          // cells of flight between smoke puffs
const ROCKET_TRAIL_SIZE = [0.5, 0.8];   // cells across at birth (the jet smoke's growth)
const ROCKET_TRAIL_LIFE = [0.6, 1.1];   // s
const ROCKET_TRAIL_DRIFT = 1.5;         // cells/s, a puff's random drift
const ROCKET_FLAME_SIZE = [0.5, 0.8];   // cells across

// ---- the flamethrower's stream ('flame' event): a continuous jet of fire
// puffs from the nozzle to what it hits, each living FLAME_LIFE and flying the
// stream's length in that time, swelling as it goes
const FLAME_RATE = 260;                 // puffs/s
const FLAME_LIFE = [0.22, 0.32];        // s
const FLAME_SIZE = [0.35, 0.55];        // cells across at the nozzle...
const FLAME_GROW = 5;                   // ...growing to this many times that
const FLAME_SPREAD = 0.08;              // share of the speed thrown sideways at most
const FLAME_COLOR = [7, 3.2, 0.8];      // HDR, orange-yellow
const FLAME_LIGHT = 2;                  // the nozzle light, times the muzzle flash's (kept lit while it burns)

// ---- a burning torch ('torch:burn' event, every frame per flame): embers that rise off it,
// drift and wink out, left behind as it moves (it gives them only a share of its own speed)
const EMBER_RATE = 7;                   // embers/s per flame
const EMBER_RISE = [2.5, 5];            // cells/s, up
const EMBER_DRIFT = 1.2;                // cells/s sideways at most
const EMBER_CARRY = 0.3;                // share of the torch's velocity an ember leaves with
const EMBER_LIFE = [0.5, 1.3];          // s
const EMBER_SIZE = [0.035, 0.07];       // cells across
const EMBER_SPREAD = 0.12;              // cells: how far round the flame's heart they start
const EMBER_GRAVITY = -1.5;             // cells/s²: hot, they keep rising
const EMBER_DRAG = 1.2;                 // 1/s
const EMBER_COLOR = [7, 2.4, 0.4];      // HDR: orange-hot, they bloom to points of light

// ---- blasts ('blast' event: a rocket's or a bomb's): a fireball, embers and smoke
const BLAST_FLASH_SIZE = 6;             // cells across
const BLAST_FLASH_LIFE = 0.12;          // s
const BLAST_EMBERS = 36;
const BLAST_EMBER_SPEED = [20, 45];     // cells/s, every way
const BLAST_SMOKE = 14;
const BLAST_SMOKE_SPEED = [3, 9];       // cells/s, every way
const BLAST_SMOKE_SIZE = [1.2, 2];      // cells across at birth
const BLAST_LIGHT = 4;                  // times the muzzle light's strength

// ---- the burrower's drill ('drill' event): cuttings sprayed back out of the face, tinted by what it cuts
const DRILL_CHIP_RATE = 60;             // chips/s while it cuts
const DRILL_DUST_RATE = 14;             // dust puffs/s while it cuts

// ---- the laser cannon's beam ('laser' event), after Halo 3's Spartan Laser: a fat
// red beam with a white-hot core that hangs in the air, thins and burns out over
// most of a second, shedding sparks, with a flare where it bites. Three
// cylinders, each a soft-edged glow (brightest face-on, fading to nothing at its
// silhouette) with pulses running down it
const BEAM_LINGER = 0.85;               // s the beam stays
const BEAM_FLASH_S = 0.07;              // s it opens at BEAM_FLASH_WIDTH before settling
const BEAM_FLASH_WIDTH = 1.6;           // times its width while it opens
const BEAM_THIN = 0.7;                  // width falls as (life left)^this
const BEAM_FADE = 1.6;                  // brightness falls as (life left)^this
// layers, inner to outer: radius as a share of the bore, HDR colour, softness (higher = a tighter glow)
const BEAM_LAYERS = [
  { radius: 0.45, color: [16, 12, 10], soft: 1.5 },   // the white-hot core
  { radius: 1.3, color: [10, 0.9, 0.5], soft: 2 },    // the red beam
  { radius: 3.2, color: [2.2, 0.15, 0.08], soft: 3 }, // the haze round it
];
const BEAM_PULSE_SPACING = 6;           // cells between the pulses running down the beam
const BEAM_PULSE_SPEED = 140;           // cells/s they run away from the muzzle
const BEAM_PULSE_DEPTH = 0.35;          // share of brightness they add and take
const BEAM_FLICKER = 0.12;              // share of brightness it flickers by, every frame
const BEAM_NEAR = 8;                    // cells out from the muzzle the beam reaches full width (closer, the eye would sit inside it)...
const BEAM_MUZZLE_SHARE = 0.08;         // ...tapering to this share of it at the muzzle
const BEAM_SIDES = 16;                  // sides on the beam's cylinders
const BEAM_LIGHT = 8;                   // its flash, times the muzzle light's strength
const BEAM_LIGHT_COLOR = 0xff3020;      // laser red
const BEAM_MUZZLE_FLARE = 3;            // cells across, the flare at the muzzle
const BEAM_IMPACT_FLARE = 7;            // cells across, the flare where it bites...
const BEAM_IMPACT_LIFE = 0.25;          // s
const BEAM_FLARE_COLOR = [14, 3, 1.6];  // HDR, red-white
const BEAM_SPARKS = 45;                 // sparks thrown back out of the bite
const BEAM_SPARK_SPEED = [15, 45];      // cells/s
const BEAM_SPARK_LIFE = [0.25, 0.55];   // s: longer than a bullet's sparks
const BEAM_MOTES_PER_CELL = 0.5;        // sparks shed along the beam per cell of it...
const BEAM_MOTES_MAX = 120;             // ...at most
const BEAM_MOTE_SPEED = [0.5, 3];       // cells/s outward
const BEAM_MOTE_LIFE = [0.3, 1.1];      // s
const BEAM_MOTE_SIZE = [0.06, 0.14];    // cells across
const BEAM_MOTE_COLOR = [9, 1.6, 0.6];  // HDR, red-orange
// the sighting beam while it charges ('laser:aim'): a thin red line that thickens and brightens as it fills
const AIM_RADIUS = [0.03, 0.14];        // cells, empty → full
const AIM_COLOR = [5, 0.35, 0.2];       // HDR at full
const AIM_DIM = 0.25;                   // its brightness at empty, a share of full
const AIM_HOLD_S = 0.1;                 // s it stays after the last aim event (then it's gone: cancelled or fired)
// motes drawn into the muzzle while it charges
const CHARGE_MOTE_RATE = 70;            // motes/s at full charge
const CHARGE_MOTE_RING = [0.6, 1.4];    // cells out from the muzzle they start
const CHARGE_MOTE_LIFE = 0.25;          // s they take to arrive
const CHARGE_MOTE_SIZE = [0.04, 0.09];  // cells across

// ---- wands (wands/runtime.js's wand:* events). After Noita, where every spell trails
// particles in its own colour and bursts into more where it lands. Colours are
// wands/look.js's (one table for every drawer) × these HDR gains; the bolts, fields
// and beams themselves are wands/visuals.js's.
const WAND_TRAIL_MAX = 400;             // the wand trail's pool (glowing motes, one draw with the other additive dots)
const WAND_TRAIL_STEP = 0.7;            // cells of flight between trail motes
const WAND_TRAIL_LIFE = [0.2, 0.45];    // s
const WAND_TRAIL_SIZE = [0.1, 0.24];    // cells across
const WAND_TRAIL_DRIFT = 1.2;           // cells/s, a mote's random drift
const WAND_TRAIL_GRAVITY = -1;          // cells/s²: they float up a little
const WAND_TRAIL_DRAG = 2;              // 1/s
const WAND_TRAIL_GAIN = 4;              // HDR, the look's colour × this
const WAND_TRAIL_EXTRA_STEP = 1.6;      // cells of flight between the look's own trail particles (sparks, embers, mist, dust, smoke)
const WAND_FLARE_SIZE = 0.8;            // cells across, the flare at the tip on a cast
const WAND_FLARE_LIFE = 0.09;           // s
const WAND_FLARE_GAIN = 5;              // HDR, the look's colour × this
const WAND_CAST_MOTES = 7;              // motes thrown out of the tip on a cast...
const WAND_CAST_MOTE_SPEED = [4, 12];   // ...cells/s, along the aim
const WAND_CAST_SPREAD = 0.5;           // share of the speed thrown sideways at most
const WAND_FIRE_PUFFS_S = 0.06;         // s of the flamethrower's stream a fire-look cast puffs out of the tip
const WAND_IMPACT_FLASH = [0.8, 4];     // cells across, an impact's flash at least / at most...
const WAND_IMPACT_FLASH_PER_RADIUS = 0.6;   // ...per cell of the spell's radius
const WAND_IMPACT_FLASH_LIFE = 0.12;    // s
const WAND_IMPACT_MOTES = 16;           // motes burst out of an impact
const WAND_IMPACT_MOTE_SPEED = [3, 10]; // cells/s
const WAND_IMPACT_SPARKS = 10;          // sparks off a spark-look or fire-look impact
const WAND_IMPACT_MIST = 10;            // puffs off a liquid-look impact
const WAND_IMPACT_DUST = 5;             // puffs (and chips) off a dust-look impact
const WAND_IMPLODE_LIFE = 0.3;          // s the void look's motes take to fall into its point
const WAND_IMPLODE_RING = [1, 2.5];     // cells out they start
const WAND_BEAM_MOTES_PER_CELL = 0.5;   // motes shed along a beam per cell...
const WAND_BEAM_MOTES_MAX = 48;         // ...at most
const WAND_BEAM_MIST_PER_CELL = 0.6;    // mist puffs along a liquid beam per cell...
const WAND_BEAM_MIST_MAX = 30;          // ...at most
const WAND_FIRE_JET_S = 0.14;           // s of the flamethrower's stream a fire-look beam is worth
const WAND_TELEPORT_STEP = 0.6;         // cells between the motes of a teleport's streak...
const WAND_TELEPORT_MAX = 90;           // ...at most this many
const WAND_TELEPORT_LIFE = [0.25, 0.5]; // s
const WAND_TELEPORT_FLASH = 3;          // cells across, the arrival flash

// ---- textures
const TEX_SIZE = 64;                   // px square
const DOT_FALLOFF = 2;                  // alpha = (1 − r²)^this
const FLASH_SPIKES = 6;                 // rays in the flash texture
const FLASH_SPIKE_SHARP = 6;            // higher = thinner rays
const FLASH_CORE = 0.35;                // radius share of the flash's round core

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const randIn = ([lo, hi]) => rand(lo, hi);
const TAU = 2 * Math.PI;

function makeTexture(alphaAt) {
  const data = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const u = (x + 0.5) / TEX_SIZE * 2 - 1, v = (y + 0.5) / TEX_SIZE * 2 - 1;
      const a = Math.min(1, Math.max(0, alphaAt(Math.hypot(u, v), Math.atan2(v, u))));
      const i = (y * TEX_SIZE + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const t = new THREE.DataTexture(data, TEX_SIZE, TEX_SIZE);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
const dotAlpha = (r) => (r >= 1 ? 0 : (1 - r * r) ** DOT_FALLOFF);
const flashAlpha = (r, th) => {
  if (r >= 1) return 0;
  const core = dotAlpha(r / FLASH_CORE);
  const ray = Math.abs(Math.cos(th * FLASH_SPIKES / 2)) ** FLASH_SPIKE_SHARP * (1 - r) ** 2;
  return core + ray + dotAlpha(r) * 0.25;
};

// A behaviour that hands each new particle to `init` (set per burst), then
// moves it with its own gravity and drag (p.gravity cells/s², scaled to world
// units; p.drag 1/s), which init sets.
class Spawner {
  constructor(getScale) {
    this.type = 'PovSpawner';
    this.init = null;
    this.getScale = getScale;
  }
  initialize(p) { this.init?.(p); }
  update(p, dt) {
    if (p.gravity) p.velocity.y -= p.gravity * this.getScale() * dt;
    if (p.drag) p.velocity.multiplyScalar(Math.exp(-p.drag * dt));
  }
  frameUpdate() {}
  reset() {}
  toJSON() { return { type: this.type }; }
  clone() { return new Spawner(this.getScale); }
}

const FADE_OUT = () => new ColorOverLife(new Gradient([[new QVector3(1, 1, 1), 0], [new QVector3(1, 1, 1), 1]], [[1, 0], [0, 1]]));
// fast in, eased out: for the flash and tracers, which should vanish, not dim
const FADE_SHARP = () => new ColorOverLife(new Gradient([[new QVector3(1, 1, 1), 0], [new QVector3(1, 1, 1), 1]], [[1, 0], [0.6, 0.4], [0, 1]]));
const GROW = (k) => new SizeOverLife(new PiecewiseBezier([[new Bezier(1, 1 + (k - 1) * 0.6, 1 + (k - 1) * 0.9, k), 0]]));

// env = { scene, camera, getVolume, getScale, isActive: () => bool }
export function createVfx(env) {
  const { scene, camera } = env;
  const batch = new BatchedRenderer();
  batch.name = 'pov-vfx';
  scene.add(batch);
  const emitters = new THREE.Group();   // emitters stay at the origin; bursts are placed by Spawner
  emitters.name = 'pov-vfx-emitters';
  scene.add(emitters);

  const dot = makeTexture(dotAlpha);
  const star = makeTexture(flashAlpha);
  const additive = (map) => new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const normal = (map) => new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, blending: THREE.NormalBlending });
  const materials = [additive(star), additive(dot), normal(dot)];
  const [starAdd, dotAdd, dotNormal] = materials;

  const scaleNow = () => env.getScale();
  const fx = {};
  function system(name, { max, material, renderMode = RenderMode.BillBoard, behaviors = [] }) {
    const spawner = new Spawner(scaleNow);
    const sys = new ParticleSystem({
      looping: true, duration: 1, worldSpace: true,
      emissionOverTime: new ConstantValue(0),
      startLife: new ConstantValue(1), startSpeed: new ConstantValue(0), startSize: new ConstantValue(1),
      startColor: new ConstantColor(new Vector4(1, 1, 1, 1)),
      shape: new PointEmitter(),
      material, renderMode,
      rendererEmitterSettings: renderMode === RenderMode.StretchedBillBoard ? { speedFactor: 1, lengthFactor: 0 } : undefined,
      behaviors: [spawner, ...behaviors],
    });
    batch.addSystem(sys);
    emitters.add(sys.emitter);
    fx[name] = { sys, spawner, max };
    return fx[name];
  }
  system('flash', { max: FLASH_MAX, material: starAdd, behaviors: [FADE_SHARP()] });
  system('spark', { max: SPARK_MAX, material: dotAdd, renderMode: RenderMode.StretchedBillBoard, behaviors: [FADE_OUT()] });
  system('debris', { max: DEBRIS_MAX, material: dotNormal, behaviors: [FADE_OUT()] });
  system('chip', { max: CHIP_MAX, material: dotNormal, behaviors: [FADE_OUT()] });
  system('mist', { max: MIST_MAX, material: dotNormal, behaviors: [FADE_OUT()] });
  system('tracer', { max: TRACER_MAX, material: dotAdd, renderMode: RenderMode.StretchedBillBoard, behaviors: [FADE_SHARP()] });
  system('jet', { max: JET_MAX, material: dotAdd, behaviors: [FADE_SHARP()] });
  system('jetSmoke', { max: JET_SMOKE_MAX, material: dotNormal, behaviors: [FADE_OUT()] });
  system('flame', { max: FLAME_MAX, material: dotAdd, behaviors: [FADE_OUT()] });
  system('ember', { max: EMBER_MAX, material: dotAdd, behaviors: [FADE_OUT()] });
  system('mote', { max: MOTE_MAX, material: dotAdd, behaviors: [FADE_OUT()] });
  system('wandTrail', { max: WAND_TRAIL_MAX, material: dotAdd, behaviors: [FADE_OUT()] });
  // dust and mist puffs grow (from each particle's own start size); chips don't.
  // Systems with the same material and mode share one batch (one draw call).
  fx.debris.sys.addBehavior(GROW(DUST_GROW));
  fx.mist.sys.addBehavior(GROW(MIST_GROW));
  fx.jetSmoke.sys.addBehavior(GROW(JET_SMOKE_GROW));
  fx.flame.sys.addBehavior(GROW(FLAME_GROW));

  const light = new THREE.PointLight(FLASH_LIGHT_COLOR, 0, 0, 2);
  light.name = 'pov-muzzle-light';
  scene.add(light);   // always in the scene (at 0 when off): adding and removing lights recompiles lit materials
  let lightT = 0;
  // New particles are born between renders but aged by the next frame's dt
  // before they are first drawn; they start that much younger than zero, so
  // even a flash shorter than a slow frame is seen once at full strength.
  let lastDt = 0;

  // ---- spawning
  const burstState = {
    isBursting: false, burstParticleIndex: 0, burstParticleCount: 0, burstIndex: 0,
    burstWaveIndex: 0, time: 0, waitEmiting: 0, travelDistance: 0,
  };
  const IDENTITY = new THREE.Matrix4();
  function burst(f, n, init) {
    n = Math.min(Math.round(n), f.max - f.sys.particleNum);
    if (n <= 0) return 0;
    f.spawner.init = init;
    burstState.waitEmiting = n;
    burstState.time = 0;
    burstState.burstIndex = 0;
    f.sys.emit(0, burstState, IDENTITY);
    f.spawner.init = null;
    return n;
  }
  // set a new particle: world position, velocity (world units/s), size (world), colour, life (s)
  function setP(p, pos, vel, size, rgb, alpha, life, gravity = 0, drag = 0) {
    p.position.set(pos.x, pos.y, pos.z);
    p.velocity.set(vel.x, vel.y, vel.z);
    p.startSize.set(size, size, size);
    p.size.copy(p.startSize);
    p.startColor.set(rgb[0], rgb[1], rgb[2], alpha);
    p.color.copy(p.startColor);
    p.life = life;
    p.age = -lastDt;
    p.rotation = Math.random() * TAU;
    p.gravity = gravity;
    p.drag = drag;
  }

  const toWorld = (g, out) => out.copy(g).multiplyScalar(env.getScale()).add(env.getVolume().position);
  const vP = new THREE.Vector3(), vD = new THREE.Vector3(), vV = new THREE.Vector3(), vT = new THREE.Vector3();
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const tmpColor = new THREE.Color();
  const rgbOf = (id, gain, out = [0, 0, 0]) => {
    tmpColor.set(ELEMENTS[id]?.color ?? '#808080');
    out[0] = tmpColor.r * gain; out[1] = tmpColor.g * gain; out[2] = tmpColor.b * gain;
    return out;
  };
  // a random unit vector around n: spread 0 = n, 1 = anywhere in its hemisphere
  function around(n, spread, out) {
    out.randomDirection();
    if (out.dot(n) < 0) out.negate();
    return out.lerp(n, 1 - spread).normalize();
  }

  // ---- effects (points in world units, directions unit)
  function muzzleFlash(at, dir) {
    const s = env.getScale();
    burst(fx.flash, 1, (p) => setP(p, vV.copy(at).addScaledVector(dir, FLASH_FORWARD * s), vT.set(0, 0, 0),
      FLASH_SIZE * s, FLASH_COLOR, 1, FLASH_LIFE));
    burst(fx.flash, 1, (p) => setP(p, at, vT.set(0, 0, 0), FLASH_CORE_SIZE * s, FLASH_CORE_COLOR, 1, FLASH_LIFE));
    fx.spark.sys.rendererEmitterSettings.speedFactor = SPARK_STREAK_S / (SPARK_WIDTH * s);
    burst(fx.spark, FLASH_EMBERS, (p) => {
      vV.randomDirection().multiplyScalar(FLASH_EMBER_SPREAD).add(dir).multiplyScalar(randIn(FLASH_EMBER_SPEED) * s);
      setP(p, at, vV, SPARK_WIDTH * s, SPARK_COLOR, 1, randIn(SPARK_LIFE) * 0.5, SPARK_GRAVITY, SPARK_DRAG);
    });
    burst(fx.debris, FLASH_SMOKE, (p) => {
      vV.randomDirection().add(dir).multiplyScalar(randIn(DUST_SPEED) * s);
      setP(p, at, vV, randIn(DUST_SIZE) * s, FLASH_SMOKE_COLOR, DUST_ALPHA, randIn(DUST_LIFE), -DUST_GRAVITY, DUST_DRAG);
    });
    light.color.setHex(FLASH_LIGHT_COLOR);
    light.position.copy(at);
    light.distance = FLASH_LIGHT_RANGE * s;
    lightT = FLASH_LIGHT_TIME;
  }

  function sparks(at, n, normalDir, rgb = SPARK_COLOR) {
    const s = env.getScale();
    fx.spark.sys.rendererEmitterSettings.speedFactor = SPARK_STREAK_S / (SPARK_WIDTH * s);
    burst(fx.spark, n, (p) => {
      around(normalDir, SPARK_SPREAD, vV).multiplyScalar(randIn(SPARK_SPEED) * s);
      setP(p, at, vV, SPARK_WIDTH * s, rgb, 1, randIn(SPARK_LIFE), SPARK_GRAVITY, SPARK_DRAG);
    });
  }

  const debrisRgb = [0, 0, 0];
  function dust(at, n, normalDir, id) {
    const s = env.getScale();
    rgbOf(id, DEBRIS_LIGHT, debrisRgb);
    burst(fx.debris, n, (p) => {
      around(normalDir, SPARK_SPREAD, vV).multiplyScalar(randIn(DUST_SPEED) * s);
      setP(p, at, vV, randIn(DUST_SIZE) * s, debrisRgb, DUST_ALPHA, randIn(DUST_LIFE), DUST_GRAVITY, DUST_DRAG);
    });
  }
  function chips(at, n, normalDir, id) {
    const s = env.getScale();
    rgbOf(id, DEBRIS_LIGHT, debrisRgb);
    burst(fx.chip, n, (p) => {
      around(normalDir, SPARK_SPREAD, vV).multiplyScalar(randIn(CHIP_SPEED) * s);
      setP(p, at, vV, randIn(CHIP_SIZE) * s, debrisRgb, 1, randIn(CHIP_LIFE), CHIP_GRAVITY, CHIP_DRAG);
    });
  }

  const mistRgb = [0, 0, 0];
  function mist(at, n, upDir, id, ring = 0, rgb = null) {   // rgb (0..1): a tint in place of the liquid's colour
    const s = env.getScale();
    if (rgb) for (let k = 0; k < 3; k++) mistRgb[k] = rgb[k] * MIST_LIGHT;
    else rgbOf(id, MIST_LIGHT, mistRgb);
    for (let k = 0; k < 3; k++) mistRgb[k] += (MIST_LIGHT - mistRgb[k]) * MIST_WHITE;
    burst(fx.mist, n, (p) => {
      around(upDir, SPARK_SPREAD, vV);
      vP.copy(at);
      if (ring) vP.add(vT.set(vV.x, 0, vV.z).normalize().multiplyScalar(ring * s));
      vV.multiplyScalar(randIn(MIST_SPEED) * s);
      setP(p, vP, vV, randIn(MIST_SIZE) * s, mistRgb, MIST_ALPHA, randIn(MIST_LIFE), MIST_GRAVITY, MIST_DRAG);
    });
  }

  // a streak over the world segment a → b, minus what lies within TRACER_NEAR of the camera
  function tracer(a, b) {
    const s = env.getScale();
    const cam = camera.getWorldPosition(vC);
    const len = vD.subVectors(b, a).length();
    if (len <= 0) return;
    vD.divideScalar(len);
    // start of the visible part: solve |a + t·d − cam| = near for the far root, if a is inside
    const near = TRACER_NEAR * s;
    let t0 = 0;
    const m = vT.subVectors(a, cam), bq = m.dot(vD), cq = m.lengthSq() - near * near;
    if (cq < 0) t0 = -bq + Math.sqrt(bq * bq - cq);
    if (t0 >= len) return;
    const visible = len - t0;
    fx.tracer.sys.rendererEmitterSettings.speedFactor = 1 / (TRACER_WIDTH * s);
    burst(fx.tracer, 1, (p) => {
      setP(p, b, vV.copy(vD).multiplyScalar(visible), TRACER_WIDTH * s, TRACER_COLOR, 1, TRACER_LIFE);
      p.speedModifier = 0;   // the velocity only orients and sizes the streak; it stays where it was drawn
    });
  }

  // a rocket flew from a to b (world): smoke puffs along the way, a flame at b
  let trailAcc = 0;
  function rocketTrail(a, b) {
    const s = env.getScale();
    const len = vD.subVectors(b, a).length();
    if (len <= 0) return;
    trailAcc += len / (ROCKET_TRAIL_STEP * s);
    const n = Math.floor(trailAcc);
    trailAcc -= n;
    let i = 0;
    burst(fx.jetSmoke, n, (p) => {
      vP.copy(a).addScaledVector(vD, (++i / n));
      vV.randomDirection().multiplyScalar(ROCKET_TRAIL_DRIFT * s);
      setP(p, vP, vV, randIn(ROCKET_TRAIL_SIZE) * s, JET_SMOKE_COLOR, JET_SMOKE_ALPHA, randIn(ROCKET_TRAIL_LIFE), JET_SMOKE_GRAVITY, JET_SMOKE_DRAG);
    });
    burst(fx.jet, 1, (p) => setP(p, b, vV.set(0, 0, 0), randIn(ROCKET_FLAME_SIZE) * s, JET_COLOR, 1, JET_LIFE[1]));
  }

  // the flamethrower's stream for dt seconds: from `at` (world) along unit dir, `length` cells
  let flameAcc = 0;
  function flameStream(at, dir, length, dt) {
    const s = env.getScale();
    flameAcc += FLAME_RATE * dt;
    const n = Math.floor(flameAcc);
    flameAcc -= n;
    burst(fx.flame, n, (p) => {
      const life = randIn(FLAME_LIFE);
      vV.randomDirection().multiplyScalar(FLAME_SPREAD).add(dir).multiplyScalar(Math.max(length, 1) * s / life);
      // spread along the first frame's stretch, so the jet has no gaps at low frame rates
      vP.copy(at).addScaledVector(vV, Math.random() * dt);
      setP(p, vP, vV, randIn(FLAME_SIZE) * s, FLAME_COLOR, 1, life);
    });
    light.color.setHex(FLASH_LIGHT_COLOR);
    light.position.copy(at);
    light.distance = FLASH_LIGHT_RANGE * FLAME_LIGHT * s;
    lightT = Math.max(lightT, FLASH_LIGHT_TIME);
  }

  // a torch's flame burning for dt seconds at `at` (world), moving at vel (world units/s)
  let emberOwed = 0;   // embers due, over every flame (each adds its own dt)
  function torchEmbers(at, vel, dt) {
    const s = env.getScale();
    emberOwed += EMBER_RATE * dt;
    const n = Math.floor(emberOwed);
    emberOwed -= n;
    burst(fx.ember, n, (p) => {
      vP.randomDirection().multiplyScalar(EMBER_SPREAD * s * Math.random()).add(at);
      vV.set(rand(-1, 1) * EMBER_DRIFT, randIn(EMBER_RISE), rand(-1, 1) * EMBER_DRIFT).multiplyScalar(s).addScaledVector(vel, EMBER_CARRY);
      setP(p, vP, vV, randIn(EMBER_SIZE) * s, EMBER_COLOR, 1, randIn(EMBER_LIFE), EMBER_GRAVITY, EMBER_DRAG);
    });
  }

  // a blast at `at` (world): a fireball, embers every way and a smoke cloud
  function blast(at) {
    const s = env.getScale();
    burst(fx.flash, 1, (p) => setP(p, at, vT.set(0, 0, 0), BLAST_FLASH_SIZE * s, FLASH_COLOR, 1, BLAST_FLASH_LIFE));
    fx.spark.sys.rendererEmitterSettings.speedFactor = SPARK_STREAK_S / (SPARK_WIDTH * s);
    burst(fx.spark, BLAST_EMBERS, (p) => {
      vV.randomDirection().multiplyScalar(randIn(BLAST_EMBER_SPEED) * s);
      setP(p, at, vV, SPARK_WIDTH * s, SPARK_COLOR, 1, randIn(SPARK_LIFE), SPARK_GRAVITY, SPARK_DRAG);
    });
    burst(fx.jetSmoke, BLAST_SMOKE, (p) => {
      vV.randomDirection().multiplyScalar(randIn(BLAST_SMOKE_SPEED) * s);
      setP(p, at, vV, randIn(BLAST_SMOKE_SIZE) * s, JET_SMOKE_COLOR, JET_SMOKE_ALPHA, randIn(ROCKET_TRAIL_LIFE) * 2, JET_SMOKE_GRAVITY, JET_SMOKE_DRAG);
    });
    light.color.setHex(FLASH_LIGHT_COLOR);
    light.position.copy(at);
    light.distance = FLASH_LIGHT_RANGE * BLAST_LIGHT * s;
    lightT = FLASH_LIGHT_TIME * BLAST_LIGHT;
  }

  // the burrower cutting for dt seconds at `at` (world), heading dir: chips and dust thrown back out of the face
  let drillChipAcc = 0, drillDustAcc = 0;
  function drillSpray(at, dir, id, dt) {
    drillChipAcc += DRILL_CHIP_RATE * dt;
    drillDustAcc += DRILL_DUST_RATE * dt;
    const nc = Math.floor(drillChipAcc), nd = Math.floor(drillDustAcc);
    drillChipAcc -= nc; drillDustAcc -= nd;
    const back = vD.copy(dir).negate();
    if (nc) chips(at, nc, back, id);
    if (nd) dust(at, nd, back, id);
  }

  // the laser's beam from `from` to `to` (world), the bore `radius` (world units) across
  const beamGeo = new THREE.CylinderGeometry(1, 1, 1, BEAM_SIDES, 1, true).translate(0, 0.5, 0);
  const taperGeo = new THREE.CylinderGeometry(1, BEAM_MUZZLE_SHARE, 1, BEAM_SIDES, 1, true).translate(0, 0.5, 0);   // narrow end at the muzzle
  const beamMat = (rgb, soft) => new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Vector3(...rgb) }, uBright: { value: 1 }, uSoft: { value: soft },
      uFrom: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3(0, 1, 0) }, uScale: { value: 1 },
      uTime: { value: 0 }, uPulse: { value: BEAM_PULSE_DEPTH },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN, vV, vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vec4 v = viewMatrix * w;
        vV = -v.xyz;
        vN = normalize(mat3(viewMatrix) * mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * v;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor, uFrom, uDir;
      uniform float uBright, uSoft, uScale, uTime, uPulse;
      varying vec3 vN, vV, vW;
      void main() {
        float face = abs(dot(normalize(vN), normalize(vV)));   // 1 face-on, 0 at the silhouette
        float glow = pow(face, uSoft);
        float along = dot(vW - uFrom, uDir) / uScale;           // cells from the muzzle
        float pulse = 1.0 + uPulse * sin(6.2831853 * (along - uTime * ${BEAM_PULSE_SPEED.toFixed(1)}) / ${BEAM_PULSE_SPACING.toFixed(1)});
        gl_FragColor = vec4(uColor * glow * pulse * uBright, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  // a beam: one group of tapered-then-full cylinders per layer, every layer's mesh scaled by
  // radius × its share; returned with its materials so the caller can drive them
  const UP = new THREE.Vector3(0, 1, 0);
  function beamMesh(name, layers) {
    const group = new THREE.Group();
    group.name = name;
    const mats = [], meshes = [];
    for (const L of layers) {
      const m = beamMat(L.color, L.soft);
      mats.push(m);
      const taper = new THREE.Mesh(taperGeo, m), full = new THREE.Mesh(beamGeo, m);
      for (const mesh of [taper, full]) { mesh.frustumCulled = false; mesh.userData.share = L.radius; group.add(mesh); meshes.push(mesh); }
    }
    // lay it from `from` to `to` (world), `radius` (world units) per share
    const lay = (from, to, radius) => {
      const len = vD.subVectors(to, from).length();
      if (len <= 0) return false;
      const near = Math.min(BEAM_NEAR * env.getScale(), len);
      for (let i = 0; i < meshes.length; i += 2) {
        const r = radius * meshes[i].userData.share;
        meshes[i].scale.set(r, near, r);
        meshes[i + 1].scale.set(r, Math.max(len - near, 1e-6), r);
        meshes[i + 1].position.y = near;
      }
      group.position.copy(from);
      group.quaternion.setFromUnitVectors(UP, vD.divideScalar(len));
      for (const m of mats) { m.uniforms.uFrom.value.copy(from); m.uniforms.uDir.value.copy(vD); m.uniforms.uScale.value = env.getScale(); }
      return true;
    };
    const width = (k) => { for (const mesh of meshes) { mesh.scale.x = mesh.scale.z = mesh.userData.r0 * k; } };
    const keepWidth = () => { for (const mesh of meshes) mesh.userData.r0 = mesh.scale.x; };
    return { group, mats, lay, width, keepWidth };
  }
  const beams = [];   // { beam, t, age }
  const vBeamDir = new THREE.Vector3(), vBack = new THREE.Vector3();
  let beamClock = 0;
  function laserBeam(from, to, radius, hit) {
    const s = env.getScale();
    const beam = beamMesh('pov-laser-beam', BEAM_LAYERS);
    if (!beam.lay(from, to, radius)) { beam.mats.forEach((m) => m.dispose()); return; }
    beam.keepWidth();
    beam.width(BEAM_FLASH_WIDTH);
    scene.add(beam.group);
    beams.push({ beam, t: BEAM_LINGER, age: 0 });
    const len = vD.subVectors(to, from).length(), dir = vBeamDir.copy(vD).divideScalar(len);
    // flares at both ends
    burst(fx.flash, 1, (p) => setP(p, from, vT.set(0, 0, 0), BEAM_MUZZLE_FLARE * s, BEAM_FLARE_COLOR, 1, BEAM_IMPACT_LIFE));
    if (hit) {
      burst(fx.flash, 1, (p) => setP(p, to, vT.set(0, 0, 0), BEAM_IMPACT_FLARE * s, BEAM_FLARE_COLOR, 1, BEAM_IMPACT_LIFE));
      fx.spark.sys.rendererEmitterSettings.speedFactor = SPARK_STREAK_S / (SPARK_WIDTH * s);
      const back = vBack.copy(dir).negate();
      burst(fx.spark, BEAM_SPARKS, (p) => {
        around(back, SPARK_SPREAD, vV).multiplyScalar(randIn(BEAM_SPARK_SPEED) * s);
        setP(p, to, vV, SPARK_WIDTH * s, SPARK_COLOR, 1, randIn(BEAM_SPARK_LIFE), SPARK_GRAVITY, SPARK_DRAG);
      });
    }
    // sparks shed all along it, drifting out from the axis
    const n = Math.min(BEAM_MOTES_MAX, Math.ceil(len / s * BEAM_MOTES_PER_CELL));
    burst(fx.mote, n, (p) => {
      vP.copy(from).addScaledVector(dir, Math.random() * len);
      vV.randomDirection(); vV.addScaledVector(dir, -vV.dot(dir)).normalize();
      vP.addScaledVector(vV, radius * Math.random());
      vV.multiplyScalar(randIn(BEAM_MOTE_SPEED) * s);
      setP(p, vP, vV, randIn(BEAM_MOTE_SIZE) * s, BEAM_MOTE_COLOR, 1, randIn(BEAM_MOTE_LIFE));
    });
    light.color.setHex(BEAM_LIGHT_COLOR);
    light.position.copy(from);
    light.distance = FLASH_LIGHT_RANGE * BEAM_LIGHT * s;
    lightT = FLASH_LIGHT_TIME * BEAM_LIGHT;
  }
  function fadeBeams(dt) {
    beamClock += dt;
    for (let i = beams.length - 1; i >= 0; i--) {
      const b = beams[i];
      b.t -= dt; b.age += dt;
      if (b.t <= 0) { scene.remove(b.beam.group); b.beam.mats.forEach((m) => m.dispose()); beams.splice(i, 1); continue; }
      const k = b.t / BEAM_LINGER;
      const open = Math.min(1, b.age / BEAM_FLASH_S);
      b.beam.width((BEAM_FLASH_WIDTH + (1 - BEAM_FLASH_WIDTH) * open) * Math.pow(k, BEAM_THIN));
      const bright = Math.pow(k, BEAM_FADE) * (1 + (Math.random() - 0.5) * 2 * BEAM_FLICKER);
      for (const m of b.beam.mats) { m.uniforms.uBright.value = bright; m.uniforms.uTime.value = beamClock; }
    }
  }

  // the sighting beam while the laser charges: one beam kept in the scene, shown while aim events come
  const aimBeam = beamMesh('pov-laser-aim', [{ radius: 1, color: AIM_COLOR, soft: 1 }]);
  aimBeam.group.visible = false;
  aimBeam.mats[0].uniforms.uPulse.value = 0;
  scene.add(aimBeam.group);
  let aimT = 0, moteOwed = 0;
  function laserAim(from, to, amount, dt) {
    const s = env.getScale();
    if (!aimBeam.lay(from, to, (AIM_RADIUS[0] + (AIM_RADIUS[1] - AIM_RADIUS[0]) * amount) * s)) return;
    aimBeam.mats[0].uniforms.uBright.value = (AIM_DIM + (1 - AIM_DIM) * amount) * (1 + (Math.random() - 0.5) * 2 * BEAM_FLICKER * amount);
    aimBeam.group.visible = true;
    aimT = AIM_HOLD_S;
    // motes drawn in to the muzzle, faster as it fills
    moteOwed += CHARGE_MOTE_RATE * amount * (dt ?? 0);
    const n = Math.floor(moteOwed);
    moteOwed -= n;
    burst(fx.mote, n, (p) => {
      const r = randIn(CHARGE_MOTE_RING) * s;
      vV.randomDirection();
      vP.copy(from).addScaledVector(vV, r);
      vV.multiplyScalar(-r / CHARGE_MOTE_LIFE);
      setP(p, vP, vV, randIn(CHARGE_MOTE_SIZE) * s, BEAM_MOTE_COLOR, 1, CHARGE_MOTE_LIFE);
    });
  }
  function fadeAim(dt) {
    if (aimT <= 0) return;
    aimT -= dt;
    if (aimT <= 0) aimBeam.group.visible = false;
  }

  // jetpack exhaust for dt seconds, out of the nozzles of a body at feet (grid) facing yaw
  let jetAcc = 0, smokeAcc = 0;
  const vN = new THREE.Vector3();
  function jet(feet, yaw, dt, N = JET_NOZZLES) {
    const s = env.getScale();
    jetAcc += JET_RATE * dt;
    smokeAcc += JET_SMOKE_RATE * dt;
    const nFlame = Math.floor(jetAcc), nSmoke = Math.floor(smokeAcc);
    jetAcc -= nFlame; smokeAcc -= nSmoke;
    const bx = Math.sin(yaw), bz = Math.cos(yaw);   // behind the body (forward is −z at yaw 0)
    for (const side of [-1, 1]) {
      vN.set(feet.x + bx * N.back + bz * N.side * side, feet.y + N.up, feet.z + bz * N.back - bx * N.side * side);
      const at = toWorld(vN, vP);
      burst(fx.jet, nFlame, (p) => {
        vV.randomDirection().multiplyScalar(JET_SPREAD); vV.y -= 1;
        vV.multiplyScalar(randIn(JET_SPEED) * s);
        setP(p, at, vV, randIn(JET_SIZE) * s, JET_COLOR, 1, randIn(JET_LIFE));
      });
      burst(fx.jetSmoke, nSmoke, (p) => {
        vV.randomDirection().multiplyScalar(JET_SPREAD * 2); vV.y -= 1;
        vV.multiplyScalar(randIn(JET_SMOKE_SPEED) * s);
        setP(p, at, vV, randIn(JET_SMOKE_SIZE) * s, JET_SMOKE_COLOR, JET_SMOKE_ALPHA, randIn(JET_SMOKE_LIFE), JET_SMOKE_GRAVITY, JET_SMOKE_DRAG);
      });
    }
  }

  // flames off a burning body at feet (grid) for dt seconds: random points on its sides,
  // rising (a random rounding of the rate, so no per-body state)
  function burn(feet, dt) {
    const s = env.getScale();
    const nFlame = Math.floor(BURN_RATE * dt + Math.random()), nSmoke = Math.floor(BURN_SMOKE_RATE * dt + Math.random());
    const at = (out) => {
      const a = Math.random() * TAU;
      vN.set(feet.x + Math.cos(a) * BODY_WIDTH / 2, feet.y + Math.random() * BODY_HEIGHT * BURN_REACH, feet.z + Math.sin(a) * BODY_WIDTH / 2);
      return toWorld(vN, out);
    };
    burst(fx.jet, nFlame, (p) => {
      vV.randomDirection().multiplyScalar(JET_SPREAD); vV.y += 1;
      vV.multiplyScalar(randIn(BURN_RISE) * s);
      setP(p, at(vP), vV, randIn(BURN_SIZE) * s, JET_COLOR, 1, randIn(BURN_LIFE));
    });
    burst(fx.jetSmoke, nSmoke, (p) => {
      vV.randomDirection().multiplyScalar(JET_SPREAD * 2); vV.y += 1;
      vV.multiplyScalar(randIn(BURN_RISE) * s);
      setP(p, at(vP), vV, randIn(JET_SMOKE_SIZE) * s, JET_SMOKE_COLOR, JET_SMOKE_ALPHA, randIn(JET_SMOKE_LIFE), JET_SMOKE_GRAVITY, JET_SMOKE_DRAG);
    });
  }

  // ---- wands: points in world units, directions unit; look = wands/look.js lookOf(...)
  const wA = new THREE.Vector3(), wB = new THREE.Vector3(), wD = new THREE.Vector3(), wN = new THREE.Vector3(), wV = new THREE.Vector3(), wP = new THREE.Vector3();
  const tint = (look, gain, out) => { for (let k = 0; k < 3; k++) out[k] = look.rgb[k] * gain; return out; };
  const trailRgb = [0, 0, 0], flareRgb = [0, 0, 0], sparkRgb = [0, 0, 0];
  const randomRound = (x) => Math.floor(x + Math.random());
  // n glowing motes in the look's colour at `at`, drifting from `vel` (world units/s)
  function wandMotes(at, n, look, speed = [0, WAND_TRAIL_DRIFT], dir = null, spread = 1) {
    const s = env.getScale();
    tint(look, WAND_TRAIL_GAIN, trailRgb);
    burst(fx.wandTrail, n, (p) => {
      wV.randomDirection();
      if (dir) wV.multiplyScalar(spread).add(dir);
      wV.multiplyScalar(randIn(speed) * s);
      setP(p, at, wV, randIn(WAND_TRAIL_SIZE) * s, trailRgb, 1, randIn(WAND_TRAIL_LIFE), WAND_TRAIL_GRAVITY, WAND_TRAIL_DRAG);
    });
  }
  // a flash in the look's colour, `size` world units across
  function wandFlash(at, look, size, life, gain = WAND_FLARE_GAIN) {
    burst(fx.flash, 1, (p) => setP(p, at, vT.set(0, 0, 0), size, tint(look, gain, flareRgb), 1, life));
  }
  // the look's own particles over n points along a → b (world): sparks, embers, mist, dust or smoke
  function lookParticles(a, b, n, look) {
    const s = env.getScale();
    wD.subVectors(b, a);
    const up = wN.set(0, 1, 0);
    for (let i = 0; i < n; i++) {
      wP.copy(a).addScaledVector(wD, Math.random());
      if (look.trail === 'spark') sparks(wP, 1, up, tint(look, WAND_TRAIL_GAIN, sparkRgb));
      else if (look.trail === 'ember') torchEmbers(wP, wV.set(0, 0, 0), 1 / EMBER_RATE);
      else if (look.trail === 'mist') mist(wP, 1, up, look.id, 0, look.id >= 0 ? null : look.rgb);
      else if (look.trail === 'dust') dust(wP, 1, up, look.id >= 0 ? look.id : E.SAND);
      else if (look.trail === 'smoke') {
        burst(fx.jetSmoke, 1, (p) => {
          wV.randomDirection().multiplyScalar(ROCKET_TRAIL_DRIFT * s);
          setP(p, wP, wV, randIn(JET_SMOKE_SIZE) * s, JET_SMOKE_COLOR, JET_SMOKE_ALPHA, randIn(JET_SMOKE_LIFE), JET_SMOKE_GRAVITY, JET_SMOKE_DRAG);
        });
      }
    }
  }
  // a cast leaving the tip (world) along dir
  function wandCast(at, dir, look) {
    const s = env.getScale();
    wandFlash(at, look, WAND_FLARE_SIZE * s, WAND_FLARE_LIFE);
    wandMotes(at, WAND_CAST_MOTES, look, WAND_CAST_MOTE_SPEED, dir, WAND_CAST_SPREAD);
    if (look.fire) flameStream(at, dir, 1, WAND_FIRE_PUFFS_S);
  }
  // bolts flew a → b (world) this frame: motes every WAND_TRAIL_STEP, the look's own particles sparser
  function wandTrail(a, b, look) {
    const s = env.getScale();
    const len = wD.subVectors(b, a).length() / s;
    if (len <= 0) return;
    const n = randomRound(len / WAND_TRAIL_STEP);
    tint(look, WAND_TRAIL_GAIN, trailRgb);
    burst(fx.wandTrail, n, (p) => {
      wP.copy(a).addScaledVector(wD, Math.random());
      wV.randomDirection().multiplyScalar(WAND_TRAIL_DRIFT * s);
      setP(p, wP, wV, randIn(WAND_TRAIL_SIZE) * s, trailRgb, 1, randIn(WAND_TRAIL_LIFE), WAND_TRAIL_GRAVITY, WAND_TRAIL_DRAG);
    });
    lookParticles(a, b, randomRound(len / WAND_TRAIL_EXTRA_STEP), look);
  }
  // a spell landed at `at` (world), the surface facing `normal` (unit, or null), radius in cells, id the cell hit
  function wandImpact(at, normal, look, radius, id) {
    const s = env.getScale();
    const n = normal ?? wN.set(0, 1, 0);
    const size = Math.min(WAND_IMPACT_FLASH[1], Math.max(WAND_IMPACT_FLASH[0], radius * WAND_IMPACT_FLASH_PER_RADIUS)) * s;
    wandFlash(at, look, size, WAND_IMPACT_FLASH_LIFE);
    if (look.field === 'void' || look.field === 'pull') {
      // the matter-eating looks: motes fall into the point instead of bursting out of it
      tint(look, WAND_TRAIL_GAIN, trailRgb);
      burst(fx.wandTrail, WAND_IMPACT_MOTES, (p) => {
        const r = randIn(WAND_IMPLODE_RING) * s;
        wV.randomDirection();
        wP.copy(at).addScaledVector(wV, r);
        wV.multiplyScalar(-r / WAND_IMPLODE_LIFE);
        setP(p, wP, wV, randIn(WAND_TRAIL_SIZE) * s, trailRgb, 1, WAND_IMPLODE_LIFE);
      });
    } else wandMotes(at, WAND_IMPACT_MOTES, look, WAND_IMPACT_MOTE_SPEED, n, 1);
    if (look.trail === 'spark' || look.fire) sparks(at, WAND_IMPACT_SPARKS, n, look.fire ? SPARK_COLOR : tint(look, WAND_TRAIL_GAIN, sparkRgb));
    if (look.fire) torchEmbers(at, wV.set(0, 0, 0), WAND_IMPACT_SPARKS / EMBER_RATE);
    if (look.trail === 'mist') mist(at, WAND_IMPACT_MIST, n, look.id, 0, look.id >= 0 ? null : look.rgb);
    const hitSolid = id >= 0 && ELEMENTS[id] && ELEMENTS[id].kind !== K.LIQUID && ELEMENTS[id].kind !== K.GAS;
    if (look.trail === 'dust') {
      const what = hitSolid ? id : look.id >= 0 ? look.id : E.SAND;
      dust(at, WAND_IMPACT_DUST, n, what);
      if (hitSolid) chips(at, WAND_IMPACT_DUST, n, id);
    }
  }
  // a beam (or touch) from → to (world), the look's along it and its own particles where it ends
  function wandBeam(from, to, dir, look, hit) {
    const s = env.getScale();
    const len = wD.subVectors(to, from).length() / s;
    if (len <= 0) return;
    if (look.fire) { flameStream(from, dir, len, WAND_FIRE_JET_S); return; }
    if (look.trail === 'mist') {
      const n = Math.min(WAND_BEAM_MIST_MAX, Math.ceil(len * WAND_BEAM_MIST_PER_CELL));
      for (let i = 0; i < n; i++) {
        wP.copy(from).addScaledVector(wD, (i + Math.random()) / n);
        mist(wP, 1, dir, look.id, 0, look.id >= 0 ? null : look.rgb);
      }
    }
    const n = Math.min(WAND_BEAM_MOTES_MAX, Math.ceil(len * WAND_BEAM_MOTES_PER_CELL));
    tint(look, WAND_TRAIL_GAIN, trailRgb);
    burst(fx.wandTrail, n, (p) => {
      wP.copy(from).addScaledVector(wD, Math.random());
      wV.randomDirection().multiplyScalar(WAND_TRAIL_DRIFT * s);
      setP(p, wP, wV, randIn(WAND_TRAIL_SIZE) * s, trailRgb, 1, randIn(WAND_TRAIL_LIFE), WAND_TRAIL_GRAVITY, WAND_TRAIL_DRAG);
    });
    if (!hit && look.trail !== 'mist') lookParticles(to, to, 2, look);
  }
  // the caster moved from → to (world, body middles): a streak of motes and a flash where it arrives
  function wandTeleport(from, to, look) {
    const s = env.getScale();
    const len = wD.subVectors(to, from).length() / s;
    tint(look, WAND_TRAIL_GAIN, trailRgb);
    burst(fx.wandTrail, Math.min(WAND_TELEPORT_MAX, Math.ceil(len / WAND_TELEPORT_STEP)), (p) => {
      wP.copy(from).addScaledVector(wD, Math.random());
      wV.randomDirection().multiplyScalar(WAND_TRAIL_DRIFT * s);
      setP(p, wP, wV, randIn(WAND_TRAIL_SIZE) * s, trailRgb, 1, randIn(WAND_TELEPORT_LIFE), WAND_TRAIL_GRAVITY, WAND_TRAIL_DRAG);
    });
    wandFlash(to, look, WAND_TELEPORT_FLASH * s, WAND_IMPACT_FLASH_LIFE * 2);
    wandMotes(to, WAND_IMPACT_MOTES, look, WAND_IMPACT_MOTE_SPEED);
  }
  const bodyMiddle = (feet, out) => toWorld(out.copy(feet).setY(feet.y + BODY_HEIGHT / 2), out);

  // ---- events
  const live = () => env.isActive();
  const offs = [
    povEvents.on('gun:fire', (e) => {
      if (!live()) return;
      const at = e.muzzleWorld && !e.by ? vA.copy(e.muzzleWorld) : toWorld(e.origin, vA);   // an NPC's viewmodel isn't drawn: flash at the muzzle cell
      muzzleFlash(at, vB.copy(e.dir).normalize());
    }),
    povEvents.on('impact', (e) => {
      if (!live() || !e.point) return;
      const el = ELEMENTS[e.id];
      if (!el) return;
      const gun = !MELEE_SOURCES.has(e.source);
      const at = toWorld(e.point, vA);
      const n = e.normal ? vB.copy(e.normal).normalize() : vB.set(0, 1, 0);
      if (el.kind === K.LIQUID) { mist(at, gun ? MIST_GUN : MIST_AXE, n, e.id); return; }
      const metal = e.id === E.METAL || e.id === E.SCRAP;
      const solid = el.kind === K.SOLID;
      if (metal || (solid && e.broke === false)) sparks(at, gun ? SPARKS_GUN : SPARKS_AXE, n);
      if (el.kind === K.POWDER && !metal) dust(at, gun ? DUST_GUN : DUST_AXE, n, e.id);
      if (solid && e.broke === true) {
        dust(at, gun ? DUST_GUN : DUST_AXE, n, e.id);
        chips(at, gun ? CHIPS_GUN : CHIPS_AXE, n, e.id);
      }
    }),
    povEvents.on('round:move', (e) => {
      if (!live() || !e.from || !e.to) return;
      // bullets streak, rockets smoke; a thrown bomb (and a rocket's body) is drawn by its tool
      if (e.kind === 'round') tracer(toWorld(e.from, vA), toWorld(e.to, vB));
      else if (e.kind === 'rocket') rocketTrail(toWorld(e.from, vA), toWorld(e.to, vB));
    }),
    povEvents.on('kick:grain', (e) => {
      if (live() && e.to && e.id >= 0) dust(toWorld(e.to, vA), DUST_GRAIN, vB.set(0, 1, 0), e.id);
    }),
    povEvents.on('blast', (e) => {
      if (live() && e.point) blast(toWorld(e.point, vA));
    }),
    povEvents.on('flame', (e) => {
      if (live() && !e.by) flameStream(e.muzzleWorld, e.dir, e.length, e.dt);
    }),
    povEvents.on('drill', (e) => {
      if (live() && e.point && e.id >= 0) drillSpray(toWorld(e.point, vA), vB.copy(e.dir), e.id, e.dt);
    }),
    povEvents.on('laser', (e) => {
      if (!live() || !e.from || !e.to) return;
      // an NPC's emit carries its eye (grid) as `from` (events.js): the beam starts there
      laserBeam(e.by ? toWorld(e.from, vA) : vA.copy(e.from), vB.copy(e.to), e.radius, e.hit !== false);
    }),
    povEvents.on('laser:aim', (e) => {
      if (live() && !e.by && e.from && e.to) laserAim(vA.copy(e.from), vB.copy(e.to), e.amount ?? 0, lastDt);
    }),
    povEvents.on('torch:burn', (e) => {
      if (live()) torchEmbers(e.at, e.vel, e.dt);
    }),
    // wands (wands/runtime.js): points in grid cells, except wand:fire's muzzleWorld
    povEvents.on('wand:fire', (e) => {
      if (!live() || !e.dir) return;
      const at = e.muzzleWorld && !e.by ? wA.copy(e.muzzleWorld) : toWorld(e.muzzle ?? e.origin, wA);
      wandCast(at, wB.copy(e.dir).normalize(), lookOf(e.effect, e.material));
    }),
    povEvents.on('wand:flight', (e) => {
      if (!live()) return;
      for (const fl of e.flights ?? []) wandTrail(toWorld(fl.from, wA), toWorld(fl.to, wB), lookOf(fl.effect, fl.material));
    }),
    povEvents.on('wand:impact', (e) => {
      if (live() && e.point) wandImpact(toWorld(e.point, wA), e.normal ? wB.copy(e.normal).normalize() : null, lookOf(e.effect, e.material), e.radius ?? 1, e.id ?? -1);
    }),
    povEvents.on('wand:beam', (e) => {
      if (live() && e.from && e.to) wandBeam(toWorld(e.from, wA), toWorld(e.to, wB), vD.copy(e.dir).normalize(), lookOf(e.effect, e.material), e.hit);
    }),
    // a wand's blast is the bomb's fireball (not 'blast', which index.js counts as the player's own bomb)
    povEvents.on('wand:blast', (e) => {
      if (live() && e.point) blast(toWorld(e.point, wA));
    }),
    povEvents.on('wand:teleport', (e) => {
      if (live() && e.from && e.to) wandTeleport(bodyMiddle(e.from, wA), bodyMiddle(e.to, wB), lookOf('teleport'));
    }),
  ];

  const count = () => {
    let n = beams.length + (aimBeam.group.visible ? 1 : 0);
    for (const k in fx) n += fx[k].sys.particleNum;
    return n;
  };

  return {
    batch,
    light,   // the muzzle light (in the main scene)
    // the body fell into a liquid: feet (grid), speed (cells/s), liquid id
    splash(feet, speed, liquidId) {
      if (!live()) return;
      const n = Math.min(MIST_SPLASH_MAX, speed * MIST_SPLASH_PER_SPEED);
      mist(toWorld(feet, vA), n, vB.set(0, 1, 0), liquidId ?? E.WATER, MIST_SPLASH_RING);
    },
    // the jetpack firing this frame: feet (grid), yaw (rad), dt (s), nozzles (the body's, JET_NOZZLES' shape)
    jet(feet, yaw, dt, nozzles) { if (live()) jet(feet, yaw, dt, nozzles); },
    // a burning body this frame: feet (grid), dt (s)
    burn(feet, dt) { if (live()) burn(feet, dt); },
    // every POV frame; true while anything is still showing (keep rendering)
    update(dt) {
      batch.update(dt);
      fadeBeams(dt);
      fadeAim(dt);
      lastDt = dt;
      // the light shows at its current strength this frame, then fades (at
      // least one frame lit, however slow)
      const s = env.getScale();
      light.intensity = lightT > 0 ? FLASH_LIGHT_GAIN * s * s * (lightT / FLASH_LIGHT_TIME) : 0;
      const lit = lightT > 0;
      lightT = Math.max(0, lightT - dt);
      return lit || count() > 0;
    },
    // particle counts per effect (checks)
    counts() {
      const o = {};
      for (const k in fx) o[k] = fx[k].sys.particleNum;
      return o;
    },
    get busy() { return lightT > 0 || count() > 0; },
    setVisible(v) { batch.visible = v; },
    // drop everything in flight (leaving POV)
    clear() {
      for (const k in fx) { fx[k].sys.particleNum = 0; }
      fadeBeams(Infinity);
      lightT = 0;
      light.intensity = 0;
      batch.update(0);
    },
    dispose() {
      offs.forEach((f) => f());
      for (const k in fx) fx[k].sys.dispose();
      scene.remove(batch, emitters, light);
      materials.forEach((m) => m.dispose());
      dot.dispose(); star.dispose();
      fadeBeams(Infinity);
      scene.remove(aimBeam.group); aimBeam.mats.forEach((m) => m.dispose());
      beamGeo.dispose(); taperGeo.dispose();
    },
  };
}
