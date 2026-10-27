// Persistent-storage assessment, NOT display availability. See specimens.js.
import { ELEMENTS, itemByKey } from '../elements.js';
import { materialTags, describeTag } from '../materialTraits.js';
import { elementFacts } from './facts.js';

const requirement = (label, supported, reason) => Object.freeze({ label, supported, reason });
export const STORAGE_REQUIREMENTS = Object.freeze({
  support: requirement('Supporting floor', true, 'Geometric support must be checked by a future generator.'),
  basin: requirement('Liquid basin', true, 'Basin geometry is a candidate, not a proven indefinite store.'),
  sealed: requirement('Closed gas volume', true, 'Closed geometry alone does not establish pressure or thermal safety.'),
  'thermal-control': requirement('Temperature control', false, 'Temperature control is not implemented.'),
  'pressure-shielding': requirement('Pressure shielding', false, 'Pressure shielding is not implemented or validated.'),
  'radiation-shielding': requirement('Neutron shielding', false, 'Neutron shielding is not validated.'),
  'electrical-isolation': requirement('Electrical isolation', true, 'Separate conductors from spark sources; candidate geometry only.'),
  'ignition-separation': requirement('Ignition separation', true, 'Keep away from flames and hot neighbors; not an indefinite safety proof.'),
  'mechanical-isolation': requirement('Mechanical isolation', true, 'Keep the sample at rest and away from impact/pressure sources; candidate geometry only.'),
  'corrosion-resistant': requirement('Acid-resistant storage', false, 'Compatible walls alone do not establish indefinite storage.'),
  'contact-isolation': requirement('Contact isolation', true, 'Separate specific reaction partners; compatible geometry still needs validation.'),
  'growth-isolation': requirement('Growth isolation', false, 'Resource and growth isolation have not been validated.'),
  'replication-isolation': requirement('Replication isolation', false, 'Clone isolation has not been validated.'),
  'matter-isolation': requirement('Matter-consumption isolation', false, 'No validated enclosure for matter-consuming behavior.'),
  replenishment: requirement('Replenishment', false, 'Short-lived matter requires an active supply, not just a sealed vessel.'),
  'body-isolation': requirement('Body-contact isolation', true, 'Keep samples inaccessible to bodies and ingestion; candidate geometry only.'),
  'effect-source': requirement('Controlled effect source', false, 'A persistent, isolated effect demonstration is not implemented.'),
});
const BY_TAG = Object.freeze({
  air: ['sealed'], solid: [], powder: ['support'], liquid: ['basin'], gas: ['sealed'],
  flammable: ['ignition-separation'], explosive: ['ignition-separation', 'pressure-shielding'],
  'impact-sensitive': ['mechanical-isolation'], 'pressure-sensitive': ['mechanical-isolation'],
  oxidizer: ['ignition-separation', 'contact-isolation'], annihilating: ['matter-isolation', 'pressure-shielding'],
  'airborne-explosive': ['ignition-separation', 'pressure-shielding'],
  corrosive: ['corrosion-resistant'], radioactive: ['radiation-shielding', 'pressure-shielding'],
  'neutron-emitter': ['radiation-shielding'], reactive: ['contact-isolation'],
  'pressure-producing': ['pressure-shielding'], hot: ['thermal-control'], cold: ['thermal-control'], cryogenic: ['thermal-control'],
  'pressure-anomaly': ['pressure-shielding'],
  'thermally-unstable': ['thermal-control'], 'phase-changing': [], conductive: ['electrical-isolation'], 'acid-resistant': [],
  decaying: ['replenishment'], growing: ['growth-isolation'], replicating: ['replication-isolation'],
  'matter-consuming': ['matter-isolation'], biological: ['body-isolation'], potion: ['body-isolation'],
  'mobile-matter-only': [], 'electrical-receiver': ['electrical-isolation'],
});
export function requirementsForTags(tags) {
  if (!Array.isArray(tags)) throw new Error('requirementsForTags expects an array of material tag strings.');
  return [...new Set(tags.flatMap(key => {
    describeTag(key);
    if (!Object.hasOwn(BY_TAG, key)) throw new Error(`No storage policy for material tag "${key}"; add one to lab/catalog.js.`);
    return BY_TAG[key];
  }))];
}
function admission(requirements) {
  const unsupported = requirements.filter(key => !STORAGE_REQUIREMENTS[key].supported);
  return unsupported.length ? {
    status: 'plaque-only', reason: unsupported.map(key => STORAGE_REQUIREMENTS[key].reason).join(' '),
  } : {
    status: 'candidate', reason: 'Geometric candidate only; no recipe is proven safe indefinitely.',
  };
}
// These are named demonstrations, not voxel materials or general tool admission.
export const EFFECT_KEYS = Object.freeze(['PHOTON', 'NEUTRON', 'SPARK']);
export function createExhibitCatalog(elements = ELEMENTS) {
  if (!Array.isArray(elements)) throw new Error('createExhibitCatalog expects an array of element rows.');
  const keys = new Set(), ids = new Set();
  const materials = elements.map(element => {
    if (!element || typeof element.key !== 'string' || !element.key || !Number.isInteger(element.id) || element.id < 0 || !element.name) {
      throw new Error('Catalog material rows need key, name and a nonnegative integer id; tools are not materials.');
    }
    if (keys.has(element.key) || ids.has(element.id) || EFFECT_KEYS.includes(element.key)) throw new Error(`Duplicate or reserved catalog material: ${element.key} (id ${element.id}).`);
    keys.add(element.key); ids.add(element.id);
    const tags = materialTags(element), requirements = requirementsForTags(tags);
    return { key: element.key, elementId: element.id, name: element.name, type: 'material', category: tags.find(key => describeTag(key).group === 'kind'),
      tags, requirements, ...admission(requirements), facts: elementFacts(element) };
  });
  return [...materials, ...EFFECT_KEYS.map(key => {
    const effect = itemByKey(key), requirements = ['effect-source'];
    return { key, elementId: null, toolId: effect.id, name: effect.name, type: 'effect', category: 'effect',
      tags: [], requirements, ...admission(requirements), facts: [{ key: 'effect', chips: [effect.desc, '', ''] }] };
  })];
}
