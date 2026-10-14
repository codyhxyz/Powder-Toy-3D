import { E } from '../elements.js';
import { DEVICE_TYPES, QUARRY_STARTERS, CASTING_TEMPERATURE } from './catalog.js';

// Sandustry-style growth is paid for by physical deliveries, never a timer.
const INITIAL_CREDITS = 24;
const TYPES = Object.keys(DEVICE_TYPES);
const ADDED_TYPES = new Set(['hearth', 'gate']);
const starterOwned = Object.fromEntries(TYPES.map(type =>
  [type, QUARRY_STARTERS.filter(d => d.type === type).length]));
const costOf = owned => TYPES.reduce((sum, type) => sum + owned[type] * DEVICE_TYPES[type].cost, 0);
const INITIAL_EQUITY = INITIAL_CREDITS + costOf(starterOwned);
const natural = n => Number.isSafeInteger(n) && n >= 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const fail = reason => ({ ok: false, reason });
const success = () => ({ ok: true, reason: '' });

export function createProgression(saved) {
  let credits = INITIAL_CREDITS, earned = 0;
  let owned = { ...starterOwned };
  let delivered = { nuggets: 0, metal: 0 };
  if (saved !== undefined) {
    if (!record(saved) || saved.version !== 1 || !natural(saved.credits) || !natural(saved.earned)
      || !record(saved.owned) || !record(saved.delivered)
      || Object.keys(saved.owned).some(type => !TYPES.includes(type))
      || !TYPES.every(type => Object.hasOwn(saved.owned, type) ? natural(saved.owned[type]) : ADDED_TYPES.has(type))
      || !natural(saved.delivered.nuggets) || !natural(saved.delivered.metal)) {
      throw new TypeError('Invalid factory progression save');
    }
    const deliveryValue = saved.delivered.nuggets + saved.delivered.metal * 4;
    const restoredOwned = Object.fromEntries(TYPES.map(type => [type, saved.owned[type] ?? 0]));
    const assets = costOf(restoredOwned);
    const equity = INITIAL_EQUITY + saved.earned;
    if (!natural(deliveryValue) || !natural(assets) || !natural(equity)
      || deliveryValue !== saved.earned || saved.credits + assets !== equity) {
      throw new TypeError('Inconsistent factory progression economy');
    }
    credits = saved.credits;
    earned = saved.earned;
    owned = restoredOwned;
    delivered = { nuggets: saved.delivered.nuggets, metal: saved.delivered.metal };
  }

  function snapshot() {
    const stage = earned < 12 ? 0 : earned < 48 ? 1 : earned < 96 ? 2 : delivered.metal < 32 ? 3 : 4;
    const unlocked = TYPES.filter(type => !['miner', 'lift', 'pump', 'heater', 'hearth'].includes(type)
      || ((type === 'miner' || type === 'lift') && earned >= 12)
      || (type === 'pump' && earned >= 48) || (['heater', 'hearth'].includes(type) && earned >= 96));
    const goals = [
      `Ship starter gold: ${Math.min(earned, 12)}/12 lifetime credits`,
      `Automate the gold face: ${Math.min(earned, 48)}/48 lifetime credits`,
      `Prepare water cooling: ${Math.min(earned, 96)}/96 lifetime credits`,
      `Ship cooled metal: ${Math.min(delivered.metal, 32)}/32 grains`,
      'Quarry complete — keep expanding',
    ];
    const hints = [
      'Watch the starter sorter. Catch more shallow paydirt; only gold entering the intake earns credits.',
      'Build a mining agent facing the exposed gold wall. Catch its nuggets with belts and a lift.',
      'Pump the finite east reservoir toward a cooling catch. Keep shipping gold to unlock the coal hearth.',
      `Mine coal and scrap. Feed coal to the rear firebox and scrap to the middle. Catch and cool the melt below ${CASTING_TEMPERATURE}°C; solid metal will not ride belts.`,
      'Freeplay: all machines stay unlocked. Extend the quarry; dismantling refunds the full price.',
    ];
    return { version: 1, credits, earned, stage, goal: goals[stage], hint: hints[stage],
      unlocked, delivered: { ...delivered }, complete: stage === 4, owned: { ...owned } };
  }

  function canBuild(type) {
    if (typeof type !== 'string' || !Object.hasOwn(DEVICE_TYPES, type)) return fail('Unknown machine');
    if (!snapshot().unlocked.includes(type)) return fail('Ship more material to unlock this machine');
    if (credits < DEVICE_TYPES[type].cost) return fail('Not enough credits');
    return success();
  }
  function build(type) {
    const result = canBuild(type);
    if (!result.ok) return result;
    credits -= DEVICE_TYPES[type].cost;
    owned[type]++;
    return result;
  }
  function refund(type) {
    if (typeof type !== 'string' || !Object.hasOwn(DEVICE_TYPES, type)) return fail('Unknown machine');
    if (!owned[type]) return fail('No purchased machine to refund');
    credits += DEVICE_TYPES[type].cost;
    owned[type]--;
    return success();
  }
  function ship(batch) {
    if (!record(batch) || !Number.isSafeInteger(batch.count) || batch.count <= 0
      || !Number.isFinite(batch.temperature)) return fail('Invalid physical delivery');
    const key = batch.id === E.NUGGETS ? 'nuggets' : batch.id === E.METAL ? 'metal' : null;
    if (!key) return fail('Intake accepts gold nuggets and cooled metal only');
    if (key === 'metal' && batch.temperature > CASTING_TEMPERATURE) return fail(`Cool metal to ${CASTING_TEMPERATURE}°C or below`);
    const value = batch.count * (key === 'metal' ? 4 : 1);
    if (!natural(value) || !natural(INITIAL_EQUITY + earned + value)
      || !natural(credits + value) || !natural(delivered[key] + batch.count)) return fail('Delivery exceeds economy limit');
    credits += value;
    earned += value;
    delivered[key] += batch.count;
    return success();
  }
  return { snapshot, canBuild, build, refund, ship };
}
