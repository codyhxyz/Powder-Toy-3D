// Cruelty Squad wiki, Game Mechanics / Missions: eliminate designated targets,
// then walk to EXIT. Death restarts the level, not an individual body; no match clock.
// https://crueltysquad.fandom.com/wiki/Game_Mechanics
// https://crueltysquad.fandom.com/wiki/Missions
// Authored coordinates are feet in world cells (box maps use origin zero).
import { validMission } from '../maps.js';
export { validMission };

// One attempt only. The adapter creates a new attempt after a fresh map reload.
export function createMissionAttempt(manifest) {
  if (!validMission(manifest)) throw new Error('Invalid authored mission manifest');
  const eliminated = new Set();
  let phase = 'active';
  return {
    eliminate(id) {
      if (phase !== 'active' || !manifest.targets.some((t) => t.id === id) || eliminated.has(id)) return false;
      eliminated.add(id);
      return true;
    },
    update({ dead, at }) {
      if (phase !== 'active') return phase;
      // Player death wins over extraction on the same frame.
      if (dead) phase = 'failed';
      else if (eliminated.size === manifest.targets.length && at) {
        const e = manifest.extraction;
        if (Math.hypot(at.x - e.at[0], at.z - e.at[2]) <= e.radius && Math.abs(at.y - e.at[1]) <= e.height) phase = 'complete';
      }
      return phase;
    },
    stop() { phase = 'stopped'; },
    get state() {
      return { phase, ready: eliminated.size === manifest.targets.length, eliminated: eliminated.size,
        total: manifest.targets.length, targets: manifest.targets.map((t) => ({ id: t.id, name: t.name, eliminated: eliminated.has(t.id) })) };
    },
  };
}
