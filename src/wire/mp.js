// Host-owned World window and read-only exploration replicas.
import { Vector3 } from 'three';
import { createMultiplayer } from '../net/multiplayer.js';
import { createRemotePlayers } from '../net/players.js';
import { leash } from '../net/protocol.js';
import { TEXEL_BYTES } from '../net/codec.js';
import world from './world.js';

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
      if (!sim || !app.mapKind.streamed) return null; // retain the legacy box wire format and editing compatibility
      const focus = p?.active && p.player ? p.player.pos.clone().add(sim.origin).toArray()
        : win ? world.godFocus(app).toSpliced(1, 0, 0)   // (the god view's window focus)
          : [app.controls.target.x / app.scale + app.anchor.x, 0, app.controls.target.z / app.scale + app.anchor.y];
      if (!p?.active) focus[1] = win ? win.scene.ground(focus[0], focus[2], win.P) + 1 : sim.g.ny / 2;
      return { v: 1, id: `${session}:${sim.id}:${win?.epoch ?? 0}:${app.settings.preset}`, mode: win ? 'world' : 'box',
        scene: win?.scene.key ?? app.settings.preset, seed: (win?.P.seed ?? 0) >>> 0,
        origin: sim.origin.toArray(), size: win?.size ?? [sim.g.nx, sim.g.ny, sim.g.nz], focus, away: document.hidden };
    };
    // A guest's world copy (docs/seamless-world.md, "W"): the whole map built here from the host's scene and
    // seed (setGrid made the window from the metadata's: the generator, its trees and structures, all
    // deterministic in them), then the streamed window's cells over it (noteWindowReplaced, each frame), so
    // the world march and the far field draw what the host's do. What the host changed outside the window
    // it streams (a save's bricks, edits left behind before the guest joined) can't be known here: the
    // copy shows the generated world there until the window passes over it. Drawing only: no window load,
    // no slab fill (attachWorldCopy), no physics; a replica's window never moves itself (wire/world.js).
    // Once a window: a session that starts over on the same map (sessionChanged) keeps the copy it has, its
    // cells already the host's through each frame's writeback.
    const copied = new WeakSet();
    const buildGuestCopy = (win) => {
      if (copied.has(win) || !app.worldView) return;
      copied.add(win);
      return app.worldView.build(win).then((copy) => {
        if (app.win !== win || !app.mp.replica || !copy?.bindGroup) return;
        win.far?.useWorldCopy?.(copy);   // the far field from it (world/far.js); one joining later takes it then
        app.wakeLoop();
      }, (err) => { copied.delete(win); throw err; });
    };
    const avatars = createRemotePlayers({ scene: app.scene, renderer: app.renderer, camera: app.camera,
      getSim: () => app.sim, getVolume: () => app.volume });
    app.mp = createMultiplayer({
      gpu: app.gpu, scene: app.scene, camera: app.camera, hud: app.hud,
      getSim: () => app.sim, getVolume: () => app.volume, setGrid: app.setGrid,
      mapKind: () => app.mapKind, score: () => app.scoreboard.mine, getMetadata: metadata,
      // a big map is hosted in Sandbox only (mapKind.js coopSandboxOnly)
      canHost: () => !app.mapKind.coopSandboxOnly || app.gamemode === 'sandbox', canStream: () => !app.mapKind.streamed || app.win.loaded, avatars,
      sessionChanged(role) {
        session++; map = ''; warp++;
        app.pov?.exit(true); app.pov?.worldReplaced();
        if (role === 'guest' && app.mapKind.streamed) app.win.epoch++; // cancel outstanding local generator work
      },
      commitFrame(meta, bytes) {
        // the frame's cells, written next in the same recording (net/codec.js), replace the window behind
        // V2's record of change (it never ticks here): the copy's next writeback compares every window brick
        // (world/worldCopy.js noteWindowReplaced)
        app.worldView?.worldCopy.noteWindowReplaced();
        // a box host's frame: the sea past the walls where its water reaches them (app.js boxSeaFrom)
        if (!meta) { if (bytes) app.boxSeaFrom((x, y, z) => bytes[app.sim.cellTexel(x, y, z) * TEXEL_BYTES]); return; }
        const old = app.sim.origin.clone();
        const replaced = map !== meta.id;
        app.sim.origin.fromArray(meta.origin);
        app.placeVolume();
        app.pov?.windowShifted(meta.origin[0] - old.x, meta.origin[2] - old.z);
        // A new map: its world copy, after the paired unpack write (the build's own writeback of the
        // window then holds this frame). A move rebuilds nothing: the copy is the whole world, and the
        // moved window's cells reach it through the frame's writeback. Never refill replica cells.
        if (app.mapKind.streamed) app.win.loaded = true;
        if (app.mapKind.streamed && replaced) {
          const win = app.win, token = ++backdrop;
          queueMicrotask(() => win.whenReady().then(() => {
            if (token === backdrop && app.win === win && app.mp.replica) return buildGuestCopy(win);
          }).catch((err) => console.error('multiplayer: the world copy was not built', err)));
        }
        if (replaced) {
          forceCatchup = true; warp++; app.post.reset();
          if (!app.pov?.active) { app.homeOver(meta.focus[0], meta.focus[2]); app.rig.reset(true); }
        }
        map = meta.id;
      },
      catchUp() { forceCatchup = true; },
      getControlContext() {
        const sim = app.sim;
        if (!sim) return null;
        return { map: session + ':' + sim.id + ':' + (app.win?.epoch ?? 0) + ':' + app.settings.preset + ':' + app.settings.scene + ':' + app.worldSeed + ':' + (app.electronics?.generation ?? 0),
          origin: sim.origin.toArray(), size: [sim.g.nx, sim.g.ny, sim.g.nz] };
      },
      getControlPose(source, actionRay) {
        const p = app.pov?.player, look = app.pov?.networkLook;
        if (source === 'god') {
          return { active: !app.pov?.active, p: actionRay?.eye?.slice(), dir: actionRay?.dir?.slice(),
            eyeHeight: 5, crouch: 0, yaw: 0, pitch: 0, warp };
        }
        return { active: !!(app.pov?.active && p && !p.dead && !app.pov.networkPending),
          p: p ? p.pos.clone().add(app.sim.origin).toArray() : [0, 0, 0], eyeHeight: p?.eyeHeight ?? 5,
          crouch: p?.crouch ?? 0, yaw: look?.yaw ?? 0, pitch: look?.pitch ?? 0,
          warp: warp + (app.pov?.networkWarp ?? 0) };
      },
      controlUse({ eye, dir, expected, source, valid }) {
        if (!app.electronics || !valid()) return;
        return app.electronics.useRay(new Vector3(...eye).sub(app.sim.origin), new Vector3(...dir),
          { source, expected, authority: valid });
      },
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
