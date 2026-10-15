// HDR post-processing on WebGPU (docs/webgpu.md W16, F1, F4, F7): the scene
// target (linear, premultiplied HDR radiance and its depth) → three's TAAU →
// eye adaptation → bloom → sharpen + AgX + sRGB + dither (+ night vision) →
// the canvas, composited there over the page's sky gradient.
//
//   const post = createPost(gpu, { presenter, pixScale, presentation });   // presentation: gfx/presentation.js (motion through the rolling log)
//   await post.ready;                    // its pipelines (built at once: boot needs post)
//   post.render({ prepare, compute, opaque, draw, meshes, overlay }, camera, null, dt);
//   post.reset();                        // after anything that invalidates history
//   post.settings.taa / .upscale / .bloom / .exposure (EV) / .sharpen / .look / .raw / .hotStart / .hotFull
//   post.settings.night / .nightGain / .meter, post.sceneLuma: night-vision goggles (below)
//
// A presented frame, as render() records it (B3's E1 and E2), all of it in the
// tick's one encoder unless three draws:
//   beginScene           sizes the targets, jitters the camera (three's TAAU: a view offset, F4), sets pixScale
//   prepare(post)        write FrameUniforms, the tick's one write: the camera is jittered now, and
//                        post.jitter, post.inSize and pixScale are this frame's (F6)
//   compute(post)        E1's commands that read FrameUniforms (derived passes, shadow, GI, pick),
//                        after that write, so the write needn't flush (B3). E1's other work (edits,
//                        paint, the steps) may come before render(), into the same encoder. JS here
//                        that casts rays from the camera wraps them in post.withoutJitter(fn)
//   opaque(post)         three's opaque meshes first, if any (docs/webgpu.md Sync log S1): three
//                        renders them into post.sceneTarget.rt clearing it (colour 0, depth 1),
//                        and the hook returns true; the volume then reads their depth
//                        (gfx/meshCut.js capture, which also returns true)
//   scene pass           draw(rp, post) into post.sceneTarget: colour cleared to 0 and depth to 1,
//                        or both loaded when opaque drew (F1, S1)
//   meshes(post)         three.render into post.sceneTarget.rt (its own submit, loadOp load), if any:
//                        what draws after our scene (the transparent meshes)
//   overlay pass         overlay(rp, post): the rays sprites, colour loaded, depth read-only, if any
//   endScene             the camera's own projection back; onPass('scene')
//   motion pass          → TAAU's inputs: velocity and the colour, sanitized (fragment, the scene's size)
//   three's TAAU         resolve → output size, history and depth copies (three's submits, gpu/three.js)
//   prefilter pass       → down[0], half resolution                       (fragment)
//   compute pass 'post'  bloom down 1–5, up 4–1; luminance grid, histogram, adaptation, meter (one workgroup)
//   bloom up0 pass       → up[0], half the output's size                 (fragment)
//   bloom pass           → the bloom image: up[0]'s 3×3 tent, its size    (fragment)
//   canvas pass          sharpen, bloom, AgX, sky, viewmodel, glow       (fragment, presenter's texture)
// so post is 4 render passes of ours and 1 compute pass besides the scene and
// canvas passes, and three's TAAU (the WebGL2 build made about 17). The split methods (beginScene,
// endScene, finish) are there for callers that need the parts apart; tools
// count view frames by wrapping render(), so the app's frames go through it.
// After radiance/TAA settle, render(..., { postOnly: true }) may retain the
// resolved colour and bloom: only advance adaptation toward its saved histogram
// target and composite. app.js certifies external dependencies; canReuse also
// validates image settings, camera, canvas, presentation and temporal history.
//
// Retina (a device pixel ratio of 2: 4× the pixels of the CSS size) made the
// output-size work the expensive part. Ours is the canvas pass (one fragment
// a pixel) and the prefilter's read of the resolved frame; the rest is at half
// size or smaller. So the canvas pass takes bloom in one bilinear tap of a
// half-size image the bloom pass pre-filters with the 3×3 tent the composite
// used to apply in nine taps (bilinear interpolation commutes with the tent
// on the texel grid: the same values inside the frame), and per pixel it
// skips what it can show changes nothing (the sky under full coverage, the HDR
// gain below SDR's shoulder, the white point, which is per frame). The bright
// pass stays on the resolved frame: the aliased scene has about twice its
// above-threshold light along thin bright lines (lamp tubes, sparks), so a
// halo made from it would outshine what the composite takes away. The
// histogram's grid is sparse (2304 patches), the same cost from any image.
//
// The scene is rendered as linear, premultiplied HDR radiance. Tone mapping is
// applied to the premultiplied colour ("over black"), so opaque pixels are
// exact, coverage at silhouettes is resolved in linear light, and emissive media
// and bloom add light over the background. The canvas is opaque (F7): where the
// scene's coverage is below 1 the composite draws the page's sky gradient
// (ui/styles.css body background) behind it, exactly as the compositor blended
// the old transparent canvas over the page, so the compositor no longer blends a
// full-window layer every frame.
//
// Temporal anti-aliasing and upscaling: three.js r186's TAAUNode (gpu/three.js
// createTemporalUpscaler; Karis 2014's jittered reconstruction, FSR 2's
// single-pass history) at every Upscaling preset, native included. The scene
// renders at the preset's share of the output's pixels per axis (UPSCALE: AMD
// FSR 2's quality modes, of the device's real pixels), jittered by the node's
// own Halton sequence as a view offset on the camera; our motion pass turns its
// depth into the node's velocity (camera motion, and the rolling log's bend
// folded in) and hands it the colour, sanitized; the node resolves to output
// size and keeps its history. It needs three's renderer on the gpu: without
// one (Node tools) there is no TAA and the scene renders at output size.
// Bloom (Jimenez 2014): per-pixel soft-knee bright pass at half resolution, 13-tap
// downsample to 1/64, 9-tap tent upsample. It is energy-conserving: the halo only
// redistributes the above-threshold light (out = c + k·(blur(bright) − bright(c))).
// Eyes adjusting to the dark: histogram auto exposure as in Unreal (and Frostbite:
// Lagarde & de Rousiers 2014), only ever upward. The resolved frame's luminance is
// sampled on a coarse grid, scattered into a log-luminance histogram (fixed-point
// atomics in workgroup memory, which sum exactly in any order), and the mean of the
// histogram between two percentiles (Unreal's; it ignores the darkest pixels and
// small bright lights) says how bright the view is. Over ADAPT.LOG_DARK nothing
// changes; under it the exposure rises by what brings it back there, up to
// ADAPT.MAX_EV, with the exponential time course of visual adaptation (Pattanaik et
// al. 2000, as in Krawczyk et al. 2005): slow into the dark, quick back into the light.
// Night vision (the Night Vision perk, pov/nightVision.js): an image intensifier's picture, mixed in
// by settings.night: the scene's luminance × settings.nightGain, tone-mapped as a grey and shown on a
// green P43 phosphor, with the tube's shot-noise grain (σ ∝ √(signal·gain): it counts photons) and
// its round field's vignette. With settings.meter on, the pipeline also measures the scene's
// log-average luminance (Reinhard et al. 2002, the auto-exposure key) every METER_INTERVAL frames
// over a METER_SIZE² grid of tiles, reduced on the GPU and read back asynchronously: post.sceneLuma
// (linear, before exposure; over covered pixels only: the sky behind the scene isn't the scene).
//
// Conventions (F4): clip depth is 0..1 and every projection comes from a camera in
// WebGPU's coordinate system; framebuffer and texture coordinates are top-left
// (y down), so per-pixel noise (dither, grain) is the WebGL build's mirrored
// vertically. The jitter (post.jitter) is the node's offset (jx, jy) in scene
// pixels with y down: scene texel m sampled the view at m + ½ + jitter. It is a
// view offset on the camera (three's Camera.setViewOffset: projection column 2
// gets +2·jx/w and −2·jy/h), so three's meshes jitter with our passes, and comes
// out after the scene. Velocity is three's VelocityNode's convention: this
// frame's unjittered NDC minus the last frame's. The rolling log
// (gfx/presentation.js): while a gamemode's effect bends the view, or bent the
// last frame, the motion pass reprojects through the displayed world: this
// frame's depth back to its displayed point, unwarped with this frame's
// parameters, warped with the last frame's, into the last frame's clip space.

import {
  Matrix4, Vector3, Quaternion, RenderTarget, DepthTexture, HalfFloatType, FloatType, NearestFilter,
} from 'three/webgpu';
import { uniformStruct, fullscreenVert, luma as lumaWGSL, STAGE } from '../gpu/index.js';
import { initRenderTarget, gpuTextureOf, createTemporalUpscaler } from '../gpu/three.js';
import { createBlit } from '../gpu/present.js';
import { IDENTITY, presentationWGSL } from './presentationMath.js';
import { glf as f } from '../glsl.js';
import { sprintBlurWGSL } from './sprintBlur.js';
import { crueltyDisplayWGSL, crueltyFrameSettings } from './crueltyDisplay.js';

export const POST_DEFAULTS = {
  taa: true,
  upscale: 1, // render scale per axis under TAA, of the output's pixels (1 = native; see UPSCALE)
  resolutionScale: 1, // automatic multiplier under an upscaling preset (never at native); output and history stay full size
  adaptive: null, // resolutionScale applies; null: under an upscaling preset (upscale < 1). The app's Fast draws 1:1 on a page-sized canvas and still adapts
  floor: null, // lowest render scale it may take, of the output's pixels; null: UPSCALE_FLOOR
  bloom: 0.3, // fraction of above-threshold light scattered into the halo (0..1)
  // EV stops. +0.7 with look 0.5 reproduces the mean brightness and saturation of the
  // old in-shader ACES (measured on the lab and volcano presets).
  exposure: 0.7,
  sharpen: 0.25, // CAS-style post-TAA sharpen (0..1)
  sprintBlur: 0, // transient 0..1 speed effect, set by the POV shell; never stored or used in stills
  cruelty: false, // transient gamemode treatment; original PaletteLimiter + screenmat (crueltyDisplay.js)
  look: 0.5, // 0 = AgX base, 1 = Blender's AgX "Punchy" look
  raw: false, // true = only encode to sRGB (false-colour data views keep exact legend colours)
  bloomThreshold: 1.6, // max-channel radiance where bloom starts…
  bloomKnee: 0.8, // …with a soft knee this wide
  bloomScatter: 0.7, // energy share passed from each mip to the next wider one
  // Bright saturated colours (lava, flames, glowing metal) roll off per channel, like film,
  // instead of fading to white: the blend starts at this exposed max-channel radiance…
  hotStart: 1.0,
  hotFull: 4.0, // …and is complete here
  adapt: true, // eyes adjusting to the dark (ADAPT); false holds the gain at 1 (A/B checks)
  night: 0, // night-vision goggles' share of the picture (0 = off)
  nightGain: 1, // × light they add
  meter: false, // measure post.sceneLuma
};

// HDR output (EDR on a Mac; src/gpu/present.js makes the canvas). The SDR picture
// stays AgX exactly; each pixel is then scaled by how much further Gran
// Turismo's tone curve reaches with the display's peak than with SDR white
// (Uchimura 2017, "HDR theory and practice", CEDEC: the curve GT Sport ships, P
// = the peak). Its toe and linear section don't depend on P, so the darks and
// mid-tones keep the SDR picture and only highlights (lava, the sun, flames,
// lamps, crystals) climb above white.
export const HDR_OUT = {
  // Brightest value sent, × SDR white: a MacBook Pro's XDR panel peaks at 1600 nits over its
  // 500-nit SDR white (3.2×); brighter values only clip, on that panel or a dimmer HDR one.
  PEAK: 3.2,
  // Exposed luminance the curve treats as 1 (white): sunlit white (≈ 1.2, gfx/incandescence.js)
  // at the default exposure (+0.7 EV) is ≈ 1.95, so diffuse white sits at the shoulder's foot.
  PAPER: 2.0,
  // Uchimura's defaults: contrast a, linear section start m and length l, black tightness c
  CONTRAST: 1.0, LINEAR_START: 0.22, LINEAR_LENGTH: 0.4, BLACK: 1.33,
};

// Eye adaptation (see the header). Luminances are log2 of scene radiance, where
// sunlit white is ≈ 1.2 (gfx/incandescence.js): daylit views sit around -2..0,
// the moonlit night a few stops under, a cave lit by crystals ~10 under.
export const ADAPT = {
  GRID: [64, 36],      // luminance samples across the frame…
  TAPS: 4,             // …each the mean of TAPS × TAPS bilinear taps over its patch
  BINS: 64,            // histogram bins…
  LOG_MIN: -16,        // …over this log2 range (darker or brighter pixels land in the end bins)
  LOG_MAX: 4,
  LOW_PCT: 0.8,        // the mean is taken between these shares of the pixels, darkest first
  HIGH_PCT: 0.983,     // (Unreal's defaults: the brightest 1.7% are lights, not the scene)
  LOG_DARK: -5,        // a view this bright or brighter keeps the fixed exposure; darker ones rise to it…
  MAX_EV: 4,           // …by at most this many stops (16×)
  TAU_DARK: 1.5,       // s: time constant of adjusting to the dark (a few seconds to settle)…
  TAU_LIGHT: 0.4,      // s: …and back to the light (Pattanaik et al. 2000's rod time constant)
  SETTLED: 1e-3,       // relative gap to its target under which the gain snaps onto it
  DT: 1 / 60,          // s: the frame time assumed when render() isn't given one
};

// Frame-time trials, not a refresh-rate target alone: a capped 30 Hz page can
// regain detail too. Failed trials back off so CPU-bound scenes don't keep cycling.
export const AUTO_RES = {
  WINDOW: 1.2,        // s of frames averaged per measurement
  BUDGET: 1 / 50,     // s: a slower average frame tries a lower scale
  DOWN: 0.85,         // scale × this per step down…
  UP: 1.08,           // …and × this per step back up
  KEEP: 0.93,         // a step is kept only if the frame time moves by this ratio
  MIN: 0.6,           // lowest multiple of the selected render scale
  HOLD: 15,           // s between trials…
  MAX_HOLD: 120,      // …doubling after each failed one, up to this
};
export function createAutoResolution() {
  const { WINDOW, BUDGET, DOWN, UP, KEEP, MIN, HOLD, MAX_HOLD } = AUTO_RES;
  let time = 0, frames = 0, trial = null, resting = false;
  let downAt = 0, upAt = HOLD, downHold = HOLD, upHold = HOLD;
  const auto = {
    enabled: true, // tools disable adaptation for stable timings (freeze current scale)
    scale: 1,
    // Finish a still at selected quality, without measuring its settling frames
    // and degrading again. Only outside input/state changes release this lock.
    recover(now) {
      if (!auto.enabled || resting) return false;
      resting = true;
      time = frames = 0; trial = null;
      upAt = now + HOLD;
      const changed = auto.scale !== 1;
      auto.scale = 1;
      return changed;
    },
    wake() { resting = false; },
    update(dt, now) {
      if (!auto.enabled || resting) { time = frames = 0; trial = null; return; }
      time += dt; frames++;
      if (time < WINDOW) return;
      const avg = time / frames;
      time = frames = 0;
      if (trial) {
        const { scale, baseline, up } = trial;
        const accepted = up ? avg <= baseline / KEEP : avg <= baseline * KEEP;
        if (!accepted) auto.scale = scale;
        if (up) {
          upAt = now + (accepted ? WINDOW : upHold);
          upHold = accepted ? HOLD : Math.min(MAX_HOLD, upHold * 2);
          // Don't immediately undo a successful recovery at a refresh-rate cap.
          downAt = Math.max(downAt, now + HOLD);
        } else {
          downAt = now + (accepted ? 0 : downHold);
          downHold = accepted ? HOLD : Math.min(MAX_HOLD, downHold * 2);
          upAt = Math.max(upAt, now + HOLD);
        }
        trial = null;
        return;
      }
      const up = auto.scale < 1 && now >= upAt;
      if (up || (avg > BUDGET && auto.scale > MIN && now >= downAt)) {
        trial = { scale: auto.scale, baseline: avg, up };
        auto.scale = up ? Math.min(1, auto.scale * UP) : Math.max(MIN, auto.scale * DOWN);
      }
    },
  };
  return auto;
}

export const MIPS = 6;
// Upscaling presets: render scale per axis of the output's (the device's) pixels,
// AMD FSR 2's quality modes (FidelityFX Super Resolution 2 docs, "Quality modes").
export const UPSCALE = { native: 1, quality: 1 / 1.5, balanced: 1 / 1.7, performance: 1 / 2 };
// The lowest render scale automatic resolution may take under an upscaling preset:
// FSR 2's Ultra Performance mode, 3× per axis. At native it never lowers the scale.
export const UPSCALE_FLOOR = 1 / 3;
// The motion pass's velocity on a frame whose history is dropped (reset, a jump):
// two screens in NDC, so TAAUNode's history uv lands off the screen for every pixel
// and the node takes the current frame alone (its isValidUV test).
const HISTORY_GONE_NDC = 4;
// History is dropped when the camera jumps: moves farther than this share of its
// distance from the origin (at least 1 world unit) in one frame…
const JUMP_MOVE_FRAC = 0.25;
const JUMP_TURN = 0.5; // …or turns more than this (radians)
// The luminance meter (night vision's automatic brightness control): a METER_SIZE² grid of tiles,
// METER_TAPS² samples each, every METER_INTERVAL frames.
const METER_SIZE = 16;
const METER_TAPS = 4;
const METER_INTERVAL = 4;
const METER_LOG_FLOOR = 1e-4; // radiance added before the log, so black pixels don't send it to −∞ (Reinhard's δ)
const METER_COVERED = 0.5;    // alpha at which a pixel counts as scene, not the sky behind it
// Night vision's screen: a Gen-3 image intensifier's P43 phosphor (green, peak 545 nm), linear sRGB, max
// channel 1 (also tints the held tool's composite below).
export const NV_PHOSPHOR = [0.30, 1.0, 0.25];
// The histogram's weights in fixed point: each sample's coverage / samples · 2^20, so a
// frame's total is at most 2^20 and integer atomics add them exactly, in any order (W21).
const HIST_FIXED = 2 ** 20;
// The workgroup that reduces the frame (luminance grid, histogram, adaptation, meter).
const REDUCE_THREADS = 256;
// The result ring's slot: gain, target, view, meter Σ log L, meter count, flags (1 adapt, 2 meter).
const RESULT_BYTES = 32;
const RESULT_SLOTS = 8;
const NO_SLOT = 0xffffffff;
const BLOOM_TILE = 8;   // compute workgroups of the bloom mips: 8×8 pixels (W22: 64 threads)

// The page's sky (ui/styles.css, body background): a three-stop linear gradient
// under a faint warm radial glow. Colours are sRGB-encoded, as CSS blends them;
// top and low are read from the page's --sky-top and --sky-low when there is a page.
export const SKY = {
  top: '#232b3a',             // --sky-top, at 0%
  mid: '#161b25',             // at MID_AT
  low: '#0e1117',             // --sky-low, at 100%
  MID_AT: 0.55,
  glow: [255, 196, 120, 0.06],   // radial-gradient(120% 70% at 50% 108%, rgba(255, 196, 120, 0.06), transparent 60%)
  GLOW_CENTRE: [0.5, 1.08],
  GLOW_RADII: [1.2, 0.7],
  GLOW_END: 0.6,
};

// GPUTextureUsage and GPUBufferUsage bits (spec values), usable where WebGPU's globals aren't (Node).
const TEX = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
const BUF = { COPY_SRC: 4, COPY_DST: 8, STORAGE: 128 };
const HDR = 'rgba16float';
const CLEAR = [0, 0, 0, 0];

const vec2 = ([x, y]) => `vec2f(${f(x)}, ${f(y)})`;

// ---------------------------------------------------------------- params

const MotionParams = uniformStruct('MotionParams', {
  // prevViewProj (unjittered) · inverse(curViewProj, jittered as the scene drew); while
  // the rolling log bends this frame or bent the last (warpK or prevK not 0), this
  // frame's clip → displayed world cells instead, the first half of the reprojection
  reproj: 'mat4x4f',
  jitterNdc: 'vec2f',    // this frame's jitter in NDC (2·jx/w, −2·jy/h): jittered NDC + this = unjittered
  size: 'vec2f',         // the scene's size
  historyValid: 'bool',  // false: send every pixel's history off the screen (HISTORY_GONE_NDC)
  // the rolling log (gfx/presentation.js): this frame's and the last frame's parameters (k 0: flat)
  warpK: 'f32',
  prevK: 'f32',
  warpAnchor: 'vec2f',
  warpDir: 'vec2f',
  prevAnchor: 'vec2f',
  prevDir: 'vec2f',
  // ...and, bent, the last frame's world cells → clip: the second half (one ring slot in all)
  prevWorldToClip: 'mat4x4f',
});
const PrefilterParams = uniformStruct('PrefilterParams', { thresh: 'vec2f', packed: 'bool' });   // packed: see radiance()
const MipParams = uniformStruct('MipParams', {
  texel: 'vec2f',   // source texel (down: the finer level; up: the coarser one)
  dst: 'vec2u',     // this level's size
  scatter: 'f32',
});
const ReduceParams = uniformStruct('ReduceParams', { dt: 'f32', adapt: 'bool', meter: 'bool', slot: 'u32', packed: 'bool', reuseTarget: 'bool' });
const CompositeParams = uniformStruct('CompositeParams', {
  size: 'vec2f', thresh: 'vec2f', hot: 'vec2f',
  bloom: 'f32', exposure: 'f32', sharpen: 'f32', look: 'f32',
  raw: 'bool', adapt: 'bool', night: 'f32', nightGain: 'f32',
  nightSeed: 'u32', opaque: 'bool', viewmodel: 'bool', glow: 'bool',
  vmNight: 'f32', peak: 'f32', sprintBlur: 'f32', cruelty: 'bool', crueltyTime: 'f32',
  packed: 'bool',   // the resolved frame is TAAU's, in taaCompress's range (radiance())
  white: 'f32',   // the brightest value sent: srgbEncode(max(peak, 1)), once a frame rather than per pixel
  skyTop: 'vec3f', skyMid: 'vec3f', skyLow: 'vec3f', skyGlow: 'vec4f',
});

// ---------------------------------------------------------------- layouts (group 2: post's own resources, C4)

const F = STAGE.FRAGMENT, C = STAGE.COMPUTE;
const tex = (binding, visibility, sampleType = 'float') => ({ binding, visibility, texture: { sampleType } });
const linear = (binding, visibility) => ({ binding, visibility, sampler: { type: 'filtering' } });
export const POST_LAYOUTS = {
  // the scene's colour and its depth (texelFetch)
  MOTION: [tex(0, F), tex(1, F, 'depth')],
  // two images and a sampler: the prefilter and the bloom pass (one source each)
  PAIR: [tex(0, F), tex(1, F), linear(2, F)],
  // a bloom level: source (or low), high, sampler, the level written
  MIP: [tex(0, C), tex(1, C), linear(2, C), { binding: 3, visibility: C, storageTexture: { access: 'write-only', format: HDR } }],
  // the resolved frame, sampler, the adaptation state (in place), the result ring
  REDUCE: [tex(0, C), linear(1, C), { binding: 2, visibility: C, buffer: { type: 'storage' } }, { binding: 3, visibility: C, buffer: { type: 'storage' } }],
  // the resolved frame, the bloom image, sampler, the adaptation state, the viewmodel and glow targets (F3)
  COMPOSITE: [tex(0, F), tex(1, F), linear(2, F), { binding: 3, visibility: F, buffer: { type: 'read-only-storage' } }, tex(4, F), tex(5, F)],
};

// ---------------------------------------------------------------- WGSL

const COMMON = /* wgsl */ `
${lumaWGSL}
// NaN → 0, +Inf → large, negatives → 0, then a hue-preserving cap. The NaN/Inf test is
// done on the bits, so it survives compilers that assume finite maths (H1.26).
const MAX_RADIANCE: f32 = 4096.0;
const F32_INF: u32 = 0x7f800000u;  // IEEE-754 +Inf bits; any larger magnitude is a NaN
const F32_ABS: u32 = 0x7fffffffu;  // mask that clears the sign bit
fn sanitize(c0: vec4f) -> vec4f {
  let b = bitcast<vec4u>(c0);
  var c = select(c0, vec4f(MAX_RADIANCE), b == vec4u(F32_INF));
  c = select(c, vec4f(0.0), (b & vec4u(F32_ABS)) > vec4u(F32_INF));
  c = max(c, vec4f(0.0));
  let m = max(c.r, max(c.g, c.b));
  if (m > MAX_RADIANCE) { c = vec4f(c.rgb * (MAX_RADIANCE / m), c.a); }
  c.a = min(c.a, 1.0);
  return c;
}

// The temporal resolve's range (Karis 2014, "High Quality Temporal
// Supersampling": tonemap before the resolve, invert after). three's TAAU
// averages what it is given, so one sample many times brighter than its
// neighbours (a leaf mirroring the sun) would show as a blip for a frame
// before its variance clip takes it out; given c / (1 + max(c)), that sample
// counts for at most 1 and averages in. Max channel, as three's own
// flickerReduction compresses: the scale keeps the hue, so expand inverts it
// exactly, up to sanitize's cap.
const TAA_EXPAND_MIN: f32 = 1.0 / (1.0 + MAX_RADIANCE);   // 1 - max of a compressed MAX_RADIANCE
fn taaCompress(c: vec4f) -> vec4f { return vec4f(c.rgb / (1.0 + max(c.r, max(c.g, c.b))), c.a); }
fn taaExpand(c: vec4f) -> vec4f { return vec4f(c.rgb / max(1.0 - max(c.r, max(c.g, c.b)), TAA_EXPAND_MIN), c.a); }
// The resolved frame's texel as radiance. Under TAA it is three's resolve, still
// in taaCompress's range (packed); without TAA it is the scene itself. Its readers
// (prefilter, reduce, composite) expand each texel as they load it, instead of
// an output-size pass writing the expanded frame out for them to read back:
// at Retina size that pass cost ~2 ms (M5, 2026-10-13).
fn radiance(c: vec4f, packed: u32) -> vec4f { if (packed != 0u) { return taaExpand(c); } return c; }

// Expand each TAA texel before filtering: interpolating compressed highlights loses energy.
fn tapRadiance(t: texture_2d<f32>, s: sampler, uv: vec2f, packed: u32) -> vec4f {
  if (packed == 0u) { return textureSampleLevel(t, s, uv, 0.0); }
  let size = vec2i(textureDimensions(t));
  let hi = size - 1;
  let q = uv * vec2f(size) - 0.5;
  let i = vec2i(floor(q));
  let w = q - floor(q);
  let a = taaExpand(textureLoad(t, clamp(i, vec2i(0), hi), 0));
  let b = taaExpand(textureLoad(t, clamp(i + vec2i(1, 0), vec2i(0), hi), 0));
  let c = taaExpand(textureLoad(t, clamp(i + vec2i(0, 1), vec2i(0), hi), 0));
  let d = taaExpand(textureLoad(t, clamp(i + vec2i(1, 1), vec2i(0), hi), 0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

// Soft-knee bright pass on the max channel: the share of the light that blooms (th: threshold, knee).
fn bright(c: vec3f, th: vec2f) -> vec3f {
  let br = max(c.r, max(c.g, c.b));
  var rq = clamp(br - th.x + th.y, 0.0, 2.0 * th.y);
  rq = rq * rq / (4.0 * th.y + 1e-4);
  return c * (max(rq, br - th.x) / max(br, 1e-4));
}

// 3×3 tent: binomial weights 1-2-1 ⊗ 1-2-1 (sum 16).
fn tent9(t: texture_2d<f32>, s: sampler, uv: vec2f, texel: vec2f) -> vec3f {
  let d = vec4f(texel, -texel.x, 0.0);
  var acc = textureSampleLevel(t, s, uv - d.xy, 0.0).rgb + textureSampleLevel(t, s, uv - d.zy, 0.0).rgb
          + textureSampleLevel(t, s, uv + d.zy, 0.0).rgb + textureSampleLevel(t, s, uv + d.xy, 0.0).rgb;
  acc += 2.0 * (textureSampleLevel(t, s, uv - d.wy, 0.0).rgb + textureSampleLevel(t, s, uv + d.zw, 0.0).rgb
              + textureSampleLevel(t, s, uv + d.xw, 0.0).rgb + textureSampleLevel(t, s, uv + d.wy, 0.0).rgb);
  acc += 4.0 * textureSampleLevel(t, s, uv, 0.0).rgb;
  return acc * (1.0 / 16.0);
}
`;

/**
 * The motion pass, at the scene's size: three's TAAU's two inputs (gpu/three.js
 * createTemporalUpscaler), the scene's velocity (location 0: this frame's
 * unjittered NDC minus the last frame's, three's VelocityNode's convention,
 * from depth and the cameras, through the rolling log's bend) and its colour,
 * sanitized (location 1: a NaN or Inf would live on in the node's history)
 * and compressed into the resolve's range (taaCompress; its readers undo it, radiance()).
 */
export const motionWGSL = () => /* wgsl */ `
${fullscreenVert('vs')}
${COMMON}
${MotionParams.wgsl}
@group(2) @binding(0) var tColor: texture_2d<f32>;     // the scene: linear premultiplied radiance, alpha = coverage
@group(2) @binding(1) var tDepth: texture_depth_2d;    // its depth, 0..1 (F4)
@group(3) @binding(1) var<uniform> P: MotionParams;
const HISTORY_GONE: f32 = ${f(HISTORY_GONE_NDC)};

${presentationWGSL}
// Last frame's clip position of this frame's clip position: by the cameras
// alone, or while the rolling log bends this frame or bent the last, through
// the flat world under the displayed point (P.reproj then takes the clip
// position to the displayed world cells). The background, at depth 1, goes
// by the cameras: it is the sky, and the halves' product is the cameras'
// reprojection while the scene → world cells transform holds (it changes
// only with the grid, app.js build(), which resets the history).
fn presentationReproject(clip: vec4f) -> vec4f {
  if (P.warpK == 0.0 && P.prevK == 0.0) { return P.reproj * clip; }
  let displayWorld = P.reproj * clip;
  if (clip.z >= clip.w) { return P.prevWorldToClip * displayWorld; }
  let flatWorld = unwarpPoint(displayWorld.xyz / displayWorld.w);
  return P.prevWorldToClip * vec4f(warpPointWith(flatWorld, P.prevK, P.prevAnchor, P.prevDir), 1.0);
}

struct Motion {
  @location(0) velocity: vec2f,
  @location(1) color: vec4f,
}
@fragment fn fs(in: FullScreen) -> Motion {
  warpUse(P.warpK, P.warpAnchor, P.warpDir);
  let p = vec2i(in.position.xy);
  var o: Motion;
  o.color = taaCompress(sanitize(textureLoad(tColor, p, 0)));
  o.velocity = vec2f(HISTORY_GONE);
  if (P.historyValid == 0u) { return o; }
  let uv = in.position.xy / P.size;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);   // this texel's centre, as the jittered camera drew it
  let prev = presentationReproject(vec4f(ndc, textureLoad(tDepth, p, 0), 1.0));
  if (prev.w <= 0.0) { return o; }   // (behind last frame's camera: no history)
  o.velocity = ndc + P.jitterNdc - prev.xy / prev.w;
  return o;
}
`;

/** The bloom prefilter: the resolved frame's bright part, 2×2 → down[0] (half resolution). */
export const prefilterWGSL = () => /* wgsl */ `
${fullscreenVert('vs')}
${COMMON}
${PrefilterParams.wgsl}
@group(2) @binding(0) var tSrc: texture_2d<f32>;
@group(3) @binding(1) var<uniform> P: PrefilterParams;
@fragment fn fs(in: FullScreen) -> @location(0) vec4f {
  let p = vec2i(in.position.xy) * 2;
  let hi = vec2i(textureDimensions(tSrc)) - 1;
  let s = bright(sanitize(radiance(textureLoad(tSrc, min(p, hi), 0), P.packed)).rgb, P.thresh)
        + bright(sanitize(radiance(textureLoad(tSrc, min(p + vec2i(1, 0), hi), 0), P.packed)).rgb, P.thresh)
        + bright(sanitize(radiance(textureLoad(tSrc, min(p + vec2i(0, 1), hi), 0), P.packed)).rgb, P.thresh)
        + bright(sanitize(radiance(textureLoad(tSrc, min(p + vec2i(1, 1), hi), 0), P.packed)).rgb, P.thresh);
  return vec4f(s * 0.25, 1.0);
}
`;

/** Bloom levels 1–5 down (entry `down`) and 4–1 up (entry `up`), in the post compute pass. */
export const bloomWGSL = () => /* wgsl */ `
${COMMON}
${MipParams.wgsl}
@group(2) @binding(0) var tSrc: texture_2d<f32>;    // down: the finer level; up: the coarser one (low)
@group(2) @binding(1) var tHigh: texture_2d<f32>;   // up: this level's down
@group(2) @binding(2) var smp: sampler;
@group(2) @binding(3) var dst: texture_storage_2d<rgba16float, write>;
@group(3) @binding(1) var<uniform> P: MipParams;
// Jimenez 2014 13-tap downsample: five overlapping 2×2-texel boxes (the inner one
// weighted 1/2, the four corner ones 1/8 each), as per-tap weights.
const DOWN_W_CENTRE: f32 = 0.125;   // centre tap (shared by the four corner boxes)
const DOWN_W_CORNER: f32 = 0.03125; // outer corners (one corner box each)
const DOWN_W_EDGE: f32 = 0.0625;    // outer edge midpoints (two corner boxes each)
const DOWN_W_INNER: f32 = 0.125;    // inner box taps (all bilinear, ±1 texel)
fn tap(uv: vec2f, o: vec2f) -> vec3f { return textureSampleLevel(tSrc, smp, uv + P.texel * o, 0.0).rgb; }

@compute @workgroup_size(${BLOOM_TILE}, ${BLOOM_TILE}) fn down(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= P.dst)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(P.dst);
  var c = tap(uv, vec2f(0.0)) * DOWN_W_CENTRE;
  c += (tap(uv, vec2f(-2.0, 2.0)) + tap(uv, vec2f(2.0, 2.0)) + tap(uv, vec2f(-2.0, -2.0)) + tap(uv, vec2f(2.0, -2.0))) * DOWN_W_CORNER;
  c += (tap(uv, vec2f(0.0, 2.0)) + tap(uv, vec2f(-2.0, 0.0)) + tap(uv, vec2f(2.0, 0.0)) + tap(uv, vec2f(0.0, -2.0))) * DOWN_W_EDGE;
  c += (tap(uv, vec2f(-1.0, 1.0)) + tap(uv, vec2f(1.0, 1.0)) + tap(uv, vec2f(-1.0, -1.0)) + tap(uv, vec2f(1.0, -1.0))) * DOWN_W_INNER;
  textureStore(dst, id.xy, vec4f(c, 1.0));
}

@compute @workgroup_size(${BLOOM_TILE}, ${BLOOM_TILE}) fn up(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= P.dst)) { return; }
  let hiC = textureLoad(tHigh, vec2i(id.xy), 0).rgb;
  let loC = tent9(tSrc, smp, (vec2f(id.xy) + 0.5) / vec2f(P.dst), P.texel);
  textureStore(dst, id.xy, vec4f(mix(hiC, loC, P.scatter), 1.0));
}
`;

/** Bloom's last upsample, into up[0] (half resolution), a render pass: it stays a compressed attachment (W16). */
export const bloomUp0WGSL = () => /* wgsl */ `
${fullscreenVert('vs')}
${COMMON}
${MipParams.wgsl}
@group(2) @binding(0) var tLow: texture_2d<f32>;    // up[1]
@group(2) @binding(1) var tHigh: texture_2d<f32>;   // down[0]
@group(2) @binding(2) var smp: sampler;
@group(3) @binding(1) var<uniform> P: MipParams;
@fragment fn fs(in: FullScreen) -> @location(0) vec4f {
  let hiC = textureLoad(tHigh, vec2i(in.position.xy), 0).rgb;
  let loC = tent9(tLow, smp, in.position.xy / vec2f(P.dst), P.texel);
  return vec4f(mix(hiC, loC, P.scatter), 1.0);
}
`;

/**
 * The bloom pass: up[0] filtered with the 3×3 tent (1-2-1 ⊗ 1-2-1) on its own
 * texel grid, at its size, a render pass (a compressed attachment, W16). The
 * composite samples it once, bilinearly: that equals the tent of bilinear taps
 * it took before (tent9 at ±1 texel), at a ninth of the taps, everywhere but
 * the frame's outermost output pixels (where the clamp to the edge falls
 * differently).
 */
export const bloomTentWGSL = () => /* wgsl */ `
${fullscreenVert('vs')}
@group(2) @binding(0) var tSrc: texture_2d<f32>;    // up[0]
@fragment fn fs(in: FullScreen) -> @location(0) vec4f {
  let p = vec2i(in.position.xy);
  let hi = vec2i(textureDimensions(tSrc)) - 1;
  var acc = vec3f(0.0);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      acc += f32((2 - abs(i)) * (2 - abs(j))) * textureLoad(tSrc, clamp(p + vec2i(i, j), vec2i(0), hi), 0).rgb;
    }
  }
  return vec4f(acc * (1.0 / 16.0), 1.0);
}
`;

/**
 * The frame's reductions in one workgroup: the luminance grid, its histogram,
 * the adaptation update (in place, no ping-pong) and the meter's tile sums.
 */
export const reduceWGSL = () => /* wgsl */ `
${COMMON}
${ReduceParams.wgsl}
struct AdaptState { gain: f32, aim: f32, view: f32, pad: f32, }   // (aim: the gain it moves toward)
@group(2) @binding(0) var tSrc: texture_2d<f32>;   // the resolved frame
@group(2) @binding(1) var smp: sampler;
@group(2) @binding(2) var<storage, read_write> state: AdaptState;
@group(2) @binding(3) var<storage, read_write> ring: array<u32>;   // the result ring (B7): ${RESULT_BYTES / 4} words a slot
@group(3) @binding(1) var<uniform> P: ReduceParams;

const THREADS: u32 = ${REDUCE_THREADS}u;
// eye adaptation (ADAPT in gfx/post.js)
const GRID_W: u32 = ${ADAPT.GRID[0]}u;
const GRID: vec2f = ${vec2(ADAPT.GRID)};
const TAPS: u32 = ${ADAPT.TAPS}u;
const BINS: u32 = ${ADAPT.BINS}u;
const SAMPLES: u32 = ${ADAPT.GRID[0] * ADAPT.GRID[1]}u;
const LOG_MIN: f32 = ${f(ADAPT.LOG_MIN)};
const LOG_MAX: f32 = ${f(ADAPT.LOG_MAX)};
const LOG_FLOOR: f32 = ${f(ADAPT.LOG_MIN - 1)};   // log2 luminance of black (below the histogram)
const LOW_PCT: f32 = ${f(ADAPT.LOW_PCT)};
const HIGH_PCT: f32 = ${f(ADAPT.HIGH_PCT)};
const LOG_DARK: f32 = ${f(ADAPT.LOG_DARK)};
const MAX_EV: f32 = ${f(ADAPT.MAX_EV)};
const TAU_DARK: f32 = ${f(ADAPT.TAU_DARK)};
const TAU_LIGHT: f32 = ${f(ADAPT.TAU_LIGHT)};
const SETTLED: f32 = ${f(ADAPT.SETTLED)};
const EMPTY: f32 = 1e-6;    // total weight under which nothing covers the frame
const FIXED: f32 = ${f(HIST_FIXED)};   // the histogram's fixed point
// the meter: one tile a thread
const METER_SIZE: f32 = ${f(METER_SIZE)};
const METER_TAPS: u32 = ${METER_TAPS}u;
const METER_LOG_FLOOR: f32 = ${f(METER_LOG_FLOOR)};
const METER_COVERED: f32 = ${f(METER_COVERED)};
const NO_SLOT: u32 = ${NO_SLOT}u;

var<workgroup> bins: array<atomic<u32>, ${ADAPT.BINS}>;
var<workgroup> meterS: array<f32, ${REDUCE_THREADS}>;
var<workgroup> meterN: array<f32, ${REDUCE_THREADS}>;

@compute @workgroup_size(${REDUCE_THREADS}) fn main(@builtin(local_invocation_index) li: u32) {
  if (li < BINS) { atomicStore(&bins[li], 0u); }
  workgroupBarrier();

  // 1. the luminance grid: per sample, a patch mean (premultiplied: the covered part's own
  // luminance), its log2 and coverage; each sample is dropped into its bin, weighted by its coverage
  if (P.adapt != 0u && P.reuseTarget == 0u) {
    for (var s = li; s < SAMPLES; s += THREADS) {
      let cell = vec2f(f32(s % GRID_W), f32(s / GRID_W));
      var sum = vec4f(0.0);
      for (var y = 0u; y < TAPS; y++) {
        for (var x = 0u; x < TAPS; x++) {
          let uv = (cell + (vec2f(f32(x), f32(y)) + 0.5) / f32(TAPS)) / GRID;
          sum += sanitize(tapRadiance(tSrc, smp, uv, P.packed));
        }
      }
      sum /= f32(TAPS * TAPS);
      let L = luma(sum.rgb) / max(sum.a, 1e-4);
      var lg = LOG_FLOOR;
      if (L > 0.0) { lg = max(log2(L), LOG_FLOOR); }
      let bin = u32(clamp(floor((lg - LOG_MIN) / (LOG_MAX - LOG_MIN) * f32(BINS)), 0.0, f32(BINS) - 1.0));
      atomicAdd(&bins[bin], u32(sum.a / f32(SAMPLES) * FIXED + 0.5));
    }
  }

  // 2. the meter: Σ log luminance over covered taps, and their count, per tile, then summed
  var ms = 0.0;
  var mc = 0.0;
  if (P.meter != 0u) {
    let tile = vec2f(f32(li % u32(METER_SIZE)), f32(li / u32(METER_SIZE)));
    for (var j = 0u; j < METER_TAPS; j++) {
      for (var i = 0u; i < METER_TAPS; i++) {
        let c = sanitize(tapRadiance(tSrc, smp, (tile + (vec2f(f32(i), f32(j)) + 0.5) / f32(METER_TAPS)) / METER_SIZE, P.packed));
        let w = step(METER_COVERED, c.a);
        ms += w * log(METER_LOG_FLOOR + luma(c.rgb) / max(c.a, 1e-3));
        mc += w;
      }
    }
  }
  meterS[li] = ms;
  meterN[li] = mc;
  workgroupBarrier();
  for (var stride = THREADS / 2u; stride > 0u; stride >>= 1u) {
    if (li < stride) {
      meterS[li] += meterS[li + stride];
      meterN[li] += meterN[li + stride];
    }
    workgroupBarrier();
  }
  if (li != 0u) { return; }

  // 3. the histogram's mean between the percentiles, the gain that brings it up to
  // LOG_DARK, and last frame's gain moved toward it
  var flags = 0u;
  if (P.adapt != 0u) {
    var aim = state.aim;
    var view = state.view;
    if (P.reuseTarget == 0u) {
      var total = 0.0;
      for (var i = 0u; i < BINS; i++) { total += f32(atomicLoad(&bins[i])) / FIXED; }
      let lo = LOW_PCT * total;
      let hi = HIGH_PCT * total;
      var cum = 0.0;
      var wSum = 0.0;
      var lSum = 0.0;
      for (var i = 0u; i < BINS; i++) {
        let w = f32(atomicLoad(&bins[i])) / FIXED;
        let part = max(min(cum + w, hi) - max(cum, lo), 0.0);   // this bin's share inside the band
        lSum += part * (LOG_MIN + (f32(i) + 0.5) / f32(BINS) * (LOG_MAX - LOG_MIN));
        wSum += part;
        cum += w;
      }
      view = LOG_DARK;
      if (wSum > 0.0) { view = lSum / wSum; }
      aim = 1.0;
      if (total > EMPTY) { aim = exp2(clamp(LOG_DARK - view, 0.0, MAX_EV)); }
    }
    var g = state.gain;
    if (!(g > 0.0)) { g = 1.0; }   // the first frame starts adapted to daylight
    var tau = TAU_LIGHT;
    if (aim > g) { tau = TAU_DARK; }
    g += (aim - g) * (1.0 - exp(-P.dt / tau));
    if (abs(g - aim) <= SETTLED * aim) { g = aim; }
    state = AdaptState(g, aim, view, 0.0);
    flags |= 1u;
  }
  if (P.meter != 0u) { flags |= 2u; }
  if (P.slot != NO_SLOT) {
    let o = P.slot * ${RESULT_BYTES / 4}u;
    ring[o] = bitcast<u32>(state.gain);
    ring[o + 1u] = bitcast<u32>(state.aim);
    ring[o + 2u] = bitcast<u32>(state.view);
    ring[o + 3u] = bitcast<u32>(meterS[0]);
    ring[o + 4u] = bitcast<u32>(meterN[0]);
    ring[o + 5u] = flags;
  }
}
`;

/**
 * The composite: sharpen, bloom, exposure × adaptation, AgX (+ Punchy look, hot
 * roll-off), sRGB, night vision, dither; on the canvas (opaque) also the sky
 * behind the scene, the viewmodels over it and the glow added on top. Stills
 * (thumbnails) keep the scene's alpha instead.
 */
export const compositeWGSL = () => /* wgsl */ `
${fullscreenVert('vs')}
${COMMON}
${CompositeParams.wgsl}
struct AdaptState { gain: f32, aim: f32, view: f32, pad: f32, }
@group(2) @binding(0) var tColor: texture_2d<f32>;
@group(2) @binding(1) var tBloom: texture_2d<f32>;
@group(2) @binding(2) var smp: sampler;
@group(2) @binding(3) var<storage, read> adaptation: AdaptState;   // eye adaptation: gain (1 in daylight)
@group(2) @binding(4) var tViewmodel: texture_2d<f32>;   // the held tool: linear premultiplied, output size (F3)
@group(2) @binding(5) var tGlow: texture_2d<f32>;        // its glow layer, display values, added
@group(3) @binding(1) var<uniform> P: CompositeParams;

const SRGB_TO_REC2020: mat3x3f = mat3x3f(
  vec3f(0.6274, 0.0691, 0.0164), vec3f(0.3293, 0.9195, 0.0880), vec3f(0.0433, 0.0113, 0.8956));
const REC2020_TO_SRGB: mat3x3f = mat3x3f(
  vec3f(1.6605, -0.1246, -0.0182), vec3f(-0.5876, 1.1329, -0.1006), vec3f(-0.0728, -0.0083, 1.1187));
const AGX_INSET: mat3x3f = mat3x3f(
  vec3f(0.856627153315983, 0.137318972929847, 0.11189821299995),
  vec3f(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
  vec3f(0.0482516061458583, 0.101439036467562, 0.811302368396859));
const AGX_OUTSET: mat3x3f = mat3x3f(
  vec3f(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
  vec3f(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
  vec3f(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
const AGX_MIN_EV: f32 = -12.47393; // log2(2^-10 · 0.18)
const AGX_MAX_EV: f32 = 4.026069;  // log2(2^6.5 · 0.18)
const AGX_GAMMA: f32 = 2.2;        // display gamma AgX's curve encodes for (decoded after the outset)
const PUNCHY_POWER: f32 = 1.35;    // Blender's AgX "Punchy" look: power on the encoded values…
const PUNCHY_SAT: f32 = 1.4;       // …and saturation around their luma

// AgX base contrast sigmoid: 6th-order polynomial fit (Wrensch 2023, as in three.js).
fn agxContrast(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

// AgX log encoding, sigmoid and look, per channel (encoded display values out).
fn agxCurve(c0: vec3f) -> vec3f {
  var c = clamp((log2(max(c0, vec3f(1e-10))) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), vec3f(0.0), vec3f(1.0));
  c = agxContrast(c);
  c = pow(max(c, vec3f(0.0)), vec3f(mix(1.0, PUNCHY_POWER, P.look)));
  let l = dot(c, LUMA_709);
  return l + mix(1.0, PUNCHY_SAT, P.look) * (c - l);
}

// AgX (Blender / Filament / three.js) with an optional blend toward the "Punchy" look.
fn agx(c0: vec3f) -> vec3f {
  let c = agxCurve(AGX_INSET * (SRGB_TO_REC2020 * c0));
  return clamp(REC2020_TO_SRGB * pow(max(AGX_OUTSET * c, vec3f(0.0)), vec3f(AGX_GAMMA)), vec3f(0.0), vec3f(1.0));
}

// AgX desaturates bright colours on their way to white, so molten lava and
// flames come out pale peach. Film and camera sensors clip the dominant channel
// first instead: bright orange runs through amber and gold to white, the look of
// every photo of lava or fire (and of the eye's own Bezold–Brücke shift). So
// bright, clearly saturated pixels blend toward the same curve applied to each
// Rec.2020 channel alone (AgX's working space; in sRGB primaries the roll-off
// turns lemon yellow). Greys and everything in the sunlit range stay plain AgX:
// for a grey both curves agree exactly. The eye's shift moves bright hues toward
// its invariant ones (yellow, and blue at ~475 nm): warm light toward yellow, as
// the per-channel curve does, but violet toward blue, where that curve would turn
// it magenta. So only warm light (red over blue) takes it; the rest stays plain
// AgX, whose path to white keeps violet violet. (P.hot: blend start, full.)
// (The weight goes with saturation squared: only clearly coloured light.)
const HOT_WARM_EDGE: f32 = 0.2; // (red - blue) / max channel over which the weight fades in
fn tonemap(c: vec3f) -> vec3f {
  let a = agx(c);
  let mx = max(c.r, max(c.g, c.b));
  let sat = 1.0 - min(c.r, min(c.g, c.b)) / max(mx, 1e-6);
  let warm = smoothstep(-HOT_WARM_EDGE, HOT_WARM_EDGE, (c.r - c.b) / max(mx, 1e-6));
  let w = smoothstep(P.hot.x, P.hot.y, mx) * (sat * sat) * warm;
  if (w <= 0.0) { return a; }
  let pc = pow(max(agxCurve(SRGB_TO_REC2020 * c), vec3f(0.0)), vec3f(AGX_GAMMA));
  return mix(a, clamp(REC2020_TO_SRGB * pc, vec3f(0.0), vec3f(1.0)), w);
}

// sRGB transfer function (IEC 61966-2-1); above 1 it continues the curve (the HDR canvas's extended sRGB).
fn srgbEncode(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

// HDR (HDR_OUT in gfx/post.js): Gran Turismo's tone curve (Uchimura 2017) with peak p.
const GT_A: f32 = ${f(HDR_OUT.CONTRAST)};
const GT_M: f32 = ${f(HDR_OUT.LINEAR_START)};
const GT_L: f32 = ${f(HDR_OUT.LINEAR_LENGTH)};
const GT_C: f32 = ${f(HDR_OUT.BLACK)};
const HDR_PAPER: f32 = ${f(HDR_OUT.PAPER)};
fn gtCurve(x: f32, p: f32) -> f32 {
  let l0 = (p - GT_M) * GT_L / GT_A;
  let s0 = GT_M + l0;
  let s1 = GT_M + GT_A * l0;
  let cp = -GT_A * p / (p - s1) / p;
  let w0 = 1.0 - smoothstep(0.0, GT_M, x);
  let w2 = step(s0, x);
  let toe = GT_M * pow(max(x, 0.0) / GT_M, GT_C);
  let lin = GT_M + GT_A * (x - GT_M);
  let shoulder = p - (p - s1) * exp(cp * (x - s0));
  return toe * w0 + lin * (1.0 - w0 - w2) + shoulder * w2;
}
// Where SDR's curve (p = 1) reaches its shoulder: below it both curves are the same toe and linear
// section (neither depends on p), so the gain is exactly 1 and most pixels skip the two curves.
const GT_SHOULDER_SDR: f32 = ${f(HDR_OUT.LINEAR_START + ((1 - HDR_OUT.LINEAR_START) * HDR_OUT.LINEAR_LENGTH) / HDR_OUT.CONTRAST)};
// × on the tone-mapped (linear display) colour of exposed radiance c: 1 in SDR and below the shoulder
fn hdrGain(c: vec3f) -> f32 {
  if (P.peak <= 1.0) { return 1.0; }
  let x = luma(c) / HDR_PAPER;
  if (x < GT_SHOULDER_SDR) { return 1.0; }
  return gtCurve(x, P.peak) / max(gtCurve(x, 1.0), 1e-6);
}
fn display(c: vec3f) -> vec3f {
  // Original normal display: linear tone mapper, no AgX/look or HDR shoulder.
  if (P.cruelty != 0u) { return clamp(c, vec3f(0.0), vec3f(1.0)); }
  return tonemap(c) * hdrGain(c);
}

// The reversible tone map CAS works in, t = c / (1 + luma(c)): t, and its luma in w
// (luma(c) / (1 + luma(c)): one luma and one reciprocal a tap)
fn tmL(c: vec3f) -> vec4f {
  let l = luma(c);
  let r = 1.0 / (1.0 + l);
  return vec4f(c * r, l * r);
}
fn itm(c: vec3f) -> vec3f { return c / max(1.0 - luma(c), 1e-3); }

// AMD CAS: the cross taps get the negative lobe -amp / mix(SOFT, HARD, sharpen).
const CAS_LOBE_SOFT: f32 = 8.0;
const CAS_LOBE_HARD: f32 = 5.0;
// Output dither: interleaved gradient noise (Jimenez 2014), ±½ of one 8-bit step.
const IGN: vec3f = vec3f(0.06711056, 0.00583715, 52.9829189);
const DITHER_LEVELS: f32 = 255.0;  // output code values above 0
const DITHER_BLACK: f32 = 1e-5;    // max channel at or below which a pixel counts as exact black (no dither)
const NV_PHOSPHOR: vec3f = vec3f(${NV_PHOSPHOR.map(f).join(', ')});   // night vision's screen (NV_PHOSPHOR in JS)
const NV_GRAIN: f32 = 0.08;        // grain σ (display units) on a mid-grey picture at NV_GRAIN_GAIN...
const NV_GRAIN_GAIN: f32 = 16.0;   // ...this gain (one stack); σ ∝ √(picture·gain), shot noise
const NV_VIGNETTE: f32 = 0.6;      // darkening at the corners: the tube's round field of view...
const NV_VIGNETTE_START: f32 = 0.45; // ...starting this far out (share of the half-diagonal)
const UNIFORM_SIGMA: f32 = 3.4641016; // √12: a uniform variable in [−½, ½] scaled to σ 1
// PCG hash (Jarzynski & Olano 2020, "Hash Functions for GPU Rendering"): white noise for the grain.
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// u32 → f32 rounded to nearest on every device (H1.28)
fn u32ToF32(s: u32) -> f32 { return f32(s >> 8u) * 256.0 + f32(s & 255u); }
const U32_TO_UNIT: f32 = 1.0 / 4294967296.0;
fn nightVision(rad: vec3f, p: vec2i) -> vec3f {
  var t = tonemap(vec3f(luma(rad) * P.exposure * P.nightGain)).g;   // AgX on a grey: the screen's brightness
  let u = u32ToF32(pcg(u32(p.x) + pcg(u32(p.y) + pcg(P.nightSeed)))) * U32_TO_UNIT - 0.5;
  t += u * UNIFORM_SIGMA * NV_GRAIN * sqrt(max(t, 0.0) * P.nightGain / NV_GRAIN_GAIN);
  let q = (vec2f(p) + 0.5) / P.size - 0.5;
  let r = length(q * vec2f(P.size.x / P.size.y, 1.0)) / length(vec2f(0.5 * P.size.x / P.size.y, 0.5));
  t *= 1.0 - NV_VIGNETTE * smoothstep(NV_VIGNETTE_START, 1.0, r);
  return NV_PHOSPHOR * clamp(t, 0.0, 1.0);
}

// The page's sky (SKY in gfx/post.js, ui/styles.css), sRGB-encoded as CSS blends it:
// the linear gradient, then the warm radial glow over it.
const SKY_MID_AT: f32 = ${f(SKY.MID_AT)};
const SKY_GLOW_CENTRE: vec2f = ${vec2(SKY.GLOW_CENTRE)};
const SKY_GLOW_RADII: vec2f = ${vec2(SKY.GLOW_RADII)};
const SKY_GLOW_END: f32 = ${f(SKY.GLOW_END)};
fn sky(uv: vec2f) -> vec3f {
  var c = mix(P.skyTop, P.skyMid, saturate(uv.y / SKY_MID_AT));
  if (uv.y > SKY_MID_AT) { c = mix(P.skyMid, P.skyLow, saturate((uv.y - SKY_MID_AT) / (1.0 - SKY_MID_AT))); }
  let t = length((uv - SKY_GLOW_CENTRE) / SKY_GLOW_RADII) / SKY_GLOW_END;
  return mix(c, P.skyGlow.rgb, P.skyGlow.a * saturate(1.0 - t));
}

${sprintBlurWGSL()}
${crueltyDisplayWGSL()}
@fragment fn fs(in: FullScreen) -> @location(0) vec4f {
  let p = vec2i(in.position.xy);
  let hi = vec2i(P.size) - 1;
  let uv = (vec2f(p) + 0.5) / P.size;
  var c = sanitize(radiance(textureLoad(tColor, p, 0), P.packed));
  var rad = c.rgb;

  if (P.sharpen > 0.0) {
    // contrast-adaptive sharpening (AMD CAS, cross taps, luma-driven) in tone-mapped space
    let e = tmL(c.rgb);
    let n = tmL(sanitize(radiance(textureLoad(tColor, clamp(p + vec2i(0, 1), vec2i(0), hi), 0), P.packed)).rgb);
    let s = tmL(sanitize(radiance(textureLoad(tColor, clamp(p - vec2i(0, 1), vec2i(0), hi), 0), P.packed)).rgb);
    let w = tmL(sanitize(radiance(textureLoad(tColor, clamp(p - vec2i(1, 0), vec2i(0), hi), 0), P.packed)).rgb);
    let r = tmL(sanitize(radiance(textureLoad(tColor, clamp(p + vec2i(1, 0), vec2i(0), hi), 0), P.packed)).rgb);
    let mnL = min(e.w, min(min(n.w, s.w), min(w.w, r.w)));
    let mxL = max(e.w, max(max(n.w, s.w), max(w.w, r.w)));
    let amp = sqrt(clamp(min(mnL, 1.0 - mxL) / max(mxL, 1e-4), 0.0, 1.0));
    let k = -amp / mix(CAS_LOBE_SOFT, CAS_LOBE_HARD, P.sharpen);
    rad = itm(max((e.rgb + k * (n.rgb + s.rgb + w.rgb + r.rgb)) / (1.0 + 4.0 * k), vec3f(0.0)));
  }

  // Blur world radiance and coverage together, after sharpening, before the unblurred hands/HUD.
  let streak = sprintBlur(uv, c);
  rad += streak.rgb - c.rgb;
  c = streak;
  if (P.bloom > 0.0) {
    // the bloom image is up[0] already tent-filtered (the bloom pass): one bilinear tap
    let b = textureSampleLevel(tBloom, smp, uv, 0.0).rgb;
    rad += P.bloom * (b - bright(c.rgb, P.thresh));
  }

  var gain = 1.0;
  if (P.adapt != 0u && adaptation.gain > 0.0) { gain = adaptation.gain; }
  var o: vec3f;
  if (P.raw != 0u) { o = srgbEncode(clamp(rad, vec3f(0.0), vec3f(1.0))); }
  else { o = srgbEncode(display(max(rad, vec3f(0.0)) * (P.exposure * gain))); }
  if (P.night > 0.0 && P.raw == 0u) { o = mix(o, srgbEncode(nightVision(max(rad, vec3f(0.0)), p)), P.night); }
  // the canvas is opaque: the sky shows through where the scene's coverage is below 1,
  // premultiplied over, as the compositor blended the old transparent canvas over the page
  var a = c.a;
  if (P.opaque != 0u) {
    if (a < 1.0) { o += (1.0 - a) * sky(uv); }   // (covered pixels skip the gradient: it adds 0 there)
    a = 1.0;
  }
  // ±½ LSB dither against 8-bit banding; keep exact zeros exact
  let ign = fract(IGN.z * fract(dot(vec2f(p), IGN.xy)));
  if (P.cruelty == 0u) { o += (ign - 0.5) / DITHER_LEVELS * step(DITHER_BLACK, max(o.r, max(o.g, o.b))); }
  let white = vec3f(P.white);   // SDR white, or the HDR peak
  if (P.cruelty == 0u) { o = clamp(o, vec3f(0.0), white); }

  // The held tool (pov/viewmodel.js): straight colour → the same tone map at the
  // exposure, without the adaptation gain → sRGB, premultiplied over. Tone mapping is
  // nonlinear, so it runs on straight colour: on premultiplied colour every partly
  // covered edge pixel would brighten into a pale outline. Transparent texels add 0.
  if (P.viewmodel != 0u) {
    let v = textureSampleLevel(tViewmodel, smp, uv, 0.0);
    if (v.a > 0.0) {
      let va = min(v.a, 1.0);
      var sc = v.rgb / v.a;
      sc = mix(sc, NV_PHOSPHOR * luma(sc), P.vmNight);   // the tool seen through the goggles too
      var e2: vec3f;
      if (P.raw != 0u) { e2 = srgbEncode(clamp(sc, vec3f(0.0), vec3f(1.0))); }
      else { e2 = srgbEncode(display(max(sc, vec3f(0.0)) * P.exposure)); }
      o = e2 * va + o * (1.0 - va);
    }
  }
  // the hands' light, added over it all (its materials tone map themselves)
  if (P.glow != 0u) {
    o += textureSampleLevel(tGlow, smp, uv, 0.0).rgb;
    if (P.cruelty == 0u) { o = clamp(o, vec3f(0.0), white); }
  }
  // Source canvas treatment sees the complete picture, including sky/hands/glow,
  // not the HTML HUD. Quantize display RGB, then source noise, then final clamp.
  if (P.cruelty != 0u) { o = clamp(crueltyDisplay(o, uv, P.crueltyTime), vec3f(0.0), white); }
  return vec4f(o, a);
}
`;

// ---------------------------------------------------------------- pipelines (tools/check-wgsl.mjs, B5's warm-up)

// Post's pipelines as plain data. check-wgsl and the start menu's warm-up (B5)
// read WGSL_CHECK, and createPost builds each of its pipelines from the same
// entry (postPipe), so the two can't describe different pipelines. The
// pipeline cache keys on the module, the layout objects and the descriptor: a
// warm-up hits createPost's entries only with the layouts made under their
// names, gpu.layout(e.layoutNames[i], e.layouts()[i]) (POST_MOTION, POST_PAIR,
// POST_MIP, POST_REDUCE, POST_COMPOSITE), and the descriptor fields as given.
const groupsOf = (layout) => () => [undefined, undefined, POST_LAYOUTS[layout]];
const namesOf = (layout) => [undefined, undefined, `POST_${layout}`];
const renderEntry = (name, code, layout, params, entry = 'fs', format = HDR, formats = [format]) => ({
  name, kind: 'render', grids: false, code, layouts: groupsOf(layout), layoutNames: namesOf(layout), params,
  fragment: { entry, targets: formats.map((f) => ({ format: f })) },
});
// the motion pass's targets: TAAU's velocity and colour (gpu/three.js createTemporalUpscaler)
const MOTION_FORMATS = ['rg16float', HDR];
const computeEntry = (name, code, layout, params, extra) => ({
  name, kind: 'compute', grids: false, code, layouts: groupsOf(layout), layoutNames: namesOf(layout), params, ...extra,
});
// the composite into one output format: the canvas's (navigator.gpu.getPreferredCanvasFormat()) or a still's
const compositeEntry = (format) => renderEntry(`composite ${format}`, compositeWGSL, 'COMPOSITE', CompositeParams, 'fs', format);

/** The pipelines post builds (docs/webgpu.md I1, B5: the start menu warms the same list). */
export const WGSL_CHECK = [
  renderEntry('motion', motionWGSL, 'MOTION', MotionParams, 'fs', HDR, MOTION_FORMATS),
  renderEntry('prefilter', prefilterWGSL, 'PAIR', PrefilterParams),
  renderEntry('bloomUp0', bloomUp0WGSL, 'PAIR', MipParams),
  renderEntry('bloomTent', bloomTentWGSL, 'PAIR', null),
  computeEntry('bloomDown', bloomWGSL, 'MIP', MipParams, { entry: 'down', workgroupSize: [BLOOM_TILE, BLOOM_TILE, 1] }),
  computeEntry('bloomUp', bloomWGSL, 'MIP', MipParams, { entry: 'up', workgroupSize: [BLOOM_TILE, BLOOM_TILE, 1] }),
  computeEntry('postReduce', reduceWGSL, 'REDUCE', ReduceParams, { workgroupSize: [REDUCE_THREADS, 1, 1], dispatch: () => [1, 1, 1] }),
  compositeEntry('bgra8unorm'),
  compositeEntry('rgba8unorm'),
  compositeEntry('rgba16float'),   // the HDR canvas (gpu/present.js)
];
const PIPES = Object.fromEntries(WGSL_CHECK.map((e) => [e.name, e]));

// One of post's pipelines on `gpu`, built from its WGSL_CHECK entry.
function postPipe(gpu, e) {
  const groups = e.layouts();
  const layouts = e.layoutNames.map((name, i) => (name ? gpu.layout(name, groups[i]) : undefined));
  const desc = { name: e.name, code: e.code(), layouts, params: e.params };
  if (e.kind === 'render') return gpu.renderPipeline({ ...desc, fragment: e.fragment });
  return gpu.kernel({ ...desc, entry: e.entry, workgroupSize: e.workgroupSize });
}

// ---------------------------------------------------------------- JS helpers

/**
 * The sizes post works at: output `size` (canvas or target), the scene's
 * `inSize` (× the render scale, upscaled below 1) and the bloom levels (down[i],
 * and up[i] for i < MIPS - 1), each max(1, size >> (i + 1)).
 * @param {number} w
 * @param {number} h
 * @param {number} [scale]
 */
export function postSizes(w, h, scale = 1) {
  w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.floor(h));
  const iw = Math.max(1, Math.round(w * scale)), ih = Math.max(1, Math.round(h * scale));
  const mips = Array.from({ length: MIPS }, (_, i) => [Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1))]);
  return { size: [w, h], inSize: [iw, ih], mips };
}

// The composite's srgbEncode, for a value it would compute the same way in every pixel.
const srgbEncode = (x) => (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055);

// A CSS colour ('#rgb', '#rrggbb', 'rgb(r, g, b)') as sRGB-encoded 0..1, or null.
function cssColour(text) {
  const t = String(text ?? '').trim();
  let m = /^#([0-9a-f]{6})$/i.exec(t);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  m = /^#([0-9a-f]{3})$/i.exec(t);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16) / 255);
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(t);
  if (m) return [m[1], m[2], m[3]].map((x) => Number(x) / 255);
  return null;
}

/**
 * The sky's colours (SKY), sRGB-encoded 0..1: --sky-top and --sky-low from the
 * page's computed style when there is a page, read once at createPost.
 * @returns {{ top: number[], mid: number[], low: number[], glow: number[] }}
 */
export function skyColours() {
  let style = null;
  try { style = globalThis.document ? getComputedStyle(document.documentElement) : null; } catch { style = null; }
  const css = (name) => (style ? cssColour(style.getPropertyValue(name)) : null);
  return {
    top: css('--sky-top') ?? cssColour(SKY.top),
    mid: cssColour(SKY.mid),
    low: css('--sky-low') ?? cssColour(SKY.low),
    glow: [SKY.glow[0] / 255, SKY.glow[1] / 255, SKY.glow[2] / 255, SKY.glow[3]],
  };
}

// The scene target: three's RenderTarget when three draws meshes on this gpu (it
// can render only into its own targets; F3), else two textures of ours. Its
// colour is rgba16float, its depth depth32float (F1).
function createSceneTarget(gpu, label) {
  let three;   // (decided at the first resize: make post after three's renderer)
  let rt = null, color = null, depth = null, packedOpaque = null, width = 0, height = 0, version = 0;
  const target = {
    label,
    /** three's RenderTarget (meshes render into it with loadOp load), or null */
    get rt() { return rt; },
    /** @returns {GPUTexture} */
    get color() { return color; },
    /** @returns {GPUTexture} */
    get depth() { return depth; },
    // Allocated only by WORLD. Staged targets are bounded and leased until
    // every scene/final consumer finishes, including discarded submissions.
    get packedOpaque() {
      if(!color)throw new Error('size scene target before opaque capture');
      return packedOpaque??=gpu.createTexture({label:`${label} packed opaque`,size:[width,height],
        format:'rgba32uint',usage:TEX.STORAGE_BINDING|TEX.TEXTURE_BINDING|TEX.COPY_SRC});
    },
    get width() { return width; },
    get height() { return height; },
    /** changes whenever the GPUTextures do */
    get version() { return version; },
    /** Sizes it (new GPUTextures on a change only); true when they changed. */
    resize(w, h) {
      if (w === width && h === height && color) return false;
      if (three === undefined) three = gpu.three?.renderer ?? null;
      // the old textures go now (ours and three's alike): commands recorded
      // with them must be submitted first, or the submit fails validation
      if (color) gpu.flush('post resize');
      packedOpaque?.destroy();packedOpaque=null;
      if (three) {
        if (!rt) {
          rt = new RenderTarget(w, h, {
            type: HalfFloatType, depthBuffer: true, stencilBuffer: false, generateMipmaps: false,
            minFilter: NearestFilter, magFilter: NearestFilter, depthTexture: new DepthTexture(w, h, FloatType),
          });
          rt.texture.name = `${label} colour`;
          rt.depthTexture.name = `${label} depth`;
        } else rt.setSize(w, h);
        initRenderTarget(three, rt);
        color = gpuTextureOf(three, rt.texture);
        depth = gpuTextureOf(three, rt.depthTexture);
      } else {
        color?.destroy();
        depth?.destroy();
        const usage = TEX.RENDER_ATTACHMENT | TEX.TEXTURE_BINDING | TEX.COPY_SRC;
        color = gpu.createTexture({ label: `${label} colour`, size: [w, h], format: HDR, usage });
        depth = gpu.createTexture({ label: `${label} depth`, size: [w, h], format: 'depth32float', usage });
      }
      width = w; height = h; version++;
      return true;
    },
    // three recreates its GPUTextures on a samples change and after dispose
    // (B10): fetch them again, true when they changed
    refresh() {
      if (!three || !rt) return false;
      const c = gpuTextureOf(three, rt.texture), d = gpuTextureOf(three, rt.depthTexture);
      if (c === color && d === depth) return false;
      color = c; depth = d; version++;
      return true;
    },
    // bytes three holds for it (gpu.memory() counts ours)
    get threeBytes() { return rt ? width * height * (8 + 4) : 0; },
    destroy() {
      if (color) gpu.flush('post dispose');
      if (rt) { rt.depthTexture?.dispose(); rt.dispose(); } else { color?.destroy(); depth?.destroy(); }
      packedOpaque?.destroy();packedOpaque=null;
      rt = color = depth = null; width = height = 0;
    },
  };
  return target;
}

/**
 * @param {object} gpu the gpu from createGpu (src/gpu/device.js)
 * @param {{ presenter?: object, pixScale?: { value: number }, sky?: object, readable?: boolean, temporal?: object | null }} [opts]
 *   presenter: the canvas's (src/gpu/present.js), for render(…, null) and screenshots;
 *   pixScale: set to an output pixel's size in rendered pixels before each scene
 *   (the shaders' LOD bias, FrameUniforms.pixScale); sky: skyColours() to use;
 *   readable: tests only, the bloom levels get COPY_SRC so a tool can read them;
 *   temporal: the temporal upscaler (gpu/three.js createTemporalUpscaler's
 *   interface; tests pass a stand-in), by default three's TAAU when the gpu has
 *   three's renderer (made at the first frame: make post after three's renderer)
 * @returns post-processing pipeline; see the file header.
 */
export function createPost(gpu, { presenter = null, pixScale = null, sky = skyColours(), readable = false, presentation = null, temporal, maxPendingScenes = 3 } = {}) {
  if (!Number.isInteger(maxPendingScenes) || maxPendingScenes < 1 || maxPendingScenes > 8) throw new RangeError('post pending scene limit must be 1..8');
  const L = Object.fromEntries(Object.entries(POST_LAYOUTS).map(([k, entries]) => [k, gpu.layout(`POST_${k}`, entries)]));
  const pipes = {
    motion: postPipe(gpu, PIPES.motion),
    prefilter: postPipe(gpu, PIPES.prefilter),
    up0: postPipe(gpu, PIPES.bloomUp0),
    tent: postPipe(gpu, PIPES.bloomTent),
    down: postPipe(gpu, PIPES.bloomDown),
    up: postPipe(gpu, PIPES.bloomUp),
    reduce: postPipe(gpu, PIPES.postReduce),
  };
  const composites = new Map();
  const compositeFor = (format) => {
    let p = composites.get(format);
    if (!p) composites.set(format, p = postPipe(gpu, compositeEntry(format)));
    return p;
  };
  if (presenter) compositeFor(presenter.format);
  compositeFor('rgba8unorm');   // stills and thumbnails (F5)
  const allPipes = () => [...Object.values(pipes), ...composites.values()];

  const sampler = gpu.device.createSampler({ label: 'post linear', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  // eye adaptation's state (gain, target, view), updated in place by the reduce kernel
  const adaptState = gpu.createBuffer({ label: 'post adaptation', size: 16, usage: BUF.STORAGE | BUF.COPY_SRC | BUF.COPY_DST });
  const results = gpu.readback.ring('post', RESULT_BYTES, RESULT_SLOTS);
  // bound where a viewmodel, glow or bloom texture is absent
  const blank = gpu.createTexture({ label: 'post blank', size: [1, 1], format: HDR, usage: TEX.TEXTURE_BINDING });

  const main = createSceneTarget(gpu, 'scene');
  const still = createSceneTarget(gpu, 'still');
  let active = main;
  let size = [0, 0], inSize = [0, 0];
  let down = [], up = [], bloomImage = null, resolved = null;
  let historyValid = false, frame = 0, lastTaa = null, prevCamera = null;
  let crueltyTime = 0; // render dt clock: dt=0 freezes noise; stills don't advance it
  let jitter = [0, 0], taaNow = false;
  // the cameras' view-projections: last frame's and this frame's unjittered, this frame's jittered (as the scene drew)
  const prevVP = new Matrix4(), curVP = new Matrix4(), jitVP = new Matrix4(), invVP = new Matrix4(), reproj = new Matrix4();
  // the rolling log's (gfx/presentation.js) for the motion pass: the last frame's parameters and world cells → clip
  const prevWorldToClip = new Matrix4();
  let prevWarp = IDENTITY;
  const prevPos = new Vector3(), prevQuat = new Quaternion();
  // the jittered camera's own projection and the jittered one (withoutJitter swaps them)
  const savedProj = new Matrix4(), savedProjInv = new Matrix4(), jitProj = new Matrix4(), jitProjInv = new Matrix4();
  let jittered = null, unjitteredNow = false;
  // three's TAAU (gpu/three.js), made at the first frame (three's renderer is on the gpu by then)
  const temporalOf = () => {
    if (temporal === undefined) temporal = gpu.three?.renderer ? createTemporalUpscaler(gpu) : null;
    return temporal;
  };
  // adaptation and the meter, read back 1–3 frames late, one read at a time
  let reading = false, adaptSeen = null, adaptOn = false, meterAt = 0;
  // References only: no copied scene, and never the mesh-motion cache. These
  // images belong to the last complete finish(), until any full scene starts.
  let keptPost = null;
  // Staged scenes have no access to committed temporal state while recording.
  const stagedTargets = [], sceneTickets = new WeakMap(), pendingScenes = new Set(), liveScenes = new Set();
  let stageContext = null, sceneIdentity = null, sceneGeneration = 0, sceneSequence = 0, admittedSequence = 0;
  let admitting = false, disposed = false, stageCameraKey = null, lastImage = null, stageBlit = null;
  let pendingSceneSubmission = null;
  const imageStamp = (camera, s) => {
    camera.updateMatrixWorld();
    // Composite-only controls don't change radiance, bloom or the histogram.
    // The app still settles full frames on settings changes through its view key.
    // cruelty stays in imageSettings: a mode flip must never reuse old images.
    const { exposure, sharpen, look, hotStart, hotFull, nightGain, sprintBlur, ...imageSettings } = s;
    return JSON.stringify([imageSettings, camera.matrixWorld.elements, camera.projectionMatrix.elements,
      presenter?.canvas.width, presenter?.canvas.height, presenter?.format, presenter?.hdrActive,
      presentation?.key, main.version, size, inSize, post.renderScale]);
  };

  // views and bind groups, made once per texture (per resize: B6) and reused
  const views = new WeakMap();
  const viewOf = (t) => { let v = views.get(t); if (!v) views.set(t, v = t.createView({ label: t.label })); return v; };
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (o) => { let id = ids.get(o); if (!id) ids.set(o, id = nextId++); return id; };
  let groups = new Map();
  const group = (layout, textures, entries) => {
    const key = `${layout.label}|${textures.map(idOf).join(',')}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = gpu.bindGroup(layout, entries(), key));
    return g;
  };
  const texEntry = (binding, t) => ({ binding, resource: viewOf(t) });
  const samplerEntry = (binding) => ({ binding, resource: sampler });

  const make = (label, [w, h], usage) => gpu.createTexture({ label, size: [w, h], format: HDR, usage });
  // (F7: attachments are RENDER_ATTACHMENT | TEXTURE_BINDING only, so they stay compressible; TAAU's targets are three's)
  const COPY = readable ? TEX.COPY_SRC : 0;
  const ATTACH = TEX.RENDER_ATTACHMENT | TEX.TEXTURE_BINDING | COPY;
  const STORE = TEX.STORAGE_BINDING | TEX.TEXTURE_BINDING | COPY;

  const settingsOf = () => crueltyFrameSettings({ ...POST_DEFAULTS, ...post.settings });
  const ready = Promise.all(allPipes().map((p) => p.ready)).then(() => post);
  ready.catch(() => {});

  // a render pass of ours that overwrites every pixel of `view` with one draw
  const drawPass = (pipe, view, name, bind, params) => {
    const rp = gpu.frame.render({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: CLEAR }] }, name);
    pipe.draw(rp, { bind: [, , bind], params });
    rp.end();
  };
  const sizeOf = (t) => [t.width, t.height];
  const texel = (t) => [1 / t.width, 1 / t.height];

  const post = {
    settings: { ...POST_DEFAULTS },
    /** Log-average scene luminance (linear, before exposure) while settings.meter is on; null before the first reading or with no scene in view. */
    sceneLuma: null,
    /** Optional profiling hook: onPass(name, { kind }) after the scene, 'taa', 'bloom' and 'composite'. */
    onPass: null,
    /** Optional: called when an adaptation or meter reading lands (a sleeping frame loop may want to wake). */
    onRead: null,
    /** Resolves when every pipeline post draws with is built (B5: boot awaits it). */
    ready,
    /** Every pipeline is built. */
    get isReady() { return allPipes().every((p) => p.state === 'ready'); },
    /** Output size [w, h] (canvas or target). */
    get size() { return [...size]; },
    /** The scene's size [w, h]: the output size × the render scale (the still's size during renderStill). */
    get inSize() { return stageContext ? [...stageContext.inSize] : active === still ? [still.width, still.height] : [...inSize]; },
    /** This frame's jitter, scene pixels, y down: texel m sampled the view at m + ½ + jitter (three's TAAU's; FrameUniforms.jitter, F4); none during renderStill. */
    get jitter() { return stageContext ? [...stageContext.jitter] : active === still ? [0, 0] : [...jitter]; },
    /** The target the scene is drawn into now ({ rt, color, depth, width, height }): the main one, or the still's during renderStill. */
    get sceneTarget() { return active; },
    /**
     * Between beginScene and endScene, the jittered camera's projection
     * without the jitter, { projectionMatrix, projectionMatrixInverse }; null otherwise.
     */
    get unjittered() { return stageContext ? stageContext.unjittered : jittered ? { projectionMatrix: savedProj, projectionMatrixInverse: savedProjInv } : null; },
    /** Every texture post holds, for memory estimates (gpu.memory() counts ours; threeBytes is three's share). */
    get allTargets() { return [main.color,main.depth,still.color,still.depth,...down,...up,bloomImage,
      ...stagedTargets.flatMap(s=>[s.target.color,s.target.depth]),...[...liveScenes].flatMap(t=>t.copies),lastImage?.texture].filter(Boolean); },
    /** Bytes of the scene targets three holds (not in gpu.memory()). */
    get threeBytes() { return main.threeBytes + still.threeBytes + stagedTargets.reduce((n,s)=>n+s.target.threeBytes,0); },
    /** Eyes still adjusting (the view should keep rendering until they settle). */
    get adapting() { return adaptOn && !!adaptSeen && adaptSeen.gain !== adaptSeen.target; },
    /** Last gain read back: { gain, target, view (log2 luminance) }, or null. */
    get adaptation() { return adaptSeen; },
    /** A reading is in flight (deep idle waits for it, F7). */
    get reading() { return reading; },
    /** Current-frame weight TAA settles with (three's TAAUNode.currentFrameWeight: how long the view needs to converge). */
    get settleWeight() { return temporalOf()?.currentWeight ?? 1; },
    /**
     * Render scale per axis the next render uses, of the output's pixels: the
     * preset's (UPSCALE); while adaptive (under an upscaling preset) × the
     * automatic resolutionScale, not below the floor (UPSCALE_FLOOR). Native
     * stays native. 1 without TAA.
     */
    get renderScale() {
      const s = settingsOf();
      if (!s.taa || !temporalOf()) return 1;
      if (!(s.adaptive ?? s.upscale < 1)) return Math.min(1, s.upscale);
      return Math.max(s.floor ?? UPSCALE_FLOOR, s.upscale * Math.min(1, Math.max(AUTO_RES.MIN, s.resolutionScale)));
    },
    /**
     * GPUTextures: { scene, depth, resolved (TAA's output, in taaCompress's range, or the scene without TAA), bloom (the
     * composite's: up[0] tent-filtered), down, up } (width and height on each).
     */
    get targets() { return { scene: main.color, depth: main.depth, resolved: resolved ?? main.color, bloom: bloomImage, down, up }; },

    /**
     * Output size in pixels (defaults to the presenter's canvas); the scene
     * renders at `scale` of it per axis. Allocates on a change only.
     */
    setSize(w, h, scale = 1) {
      if (stageContext) throw new Error('cannot resize post from a staged scene hook');
      if (w === undefined) {
        const canvas = presenter?.canvas;
        if (!canvas) throw new Error('post.setSize: no size and no presenter canvas');
        w = canvas.width; h = canvas.height;
      }
      const z = postSizes(w, h, scale);
      if (z.size[0] === size[0] && z.size[1] === size[1] && z.inSize[0] === inSize[0] && z.inSize[1] === inSize[1] && main.color) return;
      keptPost = null;
      const outChanged = z.size[0] !== size[0] || z.size[1] !== size[1] || !down.length;
      size = z.size; inSize = z.inSize;
      main.resize(inSize[0], inSize[1]);
      if (outChanged) {
        if (down.length) gpu.flush('post resize');   // (as the scene target's resize)
        const retired = [...down,...up,bloomImage];
        const uses = [...liveScenes].flatMap(t=>t.uses);
        if (uses.length) Promise.allSettled(uses).then(()=>retired.forEach(t=>t?.destroy()));
        else retired.forEach(t=>t?.destroy());
        down = z.mips.map((m, i) => make(`post down ${i}`, m, i === 0 ? ATTACH : STORE));
        up = z.mips.slice(0, MIPS - 1).map((m, i) => make(`post up ${i}`, m, i === 0 ? ATTACH : STORE));
        bloomImage = make('post bloom', z.mips[0], ATTACH);
        // (TAAU restarts its history at a new output size itself; a new scene size keeps it:
        // the history is at output size, so automatic resolution's steps don't flash)
        post.reset();
      }
      groups = new Map();
    },

    /** Drop the TAA history (call after scene swaps, teleports, etc.): the next frame takes the current view alone. */
    reset() {
      if (stageContext) throw new Error('cannot reset post from a staged scene hook');
      historyValid = false; keptPost = null;
      if (!admitting) {sceneGeneration++;for (const t of [...pendingScenes]) retireScene(t, 'discarded');}
    },

    /** Prewarm before opening native passes. BOX render() remains unchanged. */
    get sceneReady() {
      if (presenter) stageBlit ??= createBlit(gpu, presenter.format);
      return Promise.all([...allPipes().map(p=>p.ready), ...(stageBlit ? [stageBlit.ready] : [])]);
    },
    setSceneIdentity(identity) {
      if (stageContext) throw new Error('cannot change scene identity from a staged scene hook');
      if (disposed) throw new Error('post disposed');
      checkIdentity(identity);
      if (!sameIdentity(identity, sceneIdentity)) {
        sceneIdentity = Object.freeze({ ...identity });post.reset();
        if (lastImage) {retireImage(lastImage);lastImage = null;}
      }
    },
    /** Synchronous native scene recording only. Ownership/submission protocol:
     * see docs/world-scene-admission.md. null means no resources were acquired. */
    recordScene(scene, camera, options = {}) { return recordStagedScene(scene, camera, options); },
    recordStill(scene, camera, target, options = {}) {
      return recordStagedScene(scene, camera, { ...options, target, still: true });
    },
    commitScene(ticket, options = {}) { return commitStagedScene(ticket, options); },
    commitStill(ticket, options = {}) {
      const t = sceneTickets.get(ticket);if (!t?.still) throw new Error('post still ticket required');
      return commitStagedScene(ticket, options);
    },
    discardScene(ticket) {
      const t = sceneTickets.get(ticket);if (!t) throw new Error('foreign post scene ticket');
      if (t.status !== 'recorded') return false;
      retireScene(t, 'discarded');return true;
    },
    /** Re-present the exact last admitted composite: no TAA/adaptation/time step. */
    presentLast({ submission } = {}) {
      if (stageContext || jittered) throw new Error('cannot present during scene recording');
      if (disposed) throw new Error('post disposed');
      if (!lastImage || !presenter || lastImage.width !== presenter.canvas.width || lastImage.height !== presenter.canvas.height) return false;
      const use = sceneFence(submission);lastImage.uses.push(use);
      blitLast(lastImage);return true;
    },

    /**
     * A presented frame's start (render() calls it; the split methods are for
     * callers that need the parts apart): sizes the targets for the output
     * (`target` or the canvas), jitters `camera.projectionMatrix` in place
     * (F4), sets pixScale. Then write FrameUniforms once from the jittered
     * camera, record E1's commands that read it, the scene pass into
     * post.sceneTarget (sceneDescriptor()) and three's meshes, and call
     * endScene, then finish.
     * @param {object} camera a three camera in WebGPU's coordinate system
     * @param {{ target?: { width: number, height: number } | null }} [opts]
     */
    beginScene(camera, { target = null } = {}) {
      if (stageContext) throw new Error('cannot begin immediate scene from a staged scene hook');
      keptPost = null;
      if (jittered) restore(jittered);   // (a scene left unended: don't jitter twice)
      const s = settingsOf();
      const scale = post.renderScale;
      if (target) post.setSize(target.width, target.height, scale); else post.setSize(undefined, undefined, scale);
      if (main.refresh()) groups = new Map();
      active = main;

      camera.updateMatrixWorld();
      taaNow = !!(s.taa && temporalOf());
      if (taaNow !== lastTaa || camera !== prevCamera || cameraJumped(camera)) post.reset();
      lastTaa = taaNow;
      prevCamera = camera;
      prevPos.setFromMatrixPosition(camera.matrixWorld);
      prevQuat.setFromRotationMatrix(camera.matrixWorld);

      // the one jitter: three's TAAU's own (Halton(2, 3) over its 32 offsets, in scene
      // pixels), a view offset on the camera until endScene (gpu/three.js). The node
      // projects from the camera's parameters (updateProjectionMatrix), so its own
      // projection, unjittered, is that too.
      if (taaNow) camera.updateProjectionMatrix();
      savedProj.copy(camera.projectionMatrix);
      savedProjInv.copy(camera.projectionMatrixInverse);
      curVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      jittered = camera;
      jitter = taaNow ? temporal.jitter(camera, inSize[0], inSize[1]) : [0, 0];
      jitProj.copy(camera.projectionMatrix);
      jitProjInv.copy(camera.projectionMatrixInverse);
      jitVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      if (pixScale) pixScale.value = inSize[0] / size[0];
    },

    /**
     * Runs `fn` with the jittered camera's projection back without the jitter,
     * then jitters it again, and returns what fn returns: for JS between
     * beginScene and endScene (render's prepare and compute) that casts rays
     * from the camera or projects with it (hover, pickRay, labels). Outside a
     * scene it just runs fn.
     * @template T
     * @param {() => T} fn
     * @returns {T}
     */
    withoutJitter(fn) {
      if (stageContext) {
        const c = stageContext, camera = c.liveCamera;
        const p = camera.projectionMatrix.clone(), pi = camera.projectionMatrixInverse.clone();
        camera.projectionMatrix.copy(c.unjittered.projectionMatrix);camera.projectionMatrixInverse.copy(c.unjittered.projectionMatrixInverse);
        try {return fn();} finally {camera.projectionMatrix.copy(p);camera.projectionMatrixInverse.copy(pi);}
      }
      const camera = jittered;
      if (!camera || unjitteredNow) return fn();
      unjitteredNow = true;
      camera.projectionMatrix.copy(savedProj);
      camera.projectionMatrixInverse.copy(savedProjInv);
      try {
        return fn();
      } finally {
        camera.projectionMatrix.copy(jitProj);
        camera.projectionMatrixInverse.copy(jitProjInv);
        unjitteredNow = false;
      }
    },

    /**
     * The scene pass's descriptor: post.sceneTarget's colour cleared to 0 and
     * depth to 1, both stored (TAA reads the depth); with load, both loaded
     * instead (three's opaque meshes are in them: the `opaque` hook, S1).
     * @param {{ load?: boolean }} [opts]
     * @returns {GPURenderPassDescriptor}
     */
    sceneDescriptor({ load = false } = {}) {
      return {
        colorAttachments: [{ view: viewOf(active.color), loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: CLEAR }],
        depthStencilAttachment: {
          view: viewOf(active.depth), depthClearValue: 1, depthLoadOp: load ? 'load' : 'clear', depthStoreOp: 'store',
        },
      };
    },

    /**
     * E2's overlay pass's descriptor (the rays sprites): colour loaded, depth read-only.
     * @returns {GPURenderPassDescriptor}
     */
    overlayDescriptor() {
      return {
        colorAttachments: [{ view: viewOf(active.color), loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: { view: viewOf(active.depth), depthReadOnly: true },
      };
    },

    /**
     * The scene's end (after the meshes and the overlay): the camera's
     * projection without the jitter again, then onPass('scene').
     */
    endScene(camera = jittered) {
      if (!camera || camera !== jittered) return;
      restore(camera);
      post.onPass?.('scene', { kind: 'render' });
    },

    /**
     * E2: TAA, bloom, adaptation and the composite into `target` (null: the
     * canvas, through the presenter). Call after beginScene, the scene pass
     * and endScene.
     * @param {{ target?: object | null, dt?: number, viewmodel?: GPUTexture | null, glow?: GPUTexture | null }} [opts]
     *   target: a GPUTexture or { view, width, height, format }; viewmodel, glow:
     *   the held tool's resolved target and its glow layer (F3), canvas only
     */
    finish({ target = null, dt = ADAPT.DT, viewmodel = null, glow = null, postOnly = false,
      sceneTarget = main, frameSettings = null, framePresentation = presentation, frameSky = sky, output = null } = {}) {
      if (stageContext) throw new Error('cannot finish post from a staged scene hook');
      if (!postOnly) keptPost = null;
      const s = frameSettings ?? settingsOf();
      const f = gpu.frame;
      const scene = sceneTarget.color, depth = sceneTarget.depth;

      // three's TAAU: the motion pass writes its inputs at the scene's size (velocity,
      // the colour sanitized), then the node resolves to output size (gpu/three.js:
      // its own submits, after a flush of this encoder)
      let color = postOnly ? keptPost.color : scene, packed = postOnly && keptPost.packed;
      if (!postOnly) {
        resolved = null;
        if (taaNow) {
          const inputs = temporal.inputs(inSize[0], inSize[1]);
          invVP.copy(jitVP).invert();
          const warp = framePresentation?.active ? framePresentation.parameters : IDENTITY;
          // (bent, this frame or the last: this frame's clip → displayed world cells, prevWorldToClip the rest)
          if (warp.k !== 0 || prevWarp.k !== 0) reproj.multiplyMatrices(framePresentation.sceneToWorld, invVP);
          else reproj.multiplyMatrices(prevVP, invVP);
          const bind = group(L.MOTION, [scene, depth], () => [texEntry(0, scene), texEntry(1, depth)]);
          const attach = (t) => ({ view: viewOf(t), loadOp: 'clear', storeOp: 'store', clearValue: CLEAR });
          const rp = f.render({ colorAttachments: [attach(inputs.velocity), attach(inputs.color)] }, 'motion');
          pipes.motion.draw(rp, {
            bind: [, , bind],
            params: {
              reproj, jitterNdc: [(2 * jitter[0]) / inSize[0], (-2 * jitter[1]) / inSize[1]], size: inSize, historyValid,
              warpK: warp.k, warpAnchor: warp.anchor, warpDir: warp.dir,
              prevK: prevWarp.k, prevAnchor: prevWarp.anchor, prevDir: prevWarp.dir, prevWorldToClip,
            },
          });
          rp.end();
          // (still in taaCompress's range: its readers expand it per texel, radiance())
          color = resolved = temporal.resolve(prevCamera, sceneTarget.rt?.depthTexture, size);
          packed = true;
          post.onPass?.('taa', { kind: 'render' });
          historyValid = true;
        }
        prevVP.copy(curVP);
        if (framePresentation) {
          // (the next frame's "last": this camera, this frame's parameters)
          prevWorldToClip.multiplyMatrices(curVP, framePresentation.worldToScene);
          prevWarp = framePresentation.active ? framePresentation.parameters : IDENTITY;
        }
      }
      frame++;
      if (Number.isFinite(dt) && dt > 0) crueltyTime += dt;

      adaptOn = s.adapt && !s.raw;   // (the data views and the plain view keep their exact colours)
      const bloomOn = s.bloom > 0 && !s.raw;
      const meterNow = s.meter && !s.raw && !reading && frame >= meterAt;
      const thresh = [s.bloomThreshold, Math.max(s.bloomKnee, 1e-3)];

      // bloom's prefilter, at half resolution
      if (bloomOn && !postOnly) drawPass(pipes.prefilter, viewOf(down[0]), 'prefilter', group(L.PAIR, [color, color], () => [texEntry(0, color), texEntry(1, color), samplerEntry(2)]), { thresh, packed });

      // one compute pass: bloom down 1–5, up 4–1, then the reductions
      if ((!postOnly && bloomOn) || adaptOn || meterNow) {
        // (named for the profiler; in its split mode every dispatch is a pass of its own)
        if (!(gpu.timing?.split && gpu.timing?.enabled)) f.compute('post');
        if (bloomOn && !postOnly) {
          const mip = (k, src, high, dst, extra) => k.dispatch(f, [Math.ceil(dst.width / BLOOM_TILE), Math.ceil(dst.height / BLOOM_TILE), 1], {
            bind: [, , group(L.MIP, [src, high, dst], () => [texEntry(0, src), texEntry(1, high), samplerEntry(2), texEntry(3, dst)])],
            params: { texel: texel(src), dst: sizeOf(dst), ...extra },
          });
          for (let i = 1; i < MIPS; i++) mip(pipes.down, down[i - 1], down[i - 1], down[i]);
          for (let i = MIPS - 2; i >= 1; i--) mip(pipes.up, i === MIPS - 2 ? down[MIPS - 1] : up[i + 1], down[i], up[i], { scatter: s.bloomScatter });
        }
        if (adaptOn || meterNow) {
          const want = !reading;
          if (meterNow) meterAt = frame + METER_INTERVAL;
          const slot = want ? results.next() : NO_SLOT;   // (right before the dispatch that writes it, B7)
          pipes.reduce.dispatch(f, [1, 1, 1], {
            bind: [, , group(L.REDUCE, [color], () => [texEntry(0, color), samplerEntry(1), { binding: 2, resource: { buffer: adaptState } }, { binding: 3, resource: { buffer: results.buffer } }])],
            params: { dt, adapt: adaptOn, meter: meterNow, slot, packed, reuseTarget: postOnly },
          });
          if (want) read(slot);
        }
      }

      // bloom's last upsample into up[0], then the bloom image: up[0] tent-filtered at its
      // size, so the composite takes one tap of it, not nine (both half the output's size)
      if (bloomOn && !postOnly) {
        drawPass(pipes.up0, viewOf(up[0]), 'bloomUp0', group(L.PAIR, [up[1], down[0]], () => [texEntry(0, up[1]), texEntry(1, down[0]), samplerEntry(2)]),
          { texel: texel(up[1]), dst: sizeOf(up[0]), scatter: s.bloomScatter });
        drawPass(pipes.tent, viewOf(bloomImage), 'bloom', group(L.PAIR, [up[0], up[0]], () => [texEntry(0, up[0]), texEntry(1, up[0]), samplerEntry(2)]));
        post.onPass?.('bloom', { kind: 'render' });
      }

      // the composite: into the canvas (opaque, over the sky, viewmodel and glow) or a target
      const out = output ?? outputOf(target);
      const pipe = compositeFor(out.format);
      if (pipe.state !== 'ready') throw new Error(`post: the composite for ${out.format} isn't built yet (await post.ready, or render to it once and wait)`);
      const bloomTex = bloomOn ? bloomImage : blank;
      const vm = out.canvas && viewmodel ? viewmodel : blank, gl = out.canvas && glow ? glow : blank;
      const bind = group(L.COMPOSITE, [color, bloomTex, vm, gl], () => [
        texEntry(0, color), texEntry(1, bloomTex), samplerEntry(2), { binding: 3, resource: { buffer: adaptState } }, texEntry(4, vm), texEntry(5, gl),
      ]);
      const rp = f.render({ colorAttachments: [out.attachment] }, out.canvas ? 'canvas' : 'composite');
      pipe.draw(rp, {
        bind: [, , bind],
        params: compositeParams(s, size, {
          bloom: bloomOn ? s.bloom : 0, sharpen: taaNow && !s.raw ? s.sharpen : 0,
          adapt: adaptOn, night: s.raw ? 0 : s.night, nightSeed: frame, opaque: out.canvas,
          viewmodel: vm !== blank, glow: gl !== blank, vmNight: s.raw ? 0 : s.night,
          peak: out.canvas && presenter?.hdrActive && !s.raw && !s.cruelty ? HDR_OUT.PEAK : 1, packed,
          sprintBlur: s.raw ? 0 : s.sprintBlur,
        }, frameSky),
      });
      rp.end();
      post.onPass?.('composite', { kind: 'render' });
      if (!postOnly && !target && !viewmodel && !glow && adaptOn && !s.night && !s.meter) {
        keptPost = { color, packed, camera: prevCamera, stamp: imageStamp(prevCamera, s) };
      }
    },

    /** Defensive image validation; the app additionally requires settled, unchanged radiance. */
    canReuse(camera, { viewmodel = null, glow = null } = {}) {
      const s = settingsOf();
      return !!(post.isReady && keptPost && !jittered && camera === keptPost.camera
        && (!taaNow || historyValid) && s.adapt && !s.raw && !s.night && !s.meter
        && !viewmodel && !glow && !main.refresh() && keptPost.stamp === imageStamp(camera, s));
    },

    /**
     * Render a frame through the pipeline into `target` (null = the canvas):
     * beginScene, prepare, compute, the opaque meshes, the scene pass, meshes,
     * the overlay, endScene, finish (the file header). This is the app's view
     * frame: tools wrap it to count them.
     * @param {{ prepare?: Function, compute?: Function, opaque?: Function, draw?: Function, meshes?: Function, overlay?: Function } | Function | null} scene
     *   the frame's parts (see the file header); a function is draw alone
     * @param {object} camera
     * @param {object | null} [target] a GPUTexture or { view, width, height, format }
     * @param {number} [dt] s since the last frame (eye adaptation's time course)
     * @param {{ viewmodel?: GPUTexture | null, glow?: GPUTexture | null, postOnly?: boolean }} [extra]
     *   postOnly: caller certifies radiance/TAA settled and external scene/pick dependencies unchanged.
     * @returns {boolean} false while pipelines build or post-only validation fails (nothing recorded)
     */
    render(scene, camera, target = null, dt = ADAPT.DT, { viewmodel = null, glow = null, postOnly = false } = {}) {
      if (!post.isReady) return false;
      // A failed post-only attempt records nothing: app.js runs its full path
      // in this same tick, including beforeView and picking, not stale output.
      if (postOnly) {
        if (target || !post.canReuse(camera, { viewmodel, glow })) return false;
        post.finish({ dt, postOnly: true });
        return true;
      }
      const hooks = hooksOf(scene);
      const out = target ? outputOf(target) : null;
      post.beginScene(camera, { target: out });
      try {
        hooks.prepare?.(post);
        hooks.compute?.(post);
        drawScene(hooks);
      } finally {
        post.endScene(camera);
      }
      post.finish({ target, dt, viewmodel, glow });
      return true;
    },

    /**
     * One-off render (thumbnails, captures) into `target` at its own size: HDR scene
     * + tone mapping, no TAA, no bloom, no night vision, the last adaptation gain;
     * history untouched. The output keeps the scene's alpha (premultiplied).
     * @param {object} scene the frame's parts, as render() takes them, without
     *   compute: a still is drawn from the state the last frame derived
     *   (prepare, opaque, draw, meshes, overlay run; no jitter)
     * @param {object} camera
     * @param {object} target a GPUTexture (rgba8unorm with RENDER_ATTACHMENT) or { view, width, height, format }
     * @returns {boolean} false while post's pipelines are still building
     */
    renderStill(scene, camera, target) {
      if (!post.isReady) return false;
      const out = outputOf(target);
      const pipe = compositeFor(out.format);
      if (pipe.state !== 'ready') return false;
      const s = settingsOf();
      if (still.resize(out.width, out.height) | still.refresh()) groups = new Map();
      const was = active;
      active = still;
      try {
        if (pixScale) pixScale.value = 1;
        camera.updateMatrixWorld();
        const hooks = hooksOf(scene);
        hooks.prepare?.(post);
        drawScene(hooks);
      } finally {
        active = was;
      }
      post.onPass?.('scene', { kind: 'render' });
      finishStill(still,out,s);
      return true;
    },

    /**
     * The canvas as this frame presented it (F5's screenshot fallback: call it
     * in the task that drew the frame), R, G, B, A whatever the canvas format.
     * @returns {Promise<{ width: number, height: number, data: Uint8Array }>}
     */
    capture() {
      if (!presenter) return Promise.reject(new Error('post.capture: no presenter'));
      return presenter.capture();
    },

    /** The adaptation state's GPU buffer (gain, target, view as f32): tools read it. */
    get adaptationBuffer() { return adaptState; },

    dispose() {
      if (stageContext) throw new Error('cannot dispose post from a staged scene hook');
      if (disposed) return;
      disposed = true;keptPost = null;sceneGeneration++;
      const waits = [...liveScenes].flatMap(t => t.uses);
      for (const t of [...pendingScenes]) retireScene(t,'discarded');
      if (lastImage) {waits.push(...lastImage.uses);retireImage(lastImage);lastImage=null;}
      gpu.flush('post dispose');
      const destroy = () => {
        presentation?.dispose();temporal?.dispose();
        [...down, ...up, bloomImage, blank].forEach(t => t?.destroy());
        down=[];up=[];bloomImage=null;resolved=null;
        main.destroy();still.destroy();stagedTargets.forEach(s => s.target.destroy());adaptState.destroy();groups=new Map();
      };
      if (waits.length) Promise.allSettled(waits).then(destroy);else destroy();
    },
  };

  function finishStill(sceneTarget, out, s, frameSky = sky) {
    const pipe = compositeFor(out.format), adapt = s.adapt && !s.raw;
    const bind = group(L.COMPOSITE,[sceneTarget.color,blank,blank,blank],()=>[
      texEntry(0,sceneTarget.color),texEntry(1,blank),samplerEntry(2),{binding:3,resource:{buffer:adaptState}},texEntry(4,blank),texEntry(5,blank),
    ]);
    const rp = gpu.frame.render({colorAttachments:[out.attachment]},'still');
    try {pipe.draw(rp,{bind:[,,bind],params:compositeParams(s,[out.width,out.height],{
      bloom:0,sharpen:0,adapt,night:0,nightSeed:0,opaque:false,viewmodel:false,glow:false,vmNight:0,peak:1,
    },frameSky)});} finally {rp.end();}
  }
  function checkIdentity(identity) {
    if (!identity || !Number.isInteger(identity.epoch) || identity.epoch < 0 || identity.sceneToken === undefined || identity.configVersion === undefined) throw new TypeError('scene epoch/token/configuration identity required');
  }
  const sameIdentity = (a, b) => !!a && !!b && a.epoch === b.epoch && a.sceneToken === b.sceneToken && a.configVersion === b.configVersion;
  const freezeValues = value => {
    if (Array.isArray(value) || ArrayBuffer.isView(value)) return Object.freeze(Array.from(value, freezeValues));
    if (value?.clone) return value.clone();
    if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([k,v]) => [k,freezeValues(v)])));
    return value;
  };
  function frozenPresentation() {
    return presentation ? {active:presentation.active, parameters:freezeValues(presentation.parameters ?? IDENTITY),
      worldToScene:presentation.worldToScene.clone(), sceneToWorld:presentation.sceneToWorld?.clone()} : null;
  }
  // A rejected submitted promise MUST mean its final encoder was discarded or
  // lost. Prefix auto-submits alone must never resolve this caller-owned fence.
  function sceneFence(submission) {
    if (!submission?.submitted?.then) throw new TypeError('final-submission ticket required');
    const queue = gpu.queue ?? gpu.device.queue;
    if (!queue?.onSubmittedWorkDone) throw new TypeError('queue completion service required');
    const done = Promise.resolve(submission.submitted).then(()=>null,error=>({error})).then(async failure=>{
      await queue.onSubmittedWorkDone();
      if(failure)throw failure.error;
    });
    done.catch(() => {});return done;
  }
  function retireImage(image) {
    if (image.retired) return;
    image.retired = true;Promise.allSettled(image.uses).then(() => image.texture.destroy());
  }
  function retireScene(t, status) {
    if (t.retired) return;
    t.retired = true;t.status = status;pendingScenes.delete(t);
    t.completion = Promise.allSettled(t.uses).then(() => {
      t.copies.forEach(texture => texture.destroy());t.copies.length = 0;
      try {t.publication.release();} finally {t.slot.busy = false;liveScenes.delete(t);groups=new Map();if(disposed)t.slot.target.destroy();}
    });
  }
  function syncHook(fn, ...args) {
    if (!fn) return;
    if (fn.constructor?.name === 'AsyncFunction' || fn.constructor?.name === 'AsyncGeneratorFunction') throw new TypeError('staged scene hooks must be synchronous');
    const result = fn(...args);
    if (result?.then) {result.catch?.(() => {});throw new TypeError('staged scene hooks must not return promises');}
    return result;
  }
  function copySceneImage(image, t, label) {
    if (!image) return null;
    if (image.usage !== undefined && !(image.usage & TEX.COPY_SRC)) throw new Error(`${label} must support COPY_SRC`);
    const copy = gpu.createTexture({label, size:[image.width,image.height], format:image.format, usage:TEX.COPY_DST|TEX.TEXTURE_BINDING});
    t.copies.push(copy);
    gpu.frame.direct().copyTextureToTexture({texture:image},{texture:copy},[image.width,image.height,1]);
    return copy;
  }
  function freezeCamera(camera) {
    const copy = camera.clone();copy.parent = null;copy.matrixAutoUpdate = false;
    copy.matrix.copy(camera.matrixWorld);copy.matrixWorld.copy(camera.matrixWorld);copy.matrixWorldInverse.copy(camera.matrixWorldInverse);
    copy.matrix.decompose(copy.position,copy.quaternion,copy.scale);return copy;
  }
  function recordStagedScene(scene, camera, options) {
    if (disposed) throw new Error('post disposed');
    if (jittered || stageContext) throw new Error('cannot nest staged and immediate scenes');
    if (!post.isReady) return null;
    const hooks = hooksOf(scene);
    for (const fn of Object.values(hooks)) if (typeof fn === 'function' && /^(AsyncFunction|AsyncGeneratorFunction)$/.test(fn.constructor?.name)) throw new TypeError('staged scene hooks must be synchronous');
    checkIdentity(options.identity);
    const target = options.target ?? null, isStill = options.still === true;
    if (isStill && !target) throw new Error('staged still requires an output target');
    if (!target) {
      if (!presenter) throw new Error('post: no target and no presenter');
      stageBlit ??= createBlit(gpu,presenter.format);
      if (stageBlit.pipe.state !== 'ready') return null;
    }
    const out = target ? outputOf(target) : {canvas:true,width:presenter.canvas.width,height:presenter.canvas.height,format:presenter.format};
    if (compositeFor(out.format).state !== 'ready') return null;
    if (!sceneIdentity) sceneIdentity = Object.freeze({...options.identity});
    else if (!sameIdentity(options.identity,sceneIdentity)) throw new Error('set current scene identity before recording a new epoch/configuration');
    let slot = stagedTargets.find(s => !s.busy);
    if (!slot && stagedTargets.length < maxPendingScenes) {slot={target:createSceneTarget(gpu,`staged scene ${stagedTargets.length}`),busy:false};stagedTargets.push(slot);}
    if (!slot) return null;
    if (!options.publication?.release || options.feedbackIdentity === undefined) throw new TypeError('owned publication and feedback identity required');
    const submitted = sceneFence(options.submission);
    const s = freezeValues(settingsOf()), scale = isStill ? 1 : post.renderScale;
    const capturedPresentation = frozenPresentation(), capturedSky = freezeValues(sky);
    const worldModel = options.worldModel?.clone() ?? capturedPresentation?.worldToScene?.clone() ?? null;
    if (options.onCommit && (typeof options.onCommit !== 'function' || /^(AsyncFunction|AsyncGeneratorFunction)$/.test(options.onCommit.constructor?.name))) throw new TypeError('scene commit callback must be synchronous');
    const sizes = postSizes(out.width,out.height,scale);
    slot.target.resize(...sizes.inSize);slot.target.refresh();slot.busy = true;
    const t = {slot, publication:options.publication, feedbackIdentity:options.feedbackIdentity, identity:sceneIdentity,
      generation:sceneGeneration, id:++sceneSequence, status:'recorded', retired:false, uses:[submitted], copies:[], completion:null,
      settings:s,sizes,out,still:isStill,dt:options.dt ?? ADAPT.DT,presentation:capturedPresentation,sky:capturedSky,worldModel,
      cameraKey:camera, reservation:null, onCommit:options.onCommit};
    const ticket = Object.freeze({id:t.id,identity:t.identity,publication:t.publication,feedbackIdentity:t.feedbackIdentity,
      worldModel:t.worldModel ? Object.freeze([...t.worldModel.elements]) : null,
      width:out.width,height:out.height,get status(){return t.status;},get error(){return t.error;},
      get callbackError(){return t.callbackError;},
      get confirmation(){return t.confirmation;},get completion(){return t.completion;},recorded:submitted});
    sceneTickets.set(ticket,t);pendingScenes.add(t);liveScenes.add(t);
    Promise.resolve(options.submission.submitted).then(() => {t.submitted = true;}, () => retireScene(t,'failed'));
    const previousTarget = active, previousPixScale = pixScale?.value;
    const projection = camera.projectionMatrix.clone(), inverse = camera.projectionMatrixInverse.clone();
    const view = camera.view ? {...camera.view} : null, aspect = camera.aspect;
    try {
      camera.updateMatrixWorld();t.taa = !isStill && !!(s.taa && temporalOf());
      if (t.taa && !temporal.reserveJitter) throw new Error('staged TAA requires reversible jitter reservations');
      if (t.taa) camera.updateProjectionMatrix();
      const original = camera.projectionMatrix.clone(), originalInverse = camera.projectionMatrixInverse.clone();
      t.camera = freezeCamera(camera);t.curVP = new Matrix4().multiplyMatrices(original,camera.matrixWorldInverse);
      t.reservation = t.taa ? temporal.reserveJitter(camera,...sizes.inSize) : null;
      t.jitter = t.reservation ? [...t.reservation.jitter] : [0,0];
      t.jitVP = new Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
      active = slot.target;
      stageContext = {liveCamera:camera,inSize:sizes.inSize,jitter:t.jitter,unjittered:{projectionMatrix:original,projectionMatrixInverse:originalInverse}};
      if (pixScale) pixScale.value = sizes.inSize[0]/sizes.size[0];
      syncHook(hooks.prepare,post);if (!isStill) syncHook(hooks.compute,post);
      drawScene(hooks,true);
      t.viewmodel = copySceneImage(options.viewmodel,t,'staged viewmodel');t.glow = copySceneImage(options.glow,t,'staged glow');
      return ticket;
    } catch (e) {retireScene(t,'failed');throw e;}
    finally {
      t.reservation?.restore();camera.view = view;if(aspect !== undefined)camera.aspect = aspect;
      camera.projectionMatrix.copy(projection);camera.projectionMatrixInverse.copy(inverse);
      stageContext = null;active = previousTarget;if(pixScale)pixScale.value = previousPixScale;
    }
  }
  function blitLast(image) {
    const rp = gpu.frame.render({colorAttachments:[presenter.attachment()]},'admitted scene');
    try {stageBlit.draw(rp,viewOf(image.texture));} finally {rp.end();}
  }
  function commitStagedScene(ticket, options) {
    if (stageContext || jittered) throw new Error('cannot admit during scene recording');
    const t = sceneTickets.get(ticket);
    if (!t) throw new Error('foreign post scene ticket');
    if (disposed || t.status !== 'recorded') return false;
    if (options.feedbackIdentity !== t.feedbackIdentity) throw new Error('scene feedback identity mismatch');
    if (!t.submitted) return false; // feedback cannot admit an unsubmitted scene
    if (options.feedback?.incomplete !== false) {retireScene(t,'discarded');return false;}
    if (t.generation !== sceneGeneration || !sameIdentity(t.identity,sceneIdentity) || (!t.still && t.id <= admittedSequence)
      || (t.out.canvas && (presenter.canvas.width !== t.out.width || presenter.canvas.height !== t.out.height))) {
      retireScene(t,'discarded');return false;
    }
    if (!post.isReady || compositeFor(t.out.format).state !== 'ready') return false;
    // A following TAA resolve cannot depend on a final encoder whose
    // submission is still unknown. This waits for CPU submission, not GPU idle.
    if(pendingSceneSubmission?.generation===sceneGeneration)return false;
    // TAAU owns resizeable history targets. Do not resize them while an older
    // admitted scene still has an uncompleted final consumer.
    if (!t.still && (size.some((n,i)=>n!==t.sizes.size[i]) || inSize.some((n,i)=>n!==t.sizes.inSize[i]))
      && [...liveScenes].some(other=>other!==t && other.sharedPostWork)) return false;
    const finished = sceneFence(options.submission);t.uses.push(finished);
    admitting = true;let image = null;
    try {
      if (t.still) {
        post.onPass?.('scene',{kind:'render'});
        finishStill(t.slot.target,t.out,t.settings,t.sky);
      } else {
        t.sharedPostWork=true;
        post.setSize(...t.sizes.size,t.sizes.inSize[0]/t.sizes.size[0]);
        taaNow = t.taa;
        if (taaNow !== lastTaa || stageCameraKey !== t.cameraKey || cameraJumped(t.camera)) {historyValid = false;keptPost = null;}
        lastTaa = taaNow;stageCameraKey = t.cameraKey;prevCamera = t.camera;
        prevPos.setFromMatrixPosition(t.camera.matrixWorld);prevQuat.setFromRotationMatrix(t.camera.matrixWorld);
        curVP.copy(t.curVP);jitVP.copy(t.jitVP);jitter = [...t.jitter];
        t.reservation?.commit(t.camera);
        let out = t.out;
        if (out.canvas) {
          image = {texture:gpu.createTexture({label:'last admitted scene',size:t.sizes.size,format:out.format,usage:TEX.RENDER_ATTACHMENT|TEX.TEXTURE_BINDING|TEX.COPY_SRC}),
            width:out.width,height:out.height,uses:[finished],retired:false};
          out = {...out,attachment:{view:viewOf(image.texture),loadOp:'clear',storeOp:'store',clearValue:CLEAR}};
        }
        try {
          post.onPass?.('scene',{kind:'render'});
          post.finish({dt:t.dt,viewmodel:t.viewmodel,glow:t.glow,sceneTarget:t.slot.target,frameSettings:t.settings,
            framePresentation:t.presentation,frameSky:t.sky,output:out,target:t.out.canvas ? null : options.target ?? t.out});
          if (image) blitLast(image);
        } catch (e) {if(image)retireImage(image);historyValid=false;throw e;}
        admittedSequence = t.id;
      }
      retireScene(t,'admitted');
      pendingSceneSubmission=t;
      const fail=error=>{
        t.status='failed';t.error=error;
        if(image){if(lastImage===image)lastImage=null;retireImage(image);}
        if(t.generation===sceneGeneration&&sameIdentity(t.identity,sceneIdentity)){historyValid=false;keptPost=null;}
        return false;
      };
      t.confirmation=Promise.resolve(options.submission.submitted).then(()=>{
        if(disposed||t.generation!==sceneGeneration||!sameIdentity(t.identity,sceneIdentity)){
          t.status='discarded';if(image)retireImage(image);return false;
        }
        if(image){if(lastImage)retireImage(lastImage);lastImage=image;}
        t.status='committed';
        try{syncHook(t.onCommit,ticket);}catch(error){t.callbackError=error;}
        return true;
      },fail).catch(fail).finally(()=>{if(pendingSceneSubmission===t)pendingSceneSubmission=null;});
      return true;
    } catch (e) {retireScene(t,'failed');throw e;} finally {admitting = false;}
  }

  // The scene pass and what goes around it: three's opaque meshes before it
  // (Sync log S1: the volume marches to their depth), the meshes after it
  // (three's own submits) and E2's overlay. Everything here draws into `active`.
  function drawScene(hooks, strict = false) {
    const call = strict ? syncHook : (fn,...args) => fn?.(...args);
    const drew = call(hooks.opaque,post) === true;
    if (strict) call(hooks.capture,post); // real opaque HDR/depth packing belongs here
    const rp = gpu.frame.render(post.sceneDescriptor({ load: drew }), 'scene');
    try {call(hooks.draw,rp,post);} finally {rp.end();}
    call(hooks.meshes,post);
    if (hooks.overlay) {
      const op = gpu.frame.render(post.overlayDescriptor(), 'overlay');
      try {call(hooks.overlay,op,post);} finally {op.end();}
    }
  }

  // The jittered camera's own projection back (endScene, or beginScene after a scene left unended)
  function restore(camera) {
    if (taaNow) temporal.unjitter(camera);
    camera.projectionMatrix.copy(savedProj);
    camera.projectionMatrixInverse.copy(savedProjInv);
    jittered = null;
  }

  function hooksOf(scene) {
    if (!scene) return {};
    if (typeof scene === 'function') return { draw: scene };
    if (scene.isObject3D) throw new Error('post.render takes the frame\'s parts ({ prepare, compute, opaque, draw, meshes, overlay }), not a three scene (docs/webgpu.md F1)');
    return scene;
  }

  // the composite's output: the presenter's current texture (null), a GPUTexture, or { view, width, height, format }
  function outputOf(target) {
    if (!target) {
      if (!presenter) throw new Error('post: no target and no presenter');
      const t = presenter.texture();
      return { canvas: true, width: t.width, height: t.height, format: presenter.format, attachment: presenter.attachment() };
    }
    const view = target.view ?? viewOf(target);
    return {
      canvas: false, width: target.width, height: target.height, format: target.format,
      attachment: { view, loadOp: 'clear', storeOp: 'store', clearValue: CLEAR },
    };
  }

  function compositeParams(s, outSize, o, frameSky = sky) {
    return {
      size: outSize, thresh: [s.bloomThreshold, Math.max(s.bloomKnee, 1e-3)], hot: [s.hotStart, s.hotFull],
      bloom: o.bloom, exposure: 2 ** s.exposure, sharpen: o.sharpen, look: s.look,
      raw: s.raw, adapt: o.adapt, night: o.night, nightGain: s.nightGain,
      cruelty: s.cruelty, crueltyTime,
      nightSeed: o.nightSeed >>> 0, opaque: o.opaque, viewmodel: o.viewmodel, glow: o.glow, vmNight: o.vmNight, peak: o.peak, packed: !!o.packed,
      white: srgbEncode(Math.max(o.peak, 1)),
      sprintBlur: Number.isFinite(o.sprintBlur) ? Math.max(0, Math.min(1, o.sprintBlur)) : 0,
      skyTop: frameSky.top, skyMid: frameSky.mid, skyLow: frameSky.low, skyGlow: frameSky.glow,
    };
  }

  // the slot's adaptation and meter values, when the flush that copies it has mapped
  function read(slot) {
    reading = true;
    results.read(slot).then((bytes) => {
      const v = new Float32Array(bytes), flags = new Uint32Array(bytes)[5];
      if (flags & 1) adaptSeen = { gain: v[0], target: v[1], view: v[2] };
      if (flags & 2) post.sceneLuma = v[4] > 0 ? Math.max(0, Math.exp(v[3] / v[4]) - METER_LOG_FLOOR) : null;
    }).catch(() => {}).finally(() => {
      reading = false;
      post.onRead?.();
    });
  }

  // Teleports and very fast moves: history would be mostly disoccluded anyway.
  const _p = new Vector3(), _q = new Quaternion();
  function cameraJumped(camera) {
    if (!historyValid) return false;
    _p.setFromMatrixPosition(camera.matrixWorld);
    _q.setFromRotationMatrix(camera.matrixWorld);
    const move = _p.distanceTo(prevPos);
    return move > JUMP_MOVE_FRAC * Math.max(prevPos.length(), 1) || _q.angleTo(prevQuat) > JUMP_TURN;
  }

  return post;
}
