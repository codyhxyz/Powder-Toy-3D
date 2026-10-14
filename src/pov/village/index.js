import * as THREE from 'three';
import { HOMES, FLOOR, HOME_Z, ITEMS, RESIDENTS, DRESSER, initialState, loadState, change, bounds, overlaps, carryTarget, placementError } from './state.js';
import { character, furniture, nameplate, dispose } from './models.js';
import { createSpeech } from './speech.js';
import { createVillageUi } from './ui.js';
import { attachModel } from '../models.js';
import { VILLAGE_TOOLS, PUNCH_COOLDOWN, PUNCH_DURATION, punchTarget, punchOccluded, stepResident } from './actions.js';

export function createVillage({ app, getPlayer, live, freeMouse, releaseInput, releaseActions, camera, onEnabled, onTool, useTool, toolReadout }) {
  const root = new THREE.Group(); root.name = 'willow-village'; root.visible = false; app.scene.add(root);
  const avatar = character(), speech = createSpeech(); app.scene.add(avatar.root); avatar.root.visible = false;
  let enabled = false, size = null, state = initialState(), writable = true, warning = '', saveKey = '';
  let residents = [], furnishings = null, time = 0, speaking = null, turn = 0, oldThird = false;
  let held = null, tool = null, toolModel = null, toolMaterials = [], usingTool = false;
  let punchAt = -Infinity, punchSerial = 0, reaction = '', reactionUntil = 0;
  function equip(key) {
    if (!VILLAGE_TOOLS.some(t => t.key === key)) return;
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
  async function punch() {
    if (!context().active || ui.opened || held || time - punchAt < PUNCH_COOLDOWN) return;
    punchAt = time; const token = ++punchSerial, sim = app.getSim(), home = room(), l = local();
    app.requestRender();
    const target = punchTarget(l && { x: l.x - HOMES[home], y: l.y, z: l.z }, camera.look.yaw, residents, home);
    if (!target) return;
    const r = target.resident, origin = sim.origin.clone();
    const start = getPlayer().pos.clone().add(new THREE.Vector3(0, 3, 0));
    const end = new THREE.Vector3(size[0] / 2 + HOMES[home] + r.x, FLOOR + 3, size[2] / 2 + HOME_Z + r.z).sub(origin);
    const distance = start.distanceTo(end), dir = end.clone().sub(start).normalize();
    try {
      const hit = await app.pickRay(start, dir);
      if (token !== punchSerial || !context().active || ui.opened || held || app.getSim() !== sim || !sim.origin.equals(origin)
        || room() !== home || getPlayer().pos.distanceTo(start.clone().setY(start.y - 3)) > 1) return;
      const now = local(), still = punchTarget({ x: now.x - HOMES[home], y: now.y, z: now.z }, camera.look.yaw, residents, home);
      if (time - punchAt > PUNCH_COOLDOWN || still?.resident !== r || punchOccluded(hit, start, distance)) return;
      r.vx = dir.x * 15; r.vz = dir.z * 15; r.bonk = 0.8;
      reaction = `${r.spec.name}: Hey! Boing!`; reactionUntil = time + 2;
      speech.speak('Hey! Boing!', r.spec.pitch); speech.bonk(); app.requestRender();
    } catch { /* A failed world probe must never punch through terrain. */ }
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
  const ownPosition = () => { const p = local(); return p ? { x: p.x - HOMES[0], z: p.z } : null; };
  function context() {
    const p = ownPosition(), active = enabled && live() && !document.querySelector('.mm.open');
    return { active, home: active && room() === 0, dresser: active && room() === 0 && Math.hypot(p.x - DRESSER.x, p.z - DRESSER.z) <= 5.5,
      player: p, state, warning, muted: speech.muted, tool, readout: toolReadout?.(), reaction: time < reactionUntil ? reaction : '',
      carry: held ? { name: ITEMS[held.item.kind].name, rotation: held.item.rotation, error: held.error } : null };
  }
  function at(root, home, item) {
    root.position.set(size[0] / 2 + HOMES[home] + item.x, FLOOR, size[2] / 2 + HOME_Z + item.z);
    root.rotation.y = (item.rotation ?? 0) * Math.PI / 2;
  }
  function rebuildFurniture() {
    if (furnishings) dispose(furnishings);
    furnishings = new THREE.Group(); root.add(furnishings);
    for (let home = 0; home < 4; home++) {
      const list = home === 0 ? state.placed : [...initialState().placed, { id: 'plant', kind: 'plant', x: 6, z: -2, rotation: 0 }];
      for (const item of [DRESSER, ...list]) {
        if (home === 0 && item.id === held?.item.id) continue;
        const model = furniture(item.kind); at(model, home, item); furnishings.add(model);
      }
    }
  }
  function distance(item, p = ownPosition()) {
    const b = bounds(item);
    return Math.hypot(Math.max(b.x - p.x, 0, p.x - b.x - b.w), Math.max(b.z - p.z, 0, p.z - b.z - b.d));
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
  function releaseHeld(restore = false) {
    if (!held) return;
    // Cancellation returns the original piece. If we walked into its old
    // footprint, step back to the grab point rather than trapping the body.
    const p = getPlayer(), here = ownPosition(), original = state.placed.find(i => i.id === held.item.id);
    if (restore && original && room() === 0 && p.pos.y < FLOOR + ITEMS[original.kind].h
      && overlaps(bounds(original), { x: here.x - 1, z: here.z - 1, w: 2, d: 2 })) {
      p.teleport(held.start.clone().sub(app.getSim().origin));
    }
    camera.look.pitch = held.pitch; camera.third = held.third;
    dispose(held.root); held = null;
  }
  function grab(id) {
    const c = context(), item = [...state.placed, ...state.pockets].find(i => i.id === id);
    if (!c.home || !item || (state.placed.includes(item) && distance(item) > 2.5)) return { error: 'Walk up to furniture in your own home to grab it.' };
    if (held) return { error: 'Set this piece down first.' };
    punchSerial++;
    ui.close();
    const model = furniture(item.kind), carrying = new THREE.Group();
    const marker = new THREE.Mesh(new THREE.PlaneGeometry(ITEMS[item.kind].w, ITEMS[item.kind].d),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }));
    marker.rotation.x = -Math.PI / 2; marker.position.y = 0.06;
    model.traverse(o => { if (o.material) { o.material.transparent = true; o.material.opacity = 0.88; o.material.depthWrite = false; } });
    carrying.add(model, marker); root.add(carrying);
    held = { item: { ...item, rotation: item.rotation ?? 0 }, root: carrying, model, marker,
      start: getPlayer().pos.clone().add(app.getSim().origin), pitch: camera.look.pitch, third: camera.third, target: null, error: null };
    // A downward decorating view keeps the destination visible over the
    // character's head, rather than hiding the held piece behind the avatar.
    camera.look.pitch = Math.min(camera.look.pitch, -1.2); camera.third = true;
    rebuildFurniture(); updateHeld(); ui.update({ active: true, place: 'Home, sweet home' }); app.requestRender();
    return {};
  }
  function nearby() {
    if (!context().active || held) return null;
    const p = local(), home = room(p);
    if (home === 0) {
      const here = ownPosition(), forward = camera.forwardH(new THREE.Vector3());
      const item = [DRESSER, ...state.placed].filter(i => {
        const b = bounds(i), dx = THREE.MathUtils.clamp(here.x, b.x, b.x + b.w) - here.x;
        const dz = THREE.MathUtils.clamp(here.z, b.z, b.z + b.d) - here.z;
        return distance(i, here) <= 2.5 && (dx * forward.x + dz * forward.z >= Math.hypot(dx, dz) * 0.2);
      }).sort((a, b) => distance(a, here) - distance(b, here))[0];
      if (item === DRESSER) return { title: 'Open dresser', use: () => ui.open('storage') };
      return item ? { title: `Grab ${ITEMS[item.kind].name.toLowerCase()}`, use: () => grab(item.id) } : null;
    }
    const r = residents.find(r => r.spec.home === home && Math.hypot(p.x - HOMES[home] - r.x, p.z - r.z) < 7);
    return r ? { title: `Talk to ${r.spec.name}`, use: () => { speaking = r; turn = 0; chat(); } } : null;
  }
  function chat() {
    if (!speaking || !context().active || room() !== speaking.spec.home) { ui.close(); return; }
    const r = speaking.spec, text = r.lines[turn++ % r.lines.length];
    ui.talk(r, text); speech.speak(text, r.pitch);
  }
  function act(action) {
    if (!context().active) return { error: 'Enter the village to use your furniture.' };
    if (action.type === 'punch') { void punch(); return {}; }
    if (action.type === 'tool') { if (!ui.opened && !held) equip(action.key); return {}; }
    if (action.type === 'tool-primary' || action.type === 'tool-secondary') {
      if (!ui.opened && !held && tool) useTool(action.type === 'tool-primary' ? 'primary' : 'secondary');
      return {};
    }
    if (action.type === 'interact') { nearby()?.use(); return {}; }
    if (action.type === 'grab') return grab(action.id);
    if (action.type === 'cancel') { releaseHeld(true); rebuildFurniture(); app.requestRender(); return {}; }
    if (action.type === 'rotate' || action.type === 'drop' || action.type === 'stow') {
      if (!held) return { error: 'Grab a piece of furniture first.' };
      if (action.type === 'rotate') { held.item.rotation = (held.item.rotation + 1) % 4; updateHeld(); app.requestRender(); return {}; }
      if (action.type === 'stow') {
        if (state.pockets.some(i => i.id === held.item.id)) { releaseHeld(); rebuildFurniture(); return {}; }
        return act({ type: 'take', id: held.item.id });
      }
      updateHeld();
      if (held.error) return { error: held.error };
      return act({ type: 'place', ...held.target });
    }
    const result = change(state, action, context());
    if (result.error) return result;
    state = result.state; warning = writable ? '' : warning;
    if (action.id === held?.item.id) releaseHeld();
    if (writable) {
      try { localStorage.setItem(saveKey, JSON.stringify(state)); }
      catch { warning = 'Your changes are in memory only: browser storage is full or unavailable. Free storage before leaving.'; }
    }
    rebuildFurniture(); app.requestRender();
    return { state: structuredClone(state) };
  }
  const ui = createVillageUi({ context, act, primary: nearby, onOpen() { punchSerial++; releaseInput(); freeMouse(); },
    onClose() { speech.stop(); speaking = null; releaseInput(); app.requestRender(); },
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
    if (['KeyE', 'KeyM', 'KeyF', 'KeyV', 'Period', 'Comma', 'Tab'].includes(e.code) || /^Digit/.test(e.code)) {
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, { capture: true });
  addEventListener('keyup', e => { if (enabled && ui.opened) e.stopImmediatePropagation(); }, { capture: true });

  function setEnabled(on, world = null) {
    on = !!on;
    if (on === enabled) return;
    enabled = on; document.body.classList.toggle('village-on', on);
    releaseInput(); punchSerial++; punchAt = -Infinity; reactionUntil = 0;
    onEnabled(on);
    if (!on) {
      toolModel?.dispose(); toolModel = null; toolMaterials.forEach(m => m.dispose()); toolMaterials = []; tool = null;
      releaseHeld();
      ui.close(); speech.stop(); root.visible = avatar.root.visible = false;
      ui.update({ active: false }); camera.third = oldThird;
      for (const child of [...root.children]) dispose(child);
      furnishings = null; residents = []; return;
    }
    size = world.size; oldThird = camera.third; camera.third = true;
    equip(null);
    saveKey = `willow-cove:furniture:v1:${world.seed}`;
    let saved;
    try { saved = loadState(localStorage, saveKey); }
    catch { saved = { state: initialState(), writable: false, warning: 'Browser storage is unavailable. Furniture will not be saved.' }; }
    ({ state, writable } = saved); warning = saved.warning ?? '';
    rebuildFurniture();
    residents = RESIDENTS.map(spec => {
      const model = character(spec); root.add(model.root);
      return { spec, model, x: 0, z: 0, vx: 0, vz: 0, bonk: 0 };
    });
    for (let home = 0; home < 4; home++) {
      const sign = nameplate(home ? `${RESIDENTS[home - 1].name}’s home` : 'Your home');
      sign.position.set(size[0] / 2 + HOMES[home], FLOOR + 12, size[2] / 2 + HOME_Z - 12.05); root.add(sign);
    }
    root.visible = true; update(0);
  }
  function beforeBody() { if (enabled && getPlayer()) previous.copy(getPlayer().pos); }
  function collide() {
    const p = getPlayer(); if (!p || p.pos.y > FLOOR + 5 || p.pos.y + p.height < FLOOR || p.pos.distanceTo(previous) > 20) return;
    const o = app.getSim().origin;
    const colliders = [];
    for (let home = 0; home < 4; home++) {
      const list = home === 0 ? state.placed : [...initialState().placed, { kind: 'plant', x: 6, z: -2, rotation: 0 }];
      for (const item of [DRESSER, ...list]) {
        if (home === 0 && item.id === held?.item.id) continue;
        const b = bounds(item); colliders.push({ ...b, top: FLOOR + ITEMS[item.kind].h, x: b.x + size[0] / 2 + HOMES[home] - o.x, z: b.z + size[2] / 2 + HOME_Z - o.z });
      }
    }
    // ponytail: solid bounding boxes, not per-cushion collision; use mesh hulls if sitting/climbing needs precision.
    const radius = p.width / 2;
    const footprint = (x, z) => ({ x: x - radius, z: z - radius, w: radius * 2, d: radius * 2 });
    // Landing support keeps a jump from dropping the body inside a piece of furniture.
    for (const b of colliders) if (p.vel.y <= 0 && previous.y >= b.top - 0.05 && p.pos.y <= b.top && overlaps(b, footprint(p.pos.x, p.pos.z))) {
      p.pos.y = b.top; p.vel.y = 0; p.onGround = true;
    }
    const blocked = (x, z) => colliders.some(b => p.pos.y < b.top - 0.01 && overlaps(b, footprint(x, z)));
    const dx = p.pos.x - previous.x, dz = p.pos.z - previous.z;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.5));
    let x = previous.x, z = previous.z;
    for (let i = 0; i < steps; i++) {
      if (!blocked(x + dx / steps, z)) x += dx / steps; else p.vel.x = 0;
      if (!blocked(x, z + dz / steps)) z += dz / steps; else p.vel.z = 0;
    }
    p.pos.x = x; p.pos.z = z;
  }
  function update(dt, shown = false, yaw = 0) {
    if (!enabled && live() && app.getMode() === 'animalCrossing' && app.getWorld()?.scene.key === 'willowCove') setEnabled(true, app.getWorld().P);
    if (!enabled) return;
    if (app.getMode() !== 'animalCrossing' || app.getWorld()?.scene.key !== 'willowCove') { setEnabled(false); return; }
    time += dt;
    const scale = app.getScale(), vol = app.getVolume(), origin = app.getSim().origin;
    root.scale.setScalar(scale); root.position.copy(origin).multiplyScalar(-scale).add(vol.position);
    root.visible = true;
    const p = getPlayer();
    if (p) {
      avatar.root.position.copy(p.pos).multiplyScalar(scale).add(vol.position); avatar.root.scale.setScalar(scale * p.size);
      avatar.root.rotation.y = yaw; avatar.root.visible = live() && shown;
      const punching = Math.max(0, 1 - (time - punchAt) / PUNCH_DURATION);
      avatar.animate(time, Math.hypot(p.vel.x, p.vel.z), false, !!held, p.onGround && !p.inLiquid ? p.sprintRush : 0, punching, !!tool, usingTool);
      if (toolModel) toolModel.obj.visible = !held && !punching;
    }
    for (const r of residents) {
      // ponytail: neighbors potter along their own clear aisle; outdoor schedules can replace this small local path.
      stepResident(r, dt, time, speaking !== r && !ui.opened);
      if (speaking !== r && !ui.opened) {
        r.model.root.rotation.y = Math.cos(time * 0.42 + r.spec.home) > 0 ? Math.PI : 0;
      } else if (p) {
        const l = local(); r.model.root.rotation.y = Math.atan2(HOMES[r.spec.home] + r.x - l.x, r.z - l.z);
      }
      r.model.root.position.set(size[0] / 2 + HOMES[r.spec.home] + r.x, FLOOR + (r.bonk > 0 ? Math.sin(r.bonk / 0.8 * Math.PI) * 0.65 : 0), size[2] / 2 + HOME_Z + r.z);
      r.model.animate(time, speaking === r || r.bonk > 0 ? 0 : 1.5, (speaking === r || r.bonk > 0) && speech.stats.queued > 0);
    }
    if (held && room() !== 0) { releaseHeld(true); rebuildFurniture(); }
    updateHeld();
    const c = context(), home = room();
    if ((!c.active || (ui.talking && home !== speaking?.spec.home)) && ui.opened) ui.close();
    ui.update({ active: c.active, place: home === 0 ? 'Home, sweet home' : home > 0 ? `${RESIDENTS[home - 1].name}’s home` : 'Tinker Creek' });
  }
  return {
    setEnabled, beforeBody, afterBody() { if (enabled) collide(); }, update, punch,
    cycleTool(direction) { if (context().active && !ui.opened && !held) equip(VILLAGE_TOOLS[(VILLAGE_TOOLS.findIndex(t => t.key === tool) + Math.sign(direction) + VILLAGE_TOOLS.length) % VILLAGE_TOOLS.length].key); },
    get tool() { return tool; }, get canAct() { return context().active && !ui.opened && !held; },
    set usingTool(value) { usingTool = value; },
    get enabled() { return enabled; }, get blocked() { return enabled && ui.opened; },
    get state() { return structuredClone(state); }, get residents() { return residents.map(r => ({ name: r.spec.name, species: r.spec.species, home: r.spec.home, x: r.x, z: r.z })); },
    get speech() { return speech.stats; }, get context() { return context(); }, get root() { return root; }, get avatar() { return avatar.root; },
    get carrying() { return held ? { ...held.target, error: held.error } : null; },
    act, open: ui.open, close: ui.close,
  };
}
