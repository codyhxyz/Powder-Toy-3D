// Backwards-compatible Paradise entry points; all geometry conversion and
// materials now use the same implementation as the other source levels.
import { crueltyProfile } from './crueltyProfiles.js';
import { crueltyMission } from './crueltyMission.js';
export { CRUELTY_MATERIALS as PARADISE_MATERIALS } from './crueltyMaterials.js';
export { crueltyExcludeNode as paradiseExcludeNode } from './crueltyMission.js';
const profile = crueltyProfile('paradise');
export const PARADISE_NODES = { spawn: profile.spawn, targets: profile.targets, extraction: profile.exits[0] };
export const paradiseMission = (scene, map, words) => crueltyMission(scene, map, words, profile);
