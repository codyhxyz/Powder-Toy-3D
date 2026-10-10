import { DEFAULT_CONFIG, SPELL_BY_ID } from './catalog.js';

export const LIMITS = Object.freeze({ cards: 64, depth: 16, nodes: 256, minCooldown: 0.02 });
export const CONFIG_BOUNDS = Object.freeze({
  manaMax: [1, 10000], manaRegen: [0, 10000], castDelay: [0.02, 30],
  recharge: [0.02, 60], capacity: [1, LIMITS.cards],
});
const PARAM_BOUNDS = {
  radius: [0.25, 24], power: [0, 10000], damage: [0, 1000], speed: [1, 240],
  lifetime: [0.05, 30], gravity: [-120, 120], spread: [0, Math.PI], recoil: [0, 80],
  bounces: [0, 8], pierce: [0, 16], homing: [0, 1],
};
const clamp = (n, [lo, hi]) => Math.max(lo, Math.min(hi, n));
const copy = (node) => ({ ...node, params: { ...node.params },
  ...(node.children ? { children: node.children.map(copy) } : {}),
  ...(node.payload ? { payload: copy(node.payload) } : {}),
});
const size = (node) => 1 + (node.children?.reduce((n, child) => n + size(child), 0) ?? 0)
  + (node.payload ? size(node.payload) : 0);

// Expression scope is deliberately simpler than Noita's casting-block scope:
// descend through formation children, but never into a carrier's payload.
function modify(node, changes) {
  if (node.children) { node.children.forEach((child) => modify(child, changes)); return; }
  for (const [key, [mode, value]] of Object.entries(changes)) {
    if (mode === 'multiply' && node.params[key] === undefined) continue;
    if (['gravity', 'bounces', 'pierce', 'homing', 'trail'].includes(key) && node.op !== 'projectile') continue;
    let next = mode === 'set' ? value : mode === 'add' ? (node.params[key] ?? 0) + value : node.params[key] * value;
    if (PARAM_BOUNDS[key]) next = clamp(next, PARAM_BOUNDS[key]);
    node.params[key] = next;
  }
}

export function compileWand(cards, input = {}) {
  const errors = [], config = { ...DEFAULT_CONFIG };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    errors.push('Configuration must be an object.');
    input = {};
  }
  for (const [key, bounds] of Object.entries(CONFIG_BOUNDS)) {
    if (!Object.hasOwn(input, key)) continue;
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) {
      errors.push(`${key} must be a finite number.`);
      continue;
    }
    config[key] = clamp(input[key], bounds);
  }
  config.capacity = Math.floor(config.capacity);
  // totalMana: one entire deck; maxCastMana: largest prepaid root including payloads.
  // castDelays/recharge: FINAL seconds (base + subtree card contributions, floored).
  // nodeCount/maxDepth: expanded output tree, not input card count or parser depth.
  const stats = { cardCount: Array.isArray(cards) ? cards.length : 0, castCount: 0,
    nodeCount: 0, maxDepth: 0, totalMana: 0, maxCastMana: 0, castDelays: [], recharge: config.recharge };
  const invalid = () => ({ casts: [], errors, stats, config });
  if (!Array.isArray(cards)) errors.push('Cards must be an array of spell IDs.');
  else if (!cards.length) errors.push('Add at least one spell.');
  else if (cards.length > config.capacity || cards.length > LIMITS.cards) errors.push(`Deck exceeds capacity (${config.capacity} cards).`);
  // Bound validation work before inspecting untrusted card arrays.
  if (errors.length) return invalid();
  for (let i = 0; i < cards.length; i++) {
    if (typeof cards[i] !== 'string' || !Object.hasOwn(SPELL_BY_ID, cards[i])) errors.push(`Card ${i + 1}: unknown spell ID.`);
  }
  if (errors.length) return invalid();

  let cursor = 0;
  function parse(depth = 1) {
    if (depth > LIMITS.depth) throw new Error(`Expression depth exceeds ${LIMITS.depth}.`);
    if (cursor >= cards.length) throw new Error(`Card ${cursor + 1}: missing expression.`);
    const spell = SPELL_BY_ID[cards[cursor++]];
    let node;
    if (spell.op === 'modifier') {
      node = parse(depth + 1);
      modify(node, spell.changes);
      node.params.mana += spell.mana;
      node.params.castDelay = (node.params.castDelay ?? 0) + (spell.castDelay ?? 0);
      node.params.recharge = (node.params.recharge ?? 0) + (spell.recharge ?? 0);
    } else if (spell.op === 'trigger') {
      node = parse(depth + 1);
      if (node.op !== 'projectile' || node.payload) throw new Error(`${spell.name} needs a single projectile carrier without an existing trigger.`);
      node.payload = parse(depth + 1);
      node.trigger = spell.trigger;
      if (spell.trigger === 'timer') node.params.delay = spell.delay;
      node.params.mana += spell.mana;
    } else if (spell.op === 'multi' || spell.op === 'burst') {
      const children = [];
      for (let i = 0; i < spell.arity; i++) children.push(parse(depth + 1));
      const repeat = spell.repeat ?? 1;
      if (1 + children.reduce((n, child) => n + size(child), 0) * repeat > LIMITS.nodes)
        throw new Error(`Expanded plan exceeds ${LIMITS.nodes} nodes.`);
      const expanded = [];
      for (let i = 0; i < repeat; i++) expanded.push(...children.map(copy));
      node = { op: spell.op, id: spell.id, effect: null, params: { mana: spell.mana }, children: expanded };
      if (spell.interval) node.params.interval = spell.interval;
      if (spell.spread) modify(node, { spread: ['add', spell.spread] });
    } else {
      node = { op: spell.op, id: spell.id, effect: spell.effect, params: { ...spell.params } };
    }
    if (size(node) > LIMITS.nodes) throw new Error(`Expanded plan exceeds ${LIMITS.nodes} nodes.`);
    return node;
  }

  const casts = [];
  try {
    let expanded = 0;
    while (cursor < cards.length) {
      const node = parse();
      expanded += size(node);
      if (expanded > LIMITS.nodes) throw new Error(`Expanded plan exceeds ${LIMITS.nodes} nodes.`);
      casts.push(node);
    }
  } catch (error) {
    errors.push(error.message);
    return invalid();
  }

  // params.mana/castDelay/recharge are subtree totals on EVERY node. Runtime
  // charges only root mana, never children/payloads again. Other params stay local.
  function total(node, depth = 1) {
    stats.nodeCount++;
    stats.maxDepth = Math.max(stats.maxDepth, depth);
    const parts = [...(node.children ?? []), ...(node.payload ? [node.payload] : [])];
    parts.forEach((part) => total(part, depth + 1));
    for (const key of ['mana', 'castDelay', 'recharge'])
      node.params[key] = (node.params[key] ?? 0) + parts.reduce((sum, part) => sum + part.params[key], 0);
  }
  casts.forEach((node) => total(node));
  stats.castCount = casts.length;
  stats.totalMana = casts.reduce((sum, node) => sum + node.params.mana, 0);
  stats.maxCastMana = Math.max(...casts.map((node) => node.params.mana));
  stats.castDelays = casts.map((node) => clamp(config.castDelay + node.params.castDelay, [LIMITS.minCooldown, 30]));
  stats.recharge = clamp(config.recharge + casts.reduce((sum, node) => sum + node.params.recharge, 0), [LIMITS.minCooldown, 60]);
  return { casts, errors, stats, config };
}
