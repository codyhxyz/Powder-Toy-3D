import * as THREE from 'three';
import { ELEMENTS, E, K } from '../../elements.js';
import { SPELL_BY_ID } from './catalog.js';

// What a spell looks like: one table, read by every drawer (visuals.js's cores,
// shells and beams, vfx.js's trails and impacts, audio.js's pitch, the held
// wand's gem in tools/index.js), so a spell reads the same in the hand, in the
// air and where it lands. After Noita: every spell has a glowing core in its
// own colour, leaves trail particles and lights what it passes. Creation spells
// take their material's colour; fire-like ones (heat, ignite, created FIRE or
// LAVA) take the fire look.
//
// Colours are linear RGB, 0..1; drawers multiply by their own HDR gains.
//   trail:  vfx.js's particles along a flight or beam: spark | ember | mist | dust | smoke | mote
//   field:  visuals.js's shell style for a sustained field: glow | pull | push | void | cloud
//   pitch:  audio.js's playback rate for this spell's cast and impact (1 = the preset's own)
export const LOOKS = Object.freeze({
  spark: { color: 0x70bcff, trail: 'spark', field: 'glow', pitch: 1.25 },
  dig: { color: 0xffc070, trail: 'dust', field: 'glow', pitch: 0.8 },
  emit: { color: 0x75d8f5, trail: 'mist', field: 'cloud', pitch: 1 },
  absorb: { color: 0x56e3b0, trail: 'mote', field: 'pull', pitch: 0.9 },
  heat: { color: 0xff722e, trail: 'ember', field: 'glow', pitch: 0.9, fire: true },
  cool: { color: 0xb0eaff, trail: 'mist', field: 'glow', pitch: 1.3 },
  pressure: { color: 0xffc777, trail: 'smoke', field: 'push', pitch: 0.7 },
  erase: { color: 0xa966ec, trail: 'mote', field: 'void', pitch: 0.6 },
  light: { color: 0xffe9aa, trail: 'mote', field: 'glow', pitch: 1.5 },
  teleport: { color: 0xaa82ff, trail: 'mote', field: 'glow', pitch: 1.4 },
  ignite: { color: 0xffae42, trail: 'ember', field: 'glow', pitch: 1, fire: true },
  place: { color: 0x90cae0, trail: 'dust', field: 'cloud', pitch: 0.85 },
  attract: { color: 0xb882ff, trail: 'mote', field: 'pull', pitch: 0.75 },
  repel: { color: 0x87cbff, trail: 'mote', field: 'push', pitch: 0.95 },
  scan: { color: 0x65f7c5, trail: 'mote', field: 'glow', pitch: 1.6 },
});
const FALLBACK = 'spark';
const FIRE_COLOR = 0xff8a2a;              // the fire look's colour (FIRE's own, elements.js)
const FIRE_MATERIALS = new Set(['FIRE', 'LAVA']);
// A dark material (smoke, oil, gunpowder) would vanish in an additive glow: below this
// luminance its colour is pulled toward the spell's own colour, so every spell still glows.
const MIN_GLOW_LUMA = 0.3;
// trail by the created material's state
const TRAIL_BY_KIND = { [K.LIQUID]: 'mist', [K.POWDER]: 'dust', [K.SOLID]: 'dust', [K.GAS]: 'smoke' };
// ops that carry or shape spells: never a wand's "main" spell
const STRUCTURAL = new Set(['modifier', 'multi', 'burst', 'trigger']);
const CARRIER = 'carrier';

const elementOf = (material) => (typeof material === 'number' ? ELEMENTS[material]
  : material ? ELEMENTS[E[material]] : null);
const luma = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

const cache = new Map();
// The look of `effect` creating or carrying `material` (an element key or id; optional).
// Returns a frozen { color: THREE.Color, rgb: [r, g, b], raw, trail, field, fire, pitch, id }: rgb is the
// glow colour, raw the material's own (for what is lit, not glowing: a cloud of smoke stays dark).
export function lookOf(effect, material = null) {
  const key = `${effect}|${material ?? ''}`;
  let look = cache.get(key);
  if (look) return look;
  const base = LOOKS[effect] ?? LOOKS[FALLBACK];
  const el = (effect === 'emit' || effect === 'place' || effect === 'absorb') ? elementOf(material) : null;
  const fire = !!base.fire || (el && FIRE_MATERIALS.has(el.key));
  const color = new THREE.Color(fire ? FIRE_COLOR : base.color);
  let trail = fire ? 'ember' : base.trail, field = base.field, raw = [color.r, color.g, color.b];
  if (el && !fire) {
    const own = new THREE.Color(el.color);
    raw = [own.r, own.g, own.b];
    const l = luma(own);
    color.copy(l >= MIN_GLOW_LUMA ? own : own.lerp(color, 1 - l / MIN_GLOW_LUMA));
    trail = TRAIL_BY_KIND[el.kind] ?? trail;
    if (el.kind === K.GAS) field = 'cloud';
  }
  look = Object.freeze({ color, rgb: [color.r, color.g, color.b], raw, trail, field, fire, pitch: base.pitch, id: el?.id ?? -1 });
  cache.set(key, look);
  return look;
}

// The leaf a cast is "about" (its first leaf that isn't a bare carrier, else its first leaf),
// for a cast's flare and sound. Works on compiled nodes (runtime.js).
export function mainNode(node) {
  let first = null;
  const walk = (n) => {
    if (!n) return null;
    if (n.children?.length) { for (const c of n.children) { const hit = walk(c); if (hit) return hit; } return null; }
    first ??= n;
    if (n.id !== CARRIER) return n;
    return walk(n.payload);
  };
  return walk(node) ?? first;
}

// A wand's main spell (its first spell card that isn't structural or a bare carrier): its gem's
// colour. Takes a definition's card ids (catalog.js PRESETS[].cards).
export function wandLook(cards = []) {
  let fallback = null;
  for (const id of cards) {
    const spell = SPELL_BY_ID[id];
    if (!spell || STRUCTURAL.has(spell.op)) continue;
    fallback ??= spell;
    if (spell.id !== CARRIER) return lookOf(spell.effect, spell.params?.material);
  }
  return lookOf(fallback?.effect ?? FALLBACK, fallback?.params?.material);
}
