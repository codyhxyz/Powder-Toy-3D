// Multiplayer (src/net; docs/webgpu.md G4, U12): a host streams its box to
// guests through the codec's pack kernel, a guest paints through the host.
// Moved here from app.js as it was (WebGL): U12 ports it. Until then the app
// plays alone: `offline` stands in for the session, so app.js's guards say
// yes, no one is a guest, and nothing joins.
import { createMultiplayer } from '../net/multiplayer.js';

/** The session while multiplayer isn't wired: alone, always the host. */
export const offline = Object.freeze({
  isGuest: false, joining: false, players: [], chatAvailable: false, panelOpen: false,
  guard: () => false, guardWorld: () => false,
  paint: () => {}, fill: () => {}, openChat: () => {}, closePanel: () => {}, update: () => {},
});

const mp = {
  name: 'mp',
  ready: false,

  boot(app) {
    app.mp = createMultiplayer({
      renderer: app.renderer, scene: app.scene, camera: app.camera, hud: app.hud, getSim: () => app.sim, getVolume: () => app.volume,
      setGrid: app.setGrid, inWorld: () => !!app.win, score: () => app.scoreboard.mine,
    });
  },
  afterStep(app, dt) {
    if (app.renderOnly) return;
    app.mp.update(dt, {
      visible: app.brushValid && app.pointerInside && !app.uiHover, center: app.brushCenter, painting: app.painting,
      radius: app.settings.radius, shape: app.settings.shape, tool: app.settings.tool,
    });
  },
  // a live session keeps the loop going (its peers' strokes and frames arrive between ticks)
  busy(app) { return app.mp !== offline && (app.mp.isGuest || app.mp.players?.length > 1); },
};

export default mp;
