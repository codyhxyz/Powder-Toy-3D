// Units: cells, cells/second, seconds and radians. Mana is prepaid per whole cast.
export const DEFAULT_CONFIG = Object.freeze({ manaMax: 240, manaRegen: 90, castDelay: 0.18, recharge: 0.45, capacity: 32 });

const leaf = (id, name, category, description, op, effect, mana, params = {}) =>
  ({ id, name, category, description, op, effect, params: { mana, ...params } });
const modifier = (id, name, description, mana, changes, timing = {}) =>
  ({ id, name, category: 'Modifiers', description, op: 'modifier', mana, changes, ...timing });
const projectile = { radius: 1, power: 1, speed: 65, lifetime: 2, gravity: 0, spread: 0, damage: 8 };

export const SPELLS = [
  leaf('spark', 'Spark bolt', 'Projectiles', 'A quick, low-cost damaging bolt.', 'projectile', 'spark', 5, projectile),
  leaf('heavy-bolt', 'Heavy bolt', 'Projectiles', 'Slow, forceful bolt with a wider impact.', 'projectile', 'spark', 14, { ...projectile, speed: 40, radius: 2, power: 3, damage: 24, castDelay: 0.08 }),
  leaf('carrier', 'Carrier bolt', 'Projectiles', 'Cheap, harmless carrier for impact or timer payloads.', 'projectile', 'spark', 2, { ...projectile, power: 0, damage: 0 }),
  leaf('bomb', 'Bomb', 'Projectiles', 'An arcing pressure projectile. Impact triggers can carry more effects.', 'projectile', 'pressure', 22, { ...projectile, radius: 5, power: 28, speed: 32, gravity: 20, damage: 32, castDelay: 0.15 }),
  leaf('acid-bolt', 'Create acid bolt', 'Creation', 'Creates a small acid splash on impact; does not consume storage.', 'projectile', 'emit', 12, { ...projectile, material: 'ACID', radius: 2, damage: 2 }),
  leaf('water-bolt', 'Create water bolt', 'Creation', 'Creates a water splash on impact.', 'projectile', 'emit', 8, { ...projectile, material: 'WATER', radius: 3, damage: 0 }),
  leaf('firebolt', 'Firebolt', 'Projectiles', 'Ignites the impact area.', 'projectile', 'ignite', 12, { ...projectile, radius: 3, power: 900, damage: 12 }),
  leaf('stored-shot', 'Stored matter shot', 'Storage', 'Launches matter from this wand’s reservoir, never creates ammunition.', 'projectile', 'emit', 3, { ...projectile, stored: true, radius: 1, speed: 100, damage: 14 }),
  leaf('stored-lob', 'Stored matter mortar', 'Storage', 'Lobs reservoir material along a gravity arc.', 'projectile', 'emit', 12, { ...projectile, stored: true, radius: 3, speed: 32, gravity: 24, lifetime: 5, damage: 6 }),
  leaf('dig', 'Digging beam', 'Mining', 'Fractures breakable terrain into debris, not deletion.', 'beam', 'dig', 12, { radius: 2, power: 70, speed: 40, lifetime: 0.6 }),
  leaf('vacuum', 'Debris vacuum', 'Storage', 'Collects loose powder into this wand’s reservoir.', 'touch', 'absorb', 5, { radius: 5, power: 1, collect: true }),
  leaf('sponge', 'Liquid sponge', 'Storage', 'Collects liquids into this wand’s reservoir.', 'touch', 'absorb', 5, { radius: 5, power: 1, collect: true }),
  leaf('release', 'Release stored matter', 'Storage', 'Pours stored matter without creating it.', 'touch', 'emit', 4, { radius: 3, power: 1, stored: true }),
  leaf('erase', 'Eraser beam', 'Mining', 'Erases ordinary matter; protected walls and clones survive.', 'beam', 'erase', 35, { radius: 2, power: 1, speed: 40, lifetime: 0.5, recharge: 0.15 }),
  leaf('water-jet', 'Create water jet', 'Creation', 'Creates a cooling water stream; separate from stored matter.', 'beam', 'emit', 8, { radius: 2, power: 1, material: 'WATER', speed: 35, lifetime: 0.5 }),
  leaf('sand', 'Create sand', 'Creation', 'Places loose sand in empty space.', 'touch', 'place', 6, { radius: 2, power: 1, material: 'SAND' }),
  leaf('powder', 'Create gunpowder', 'Creation', 'Places explosive powder. Keep away from heat.', 'touch', 'place', 10, { radius: 3, power: 1, material: 'GUNPOWDER' }),
  leaf('ice', 'Create ice beam', 'Creation', 'Builds an ice span in empty space.', 'beam', 'place', 18, { radius: 2, power: 1, material: 'ICE', speed: 24, lifetime: 0.5 }),
  leaf('stone', 'Create rock', 'Creation', 'Places solid rock in empty space.', 'touch', 'place', 15, { radius: 2, power: 1, material: 'ROCK' }),
  leaf('glass', 'Create glass', 'Creation', 'Places transparent glass in empty space.', 'touch', 'place', 12, { radius: 2, power: 1, material: 'GLASS' }),
  leaf('heat', 'Heat beam', 'Temperature', 'Heats a narrow region.', 'beam', 'heat', 10, { radius: 2, power: 600, speed: 35, lifetime: 0.5 }),
  leaf('cool', 'Cooling beam', 'Temperature', 'Cools a narrow region and extinguishes heat.', 'beam', 'cool', 8, { radius: 3, power: 160, speed: 35, lifetime: 0.5 }),
  leaf('ignite', 'Remote ignition', 'Temperature', 'Ignites the targeted area without placing fuel.', 'beam', 'ignite', 8, { radius: 2, power: 900, speed: 70, lifetime: 0.6 }),
  leaf('explosion', 'Pressure explosion', 'Forces', 'An outward pressure blast at the cast or payload origin.', 'touch', 'pressure', 20, { radius: 6, power: 35, damage: 32, castDelay: 0.1, recharge: 0.1 }),
  leaf('black-hole', 'Black hole', 'Forces', 'A temporary attraction field. Pulls matter rather than deleting it.', 'field', 'attract', 35, { radius: 10, power: 30, lifetime: 3, recharge: 0.2 }),
  leaf('repulsion', 'Repulsion field', 'Forces', 'A temporary outward force field.', 'field', 'repel', 20, { radius: 7, power: 24, lifetime: 2 }),
  leaf('recoil', 'Recoil impulse', 'Utility', 'Pushes the caster opposite aim. Aim downward to fly.', 'self', 'pressure', 8, { radius: 1, power: 0, recoil: 14 }),
  leaf('lantern', 'Cave lantern', 'Utility', 'A long-lived cold light; does not heat the world.', 'field', 'light', 10, { radius: 14, power: 1, lifetime: 20 }),
  leaf('scan', 'Survey pulse', 'Utility', 'Reports terrain at the aimed point.', 'beam', 'scan', 3, { radius: 1, power: 1, speed: 80, lifetime: 1 }),
  leaf('teleport', 'Teleport bolt', 'Utility', 'Relocates the caster at impact only if the entire body fits.', 'projectile', 'teleport', 30, { ...projectile, damage: 0, power: 0, speed: 80, lifetime: 1.5, recharge: 0.5 }),

  ...[2, 3, 4].map((arity) => ({ id: `multi-${arity}`, name: `${arity}-way multicast`, category: 'Formation', description: `Casts the next ${arity} complete expressions together.`, op: 'multi', arity, mana: arity })),
  { id: 'scatter', name: 'Triple scatter', category: 'Formation', description: 'Repeats the next complete expression three times in a wide cone.', op: 'multi', arity: 1, repeat: 3, mana: 3, spread: 0.22 },
  { id: 'burst', name: 'Triple burst', category: 'Formation', description: 'Repeats the next expression three times, 0.09 seconds apart. All mana is prepaid.', op: 'burst', arity: 1, repeat: 3, mana: 2, interval: 0.09 },
  ...[['impact', 'Impact trigger', 'impact'], ['timer', 'Timer trigger (0.6s)', 'timer'], ['expiry', 'Expiry trigger', 'expiry']].map(([id, name, trigger]) => ({ id, name, category: 'Triggers', description: 'Consumes one projectile carrier, then one independently scoped payload expression.', op: 'trigger', trigger, delay: 0.6, mana: 3 })),

  modifier('wide', 'Wide area', 'Doubles the next expression’s radii, excluding triggered payloads.', 6, { radius: ['multiply', 2] }),
  modifier('power', 'Extra power', 'Doubles power and damage within the next expression.', 8, { power: ['multiply', 2], damage: ['multiply', 2] }),
  modifier('speed', 'Accelerate', 'Doubles projectile speed within the next expression.', 3, { speed: ['multiply', 2] }),
  modifier('slow', 'Slow shot', 'Halves projectile speed within the next expression.', 1, { speed: ['multiply', 0.5] }),
  modifier('long-life', 'Lasting spell', 'Doubles lifetime within the next expression.', 5, { lifetime: ['multiply', 2] }),
  modifier('gravity', 'Arcing shot', 'Adds downward acceleration to projectiles.', 1, { gravity: ['add', 24] }),
  modifier('no-gravity', 'Weightless shot', 'Removes projectile gravity.', 3, { gravity: ['set', 0] }),
  modifier('focused', 'Focus', 'Removes spread from the next expression.', 3, { spread: ['set', 0] }),
  modifier('spread', 'Wild spread', 'Adds a wide cone to the next expression.', 0, { spread: ['add', 0.2] }),
  modifier('kick', 'Heavy recoil', 'Adds a recoil impulse to the next expression’s leaves.', 2, { recoil: ['add', 8] }),
  modifier('rapid', 'Rapid cast', 'Reduces cast delay by 0.12 seconds; minimum remains 0.02 seconds.', 4, {}, { castDelay: -0.12 }),
  modifier('quick-recharge', 'Quick recharge', 'Reduces deck recharge by 0.2 seconds; minimum remains 0.02 seconds.', 6, {}, { recharge: -0.2 }),
  modifier('bounce', 'Bouncing shot', 'Adds two projectile bounces.', 4, { bounces: ['add', 2] }),
  modifier('pierce', 'Piercing shot', 'Allows two extra projectile impacts.', 6, { pierce: ['add', 2] }),
  modifier('homing', 'Homing shot', 'Steers projectiles toward nearby targets.', 8, { homing: ['set', 0.7] }),
  modifier('fire-trail', 'Fire trail', 'Projectiles leave created fire, not stored material.', 8, { trail: ['set', 'FIRE'] }),
];

export const SPELL_BY_ID = Object.freeze(Object.fromEntries(SPELLS.map((spell) => [spell.id, spell])));

const preset = (id, name, description, slot, cards, config = {}, sandboxReservoir) => ({
  id, name, description, slot, cards, config: { ...DEFAULT_CONFIG, ...config },
  ...(sandboxReservoir ? { sandboxReservoir } : {}),
});
// Optional top-level sandboxReservoir seeds once per wand identity, not on equip/edit.
// It is separate from Create spells: { material: element KEY, count: cells, label }.
export const PRESETS = [
  preset('mining-vacuum', 'Mining vacuum', 'Break terrain and gather loose debris into storage.', 1, ['multi-2', 'dig', 'vacuum']),
  preset('tunnel-cutter', 'Tunnel cutter', 'A broad, powerful digging beam that leaves debris.', 10, ['wide', 'power', 'dig']),
  preset('acid-shotgun', 'Acid shotgun', 'Three created acid splashes spread across a cone.', 4, ['scatter', 'acid-bolt']),
  preset('spark-machinegun', 'Spark machinegun', 'Prepaid triple bursts of fast spark bolts.', 9, ['rapid', 'burst', 'spark'], { castDelay: 0.25, recharge: 0.04 }),
  preset('stored-scrap-machinegun', 'Stored scrap machinegun', 'Finite sandbox starter scrap; refill from collected matter.', 4, ['rapid', 'burst', 'stored-shot'], { castDelay: 0.25, recharge: 0.04 }, { material: 'SCRAP', count: 256, label: 'Sandbox starter: 256 scrap cells' }),
  preset('recoil-flying', 'Recoil flying', 'Aim downward; repeated self impulses lift the caster.', 5, ['rapid', 'recoil'], { recharge: 0.03 }),
  preset('water-extinguisher', 'Water extinguisher', 'Creates water and cools the same area.', 2, ['multi-2', 'water-jet', 'cool']),
  preset('liquid-sponge', 'Liquid sponge', 'Absorb liquids, then release stored matter on the next cast.', 2, ['sponge', 'release']),
  preset('stored-lava-mortar', 'Stored lava mortar', 'Finite sandbox starter lava follows a gravity arc.', 2, ['stored-lob'], {}, { material: 'LAVA', count: 256, label: 'Sandbox starter: 256 lava cells' }),
  preset('remote-black-hole', 'Remote black hole', 'A harmless bolt deploys attraction at impact.', 5, ['impact', 'carrier', 'black-hole']),
  preset('double-explosion', 'Double explosion', 'An impact carrier delivers two simultaneous pressure blasts.', 9, ['impact', 'carrier', 'multi-2', 'explosion', 'explosion']),
  preset('delayed-second-explosion', 'Delayed second explosion', 'An impact blast launches a slow timer carrier for a second blast.', 9, ['impact', 'carrier', 'multi-2', 'explosion', 'timer', 'slow', 'carrier', 'explosion']),
  preset('ice-bridge', 'Ice bridge', 'Creates a short ice span and cools its surroundings.', 6, ['multi-2', 'ice', 'cool']),
  preset('cave-lantern', 'Cave lantern', 'A bolt places a long-lived cold light at impact.', 7, ['impact', 'carrier', 'lantern']),
  preset('powder-and-ignition', 'Powder placement and remote ignition', 'First cast places gunpowder; next cast remotely ignites it.', 8, ['powder', 'ignite']),
  preset('teleport', 'Teleport', 'A fast bolt relocates the caster only to a clear full-body destination.', 7, ['teleport']),
];
