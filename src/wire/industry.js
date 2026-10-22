import { createIndustry, validateIndustrySave } from '../industry/index.js';
import { registerSaveSection } from '../saves/sections.js';

export default {
  name: 'industry', ready: true,
  boot(app) {
    registerSaveSection('industry', {
      strict: true,
      save: () => app.industry?.toJSON(),
      validate: (data, header) => {
        if (data === undefined) {
          if (header.industryMode === 'factory') throw new Error('Factory save is missing its machines and economy');
          return; // saves predating Industry remain valid
        }
        validateIndustrySave(data, header.dims, header.preset);
        if (header.industryMode === 'factory' && !data.factoryRun) throw new Error('Factory save is missing its run');
      },
      load: data => app.industry?.fromJSON(data),
      absent: () => app.industry?.reset(), // old saves contain no machines; never mint starters into their terrain
    });
  },
  attach(app) { app.industry = createIndustry(app); },
  detach(app) { app.industry?.dispose(); app.industry = null; },
  // V1's machine clocks (a furnace's heat, a pump's and a ship's cadence, a drill's pulse, a gate's poll) run on
  // the frame's wall time, dt, on every frame the world runs (shaders/industry.js update's P.dt; industry/physics.js
  // step; gates.js step): V1 steps every frame it isn't paused. Under V2 a frame may run no tick (a display past
  // 60 Hz, a low Speed: app.js nativeHostSteps) and still counts its time, held for the next frame that ticks
  // (industry/index.js update). The decks' carry is game time, beside each tick (industry/physics.js nativeStep).
  afterStep(app, dt) {
    const running = app.stepping || (app.nativeStepped === 0 && !app.settings?.paused && !app.renderOnly);
    app.industry?.update(dt, app.stepping, running);
  },
  busy(app) { return !!(app.industry?.building || app.industry?.pending); },
  invalidate(app) { app.industry?.dispose(); app.industry = null; },
};
