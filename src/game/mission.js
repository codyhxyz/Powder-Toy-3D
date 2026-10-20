import * as THREE from 'three';
import { createMissionAttempt, validMission } from './missionRules.js';
import { PLAYER } from '../pov/targets.js';
import { povEvents } from '../pov/events.js';
import { crueltyProfile } from './crueltyProfiles.js';

// cells from a World window's edge an NPC must be inside to be simulated: its body's probe and the
// AI's world model only hold the window's cells (a box's whole grid is resident)
const RESIDENT_MARGIN = 2;
export const residentIn = (p, g) => !g?.windowed
  || (p.x >= RESIDENT_MARGIN && p.z >= RESIDENT_MARGIN && p.x < g.nx - RESIDENT_MARGIN && p.z < g.nz - RESIDENT_MARGIN);

// Narrow adapter: existing NPC bodies/tools/combat, an authored mission, one attempt.
// No random spawns, match respawn, automatic next round, or fabricated level geometry.
export function createMission(shell) {
  let epoch = 0, attempt = null, manifest = null, mapKey = null, loading = false;
  const actors = new Map();
  const local = (at) => new THREE.Vector3(...at).sub(shell.app.getSim().origin);
  let visible = false, priorTools = null;
  const updateHud = () => shell.hud?.update(attempt ? { ...attempt.state, name: manifest.name, extraction: manifest.extraction } : null, visible);

  function end() {
    epoch++;
    loading = false;
    for (const n of actors.values()) { shell.scene.remove(n.root); n.dispose(); }
    actors.clear();
    if (priorTools && shell.toolbelt) {
      shell.toolbelt.restrict(priorTools.restricted, priorTools.selected);
      if (priorTools.selected) shell.toolbelt.select(priorTools.selected);
      priorTools = null;
    }
    attempt?.stop();
    attempt = manifest = mapKey = null;
    shell.markers?.clear();
    updateHud();
  }

  async function start(map) {
    end();
    if (!validMission(map?.mission) || !shell.player) return false;
    const token = epoch;
    loading = true;
    try {
      const { mod, ai } = await shell.loadNpcs();
      if (token !== epoch) return false;
      manifest = map.mission;
      mapKey = map.key;
      attempt = createMissionAttempt(manifest);
      visible = true;
      shell.respawnPlayer(local(manifest.spawn));
      if (shell.toolbelt) {
        priorTools = { restricted: shell.toolbelt.restricted, selected: shell.toolbelt.selectedKey };
        shell.toolbelt.restrict(['GUN', 'SMG'], 'GUN');
        shell.toolbelt.select('GUN');
      }
      for (const [spec, target] of [...manifest.targets.map((s) => [s, true]), ...manifest.guards.map((s) => [s, false])]) {
        const combatProfile = crueltyProfile(spec, { target, cellMeters: map.cellMeters });
        const playerThreat = () => ({ id: PLAYER, pos: shell.player.pos, vel: shell.player.vel,
          alive: !shell.player.dead && attempt?.state.phase === 'active', holding: shell.toolbelt?.selectedKey });
        const n = mod.createNpc({ env: shell.env(), ai, oneShot: true, name: spec.name, combatProfile,
          style: spec.style ?? 'axeman', home: () => local(spec.at), threat: playerThreat,
          opponents: () => combatProfile.civilian ? [] : [playerThreat()],
        });
        // Far authored actors may be outside a streamed window at entry. Keep their
        // actual world position until that window covers them; don't simulate unloaded air.
        n.body.pos.copy(local(spec.at));
        n.agent.weapons = new Set(combatProfile.weapons);
        n.body.on('revenge', ({ point }) => povEvents.emit('blast', { point }));
        n.body.on('death', () => { if (target && token === epoch) attempt?.eliminate(spec.id); });
        n.missionTarget = target;
        actors.set(spec.id, n);
        shell.scene.add(n.root);
        shell.compile?.(n);
      }
      updateHud();
      return true;
    } catch (error) {
      if (token === epoch) end();
      throw error;
    } finally { if (token === epoch) loading = false; }
  }

  function update(dt, frame) {
    if (!attempt) return;
    if (frame && attempt.state.phase === 'active') {
      const g = shell.app.getSim().g;
      for (const n of actors.values()) {
        const p = n.body.pos;
        const resident = residentIn(p, g);
        n.setVisible(visible && resident);
        if (!resident) continue;
        shell.bind?.(n);
        n.update(dt, frame);
      }
      // Body state is authoritative for every cause, not only credited weapon kills.
      for (const [id, n] of actors) if (n.missionTarget && n.body.dead) attempt.eliminate(id);
      const world = shell.player.pos.clone().add(shell.app.getSim().origin);
      const before = attempt.state.phase;
      const phase = attempt.update({ dead: shell.player.dead, at: world, width: shell.player.width, height: shell.player.height });
      if (phase !== before) {
        shell.freeMouse?.();
        povEvents.emit(`mission:${phase}`, { id: manifest.id });
      }
    }
    shell.markers?.zones((manifest.extractions ?? [manifest.extraction]).map(e => {
      if (!e.bounds) return { ...local(e.at), r: e.radius };
      const lo = local(e.bounds.min), hi = local(e.bounds.max);
      return { x: (lo.x + hi.x) / 2, y: lo.y, z: (lo.z + hi.z) / 2,
        points: e.points?.map(p => local(p).toArray()),
        bounds: { min: lo.toArray(), max: hi.toArray() } };
    }));
    shell.markers?.setVisible(visible);
    shell.markers?.update({ time: performance.now() / 1000, myTeam: 'red', bots: [...actors.values()].filter((n) => n.missionTarget)
      .map((n) => ({ id: n.id, pos: n.body.pos, alive: !n.body.dead, team: 'red' })) });
    updateHud();
  }

  return {
    start, end, update,
    retry() { return mapKey ? shell.app.openMap(mapKey, 'crueltySquad') : false; },
    get engaged() { return loading || !!attempt; },
    get active() { return attempt?.state.phase === 'active'; },
    get actors() { return [...actors.values()]; },
    get state() { return attempt ? { ...attempt.state, id: manifest.id, map: mapKey } : null; },
    setVisible(v) { visible = v; for (const n of actors.values()) n.setVisible(v); shell.markers?.setVisible(v); updateHud(); },
    // (navigation goals and sight records were in the previous window's local cells: pov/npc.js)
    windowShifted(dx, dz) { for (const n of actors.values()) n.windowShifted(dx, dz); },
  };
}
