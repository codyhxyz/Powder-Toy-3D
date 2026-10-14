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
    update({ dead, at, width = 0, height = 0 }) {
      if (phase !== 'active') return phase;
      // Player death wins over extraction on the same frame.
      if (dead) phase = 'failed';
      else if (eliminated.size === manifest.targets.length && at) {
        const hw = width / 2;
        // Original Godot Areas accept body overlap at either authored exit.
        if ((manifest.extractions ?? [manifest.extraction]).some(e => {
          const b = e.bounds;
          const broad = b ? at.x + hw >= b.min[0] && at.x - hw <= b.max[0]
            && at.y + height >= b.min[1] && at.y <= b.max[1]
            && at.z + hw >= b.min[2] && at.z - hw <= b.max[2]
            : Math.hypot(at.x - e.at[0], at.z - e.at[2]) <= e.radius && Math.abs(at.y - e.at[1]) <= e.height;
          if (!broad) return false;
          // Source convex faces + box axes + edge cross axes: exact SAT for
          // our existing AABB body against the imported Godot convex trigger.
          return !e.axes || e.axes.every(({ normal: n, min, max }) => {
            const center = n[0] * at.x + n[1] * (at.y + height / 2) + n[2] * at.z;
            const radius = (Math.abs(n[0]) + Math.abs(n[2])) * hw + Math.abs(n[1]) * height / 2;
            return center + radius >= min - 1e-6 && center - radius <= max + 1e-6;
          });
        })) phase = 'complete';
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
