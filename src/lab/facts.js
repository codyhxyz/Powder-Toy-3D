// Data-only card/plaque facts. Each record is { key, chips: [prefix, value, suffix] };
// transition records additionally expose temperature, products [{key, share}], and direction.
import { ELEMENTS, K } from '../elements.js';
import { PHYS } from '../physics.js';
import { materialTags, describeTag, materialTransitions } from '../materialTraits.js';

const deg = t => `${t} °C`;
const productsOf = into => (typeof into === 'string' ? [[into, 1]] : into).map(([key, share]) => ({ key, share }));
const nameOf = key => ELEMENTS.find(e => e.key === key)?.name ?? (key === 'SAME' ? 'unchanged material' : key);
function transitionVerb(element, products, direction) {
  const targets = products.map(p => ELEMENTS.find(e => e.key === p.key));
  const gases = targets.filter(e => e?.kind === K.GAS || e?.kind === K.EMPTY).length;
  if (direction === 'hot') {
    if (products.every(p => p.key === 'LAVA') || targets.every(e => e?.kind === K.LIQUID) && element.kind !== K.LIQUID) return 'Melts';
    if (element.kind === K.LIQUID && gases) return 'Boils';
    if (gases && element.kind !== K.GAS && element.kind !== K.EMPTY) {
      const reversible = targets.every(e => e?.cold?.into === element.key);
      return reversible ? 'Sublimates' : 'Decomposes';
    }
  } else {
    if (element.kind === K.GAS && targets.every(e => e?.kind === K.LIQUID)) return 'Condenses';
    if (element.kind === K.LIQUID) return 'Freezes';
  }
  return 'Changes';
}
export function elementFacts(element) {
  if (!element || element.id < 0) return [];
  const out = [];
  const add = (key, a, b = '', c = '', extra = {}) => out.push({ key, chips: [a, b, c], ...extra });
  if (element.kind === K.POWDER || element.kind === K.LIQUID) add('density', '', `${+(element.dens / 10).toFixed(2)}×`, ' density of water');
  if (element.kind === K.GAS && element.grav !== 0 && Number.isFinite(element.grav)) add('buoyancy', element.grav < 0 ? 'Rises at spawn temperature' : 'Sinks at spawn temperature');
  for (const [direction, transition] of Object.entries(materialTransitions(element))) {
    if (!transition) continue;
    const products = productsOf(transition.into);
    add(direction, `${transitionVerb(element, products, direction)} at `, deg(transition.T),
      ` → ${products.map(p => nameOf(p.key)).join(' / ')}${products.length > 1 ? ' (weighted products)' : ''}`, { temperature: transition.T, products, direction });
  }
  // melt: 0 is the legacy "no melt rule" sentinel, not a zero-degree transition.
  if (element.melt > 0 && !element.hot) add('melt', 'Melts at ', deg(element.melt), ` → Lava (cools to ${nameOf(element.meltInto ?? element.key)})`);
  if (element.ignite > 0) add('ignition', element.blast ? 'Heat triggers blast at ' : 'Ignites in air at ', deg(element.ignite));
  if (element.flash > 0 && element.flash !== element.ignite) add('flash', 'Flame can light above ', deg(element.flash));
  if (Number.isFinite(element.temp) && element.temp !== PHYS.AMBIENT) add('spawn', 'Starts at ', deg(element.temp));
  const tags = materialTags(element);
  for (const key of tags) {
    if (['hazard', 'behavior'].includes(describeTag(key).group) && !['hot', 'cold', 'cryogenic', 'pressure-producing'].includes(key)) add(`tag:${key}`, describeTag(key).label);
  }
  if (tags.includes('conductive')) add('electricity', 'Carries electrical sparks');
  if (element.breakInto) add('debris', 'Breaks into ', nameOf(element.breakInto));
  if (element.cond >= 0.05) add('heat', 'Conducts heat well');
  else if (element.cond <= 0.002 && element.kind !== K.GAS) add('heat', 'Insulates heat');
  return out;
}
