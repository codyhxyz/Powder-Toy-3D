// Cruelty Squad normal-mission adapter. Source evidence and deliberately approximate
// archetype/weapon mappings are tabulated in docs/cruelty-squad-enemies.md.
// Scene overrides win; missing enemy scene defaults must NOT be called exact parity.
const ROLES = {
  grunt: { health: 40, weapon: 'GUN', reaction: 1.1, interval: 0.65, spread: 0.1, outfit: 'uniform' },
  elite: { health: 100, weapon: 'SMG', reaction: 0.8, interval: 1.5, burst: 0.6, spread: 0.045, outfit: 'armor' },
  security: { health: 40, weapon: 'SMG', reaction: 1.1, interval: 1.7, burst: 0.4, spread: 0.08, outfit: 'security' },
  copRevolver: { health: 50, weapon: 'GUN', reaction: 1.1, interval: 0.9, spread: 0.06, outfit: 'police' },
  // No shotgun/knife NPC tool exists: short SMG salvos / the existing axe rig.
  copShotgun: { health: 50, weapon: 'SMG', reaction: 1.2, interval: 1.8, burst: 0.16, spread: 0.12, sightMeters: 40, outfit: 'riot' },
  assassin: { health: 60, weapon: 'SNIPER', reaction: 0.8, interval: 1.8, spread: 0.025, outfit: 'mask' },
  knifelord: { health: 60, weapon: 'AXE', reaction: 0.7, outfit: 'mask' },
  mutant: { health: 80, weapon: 'AXE', reaction: 0.9, outfit: 'mutant' },
  civilian: { health: 15, weapon: null, reaction: 1.1, outfit: 'civilian' },
  executive: { health: 15, weapon: null, reaction: 1.1, outfit: 'executive' },
  hostileTarget: { health: 100, weapon: 'GUN', reaction: 1.1, interval: 0.7, spread: 0.08, outfit: 'executive' },
  // Public mod scene reference (see docs): equipment remains a stand-in.
  chief: { health: 300, weapon: 'GUN', reaction: 1.1, interval: 0.7, spread: 0.1, speedMeters: 1, engageMeters: 2, outfit: 'mutant' },
  copNarc: { health: 50, weapon: 'SMG', reaction: 1.2, interval: 1.8, burst: 0.16, spread: 0.12, speedMeters: 7, engageMeters: 5, outfit: 'riot' },
  cultLeader: { health: 15, weapon: null, reaction: 1.1, outfit: 'executive' },
};
function classify(text) {
  if (/Obj_Chief|(?:^|\/)Chief(?:$|[._])/i.test(text)) return 'chief';
  if (/Cop_?Narc/i.test(text)) return 'copNarc';
  if (/Cult_?Leader/i.test(text)) return 'cultLeader';
  if (/Cop_?Shotgun/i.test(text)) return 'copShotgun';
  if (/Cop_?Revolver/i.test(text)) return 'copRevolver';
  if (/Elite/i.test(text)) return 'elite';
  if (/Security/i.test(text)) return 'security';
  if (/Assassin/i.test(text)) return 'assassin';
  if (/Knifelord/i.test(text)) return 'knifelord';
  if (/Mutant/i.test(text)) return 'mutant';
  if (/Grunt/i.test(text)) return 'grunt';
  if (/Executive/i.test(text)) return 'executive';
  if (/Nerd|Civilian|Stupid_Civilian/i.test(text)) return 'civilian';
  return null;
}
const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;
export function crueltyProfile(spec, { target = false, cellMeters = 0.3 } = {}) {
  // Exact resource takes precedence over compatibility names in older manifests.
  const role = classify(spec.sourceResource ?? '') ?? classify(spec.sourcePath ?? spec.name ?? '')
    ?? (target ? 'civilian' : 'grunt');
  const p = spec.sourceProperties ?? {};
  const civilian = spec.passive ?? p.civilian ?? (spec.sourceResource?.endsWith('/EnemyHandler.gd') ? false : ['civilian', 'executive', 'cultLeader'].includes(role));
  const effectiveRole = !civilian && ['civilian', 'executive'].includes(role) ? 'hostileTarget' : role;
  const r = ROLES[effectiveRole], meters = positive(cellMeters, 0.3);
  const health = positive(p.health, r.health);
  // weapon.gd's public weapon enum; only consume it if explicitly authored.
  const sourceWeapon = ({ 0: 'GUN', 1: 'SMG', 4: 'SMG', 5: 'ROCKET', 6: 'SNIPER', 7: 'SMG', 8: 'SMG', 9: 'GUN' })[p.current_weapon];
  return Object.freeze({
    role: effectiveRole, outfit: r.outfit, civilian, stupid: p.stupid ?? (role === 'cultLeader' || /Nerd/i.test(spec.sourceResource ?? spec.sourcePath ?? spec.name ?? '')),
    health, damageScale: 40 / health, // destination pistol .5 -> source pistol 20 / source HP
    weapons: Object.freeze(civilian ? [] : [...(spec.sourceResource ? [sourceWeapon ?? r.weapon ?? 'GUN'] : spec.weapons ?? [r.weapon ?? 'GUN'])]),
    reaction: Number.isFinite(p.reaction_time) && p.reaction_time >= 0 ? 0.5 + p.reaction_time / 15 : r.reaction,
    sight: positive(p.ai_distance, r.sightMeters ?? 100) / meters,
    speed: (Number.isFinite(p.move_speed) && p.move_speed >= 0 ? p.move_speed : r.speedMeters ?? 4.5) / meters,
    chaseFrom: positive(p.engage_distance, r.engageMeters ?? 7) / meters,
    memory: 12, touch: 0, track: 0.2, stagger: 0.12, breather: 0,
    interval: r.interval ?? 1.1, burst: p.burst === false ? 0 : r.burst ?? 0,
    spread: Number.isFinite(p.enemy_accuracy) && p.enemy_accuracy >= 0 ? p.enemy_accuracy : r.spread ?? 0.1, patrol: !civilian && p.no_patrol !== true && p.move_speed !== 0,
    yaw: Number.isFinite(spec.sourceYaw) ? spec.sourceYaw : 0,
  });
}
