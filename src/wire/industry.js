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
  afterStep(app, dt) { app.industry?.update(dt, app.stepping); },
  busy(app) { return !!(app.industry?.building || app.industry?.pending); },
  invalidate(app) { app.industry?.dispose(); app.industry = null; },
};
