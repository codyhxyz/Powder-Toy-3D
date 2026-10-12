// The world outcome (docs/v2.md 4.4 "a settled world with water in it
// certifies idle", 5.6): the default island, booted in the game at ?win=64 (the
// container's window; the game's own world generator and sleep rules, nothing
// built by the bench), certifies idle within a couple of seconds and holds
// water. An app test: it runs on engine-app.js (the game at a URL), so a v2
// candidate is measured by its URL (tools/outcomes.mjs --app-query engine=v2).
import { SetupError } from '../engine.js';
import { OUTCOMES } from '../thresholds.js';
import { advanceWatching, crit, r2 } from '../lib.js';

export const settledWorld = {
  name: 'settledWorld', group: 'world', kind: 'app', url: OUTCOMES.settledWorld.url, needs: [], cost: 110,
  title: 'the default island certifies idle (with water in it)',
  expressible: (e) => (e.app ? null : `${e.name} is a bare simulation: this test boots the game (engine-app.js)`),
  async run(e) {
    const O = OUTCOMES.settledWorld;
    const c = await e.census();
    const water = c.liquid.WATER ?? 0, salt = c.liquid.SALTWATER ?? 0;
    if (!(water + salt > 0)) throw new SetupError(`the window holds no water (${JSON.stringify(c.liquid)})`);
    const { idleAt, activity } = await advanceWatching(e, O.seconds, { every: 0.1 });
    return {
      headline: `${c.size.join('×')} window, ${Math.round(water)} water and ${Math.round(salt)} salt water cells: ${idleAt === null ? `${activity.awake} of ${activity.units} units still awake` : `idle at ${r2(idleAt)} s`}`,
      criteria: [crit('certifies idle', idleAt === null ? 'never' : r2(idleAt), idleAt !== null && idleAt <= O.seconds, `≤ ${O.seconds}`, 's')],
      evidence: [`liquid cells: ${JSON.stringify(c.liquid)}; cells by class: ${JSON.stringify(c.classes)}`],
      numbers: { idleAt, water, salt, awake: activity.awake, units: activity.units },
    };
  },
};

export default [settledWorld];
