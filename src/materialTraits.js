// Reusable material semantics, independent of any exhibit recipe or UI.
import { ELEMENTS, K, REACTIONS } from './elements.js';
import { NUCLEAR, EMITTERS } from './rays.js';
import { PHASE_ROWS } from './v2/phase.js';
import { PHYS } from './physics.js';

const tag = (group, label, description) => Object.freeze({ group, label, description });
export const MATERIAL_TAGS = Object.freeze({
  air: tag('kind', 'Air', 'The empty-cell air carrier, not a brush tool.'),
  solid: tag('kind', 'Solid', 'Holds its grid position.'),
  powder: tag('kind', 'Powder', 'Falls and piles as grains.'),
  liquid: tag('kind', 'Liquid', 'Flows and needs a basin.'),
  gas: tag('kind', 'Gas', 'Spreads through available air space.'),
  flammable: tag('hazard', 'Flammable', 'Has a modeled ignition or fuel-burning rule.'),
  'airborne-explosive': tag('hazard', 'Explosive when airborne', 'Its active special rule can ignite a suspended dust cloud explosively.'),
  explosive: tag('hazard', 'Explosive', 'Has a modeled blast rule.'),
  'impact-sensitive': tag('hazard', 'Impact sensitive', 'An impact above its modeled energy threshold can trigger detonation.'),
  'pressure-sensitive': tag('hazard', 'Pressure sensitive', 'Pressure above its modeled threshold can trigger detonation or a material change.'),
  oxidizer: tag('hazard', 'Supports combustion', 'Its special combustion rule accelerates burning and raises flame temperature.'),
  annihilating: tag('hazard', 'Annihilating', 'Its wildcard contact reaction consumes both participants, except explicitly compatible materials.'),
  corrosive: tag('hazard', 'Corrosive', 'Consumes susceptible matter through the acid rule.'),
  radioactive: tag('hazard', 'Nuclear fuel', 'Has modeled neutron fission cross-sections; not a general radiation-dose model.'),
  'neutron-emitter': tag('hazard', 'Emits neutrons', 'Spontaneously emits neutron packets in the active simulation.'),
  reactive: tag('hazard', 'Contact reactions', 'Participates in a shared contact-reaction row.'),
  'pressure-producing': tag('hazard', 'Pressure source', 'A modeled transition, reaction or blast releases pressure.'),
  'pressure-anomaly': tag('hazard', 'Pressure anomaly', 'Its special rule creates suction and can release a pressure burst.'),
  hot: tag('hazard', 'Hot start', 'Spawn temperature is above modeled ambient; not a burn-dose threshold.'),
  cold: tag('hazard', 'Cold start', 'Spawn temperature is below modeled ambient; not a frostbite threshold.'),
  cryogenic: tag('hazard', 'Cryogenic start', 'Spawn temperature is at or below −150 °C, a descriptive cryogenic convention, not a safety limit.'),
  'thermally-unstable': tag('hazard', 'Ambient transition risk', 'A transition threshold is reached at spawn or modeled ambient; the sample may not persist unchanged.'),
  'phase-changing': tag('property', 'Thermal transitions', 'Has a modeled hot, cold or melting transition.'),
  conductive: tag('property', 'Conductive', 'Carries electrical sparks.'),
  'electrical-receiver': tag('behavior', 'Electrical receiver', 'Receives existing electrical offers as a short-lived input; does not transmit sparks.'),
  'acid-resistant': tag('property', 'Acid resistant', 'The acid rule does not consume it; not universal containment proof.'),
  decaying: tag('behavior', 'Short-lived', 'Its active special rule spends life or disperses it.'),
  growing: tag('behavior', 'Growing', 'Its active special rule converts nearby resources into more growth.'),
  replicating: tag('behavior', 'Replicating', 'Its active clone rule can create neighboring matter.'),
  'matter-consuming': tag('hazard', 'Consumes matter', 'Its active special rule deletes or absorbs nearby matter.'),
  'mobile-matter-only': tag('behavior', 'Drains movable matter only', 'Its drain rule consumes powders, liquids and gases, not solid supports.'),
  biological: tag('behavior', 'Biological effect', 'Has a verified body-contact or ingestion effect, not just a biological name.'),
  potion: tag('behavior', 'Potion', 'Applies a modeled magical body status.'),
});
const SEMANTIC = new Set(['electrical-receiver', 'decaying', 'growing', 'replicating', 'matter-consuming', 'mobile-matter-only', 'biological', 'potion', 'airborne-explosive', 'oxidizer', 'pressure-anomaly']);
const KINDS = { [K.EMPTY]: 'air', [K.SOLID]: 'solid', [K.POWDER]: 'powder', [K.LIQUID]: 'liquid', [K.GAS]: 'gas' };

export function describeTag(key) {
  if (typeof key !== 'string' || !Object.hasOwn(MATERIAL_TAGS, key)) {
    throw new Error(`Unknown material tag ${JSON.stringify(key)}; use a key from MATERIAL_TAGS (src/materialTraits.js).`);
  }
  return MATERIAL_TAGS[key];
}
export function validateTraits(traits = [], context = 'material') {
  if (!Array.isArray(traits)) throw new Error(`${context}.traits must be an array of semantic tag strings.`);
  for (const key of traits) {
    describeTag(key);
    if (!SEMANTIC.has(key)) throw new Error(`${context}.traits: "${key}" is derived from modeled fields; do not duplicate it.`);
  }
  return [...new Set(traits)];
}

// Only the water family lacks explicit phase fields. Reuse active V2 data.
export function materialTransitions(element) {
  const waterFamily = ['WATER', 'ICE', 'SNOW', 'STEAM', 'CLOUD'].includes(element.key);
  const native = waterFamily ? PHASE_ROWS[ELEMENTS.find(e => e.key === element.key)?.id] : null;
  return { hot: element.hot ?? native?.hot ?? null, cold: element.cold ?? native?.cold ?? null };
}

export function materialTags(element) {
  const kind = Number.isInteger(element.kind) && Object.hasOwn(KINDS, element.kind) ? KINDS[element.kind] : null;
  if (!kind) throw new Error(`${element.key}: unsupported material kind ${element.kind}.`);
  const tags = new Set([kind, ...validateTraits(element.traits, element.key)]);
  const add = (condition, key) => { if (condition) tags.add(key); };
  // A wildcard's victim is susceptible, not inherently reactive. The source
  // and explicitly named chemistry partners carry the reactive facet.
  const reactions = REACTIONS.filter(r => r.a === element.key || r.b === element.key);
  const reactionFuel = reactions.some(r => r.a === element.key &&
    (r.b === 'EMPTY' || r.b === 'OXYGEN') && r.heat > 0);
  add(element.ignite > 0 || element.burnRate > 0 || reactionFuel, 'flammable');
  add(element.blast, 'explosive');
  add(element.blast?.shock > 0, 'impact-sensitive');
  add(element.blast?.crushP > 0 || element.crush?.P > 0, 'pressure-sensitive');
  add(reactions.some(r => r.a === element.key && r.b === '*' &&
    r.into?.[0] === 'EMPTY' && r.into?.[1] === 'EMPTY'), 'annihilating');
  add(element.acid, 'corrosive');
  add(element.acidProof, 'acid-resistant');
  add(element.elec > 0 || element.conducts, 'conductive');
  const { hot, cold } = materialTransitions(element);
  add(hot || cold || element.melt > 0, 'phase-changing');
  add(element.temp > PHYS.AMBIENT, 'hot');
  add(element.temp < PHYS.AMBIENT, 'cold');
  add(element.temp <= -150, 'cryogenic');
  add(reactions.length, 'reactive');
  // Only pressure released at spawn/ambient or by this material's own
  // reaction needs shielding policy. Merely boiling water someday does not.
  const hotActive = hot && Math.max(element.temp, PHYS.AMBIENT) >= hot.T;
  const coldActive = cold && Math.min(element.temp, PHYS.AMBIENT) <= cold.T;
  add(hotActive || coldActive || element.melt > 0 && Math.max(element.temp, PHYS.AMBIENT) >= element.melt, 'thermally-unstable');
  add(element.blast?.P > 0 || hotActive && hot.puff > 0 || coldActive && cold.puff > 0 ||
    element.fizz > 0 || reactions.some(r => r.a === element.key && r.puff > 0), 'pressure-producing');
  const nuclear = NUCLEAR[element.key];
  add(nuclear?.fF > 0 || nuclear?.fT > 0, 'radioactive');
  add(EMITTERS[element.key] > 0, 'neutron-emitter');
  return [...tags];
}
