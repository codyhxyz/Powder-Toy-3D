// Host-owned World window and read-only exploration replicas.
import { Vector3 } from 'three';
import { createMultiplayer } from '../net/multiplayer.js';
import { createRemotePlayers } from '../net/players.js';
import { leash } from '../net/protocol.js';

export const offline = Object.freeze({
  isGuest: false, replica: false, joining: false, players: [], chatAvailable: false, panelOpen: false,
  guard: () => false, guardWorld: () => false,
  paint: () => {}, fill: () => {}, openChat: () => {}, closePanel: () => {}, update: () => {},
});

const mp = {
  name: 'mp', ready: true,
  boot(app) {
    let session = 0, map = '', warp = 0, forceCatchup = false, backdrop = 0;
    const metadata = () => {
      const sim = app.sim, win = app.win, p = app.pov;
      if (!sim || !win) return null; // retain the legacy box wire format and editing compatibility
      const focus = p?.active && p.player ? p.player.pos.clone().add(sim.origin).toArray()
        : [app.controls.target.x / app.scale + app.anchor.x, 0, app.controls.target.z / app.scale + app.anchor.y];
      if (!p?.active) focus[1] = win ? win.scene.ground(focus[0], focus[2], win.P) + 1 : sim.g.ny / 2;
      return { v: 1, id: `${session}:${sim.id}:${win?.epoch ?? 0}:${app.settings.preset}`, mode: win ? 'world' : 'box',
        scene: win?.scene.key ?? app.settings.preset, seed: (win?.P.seed ?? 0) >>> 0,
        origin: sim.origin.toArray(), size: win?.size ?? [sim.g.nx, sim.g.ny, sim.g.nz], focus, away: document.hidden };
    };
    const avatars = createRemotePlayers({ scene: app.scene, renderer: app.renderer, camera: app.camera,
      getSim: () => app.sim, getVolume: () => app.volume });
    app.mp = createMultiplayer({
      gpu: app.gpu, scene: app.scene, camera: app.camera, hud: app.hud,
      getSim: () => app.sim, getVolume: () => app.volume, setGrid: app.setGrid,
      inWorld: () => !!app.win, score: () => app.scoreboard.mine, getMetadata: metadata,
      canHost: () => !app.win || app.gamemode === 'sandbox', canStream: () => !app.win || app.win.loaded, avatars,
      sessionChanged(role) {
        session++; map = ''; warp++;
        app.pov?.exit(true); app.pov?.worldReplaced();
        if (role === 'guest' && app.win) app.win.epoch++; // cancel outstanding local generator work
      },
      commitFrame(meta) {
        if (!meta) return;
        const old = app.sim.origin.clone();
        const moved = old.x !== meta.origin[0] || old.z !== meta.origin[2];
        const replaced = map !== meta.id;
        app.sim.origin.fromArray(meta.origin);
        app.placeVolume();
        app.pov?.windowShifted(meta.origin[0] - old.x, meta.origin[2] - old.z);
        // Backdrop only, after the paired unpack write. Never refill replica cells.
        if (app.win && (replaced || moved)) {
          const win = app.win, token = ++backdrop;
          win.loaded = true;
          queueMicrotask(() => win.whenReady().then(() => {
            if (token === backdrop && app.win === win && app.mp.replica) win.far?.build();
          }).catch(() => {}));
        }
        if (replaced) {
          forceCatchup = true; warp++; app.post.reset();
          if (!app.pov?.active) { app.homeOver(meta.focus[0], meta.focus[2]); app.rig.reset(true); }
        }
        map = meta.id;
      },
      catchUp() { forceCatchup = true; },
      getPose() {
        const p = app.pov?.player, look = app.pov?.networkLook;
        return { active: !!(app.pov?.active && p && !p.dead && !app.pov.networkPending),
          p: p ? p.pos.clone().add(app.sim.origin).toArray() : metadata()?.focus ?? [0, 0, 0],
          vel: p ? p.vel.toArray() : [0, 0, 0], yaw: look?.yaw ?? 0, pitch: look?.pitch ?? 0,
          warp: warp + (app.pov?.networkWarp ?? 0), ground: !!p?.onGround, liquid: !!p?.inLiquid, jet: !!p?.jetting };
      },
    });
    // Runs before the player's collision update, and again after to enforce the
    // soft boundary. Only the host follows/streams; guests never drive WorldWindow.
    app.coopMove = (after = false) => {
      const net = app.mp, pov = app.pov, p = pov?.player, m = net.metadata;
      if (!net.isGuest || !pov?.active || !p || !m) return;
      const g = app.sim.g, b = leash(m, [g.nx, g.ny, g.nz], p.pos.clone().add(app.sim.origin).toArray());
      if (!after && (forceCatchup || b.outside)) {
        pov.networkCatchup(new Vector3(...b.target).sub(app.sim.origin)); forceCatchup = false; warp++;
        app.hud.toast('Catching up to the host — World co-op stays in their loaded area.');
      } else if (after && b.outside) {
        for (const i of [0, 2]) {
          const n = p.pos.getComponent(i) + m.origin[i];
          if (n < b.lo[i] || n > b.hi[i]) {
            p.pos.setComponent(i, Math.max(b.lo[i], Math.min(b.hi[i], n)) - m.origin[i]); p.vel.setComponent(i, 0);
          }
        }
      }
    };
  },
  afterStep(app, dt) {
    if (app.renderOnly) return;
    app.mp.update(dt, {
      visible: !app.pov?.active && app.brushValid && app.pointerInside && !app.uiHover,
      center: app.brushCenter, painting: app.painting,
      radius: app.settings.radius, shape: app.settings.shape, tool: app.settings.tool,
    });
  },
  busy(app) { return app.mp !== offline && (app.mp.isGuest || app.mp.players?.length > 1); },
};
export default mp;
