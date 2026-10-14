import * as THREE from 'three';
import { HOMES, FLOOR, HOME_Z, HOME_ENTRY, ITEMS, RESIDENTS, DRESSER, initialState, loadState, change, bounds, overlaps, carryTarget, placementError,
  cardinal, playerPathClear, gripPosition, standPosition, gripMove, moveProgress, restPose, drawerFrame } from './state.js';
import { residentFurniture, createConversation, advanceConversation, hydrateMemory } from './residents.js';
import { resolveCharacterMotion } from './characterCollision.js';
import { povEvents } from '../events.js';
import { character, furniture, nameplate, speechBubble, dispose } from './models.js';
import { createSpeech } from './speech.js';
import { createVillageUi } from './ui.js';
import { attachModel } from '../models.js';
import { VILLAGE_TOOLS, PUNCH_COOLDOWN, PUNCH_DURATION, PUNCH_CONTACT, punchTarget, punchOccluded, stepResident } from './actions.js';
import { TIM_CROOK, crookDialogue } from './crook.js';
import { createCrookController } from './crookController.js';
import { ELEMENTS, K } from '../../elements.js';

export function createVillage({ app, getPlayer, live, freeMouse, releaseInput, releaseActions, camera, onEnabled, onTool, useTool, toolReadout }) {
  const root = new THREE.Group(); root.name = 'willow-village'; root.visible = false; app.scene.add(root);
  const persona = () => app.settings?.villageCharacter === 'girl' ? 'girl' : 'boy';
  let avatar = character({ persona: persona() });
  const speech = createSpeech(); app.scene.add(avatar.root); avatar.root.visible = false;
  let enabled = false, size = null, state = initialState(), writable = true, warning = '', saveKey = '';
  let residents = [], furnishings = null, time = 0, speaking = null, oldThird = false;
  let interaction = null, feedback = '', lastBlocked = -Infinity;
  let memories = {}, memoryWritable = true, memoryKey = '';
  const ownMeshes = new Map(), anchoredAt = new THREE.Vector3();
  let held = null, tool = null, toolModel = null, toolMaterials = [], usingTool = false;
  let punchAt = -Infinity, punchSerial = 0, kicking = false, reaction = '', reactionUntil = 0;
  let pendingPunch = null;
  let crook = null, crookModel = null, worldSeed = null;
  let bodyFrom = null, crookMotionFrom = null;
  function equip(key) {
    if (interaction || !VILLAGE_TOOLS.some(t => t.key === key)) return;
    releaseActions(); punchSerial++; tool = key; onTool(key);
    toolModel?.dispose(); toolModel = null;
    toolMaterials.forEach(m => m.dispose()); toolMaterials = [];
    if (key) {
      toolModel = attachModel(avatar.hand, key.toLowerCase(), null, { arm: false });
      toolModel.obj.position.set(0, -0.8, 0); toolModel.obj.rotation.x = -0.9; toolModel.obj.scale.setScalar(0.7);
      toolModel.obj.traverse(o => {
        if (!o.isMesh) return;
        const material = new THREE.MeshBasicMaterial({ color: o.material.color ?? '#888888', vertexColors: !!o.geometry.attributes.color });
        toolMaterials.push(material); o.material = material;
      });
    }
  }
  async function punch(kick = false) {
    if (!context().active || ui.opened || held || interaction || (!kick && tool) || time - punchAt < PUNCH_COOLDOWN) return;
    punchAt = time; kicking = kick;
    pendingPunch = null;
    speech.swing(PUNCH_CONTACT);
    const token = ++punchSerial, sim = app.getSim(), home = room(), l = local();
    app.requestRender();
    const target = punchTarget(l && { x: l.x - HOMES[home], y: l.y, z: l.z }, camera.look.yaw, residents, home);
    if (!target) return;
    const r = target.resident, origin = sim.origin.clone();
    const start = getPlayer().pos.clone().add(new THREE.Vector3(0, 3, 0));
    const end = new THREE.Vector3(size[0] / 2 + HOMES[home] + r.x, FLOOR + 3, size[2] / 2 + HOME_Z + r.z).sub(origin);
    const distance = start.distanceTo(end), dir = end.clone().sub(start).normalize();
    try {
      const hit = await app.pickRay(start, dir);
      if (token !== punchSerial || !context().active || ui.opened || held || interaction || app.getSim() !== sim || !sim.origin.equals(origin)
        || room() !== home || getPlayer().pos.distanceTo(start.clone().setY(start.y - 3)) > 1) return;
      if (punchOccluded(hit, start, distance)) return;
      pendingPunch = { token, sim, home, r, origin, start, dir };
      landPunch();
    } catch { /* A failed world probe must never punch through terrain. */ }
  }
  function landPunch() {
    if (!pendingPunch || time - punchAt < PUNCH_CONTACT) return;
    const { token, sim, home, r, origin, start, dir } = pendingPunch; pendingPunch = null;
    if (token !== punchSerial || time - punchAt > PUNCH_COOLDOWN || !context().active || ui.opened || held || interaction
      || app.getSim() !== sim || !sim.origin.equals(origin) || room() !== home
      || getPlayer().pos.distanceTo(start.clone().setY(start.y - 3)) > 1) return;
    const now = local(), still = punchTarget({ x: now.x - HOMES[home], y: now.y, z: now.z }, camera.look.yaw, residents, home);
    if (still?.resident !== r) return;
    r.vx = dir.x * 44; r.vz = dir.z * 44; r.vy = 8; r.bonk = 0.9;
    r.replyUntil = time + 2;
    reaction = `${r.spec.name}: Hey! Boing!`; reactionUntil = time + 2;
    speech.speak('Hey! Boing!', r.spec.pitch); speech.bonk(); app.requestRender();
  }
  const previous = new THREE.Vector3();
  const local = () => {
    const p = getPlayer(); if (!p || !size) return null;
    return p.pos.clone().add(app.getSim().origin).sub(new THREE.Vector3(size[0] / 2, FLOOR, size[2] / 2 + HOME_Z));
  };
  function room(p = local()) {
    if (!p || p.y < -1 || p.y > 12) return -1;
    return HOMES.findIndex(x => Math.abs(p.x - x) < 10 && Math.abs(p.z) < 10);
  }
  const roomPosition = (home = 0) => { const p = local(); return p ? { x: p.x - HOMES[home], z: p.z } : null; };
  const ownPosition = () => roomPosition();
  const roomState = home => home === 0 ? state : { placed: residentFurniture(home) };
  function charactersClear(home, from, to) {
    const radius = 1.4 * getPlayer().size;
    const obstacles = residents.map(r => ({ x: HOMES[r.spec.home] - HOMES[home] + r.x, z: r.z, radius: 1.4 }));
    if (crook?.visible) obstacles.push({ x: HOMES[0] - HOMES[home] + crook.position.x, z: crook.position.z, radius: 1.4 });
    const next = resolveCharacterMotion(from, to, radius, obstacles);
    return Math.hypot(next.x - to.x, next.z - to.z) < 1e-7
      && obstacles.every(r => Math.hypot(to.x - r.x, to.z - r.z) >= radius + r.radius - 1e-7);
  }
  function context() {
    const p = ownPosition(), active = enabled && live() && !document.hidden && !document.querySelector('.mm.open');
    return { active, home: active && room() === 0, dresser: active && room() === 0 && Math.hypot(p.x - DRESSER.x, p.z - DRESSER.z) <= 5.5,
      player: p, state, crook: crookSnapshot(), warning: warning + (crook?.warning ?? ''), feedback, muted: speech.muted, tool, readout: toolReadout?.(), reaction: time < reactionUntil ? reaction : '',
      grip: interaction?.kind === 'grip' ? { name: ITEMS[interaction.item.kind].name, moving: !!interaction.move } : null,
      rest: ['sit', 'sleep'].includes(interaction?.kind) ? interaction.kind : null,
      busy: interaction?.kind === 'dresser' && interaction.phase !== 'open',
      storageReady: interaction?.kind === 'dresser' && interaction.phase === 'open',
      carry: held ? { name: ITEMS[held.item.kind].name, rotation: held.item.rotation, error: held.error } : null };
  }
  function at(root, home, item) {
    root.position.set(size[0] / 2 + HOMES[home] + item.x, FLOOR, size[2] / 2 + HOME_Z + item.z);
    root.rotation.y = (item.rotation ?? 0) * Math.PI / 2;
  }
  function rebuildFurniture() {
    if (furnishings) dispose(furnishings);
    ownMeshes.clear();
    furnishings = new THREE.Group(); root.add(furnishings);
    for (let home = 0; home < 4; home++) {
      const list = home === 0 ? state.placed : residentFurniture(home);
      for (const item of [DRESSER, ...list]) {
        if (home === 0 && item.id === held?.item.id) continue;
        const model = furniture(item.kind); at(model, home, item); furnishings.add(model);
        if (home === 0) ownMeshes.set(item.id, model);
      }
    }
    drawInteraction();
  }
  function distance(item, p = ownPosition()) {
    const b = bounds(item);
    return Math.hypot(Math.max(b.x - p.x, 0, p.x - b.x - b.w), Math.max(b.z - p.z, 0, p.z - b.z - b.d));
  }
  function fail(error) {
    feedback = error;
    if (time - lastBlocked >= 0.3) { lastBlocked = time; povEvents.emit('village:blocked'); }
    app.requestRender();
    return { error };
  }
  function saveState(next) {
    state = next; feedback = '';
    if (writable) {
      try { localStorage.setItem(saveKey, JSON.stringify(state)); }
      catch { warning = 'Your changes are in memory only: browser storage is full or unavailable.'; }
    }
  }
  function setPlayer(point, home = interaction?.home ?? 0) {
    const p = getPlayer(), origin = app.getSim().origin;
    if (!p) return;
    p.pos.set(size[0] / 2 + HOMES[home] + point.x - origin.x, FLOOR - origin.y,
      size[2] / 2 + HOME_Z + point.z - origin.z);
    p.vel.set(0, 0, 0); p.onGround = true;
    anchoredAt.copy(p.pos).add(origin);
  }
  function drawInteraction() {
    if (interaction?.kind === 'grip') {
      const model = ownMeshes.get(interaction.item.id);
      if (model) at(model, 0, interaction.visual ?? interaction.item);
    }
    const drawer = ownMeshes.get(DRESSER.id)?.userData.drawer;
    if (drawer) drawer.position.z = interaction?.kind === 'dresser' ? -0.65 * interaction.drawer.extension : 0;
  }
  function beginInteraction(kind, item, position, yaw, extra = {}) {
    const entry = roomPosition(extra.home ?? 0);
    ui.close(); releaseInput(); releaseActions(); punchSerial++; punchAt = -Infinity; usingTool = false;
    interaction = { kind, home: 0, item: { ...item }, position: { x: position.x, z: position.z }, entry, yaw,
      radius: getPlayer().width / 2, elapsed: 0, pitch: camera.look.pitch, third: camera.third, ...extra };
    feedback = '';
    camera.third = true; camera.look.pitch = Math.min(camera.look.pitch, -0.6);
    setPlayer(interaction.position); drawInteraction(); app.requestRender();
    return {};
  }
  function endInteraction(relocate = true, force = false) {
    const s = interaction;
    if (!s) return {};
    let destination = s.move?.fromPlayer ?? s.position;
    if (relocate && ['sit', 'sleep'].includes(s.kind)) {
      destination = standPosition(roomState(s.home), s.item, s.position, s.entry, getPlayer().width / 2,
        p => charactersClear(s.home, s.position, p));
      if (!destination && force) destination = HOME_ENTRY;
      if (!destination) return fail('There is no clear place to stand.');
    }
    const model = ownMeshes.get(s.item.id), saved = state.placed.find(i => i.id === s.item.id);
    if (model && saved) at(model, 0, saved);
    camera.look.pitch = s.pitch; camera.third = s.third;
    interaction = null; feedback = '';
    if (relocate && getPlayer() && !getPlayer().dead) setPlayer(destination, s.home);
    drawInteraction(); releaseInput(); app.requestRender();
    return {};
  }
  function closeDresser() {
    if (interaction?.kind !== 'dresser' || interaction.phase === 'closing') return;
    interaction.from = interaction.drawer.extension;
    interaction.phase = 'closing'; interaction.elapsed = 0; interaction.pending = null;
    releaseInput(); app.requestRender();
  }
  function checkInteraction() {
    if (!interaction) return;
    const p = getPlayer();
    const relocated = p && p.pos.clone().add(app.getSim().origin).distanceTo(anchoredAt) > 0.25;
    if (!p || p.dead || relocated) {
      ui.close(); endInteraction(false, true);
    } else if (!context().active || room() !== interaction.home) {
      ui.close(); endInteraction(true, true);
    }
  }
  function startRest(item, home = room()) {
    const p = getPlayer(), pose = restPose(item, p?.size), c = context();
    const here = roomPosition(home);
    if (!pose || home < 0 || !c.active || held || interaction || Math.abs(local().y) > 0.75 || distance(item, here) > 2.5)
      return fail('Walk up to a chair or bed first.');
    if (!playerPathClear(roomState(home), here, pose, p.width / 2, item.id) || !charactersClear(home, here, pose))
      return fail('There is no clear way to rest there.');
    return beginInteraction(pose.kind, item, pose, pose.yaw, { pose, home });
  }
  function openDresser(pending = null) {
    const c = context(), p = getPlayer();
    if (!c.dresser || held || interaction || Math.abs(local().y) > 0.75)
      return fail('Stand in front of your dresser to open it.');
    const yaw = DRESSER.rotation * Math.PI / 2, reach = ITEMS.dresser.d / 2 + p.width / 2 + 0.12;
    const position = { x: DRESSER.x - Math.sin(yaw) * reach, z: DRESSER.z - Math.cos(yaw) * reach };
    if (!playerPathClear(state, c.player, position, p.width / 2)) return fail('Leave room in front of the dresser.');
    beginInteraction('dresser', DRESSER, position, yaw + Math.PI,
      { phase: 'opening', drawer: drawerFrame(0), pending });
    return { pending: true };
  }
  function tickInteraction(dt, input) {
    const s = interaction;
    if (!s) return;
    if (s.kind === 'grip') {
      s.elapsed += dt;
      s.wait = Math.max(0, (s.wait ?? 0) - dt);
      const direction = cardinal(input?.move ?? { x: 0, z: 0 });
      if (!s.move && !s.wait && direction) {
        const result = gripMove(state, s.item, s.position, direction, s.radius);
        if (result.error) { s.wait = 0.35; fail(result.error); }
        else s.move = { ...result, from: { ...s.item }, fromPlayer: { ...s.position }, elapsed: 0 };
      }
      if (s.move) {
        const m = s.move;
        m.elapsed = Math.min(0.35, m.elapsed + dt);
        const t = moveProgress(m.elapsed);
        s.visual = { ...m.from, x: THREE.MathUtils.lerp(m.from.x, m.target.x, t), z: THREE.MathUtils.lerp(m.from.z, m.target.z, t) };
        s.position = { x: THREE.MathUtils.lerp(m.fromPlayer.x, m.player.x, t), z: THREE.MathUtils.lerp(m.fromPlayer.z, m.player.z, t) };
        if (m.elapsed >= 0.35) {
          // gripMove already swept the actual body radius; pocket placement's
          // fixed one-cell clearance would reject the normal 0.8-cell grip.
          const result = change(state, { type: 'place', ...m.target }, { home: true });
          if (result.error) { s.position = m.fromPlayer; fail(result.error); }
          else { saveState(result.state); s.item = m.target; s.position = m.player; }
          s.visual = null; s.move = null;
        }
      }
    } else if (s.kind === 'dresser') {
      s.elapsed += dt;
      s.drawer = drawerFrame(s.elapsed, s.phase === 'closing', s.from);
      if (s.phase === 'closing' && s.drawer.done) { endInteraction(); return; }
      if (s.phase === 'opening' && s.drawer.ready) {
        s.phase = 'open';
        const pending = s.pending; s.pending = null;
        if (pending) act(pending);
        ui.open('storage');
      }
    }
    drawInteraction();
  }
  function updateHeld() {
    if (!held) return;
    held.target = carryTarget(held.item, ownPosition(), camera.look.yaw);
    held.error = room() === 0 ? placementError(state, held.target, ownPosition()) : 'Keep furniture inside your home.';
    at(held.root, 0, held.target);
    held.model.position.y = 0.5 + Math.sin(time * 3) * 0.08;
    held.marker.material.color.set(held.error ? '#d66e53' : '#63bd95');
    held.model.traverse(o => { if (o.material) o.material.color.set(held.error ? '#ffc3af' : '#ffffff'); });
    held.root.visible = live();
  }
  function releaseHeld() {
    if (!held) return;
    camera.look.pitch = held.pitch; camera.third = held.third;
    dispose(held.root); held = null;
  }
  function grab(id) {
    const c = context(), item = [...state.placed, ...state.pockets].find(i => i.id === id);
    if (!c.home || !item || (state.placed.includes(item) && distance(item) > 2.5)) return { error: 'Walk up to furniture in your own home to grab it.' };
    if (held || interaction) return fail('Finish this interaction first.');
    if (state.placed.includes(item)) {
      if (Math.abs(local().y) > 0.75) return fail('Stand on the floor to grip furniture.');
      const position = gripPosition(state, item, c.player, getPlayer().width / 2);
      if (!position) return fail('There is no clear side to grip. Try another side.');
      return beginInteraction('grip', item, position, Math.atan2(position.x - item.x, position.z - item.z));
    }
    punchSerial++;
    ui.close();
    const model = furniture(item.kind), carrying = new THREE.Group();
    const marker = new THREE.Mesh(new THREE.PlaneGeometry(ITEMS[item.kind].w, ITEMS[item.kind].d),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }));
    marker.rotation.x = -Math.PI / 2; marker.position.y = 0.06;
    model.traverse(o => { if (o.material) { o.material.transparent = true; o.material.opacity = 0.88; o.material.depthWrite = false; } });
    carrying.add(model, marker); root.add(carrying);
    held = { item: { ...item, rotation: item.rotation ?? 0 }, root: carrying, model, marker,
      pitch: camera.look.pitch, third: camera.third, target: null, error: null };
    // A downward decorating view keeps the destination visible over the
    // character's head, rather than hiding the held piece behind the avatar.
    camera.look.pitch = Math.min(camera.look.pitch, -1.2); camera.third = true;
    rebuildFurniture(); updateHeld(); ui.update({ active: true, place: 'Home, sweet home' }); app.requestRender();
    return {};
  }
  function nearby() {
    if (!context().active || held || interaction) return null;
    const p = local(), home = room(p);
    if (crook?.visible && !crook.state.complete && p.y < 1 && p.z < -13
      && Math.hypot(p.x - HOMES[0] - crook.position.x, p.z - crook.position.z) < 7)
      return { title: 'Talk to Tim Crook', use: () => { if (crook.talk()) { speaking = crook; chat(); } } };
    if (home >= 0) {
      const here = roomPosition(home), forward = camera.forwardH(new THREE.Vector3());
      const item = [DRESSER, ...roomState(home).placed].filter(i => {
        if (home !== 0 && !restPose(i)) return false;
        const b = bounds(i), dx = THREE.MathUtils.clamp(here.x, b.x, b.x + b.w) - here.x;
        const dz = THREE.MathUtils.clamp(here.z, b.z, b.z + b.d) - here.z;
        return distance(i, here) <= 2.5 && (dx * forward.x + dz * forward.z >= Math.hypot(dx, dz) * 0.2);
      }).sort((a, b) => distance(a, here) - distance(b, here))[0];
      if (item === DRESSER) return { title: 'Open dresser', use: () => openDresser() };
      const pose = restPose(item);
      if (pose) return {
        title: `${pose.kind === 'sleep' ? 'Sleep in' : 'Sit on'} ${ITEMS[item.kind].name.toLowerCase()}`,
        use: () => startRest(item, home),
        secondary: home === 0 ? { title: `Grab ${ITEMS[item.kind].name.toLowerCase()}`, use: () => grab(item.id) } : null,
      };
      if (home === 0) return item ? { title: `Grab ${ITEMS[item.kind].name.toLowerCase()}`, use: () => grab(item.id) } : null;
    }
    const r = residents.find(r => r.spec.home === home && Math.hypot(p.x - HOMES[home] - r.x, p.z - r.z) < 7);
    return r ? { title: `Talk to ${r.spec.name}`, use: () => { speaking = r; chat(undefined, true); } } : null;
  }
  function chat(choiceId, first = false) {
    if (speaking === crook && crook) {
      if (!context().active) { ui.close(); return; }
      if (choiceId !== undefined) crook.answer(choiceId);
      if (crook.state.complete) { ui.close(); return; }
      const line = crookDialogue(crook.state);
      ui.talk(TIM_CROOK, line.text, line.choices, { choiceOnly: true });
      speech.speak(line.text, TIM_CROOK.pitch);
      return;
    }
    if (!speaking || !context().active || room() !== speaking.spec.home) { ui.close(); return; }
    const r = speaking.spec, ctx = { home: r.home, hour: new Date().getHours(), furniture: residentFurniture(r.home) };
    const result = first ? createConversation(r, memories[r.name], ctx)
      : advanceConversation(r, memories[r.name], choiceId, ctx);
    memories[r.name] = result.memory;
    if (memoryWritable) {
      try { localStorage.setItem(memoryKey, JSON.stringify({ version: 1, residents: memories })); }
      catch { warning = 'Neighbor memories cannot be saved in this browser.'; }
    }
    ui.talk(r, result.text, result.choices); speech.speak(result.text, r.pitch);
  }
  function act(action) {
    if (!context().active) return { error: 'Enter the village to use your furniture.' };
    if (ui.talking) return { error: 'Finish or close the conversation first.' };
    if (action.type === 'punch') { void punch(); return {}; }
    if (action.type === 'tool') { if (!ui.opened && !held && !interaction) equip(action.key); return {}; }
    if (action.type === 'kick') { void punch(true); return {}; }
    if (action.type === 'tool-primary' || action.type === 'tool-secondary') {
      if (!ui.opened && !held && !interaction && tool) useTool(action.type === 'tool-primary' ? 'primary' : 'secondary');
      return {};
    }
    if (action.type === 'interact') {
      if (held) return act({ type: 'drop' });
      if (interaction) return act({ type: 'cancel' });
      return nearby()?.use() ?? {};
    }
    if (action.type === 'secondary') return nearby()?.secondary?.use() ?? {};
    if (action.type === 'rest') return startRest(roomState(room()).placed.find(i => i.id === action.id));
    if (action.type === 'openStorage') return openDresser();
    if (action.type === 'grab') return grab(action.id);
    if (action.type === 'cancel') {
      if (interaction?.kind === 'dresser') { if (ui.opened) ui.close(); else closeDresser(); return {}; }
      if (interaction) return endInteraction();
      releaseHeld(); rebuildFurniture(); app.requestRender(); return {};
    }
    if (interaction?.kind === 'grip' && action.type === 'stow') {
      if (interaction.move) return fail('Let the furniture finish moving first.');
      const id = interaction.item.id;
      endInteraction();
      return act({ type: 'take', id });
    }
    if (interaction && interaction.kind !== 'dresser') return fail('Let go or stand up before doing that.');
    if (['store', 'withdraw'].includes(action.type) && !context().storageReady) {
      if (interaction?.kind === 'dresser') return fail('Wait for the drawer to finish opening.');
      return openDresser(action);
    }
    if (interaction?.kind === 'dresser' && !['store', 'withdraw', 'order'].includes(action.type))
      return fail('Close the dresser first.');
    if (action.type === 'rotate' || action.type === 'drop' || action.type === 'stow') {
      if (!held) return { error: 'Grab a piece of furniture first.' };
      if (action.type === 'rotate') { held.item.rotation = (held.item.rotation + 1) % 4; updateHeld(); app.requestRender(); return {}; }
      if (action.type === 'stow') {
        releaseHeld(); rebuildFurniture(); return {};
      }
      updateHeld();
      if (held.error) return { error: held.error };
      return act({ type: 'place', ...held.target });
    }
    if (action.type === 'place' && !state.pockets.some(i => i.id === action.id))
      return fail('Grab placed furniture to push or pull it.');
    if (action.type === 'take') {
      const item = state.placed.find(i => i.id === action.id);
      if (!item || distance(item) > 2.5) return fail('Walk up to the furniture first.');
    }
    const result = change(state, action, context());
    if (result.error) return result;
    saveState(result.state);
    if (action.id === held?.item.id) releaseHeld();
    rebuildFurniture(); app.requestRender();
    return { state: structuredClone(state) };
  }
  const ui = createVillageUi({ context, act, primary: nearby, onOpen() {
    if (interaction && interaction.kind !== 'dresser' && endInteraction().error) return false;
    punchSerial++; pendingPunch = null; usingTool = false; releaseActions(); getPlayer()?.cancelJump?.(); releaseInput(); freeMouse();
  },
    onClose() { closeDresser(); crook?.close(); speech.stop(); speaking = null; releaseInput(); app.requestRender(); },
    speakNext: chat, stopSpeech: speech.stop, toggleMute() { speech.muted = !speech.muted; } });

  // Captured before toolbelt listeners are created. A modal owns keyboard input,
  // but native Tab/Enter/Space still work on its buttons (no custom focus trap).
  addEventListener('keydown', e => {
    if (!enabled || !live() || document.querySelector('.mm.open')) return;
    if (ui.opened) {
      e.stopImmediatePropagation();
      if (e.code === 'Escape' || e.code === 'KeyI' || e.code === 'KeyQ') { e.preventDefault(); if (!e.repeat) ui.close(); }
      else ui.dialogueKey(e);
      return;
    }
    if (app.isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (ui.handleKey(e)) return;
    const slot = /^Digit[1-4]$/.test(e.code) ? Number(e.code.slice(-1)) - 1 : -1;
    if (slot >= 0) { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat && !held) equip(VILLAGE_TOOLS[slot].key); return; }
    if (['KeyE', 'KeyG', 'KeyR', 'KeyM', 'KeyF', 'KeyV', 'Period', 'Comma', 'Tab'].includes(e.code)
      || (interaction && e.code === 'F5') || /^Digit/.test(e.code)) {
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, { capture: true });
  addEventListener('keyup', e => { if (enabled && ui.opened) e.stopImmediatePropagation(); }, { capture: true });
  document.addEventListener('visibilitychange', () => {
    if (!enabled || !document.hidden) return;
    ui.close(); endInteraction(true, true); releaseHeld();
  });

  function setEnabled(on, world = null) {
    on = !!on;
    if (on === enabled) return;
    enabled = on; document.body.classList.toggle('village-on', on);
    releaseInput(); punchSerial++; punchAt = -Infinity; reactionUntil = 0;
    pendingPunch = null;
    onEnabled(on);
    if (!on) {
      releaseActions(); getPlayer()?.cancelJump?.();
      ui.close(); endInteraction(true, true);
      avatar.reset();
      toolModel?.dispose(); toolModel = null; toolMaterials.forEach(m => m.dispose()); toolMaterials = []; tool = null;
      releaseHeld();
      ui.close(); speech.stop(); root.visible = avatar.root.visible = false;
      ui.update({ active: false }); camera.third = oldThird;
      for (const child of [...root.children]) dispose(child);
      furnishings = null; residents = []; crook = crookModel = null; bodyFrom = crookMotionFrom = null; worldSeed = null; ownMeshes.clear(); return;
    }
    size = world.size; oldThird = camera.third; camera.third = true;
    worldSeed = world.seed;
    // Storage may itself be unavailable (e.g. a browser privacy policy).
    let storage;
    try { storage = localStorage; } catch { storage = { getItem() { throw new Error('Unavailable'); } }; }
    crook = createCrookController(storage, world.seed);
    crookModel = character(TIM_CROOK); root.add(crookModel.root);
    equip(null);
    saveKey = `willow-cove:furniture:v1:${world.seed}`;
    let saved;
    try { saved = loadState(localStorage, saveKey); }
    catch { saved = { state: initialState(), writable: false, warning: 'Browser storage is unavailable. Furniture will not be saved.' }; }
    ({ state, writable } = saved); warning = saved.warning ?? '';
    memoryKey = `willow-cove:neighbors:v1:${world.seed}`; memories = {}; memoryWritable = true;
    try {
      const raw = localStorage.getItem(memoryKey), data = raw === null ? null : JSON.parse(raw);
      if (raw !== null && (!data || data.version !== 1 || !data.residents || typeof data.residents !== 'object' || Array.isArray(data.residents)))
        throw new Error('Unknown neighbor save');
      if (data && Object.keys(data.residents).some(name => !RESIDENTS.some(r => r.name === name)))
        memoryWritable = false;
      for (const r of RESIDENTS) {
        const value = data?.residents[r.name];
        const memory = hydrateMemory(value, r);
        // A noncanonical or future record may hold information we cannot read.
        if (data && Object.hasOwn(data.residents, r.name) && JSON.stringify(memory) !== JSON.stringify(value)) memoryWritable = false;
        memories[r.name] = memory;
      }
    } catch { memoryWritable = false; }
    if (!memoryWritable) warning += ' Neighbor memories are temporary; the unreadable save will not be overwritten.';
    rebuildFurniture();
    residents = RESIDENTS.map(spec => {
      const model = character(spec);
      const height = new THREE.Box3().setFromObject(model.root).max.y;
      root.add(model.root);
      const bubble = speechBubble(spec.name, 'Hey! Boing!'); model.root.add(bubble);
      return { spec, model, height, bubble, replyUntil: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, bonk: 0 };
    });
    for (let home = 0; home < 4; home++) {
      const sign = nameplate(home ? `${RESIDENTS[home - 1].name}’s home` : 'Your home');
      sign.position.set(size[0] / 2 + HOMES[home], FLOOR + 12, size[2] / 2 + HOME_Z - 12.05); root.add(sign);
    }
    root.visible = true; update(0);
  }
  function beforeBody(input, dt = 0) {
    if (!enabled || !getPlayer()) return;
    checkInteraction();
    previous.copy(getPlayer().pos);
    const l = local();
    bodyFrom = l && { x: l.x - HOMES[0], y: l.y, z: l.z };
    if (ui.opened) {
      if (input) {
        input.move.x = input.move.z = 0;
        input.jump = input.chargeJump = input.sprint = input.down = input.crouch = false;
        input.cancelJump = true;
      }
      getPlayer().cancelJump?.();
      getPlayer().vel.x = getPlayer().vel.z = 0;
      return;
    }
    if (!interaction) return;
    tickInteraction(Math.max(0, Math.min(0.1, dt)), input);
    if (!interaction) return;
    camera.third = true;
    if (input) {
      input.move.x = input.move.z = 0;
      input.jump = input.sprint = input.down = input.crouch = false;
      input.cancelJump = true;
    }
    getPlayer().cancelJump?.();
    setPlayer(interaction.position);
  }
  function characterObstacles(p) {
    const o = app.getSim().origin, floor = FLOOR - o.y;
    if (Math.max(previous.y, p.pos.y) + p.height <= floor) return [];
    const actors = residents.filter(r => Math.min(previous.y, p.pos.y) < floor + r.height).map(r => ({
      x: size[0] / 2 + HOMES[r.spec.home] + r.x - o.x,
      z: size[2] / 2 + HOME_Z + r.z - o.z, radius: 1.4, top: floor + r.height,
    }));
    if (crook?.visible && Math.min(previous.y, p.pos.y) < floor + 6) actors.push({
      x: size[0] / 2 + HOMES[0] + crook.position.x - o.x,
      z: size[2] / 2 + HOME_Z + crook.position.z - o.z, radius: 1.4, top: floor + 6,
    });
    return actors;
  }
  function collide() {
    const p = getPlayer(); if (!p) return;
    const obstacles = characterObstacles(p), radius = 1.4 * p.size;
    // A charged jump must not fall down through a neighbor's body.
    for (const r of obstacles) if (p.vel.y <= 0 && previous.y >= r.top - 0.05 && p.pos.y <= r.top
      && Math.hypot(p.pos.x - r.x, p.pos.z - r.z) < radius + r.radius) {
      p.pos.y = r.top; p.vel.y = 0; p.onGround = true;
    }
    const solidCharacters = obstacles.filter(r => p.pos.y < r.top - 0.01);
    const motion = resolveCharacterMotion(previous, p.pos, radius, solidCharacters);
    p.pos.x = motion.x; p.pos.z = motion.z;
    if (motion.blocked) p.vel.x = p.vel.z = 0;
    const o = app.getSim().origin, floor = FLOOR - o.y;
    if (p.pos.y > floor + 6 || p.pos.y + p.height < floor || p.pos.distanceTo(previous) > 20) return;
    const colliders = [];
    for (let home = 0; home < 4; home++) {
      const list = home === 0 ? state.placed : residentFurniture(home);
      for (const item of [DRESSER, ...list]) {
        if (home === 0 && item.id === held?.item.id) continue;
        const b = bounds(item); colliders.push({ ...b, top: floor + ITEMS[item.kind].h, x: b.x + size[0] / 2 + HOMES[home] - o.x, z: b.z + size[2] / 2 + HOME_Z - o.z });
      }
    }
    // Explicit rest poses own their anchors; ordinary walking uses solid bounds.
    const bodyRadius = p.width / 2;
    const footprint = (x, z) => ({ x: x - bodyRadius, z: z - bodyRadius, w: bodyRadius * 2, d: bodyRadius * 2 });
    // Landing support keeps a jump from dropping the body inside a piece of furniture.
    for (const b of colliders) if (p.vel.y <= 0 && previous.y >= b.top - 0.05 && p.pos.y <= b.top && overlaps(b, footprint(p.pos.x, p.pos.z))) {
      p.pos.y = b.top; p.vel.y = 0; p.onGround = true;
    }
    const blocked = (x, z) => colliders.some(b => p.pos.y < b.top - 0.01 && overlaps(b, footprint(x, z)));
    const dx = p.pos.x - previous.x, dz = p.pos.z - previous.z;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.5));
    let x = previous.x, z = previous.z;
    for (let i = 0; i < steps; i++) {
      const oldX = x, oldZ = z;
      if (!blocked(x + dx / steps, z)) x += dx / steps; else p.vel.x = 0;
      if (!blocked(x, z + dz / steps)) z += dz / steps; else p.vel.z = 0;
      const checked = resolveCharacterMotion({ x: oldX, z: oldZ }, { x, z }, radius, solidCharacters);
      // Furniture's alternate route cannot slide us through a neighbor or wall.
      if (Math.hypot(checked.x - x, checked.z - z) > 1e-7) {
        x = oldX; z = oldZ; p.vel.x = p.vel.z = 0; break;
      }
    }
    p.pos.x = x; p.pos.z = z;
  }
  function update(dt, shown = false, yaw = 0) {
    if (!enabled && live() && app.getMode() === 'animalCrossing' && app.getWorld()?.scene.key === 'willowCove') setEnabled(true, app.getWorld().P);
    if (!enabled) return;
    if (app.getMode() !== 'animalCrossing' || app.getWorld()?.scene.key !== 'willowCove') { setEnabled(false); return; }
    if (app.getWorld()?.P.seed !== worldSeed) { setEnabled(false); setEnabled(true, app.getWorld().P); return; }
    if (avatar.root.userData.persona !== persona()) {
      if (interaction) { ui.close(); endInteraction(true, true); }
      // Keep the physical player, furniture and current tool; only replace the look.
      const old = avatar;
      avatar = character({ persona: persona() }); app.scene.add(avatar.root);
      equip(tool); dispose(old.root);
    }
    time += dt;
    checkInteraction();
    landPunch();
    const scale = app.getScale(), vol = app.getVolume(), origin = app.getSim().origin;
    root.scale.setScalar(scale); root.position.copy(origin).multiplyScalar(-scale).add(vol.position);
    root.visible = true;
    const p = getPlayer();
    if (p) {
      avatar.root.position.copy(p.pos).multiplyScalar(scale).add(vol.position); avatar.root.scale.setScalar(scale * p.size);
      avatar.root.rotation.y = interaction?.yaw ?? (p.leaping ? Math.atan2(-p.vel.x, -p.vel.z) : yaw);
      avatar.root.visible = live() && (shown || !!interaction);
      const punching = interaction ? 0 : Math.max(0, 1 - (time - punchAt) / PUNCH_DURATION);
      let pose = interaction?.pose ?? null;
      if (pose) avatar.root.position.y += pose.y * scale;
      if (interaction?.kind === 'grip') {
        const m = interaction.move, spec = ITEMS[interaction.item.kind];
        const toward = m ? -(m.target.x - m.from.x) * Math.sin(interaction.yaw) - (m.target.z - m.from.z) * Math.cos(interaction.yaw) : 0;
        pose = { kind: 'grip', reach: Math.min(1, interaction.elapsed / 0.2), pulling: toward < 0,
          effort: m ? Math.sin(Math.PI * m.elapsed / 0.35) : 0,
          low: (spec.lyingHeight ?? spec.seatHeight ?? spec.h) < 2 };
      }
      if (interaction?.kind === 'dresser') pose = { kind: 'dresser', ...interaction.drawer };
      avatar.animate(time, interaction?.move ? 2 : Math.hypot(p.vel.x, p.vel.z), false, !!held,
        !interaction && p.onGround && !p.inLiquid ? p.sprintRush : 0, kicking ? 0 : punching, !!tool && !interaction,
        usingTool && !interaction, interaction ? null : p, kicking ? punching : 0, pose);
      if (toolModel) toolModel.obj.visible = !held && (kicking || !punching) && !interaction;
    }
    const active = context().active;
    tickCrook(dt, active);
    for (const r of residents) {
      // ponytail: neighbors potter along their own clear aisle; outdoor schedules can replace this small local path.
      const from = { x: r.x, z: r.z };
      stepResident(r, dt, time, speaking !== r && !ui.opened);
      const l = local(), obstacles = [];
      if (l && l.y < 6.9 && l.y + p.height > 0)
        obstacles.push({ x: l.x - HOMES[r.spec.home], z: l.z, radius: 1.4 * p.size });
      for (const other of residents) if (other !== r)
        obstacles.push({ x: HOMES[other.spec.home] - HOMES[r.spec.home] + other.x, z: other.z, radius: 1.4 });
      if (crook?.visible) obstacles.push({ x: HOMES[0] - HOMES[r.spec.home] + crook.position.x, z: crook.position.z, radius: 1.4 });
      const motion = resolveCharacterMotion(from, r, 1.4, obstacles);
      const layout = { placed: residentFurniture(r.spec.home) };
      const clear = playerPathClear(layout, from, motion, 1.4);
      r.x = clear ? motion.x : from.x; r.z = clear ? motion.z : from.z;
      if (motion.blocked || !clear) r.vx = r.vz = 0;
      let facing = r.model.root.rotation.y;
      if (speaking !== r && !ui.opened && r.bonk <= 0) {
        if (Math.hypot(r.vx, r.vz) > 0.1) facing = Math.atan2(-r.vx, -r.vz);
      } else if (p) {
        const l = local(); facing = Math.atan2(HOMES[r.spec.home] + r.x - l.x, r.z - l.z);
      }
      const turn = facing - r.model.root.rotation.y;
      r.model.root.rotation.y += Math.atan2(Math.sin(turn), Math.cos(turn)) * (1 - Math.exp(-8 * dt));
      r.model.root.position.set(size[0] / 2 + HOMES[r.spec.home] + r.x, FLOOR + r.y, size[2] / 2 + HOME_Z + r.z);
      r.model.root.rotation.x = 0.3 * r.bonk / 0.9;
      r.model.animate(time, speaking === r || r.bonk > 0 ? 0 : 1.5, (speaking === r || r.bonk > 0) && speech.stats.queued > 0);
      r.bubble.visible = active && !ui.opened && time < r.replyUntil;
      if (r.bubble.visible && app.camera) {
        // Billboard in the same world space as the head; presentation bends both together.
        r.model.root.getWorldQuaternion(r.bubble.quaternion).invert();
        r.bubble.position.set(0, 2.6, 0).applyQuaternion(r.bubble.quaternion); r.bubble.position.y += 5.5;
        r.bubble.quaternion.multiply(app.camera.quaternion);
      }
    }
    if (held && (!context().active || room() !== 0)) { releaseHeld(); rebuildFurniture(); }
    updateHeld();
    const c = context(), home = room();
    if ((!c.active || (ui.talking && speaking !== crook && home !== speaking?.spec.home)) && ui.opened) ui.close();
    ui.update({ active: c.active, place: home === 0 ? 'Home, sweet home' : home > 0 ? `${RESIDENTS[home - 1].name}’s home` : 'Tinker Creek' });
  }
  function crookSnapshot() {
    return crook ? { state: crook.state, phase: crook.phase, position: crook.position } : null;
  }
  function crookPathClear(from, to) {
    // The bounded porch path excludes all cottage walls and furniture. Check
    // the player's existing CPU terrain probe as well; never request GPU work.
    if (to.z > -14.5 || to.z < -28 || Math.abs(to.x) > 10) return false;
    const p = getPlayer(), o = app.getSim().origin;
    if (!p.cellAt) return true; // CPU adapters without terrain.
    const x = size[0] / 2 + HOMES[0] + to.x - o.x, z = size[2] / 2 + HOME_Z + to.z - o.z;
    const y = FLOOR - o.y;
    const solid = id => id < 0 || ELEMENTS[id]?.kind === K.SOLID || ELEMENTS[id]?.kind === K.POWDER;
    for (let a = Math.floor(x - 1.4); a <= Math.floor(x + 1.4); a++)
      for (let b = Math.floor(z - 1.4); b <= Math.floor(z + 1.4); b++) {
        if (!solid(p.cellAt(a, Math.floor(y - 0.1), b))) return false;
        for (let h = Math.floor(y); h < y + 5.8; h++)
          if (solid(p.cellAt(a, h, b))) return false;
      }
    return true;
  }
  function tickCrook(dt, active) {
    if (!crook || !crookModel) return;
    const p = local(), before = crook.position;
    const talk = active && crook.tick(dt, p && { x: p.x - HOMES[0], y: p.y, z: p.z }, {
      grounded: getPlayer().onGround && !getPlayer().leaping,
      busy: ui.opened || !!held || !!interaction, radius: 1.4 * getPlayer().size,
      motionFrom: crookMotionFrom,
      obstacles: residents.map(r => ({ x: HOMES[r.spec.home] - HOMES[0] + r.x, z: r.z, radius: 1.4 })),
      clear: crookPathClear,
    });
    crookMotionFrom = null;
    const pos = crook.position;
    crookModel.root.visible = crook.visible;
    at(crookModel.root, 0, pos);
    if (p) crookModel.root.rotation.y = Math.atan2(HOMES[0] + pos.x - p.x, pos.z - p.z);
    crookModel.animate(time, Math.hypot(pos.x - before.x, pos.z - before.z) > 0.001 ? 5 : 0,
      speaking === crook && speech.stats.queued > 0);
    if (talk) { speaking = crook; chat(); }
  }
  return {
    setEnabled, beforeBody, afterBody() {
      if (!enabled) return;
      if (interaction && getPlayer()?.dead) { ui.close(); endInteraction(false, true); }
      if (interaction) setPlayer(interaction.position);
      else collide();
      crookMotionFrom = bodyFrom; bodyFrom = null;
    }, update, punch, kick: () => punch(true),
    cycleTool(direction) { if (context().active && !ui.opened && !held && !interaction) equip(VILLAGE_TOOLS[(VILLAGE_TOOLS.findIndex(t => t.key === tool) + Math.sign(direction) + VILLAGE_TOOLS.length) % VILLAGE_TOOLS.length].key); },
    get tool() { return tool; }, get canAct() { return context().active && !ui.opened && !held && !interaction; },
    set usingTool(value) { usingTool = value; },
    get enabled() { return enabled; }, get blocked() { return enabled && (ui.opened || (!!interaction && interaction.kind !== 'grip')); },
    get state() { return structuredClone(state); }, get residents() { return residents.map(r => ({ name: r.spec.name, species: r.spec.species, home: r.spec.home, x: r.x, z: r.z })); },
    get speech() { return speech.stats; }, get context() { return context(); }, get root() { return root; }, get avatar() { return avatar.root; },
    get crook() { return crookSnapshot(); },
    get carrying() { return held ? { ...held.target, error: held.error } : null; },
    get interaction() {
      return interaction ? { kind: interaction.kind, id: interaction.item.id, position: { ...interaction.position },
        moving: !!interaction.move, phase: interaction.phase, extension: interaction.drawer?.extension } : null;
    },
    act, open: ui.open, close: ui.close,
  };
}
