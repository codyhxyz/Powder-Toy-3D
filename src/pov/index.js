import * as THREE from 'three';
import { BODY_HEIGHT, BODY_WIDTH, HAND_REACH } from './constants.js';
import { createPovCamera, ENTRY_PITCH, FIGURE_HIDE_DIST, RESPAWN_SWOOP_S, SWOOP_S } from './camera.js';
import { createBody } from './figureReal.js';
import { STICK_HAND } from './figure.js';
import { attachModel } from './models.js';
import { gearByKey } from './tools/catalog.js';
import { createPovHud } from './hud.js';
import { createPovAudio } from './audio.js';
import { createFeel } from './feel.js';
import { createVfx } from './vfx.js';
import { povEvents } from './events.js';
import './pov.css';
import './potions.js';   // Noita's potion statuses: stains and drinks (registers them)
import { addTarget, PLAYER } from './targets.js';
import { grant, PERK } from './perks.js';
import { createInteract } from './interact.js';
import { ORB_LIFT } from '../perkOrbs.js';
import { CLASSES_ENABLED } from './classes.js';
import { createClassPicker } from './classPicker.js';
import { createVehicles } from './vehicles/index.js';
import { createNightVision } from './nightVision.js';
import { KICK_KEY, createKickLeg } from './kick.js';
import { createCombat } from './combat.js';
import { viewmodelRig, HIT } from './viewmodel.js';
import { createGame } from '../game/index.js';
import { createDeathWatch } from './killfeed.js';
import { SPAWNER, ENEMY_KINDS } from '../spawners.js';
import { createZoom, ZOOM_KEY } from './zoom.js';
import { createTouchControls } from './touch.js';
import { createDescent } from './descent/index.js';

// First-person (POV) mode: drop into the world with V (Garry's Mod's noclip
// key; F drops in too), walk around in it, pop back out to the god view's
// free camera with V. This module is the shell: input, the camera, the
// figure, the HUD and the per-frame wiring between the body (player.js) and
// the toolbelt (tools/index.js), plus the gunplay feedback that listens to
// povEvents: feel (kick, shake, hitmarker), effects and sound. Both are optional at build time: without the
// body, V explains; without the toolbelt you just walk.

const playerModule = import.meta.glob('./player.js', { eager: true })['./player.js'];
const toolsModule = import.meta.glob('./tools/index.js', { eager: true })['./tools/index.js'];
// The NPCs (npc.js: Yuka, the world model, the tools headless) load on first use: one per enemy spawner
// (spawners.js): an axeman, a jetpack gunner (npc.js style 'gunner') or a worm (worm.js).
const PLAYER_KNOCKBACK = 18;   // cells/s a blow from an NPC throws the player
const PLAYER_KNOCK_UP = 0.4;   // its upward share
const PLAYER_DAMAGE_TAKEN = 0.5;   // share of a weapon's damage the player takes from NPCs (the hero is tougher)
const perkName = (key) => `${PERK[key].icon} ${PERK[key].name}`;
const PERK_TARGET_R = 1.1;   // cells: a perk orb's look-at target (its icon is perkOrbs.js ORB_SIZE 2.2 across)

const PREWARM_DELAY_MS = 2000;          // ms after start-up before the figure's shader compiles in the background
const RESPAWN_DELAY = 3.5;              // s from death to respawning at the drop point on its own
const RESPAWN_MIN = 1;                  // s after death before a click or Space respawns early (Minecraft-style: no forced wait)
const POV_NEAR = 0.08;                  // cells: near plane in POV (a held item sits close to the eye)
// Wheel → notches: the first event of a gesture is one notch at once (mice
// report anything from a few px to 120 per click), then every WHEEL_NOTCH_PX
// more in the same direction (fast spins, trackpad swipes) is another.
const WHEEL_NOTCH_PX = 100;             // px of wheel delta per further notch (a Windows/Linux wheel click)
const WHEEL_GESTURE_GAP_MS = 180;       // ms without wheel events that ends a gesture
const WHEEL_LINE_PX = 40;               // px per line, for wheels that report lines
const WHEEL_PAGE_PX = 800;              // px per page

// Keys held down: movement, the crouch (C held, PUBG's and Apex's key: Source's
// duck in player.js; in liquid it swims down) and the zoom (Z, zoom.js).
const CROUCH_KEY = 'KeyC';
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', CROUCH_KEY, ZOOM_KEY]);
// First or third person: Minecraft's F5 (its page reload is held back), or a
// tap of Ctrl on its own (a laptop's F5 hides behind fn; Ctrl is free in the body)
const VIEW_KEY = 'F5';
const VIEW_TAP_KEYS = new Set(['ControlLeft', 'ControlRight']);
// Third person, the tool in hand on the body (Team Fortress 2's world models):
// the viewmodel's model grown to read at a distance, as the NPCs' are (npc.js HELD_SCALE)
const HELD_SCALE = 1.8;
const REAL_HAND = 'hand_r';             // the realistic body's right-hand bone (figureReal.js)
const VEHICLE_KEY = 'KeyE';             // get in, get out, or right a vehicle (vehicles/index.js; Halo's and most shooters' use key)
// Driving, the chase camera swings back behind the vehicle once the mouse rests (GTA's and most driving games')
const CHASE_PITCH = -0.22;              // rad, the look on getting in: a little down onto the vehicle
const CHASE_IDLE_S = 1.2;               // s without mouse look before it swings back behind
const CHASE_FOLLOW_RATE = 2.5;          // 1/s, how fast it swings
// god-mode keys that stay live in POV: help, settings, screenshot, closing menus.
// With classes on, comma is TF2's class key in POV (classPicker.js), not settings.
const PASS_KEYS = new Set(['Escape', '?', ...(CLASSES_ENABLED ? [] : [',']), 'p', 'P']);

// app = { renderer, scene, camera, controls, canvas, hud, settings, mp, isTyping, post (gfx/post.js: night vision),
//         getSim, getVolume, getScale, hover, pointerHover (() => bool), pickRay (ro, rd → Promise<hit>),
//         requestRender, inWorld (() => bool: the grid is a window of a larger world, docs/scaling.md D11),
//         showToolsMenu (the palette's first-person tools brought into view: Q), hideToolsMenu (Q closed) }
export function createPov(app) {
  const { renderer, scene, camera, controls, canvas, hud } = app;
  const createPlayer = playerModule?.createPlayer;
  const createToolbelt = toolsModule?.createToolbelt;

  const povCam = createPovCamera({
    fov: () => app.settings.povFov, sensitivity: () => app.settings.sensitivity, bobbing: () => app.settings.viewBobbing,
  });
  const zoom = createZoom();   // C (zoom.js)
  const povHud = createPovHud();
  const interact = createInteract();   // look + E (interact.js): perks, and Descent's pickups and shop
  // the Descent map's Holy Mountain and gold (descent/index.js); idle off that map
  const descent = createDescent({ app, scene, hud, interact, events: povEvents, getToolbelt: () => toolbelt });
  // feedback: everything here hears povEvents (events.js) and the body's events
  const feel = createFeel({ hud: povHud });
  const nightVision = app.post ? createNightVision(app.post) : null;   // the Night Vision perk's goggles (the local player's view)
  let vfx = null;                        // three.quarks effects, built on the first drop-in
  let figure = null, player = null, toolbelt = null;
  const npcs = new Map();   // enemy spawner id → its NPC (npc.js)
  let npcMod = null, npcAi = null, npcLoading = null;   // npc.js and what NPCs share, loaded on first use
  // the killfeed's books (killfeed.js): who hurt whom last, and every body that can die
  const bodyById = (id) => [...npcs.values(), ...game.bots].find((n) => n.id === id) ?? null;
  const deaths = createDeathWatch({
    heldBy: (id) => (id === PLAYER ? toolbelt?.selectedKey ?? null : bodyById(id)?.agent?.intent.tool ?? bodyById(id)?.agent?.weapon ?? null),
    bodies: () => [...(player ? [[PLAYER, player]] : []), ...[...npcs.values()].map((n) => [n.id, n.body, n.kind])],
    quiet: () => game.running,   // a team game posts its own (src/game/index.js died)
  });
  const loadNpcs = () => (npcLoading ??= import('./npc.js').then((m) => { npcAi = m.createAi({ renderer, getSim: app.getSim }); npcMod = m; return { mod: m, ai: npcAi }; })
    .catch((err) => { console.error('NPCs failed to load', err); npcLoading = null; throw err; }));
  // the player as something weapons hit (an NPC's axe and gun; the player's own never hit it)
  addTarget({
    id: PLAYER,
    get alive() { return !!player && !player.dead && mode === 'on'; },
    box(min, max) {
      const hw = player.width / 2;   // (its own size: Shrink)
      min.set(player.pos.x - hw, player.pos.y, player.pos.z - hw);
      max.set(player.pos.x + hw, player.pos.y + player.height, player.pos.z + hw);
    },
    facing: (out) => povCam.dir(out),   // where the player looks (the knife's backstab test)
    get body() { return player; },      // its statuses scale its weapons (targets.js dealtScale)
    hurt(amount, cause, d, opts) {
      povEvents.emit('player:hit', { amount });   // inside the attacker's povEvents.as(): carries its id
      player.hurt(amount * (opts?.exact ? 1 : PLAYER_DAMAGE_TAKEN), cause, opts);   // exact: Halo's numbers (halo.js)
      // d null: the weapon shoves by momentum itself (the kick: shove below)
      if (d) player.applyImpulse(d.clone().setY(Math.max(d.y, 0) + PLAYER_KNOCK_UP).normalize().multiplyScalar(PLAYER_KNOCKBACK));
    },
    shove(dv) { player.applyImpulse(dv); },   // a momentum shove (an NPC's kick, cells/s)
    get body() { return player; },            // the body (a hook pulls on it: player.js tether)
  });
  // the jeep and the hoverbike (vehicles/index.js): Rapier loads on the first one
  const vehicles = createVehicles({
    renderer, scene, hud, getSim: app.getSim, getVolume: app.getVolume, getScale: app.getScale,
    getSpawners: app.getSpawners, requestRender: app.requestRender,
  });
  const viewmodel = new THREE.Group();
  viewmodel.name = 'pov-viewmodel';
  camera.add(viewmodel);
  viewmodel.visible = false;
  // Halo's grenades (G), red reticle and hitmarker in a Halo match (combat.js; the melee is kick.js)
  const combat = createCombat({
    scene, viewmodel, hud: povHud, getSim: app.getSim, getVolume: app.getVolume, getScale: app.getScale,
    ballistics: () => toolbelt?.ballistics ?? null, world: () => npcAi?.world ?? null,
    active: () => mode === 'on', isTyping: app.isTyping,
  });

  // the tool in hand, drawn on the body once the camera is out of the head (the
  // viewmodel shows it in first person): its model at the right hand, along the aim
  const heldProp = new THREE.Group();
  heldProp.name = 'pov-held';
  heldProp.visible = false;
  scene.add(heldProp);
  const heldModels = new Map();          // tool key → its model, built the first time it's held
  const hands = new WeakMap();           // a body's root → its right hand
  const vAim = new THREE.Vector3();
  let figureShown = false;               // the figure is drawn this frame (the camera is out of the head)
  // the shown figure's right hand (a bone), or null
  function rightHand() {
    const body = figure?.showing === 'real' ? figure.real.model : figure?.root;
    if (body && !hands.has(body)) hands.set(body, body.getObjectByName(body === figure.root ? STICK_HAND : REAL_HAND));
    return (body && hands.get(body)) ?? null;
  }
  // the right hand in the world while the figure is drawn, else null: a wand's casts are drawn from it in third person (tools/index.js)
  function handWorld(out) {
    const hand = figureShown ? rightHand() : null;
    if (!hand) return null;
    hand.updateWorldMatrix(true, false);
    return hand.getWorldPosition(out);
  }
  function showHeld(show, size) {
    const key = show ? toolbelt?.selectedKey : null;
    const model = key ? gearByKey(key)?.model : null;   // the wand has no model
    if (model && !heldModels.has(key)) heldModels.set(key, attachModel(heldProp, model, null, { arm: false }).obj);
    for (const [k, obj] of heldModels) obj.visible = k === key;
    const hand = rightHand();
    heldProp.visible = !!(model && hand);
    if (!heldProp.visible) return;
    hand.updateWorldMatrix(true, false);
    hand.getWorldPosition(heldProp.position);
    povCam.dir(vAim);
    heldProp.rotation.set(Math.asin(THREE.MathUtils.clamp(vAim.y, -1, 1)), povCam.look.yaw, 0, 'YXZ');
    heldProp.scale.setScalar(size * HELD_SCALE);
  }

  let mode = 'off';                      // off | entering | on | exiting
  let editing = false;
  let starting = false;                  // waiting for the drop point
  let locked = false;
  let deadSeen = false, deadTime = 0;
  let firstEntry = true;
  const dropPoint = new THREE.Vector3();
  const saved = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), target: new THREE.Vector3(), fov: 40, near: 0.05 };
  const enteredAt = new THREE.Vector3();   // the drop point in world cells (exit, in a larger world)

  // input
  const keys = new Set();
  let kickQueued = false, kickLeg = null;   // the kick key went down; the kicking leg in the viewmodel (kick.js)
  const buttons = { primary: false, secondary: false, primaryPressed: false, secondaryPressed: false };
  let wheelAcc = 0, wheelNotches = 0, wheelLast = -Infinity, wheelDir = 0;
  const test = { assumeLocked: false };   // headless tests can't lock the pointer

  const active = () => mode !== 'off';
  const live = () => mode === 'on' && !player?.dead;
  const isLocked = () => locked || test.assumeLocked;
  // Phones and tablets (touch.js): no pointer lock; the thumbs fill the same inputs instead
  const touch = createTouchControls({
    canvas, active: live,
    turn(dx, dy) { povCam.turn(dx, dy); lookMovedAt = performance.now(); },
    button(name, down, cancelled) {
      buttons[name] = down;
      if (down) buttons[`${name}Pressed`] = true;
      if (cancelled) buttons[`${name}Pressed`] = false;
    },
    wheel: (notches) => { wheelNotches += notches; },
    kick: () => { if (mode === 'on') kickQueued = true; },
    useVehicle,
  });
  const canUse = () => isLocked() || touch.enabled;   // the tools and the kick take input
  createPovAudio({ camera, getVolume: app.getVolume, getScale: app.getScale, state: () => ({ active: active(), player, toolbelt }) });

  // ---- grid ↔ world
  const toWorld = (g, out) => out.copy(g).multiplyScalar(app.getScale()).add(app.getVolume().position);
  const worldToGrid = new THREE.Matrix4();
  const box = { min: new THREE.Vector3(), max: new THREE.Vector3(), margin: 0 };

  // ---- pointer lock
  function requestLock() {
    if (editing || touch.enabled || document.pointerLockElement === canvas) return;   // touch has no pointer lock
    try { canvas.requestPointerLock()?.catch?.(() => {}); } catch { /* not allowed here */ }
  }
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    document.body.classList.toggle('pov-locked', locked);
    if (locked) setMenu(false);
    if (!locked) releaseInput();
    app.requestRender();
  });
  function releaseInput() {
    keys.clear();
    buttons.primary = buttons.secondary = buttons.primaryPressed = buttons.secondaryPressed = false;
    wheelNotches = wheelAcc = 0;
    touch.reset();
  }

  // Q: the spawn menu, Garry's Mod's: the mouse is freed and the palette shows
  // where it was left. A tool picked goes in hand (app.js giveGear); anything
  // else loads the tool gun (app.js loadToolGun). Q again, a click on the world
  // or a pick closes it.
  let menuOpen = false;
  function setMenu(v) {
    const was = menuOpen;
    menuOpen = !!v && active();
    document.body.classList.toggle('pov-menu', menuOpen);
    if (menuOpen) app.showToolsMenu?.();
    else if (was) app.hideToolsMenu?.();
    if (menuOpen && document.pointerLockElement === canvas) document.exitPointerLock();
    app.requestRender();
  }

  // a Halo match's spawn closes it (Q does nothing in one: the hands hold the match's guns, arsenal.js)
  povEvents.on('game:spawn', ({ bot, style }) => { if (!bot && style === 'halo' && menuOpen) { setMenu(false); requestLock(); } });

  // F1: the HUD and the hand hidden (death and the mouse prompt still show)
  let hudHidden = false;
  const setHudHidden = (v) => { hudHidden = v; document.body.classList.toggle('pov-nohud', v); app.requestRender(); };

  // Ctrl swaps the view on its own release, so a Ctrl chord (Ctrl+click, Ctrl+Z) doesn't
  let viewTap = false;
  const swapView = () => { if (mode !== 'exiting') povCam.third = !povCam.third; };
  addEventListener('keydown', (e) => {
    viewTap = VIEW_TAP_KEYS.has(e.code) && !e.repeat && !e.metaKey && !e.altKey && !e.shiftKey;
  }, { capture: true });
  addEventListener('mousedown', () => { viewTap = false; }, { capture: true });
  addEventListener('keyup', (e) => {
    if (!VIEW_TAP_KEYS.has(e.code) || !viewTap) return;
    viewTap = false;
    if (!editing && active() && !app.isTyping()) swapView();
  });
  addEventListener('keydown', (e) => {
    if (editing || !active() || app.isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (MOVE_KEYS.has(e.code)) { keys.add(e.code); if (e.code === 'Space') e.preventDefault(); }
    if (e.code === VIEW_KEY) {
      e.preventDefault();
      if (!e.repeat) swapView();
    }
    if (e.code === VEHICLE_KEY && !e.repeat && !(mode === 'on' && interact.use())) useVehicle();   // E: the thing looked at first
    if (e.code === KICK_KEY && !e.repeat && mode === 'on') kickQueued = true;   // the kick (kick.js): always to hand, no slot
    // Sprint: Toggle (the setting): Shift flips sprinting on and off instead of being held
    if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !e.repeat && app.settings.sprintMode === 'toggle') sprintOn = !sprintOn;
    // F1, as in Minecraft: hide the HUD and the hand, for a clean view or a screenshot
    if (e.code === 'F1') { e.preventDefault(); if (!e.repeat) setHudHidden(!hudHidden); }
    // (not in a Halo match: no sandbox tools, no spawn menu, docs/halo-contract.md)
    if (e.code === 'KeyQ' && !e.repeat && mode === 'on' && game.style !== 'halo') {
      if (menuOpen) { setMenu(false); requestLock(); } else setMenu(true);
    }
    // settings and help need the mouse
    if (((e.key === ',' && !classes) || e.key === '?') && document.pointerLockElement === canvas) document.exitPointerLock();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', releaseInput);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseInput(); });   // (a phone's app switch)
  // E (or the touch Vehicle button): get in, out, or right one
  function useVehicle() {
    if (live() && vehicles.use(player) === 'enter') povCam.setLook(vehicles.headingYaw(), CHASE_PITCH);
  }

  // TF2's class picker on its key, comma (classPicker.js, docs/classes.md). Made
  // now, so its keys are heard before the toolbelt's digits.
  const classes = CLASSES_ENABLED ? createClassPicker({
    isActive: () => active() && mode !== 'exiting',
    getBody: () => player,
    getToolbelt: () => toolbelt,
    lock: requestLock,
    unlock: () => { if (document.pointerLockElement === canvas) document.exitPointerLock(); },
    isLocked: () => locked,
    toast: (text) => hud.toast(text),
    allowed: () => !(game.running && game.style === 'halo'),   // a Halo match: no classes (docs/halo-contract.md)
    inRoom: () => game.inSpawnRoom(),                         // Siege: the side's respawn room, or setup (TF2)
  }) : null;

  canvas.addEventListener('mousedown', (e) => {
    if (editing || !active()) return;
    if (!isLocked()) { if (mode !== 'exiting') requestLock(); return; }   // the click that locks doesn't fire
    if ((e.button === 0 || e.button === 2) && toolbelt?.confirmSelection?.()) return;   // picks from the slot selector, as in HL2
    if (e.button === 0) { buttons.primary = true; buttons.primaryPressed = true; }
    if (e.button === 2) { buttons.secondary = true; buttons.secondaryPressed = true; }
  });
  addEventListener('mouseup', (e) => {
    if (e.button === 0) buttons.primary = false;
    if (e.button === 2) buttons.secondary = false;
  });
  document.addEventListener('mousemove', (e) => {
    if (editing || !active() || !locked || mode === 'exiting') return;
    povCam.turn(e.movementX, e.movementY);
    lookMovedAt = performance.now();
  });
  canvas.addEventListener('wheel', (e) => {
    if (editing || !active()) return;
    e.preventDefault();
    if (!isLocked()) return;
    const px = e.deltaY * (e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? WHEEL_PAGE_PX : 1);
    if (!px) return;
    const now = performance.now(), dirn = Math.sign(px);
    if (now - wheelLast > WHEEL_GESTURE_GAP_MS || dirn !== wheelDir) {
      wheelNotches += dirn;   // a new gesture (or a change of direction): one notch now
      wheelAcc = 0;
    } else {
      wheelAcc += px;
      const n = Math.trunc(wheelAcc / WHEEL_NOTCH_PX);
      wheelNotches += n;
      wheelAcc -= n * WHEEL_NOTCH_PX;
    }
    wheelLast = now;
    wheelDir = dirn;
  }, { passive: false });

  // ---- lazily built parts
  function ensureFigure() {
    if (!figure) {
      figure = createBody({ choice: () => app.settings.character });   // realistic or stickman, live
      scene.add(figure.root);
    }
    figure.bind(app.getVolume(), app.getSim().g);
    return figure.compile(renderer, camera, scene);
  }
  // compile the figure's shader once the page has settled, not on the first F
  if (createPlayer) {
    const idle = globalThis.requestIdleCallback ?? ((fn) => setTimeout(fn, PREWARM_DELAY_MS));
    setTimeout(() => idle(() => { if (app.getSim()) ensureFigure(); }), PREWARM_DELAY_MS);
  }
  function ensureParts() {
    if (!player) {
      player = createPlayer({ renderer, getSim: app.getSim });
      player.on('land', ({ speed }) => povCam.land(speed));
      player.on('revive', () => { hud.toast(`${perkName('EXTRA_LIFE')}: back on your feet`); povEvents.emit('perk:revive', { point: player.pos.clone() }); });
      player.on('revenge', ({ point }) => povEvents.emit('blast', { point }));
      povEvents.on('blast', ({ by }) => { if (!by) player.ownBlast(); });   // the player's own rocket or bomb
      player.on('splash', ({ speed }) => vfx?.splash(player.pos, speed, player.liquidId));
      feel.bindPlayer(player);
    }
    if (!vfx) {
      try {
        vfx = createVfx({ scene, camera, getVolume: app.getVolume, getScale: app.getScale, isActive: () => mode === 'on' || mode === 'entering' });
        // compile the particle shaders now, during the swoop, not on the first shot
        renderer.compileAsync(vfx.batch, camera, scene).catch(() => {});
      } catch (err) { console.error('POV effects failed to start', err); }
    }
    if (!camera.parent) scene.add(camera);   // its children (the viewmodel) render with the scene
    if (!toolbelt && createToolbelt) {
      try {
        toolbelt = createToolbelt({
          renderer, scene,
          getSim: app.getSim, getVolume: app.getVolume, getScale: app.getScale,
          hud, viewmodel, handWorld,
          interact,                            // Descent's wand and spell pickups (wands/loot.js)
          getScene: () => (app.inWorld?.() ? app.settings.scene : null),   // the world scene loaded (Descent levels are world scenes)
          toolGun: app.toolGun,   // the god view's click at the crosshair (app.js), for the tool gun
          isActive: () => live() && !editing,
          getStepsPerFrame: () => app.settings.paused ? 0 : app.settings.steps,
          requestRender: app.requestRender,
          releaseInput,
          onEditorOpenChange(open) { editing = open; releaseInput(); sprintOn = false; app.requestRender(); },
        });
      } catch (err) { console.error('POV toolbelt failed to start', err); }
    }
    if (toolbelt && player?.kicker) player.kicker.ballistics = toolbelt.ballistics;   // kicked sand flies as a projectile (kick.js)
  }

  // Where to drop in: on top of the hovered surface, else on whatever is in
  // the middle of the box.
  const hitToFeet = (hit, g, out) => {
    const c = hit.cell, axis = Math.floor(hit.face / 2), sign = hit.face % 2 === 0 ? 1 : -1;
    out.set(c.x + 0.5, c.y, c.z + 0.5);
    if (axis === 1) out.y = sign > 0 ? c.y + 1 : c.y - BODY_HEIGHT;   // on top / under an overhang
    else out.setComponent(axis, out.getComponent(axis) + sign);        // beside a wall: drop down along it
    const hw = BODY_WIDTH / 2;
    out.x = THREE.MathUtils.clamp(out.x, hw, g.nx - hw);
    out.z = THREE.MathUtils.clamp(out.z, hw, g.nz - hw);
    out.y = THREE.MathUtils.clamp(out.y, 0, g.ny - BODY_HEIGHT);
    return out;
  };
  async function findDropPoint(out) {
    const fixed = app.dropAt?.();   // a map that says where you start (a Descent level's spawn: app.js)
    if (fixed) return out.copy(fixed);
    const g = app.getSim().g;
    const hv = app.hover;
    // a player spawn: the one nearest the cursor's surface (or the box's middle)
    const sp = app.getSpawners?.();
    if (sp?.of('player').length) {
      const near = app.pointerHover() && hv.valid ? hitToFeet(hv, g, new THREE.Vector3()) : new THREE.Vector3(g.nx / 2, 0, g.nz / 2);
      const s = sp.nearestPlayer(near);
      if (s) return out.copy(sp.feet(s));
    }
    if (app.pointerHover() && hv.valid) return hitToFeet(hv, g, out);
    const hit = await app.pickRay(new THREE.Vector3(g.nx / 2, g.ny + 1, g.nz / 2), new THREE.Vector3(0, -1, 0));
    if (hit?.valid) return hitToFeet(hit, g, out);
    return out.set(g.nx / 2, 0, g.nz / 2);
  }

  const camPose = () => ({ pos: camera.position.clone(), quat: camera.quaternion.clone(), fov: camera.fov });

  // Drop in. A call while a drop-in is under way waits for it (app.js startMode
  // starts a match once the player exists). opts.swoop: s of the flight down from
  // the god view (a match: 0, Halo's cut straight to the eyes); opts.hint: the
  // keys' hint on the first drop-in (a match shows its own card, game/hud.js);
  // opts.at: drop in with the feet here (grid cells) and keep the body as it
  // is, health, fuel and statuses (player.teleport): a Descent level change
  let dropping = null;
  function enter(opts) { return starting ? dropping : (dropping = dropIn(opts)); }
  async function dropIn(opts = {}) {
    const { swoop = SWOOP_S, hint = true } = opts;
    if (mode === 'on' || mode === 'entering' || starting) return;
    if (app.mp.isGuest) { hud.toast("POV isn't available as a guest yet"); return; }
    if (mode === 'exiting') {   // changed our mind halfway out: fly back in
      mode = 'entering';
      povCam.startSwoop('in', camPose());
      requestLock();
      return;
    }
    if (!createPlayer) { hud.toast('First-person mode is still being built'); return; }
    requestLock();   // while the key press still counts as a user gesture
    starting = true;
    const foundAt = new THREE.Vector3();   // the window's origin when the drop point was found (docs/scaling.md D11)
    try {
      await Promise.all([(opts.at ? Promise.resolve(dropPoint.copy(opts.at)) : findDropPoint(dropPoint)).then(() => foundAt.copy(app.getSim().origin)), ensureFigure()]);
      ensureParts();
      // the figure may compile for a while, and a world's window move meanwhile
      const o = app.getSim().origin;
      dropPoint.x += foundAt.x - o.x;
      dropPoint.z += foundAt.z - o.z;
    } catch (err) {
      console.error('POV failed to start', err);
      hud.toast("Couldn't drop in here");
      starting = false;
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      return;
    }
    starting = false;
    // remember the god view exactly
    saved.pos.copy(camera.position);
    saved.quat.copy(camera.quaternion);
    saved.target.copy(controls.target);
    saved.fov = camera.fov;
    saved.near = camera.near;
    controls.enabled = false;
    // stop any orbit damping still in flight, so popping out lands exactly here
    controls._sphericalDelta?.set(0, 0, 0);
    controls._panOffset?.set(0, 0, 0);

    // face where the god camera was looking
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    povCam.setLook(Math.atan2(-fwd.x, -fwd.z), ENTRY_PITCH);
    povCam.reset();
    zoom.reset();
    feel.reset();
    if (opts.at && !player.dead) player.teleport(dropPoint.clone());
    else player.spawn(dropPoint.clone());
    classes?.spawned(player);
    enteredAt.copy(dropPoint).add(app.getSim().origin);
    deadSeen = false;
    povCam.startSwoop('in', camPose(), { duration: swoop });
    camera.near = POV_NEAR * app.getScale();
    camera.updateProjectionMatrix();
    mode = 'entering';
    document.body.classList.add('pov-on');
    hud.dismissHint();
    povHud.show(true);
    if (firstEntry && hint) { povHud.showHint(); firstEntry = false; }
    app.requestRender();
  }

  function exit(instant = false) {
    if (!active()) return;
    vehicles.reset(player);
    setMenu(false);
    toolbelt?.setVisible(false);
    viewmodel.visible = heldProp.visible = false;
    classes?.close({ relock: false });
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    releaseInput();
    // In a world larger than the grid, the god view comes back over where the
    // body is now, as it was framed over the drop point, not across the world
    // where it went in (the window would have to go all the way back).
    if (app.inWorld?.() && player) {
      const here = vB.copy(player.pos).add(app.getSim().origin);
      const moved = vA.subVectors(here, enteredAt).multiplyScalar(app.getScale());
      saved.pos.add(moved);
      saved.target.add(moved);
      enteredAt.copy(here);   // (flying back in and out again moves it on from here)
    }
    if (instant) { finishExit(); return; }
    mode = 'exiting';
    povCam.startSwoop('out', camPose(), { to: { pos: saved.pos, quat: saved.quat, fov: saved.fov } });
    povHud.show(false);
  }

  function finishExit() {
    mode = 'off';
    touch.update({ live: false });
    zoom.reset();
    camera.position.copy(saved.pos);
    camera.quaternion.copy(saved.quat);
    camera.fov = saved.fov;
    camera.near = saved.near;
    camera.updateProjectionMatrix();
    controls.target.copy(saved.target);
    controls.enabled = true;
    controls.update();
    figure?.setVisible(false);
    for (const n of npcs.values()) n.reset();
    vehicles.reset(player);
    game.setVisible(false);
    viewmodel.visible = heldProp.visible = false;
    povHud.show(false);
    feel.reset();
    nightVision?.reset();
    vfx?.clear();
    document.body.classList.remove('pov-on');
    setHudHidden(false);
    sprintOn = false;
    app.requestRender();
  }

  // ---- per frame
  const ctx = {
    sim: null, dt: 0, stepsPerFrame: 0,
    toolRate: 1,                    // tool speed (the Faster Tools perk; tools/action.js toolDt)
    eye: new THREE.Vector3(), dir: new THREE.Vector3(),
    primary: false, secondary: false, primaryPressed: false, secondaryPressed: false, wheel: 0,
    viewBobbing: true,              // the View Bobbing setting (the viewmodel rig's hand bob reads it)
    aim: { valid: false, cell: new THREE.Vector3(), face: 0, id: -1, T: 0, P: 0, dist: Infinity },
    player: { pos: null, vel: null, onGround: false, inLiquid: false, applyImpulse: (dv) => player?.applyImpulse(dv), teleport: (feet) => player?.teleport(feet), holdPogo: () => player?.holdPogo(), body: null },   // body: the player itself (a drink acts on it: ingest.js)
  };
  const input = { move: { x: 0, z: 0 }, jump: false, sprint: false, down: false, crouch: false };
  let sprintOn = false;     // Sprint: Toggle's state
  const vEye = new THREE.Vector3(), vFeet = new THREE.Vector3(), vA = new THREE.Vector3(), vB = new THREE.Vector3();
  const closest = new THREE.Vector3();
  let speedH = 0;
  let wasDriving = false, lookMovedAt = 0;

  function readInput() {
    input.move.x = input.move.z = 0;
    input.jump = input.sprint = input.down = input.crouch = false;
    const d = vehicles.drive;
    d.throttle = d.steer = 0; d.brake = d.boost = false;
    if (editing || mode !== 'on' || player.dead || app.isTyping()) return;
    if (vehicles.seated) {   // the keys drive: W/S throttle, A/D steer (+ is left), Space brake or hop, Shift boost
      const t = touch.state;   // (the touch stick drives too: forward throttles, sideways steers)
      d.throttle = THREE.MathUtils.clamp((keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0) + t.z, -1, 1);
      d.steer = THREE.MathUtils.clamp((keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0) - t.x, -1, 1);
      d.brake = keys.has('Space') || t.jump;
      d.boost = keys.has('ShiftLeft') || keys.has('ShiftRight') || t.sprint;
      return;
    }
    const t = touch.state;   // the touch stick adds in, analog (touch.js)
    const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0) + t.z;
    const r = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0) + t.x;
    if (f || r) {
      const fw = povCam.forwardH(vA), rt = povCam.rightH(vB);
      let x = fw.x * f + rt.x * r, z = fw.z * f + rt.z * r;
      const len = Math.hypot(x, z);
      if (len > 1) { x /= len; z /= len; }
      input.move.x = x; input.move.z = z;
    }
    input.jump = keys.has('Space') || t.jump;
    input.sprint = t.sprint || (app.settings.sprintMode === 'toggle' ? sprintOn : keys.has('ShiftLeft') || keys.has('ShiftRight'));
    input.crouch = input.down = keys.has(CROUCH_KEY) || t.down;   // crouched on land, swimming down in liquid
  }

  function update(dt) {
    touch.update({
      live: live(), tool: toolbelt?.selectedKey, inLiquid: !!player?.inLiquid,
      wantsWheel: !!toolbelt?.wantsWheel, driving: !!vehicles.seated, vehicles: vehicles.list.length > 0,
    });
    descentFrame(dt);
    if (!active()) return;
    const sim = app.getSim(), vol = app.getVolume(), scale = app.getScale();
    const g = sim.g;
    vol.updateMatrixWorld();
    worldToGrid.copy(vol.matrixWorld).invert();
    box.min.copy(vol.position);
    box.max.set(g.nx, g.ny, g.nz).multiplyScalar(scale).add(vol.position);
    box.margin = 0.5 * scale;

    // the body
    readInput();
    vehicles.beforeBody(player);
    player.update(dt, input);
    vehicles.update(dt, { player, live: live() && mode === 'on', worldToGrid });
    vehicles.afterBody(player);
    const driving = !!vehicles.seated;
    if (driving !== wasDriving) {   // in a vehicle the hands are on the wheel; out of it (E, or it blew up) they're back
      wasDriving = driving;
      if (live() && mode === 'on') toolbelt?.setVisible(!driving);
    }
    if (player.dead && !deadSeen) {
      deadSeen = true; deadTime = 0;
      toolbelt?.setVisible(false);
      releaseInput();
    }
    const match = game.playerRespawn;   // in a team game: Halo's delay, at a spawn of your side
    if (deadSeen) {
      deadTime += dt;
      const asked = !match && deadTime >= RESPAWN_MIN && (buttons.primaryPressed || keys.has('Space'));
      if ((deadTime >= (match?.delay ?? RESPAWN_DELAY) || asked) && mode === 'on') {
        keys.delete('Space');   // the key that respawned doesn't also jump
        player.spawn(match ? match.at() : dropPoint.clone());
        classes?.spawned(player);
        deadSeen = false;
        povCam.reset();
        feel.reset();
        povCam.startSwoop('in', camPose(), { duration: RESPAWN_SWOOP_S });
        mode = 'entering';
      }
    }
    speedH = Math.hypot(player.vel.x, player.vel.z);

    // the NPCs: one per enemy spawner, with every tool you have. Not in a world
    // (g.windowed): the NPCs don't move with the window (windowShifted).
    const sp = app.getSpawners?.();
    const npcFrame = { player, holding: toolbelt?.selectedKey ?? null, toWorld, worldToGrid, scale, stepsPerFrame: app.settings.paused ? 0 : app.settings.steps };
    const npcsWanted = !!sp && !g.windowed && (mode === 'on' || mode === 'entering') && !!toolbelt;
    const homes = npcsWanted && !game.running ? ENEMY_KINDS.flatMap((k) => sp.of(k)) : [];   // a team game (src/game) has its own bots
    if (homes.length && !npcMod) loadNpcs().catch(() => {});
    if (npcMod) {
      for (const s of homes) {
        if (npcs.has(s.id)) continue;
        const spec = {
          env: { renderer, scene, getSim: app.getSim, getVolume: app.getVolume, getScale: app.getScale, ballistics: toolbelt.ballistics },
          ai: npcAi,
          home: () => sp.feet(s),   // it appears, and comes back, on its spawner
        };
        const worm = s.kind === SPAWNER.WORM || s.kind === SPAWNER.GIANT_WORM;
        const n = worm ? npcMod.createWorm({ ...spec, size: s.kind === SPAWNER.GIANT_WORM ? 'giant' : 'small' })
          : npcMod.createNpc({ ...spec, style: s.kind === SPAWNER.GUNNER ? 'gunner' : 'axeman' });
        scene.add(n.root);
        n.body.on('revenge', ({ point }) => povEvents.emit('blast', { point }));
        n.bind(app.getVolume(), g);
        n.compile(renderer, camera, scene);
        npcs.set(s.id, n);
      }
      // a spawner taken away takes its NPC with it
      for (const [id, n] of npcs) {
        if (homes.some((s) => s.id === id) || (npcsWanted === false && sp?.list.some((s) => s.id === id))) continue;
        scene.remove(n.root); n.dispose(); npcs.delete(id);
      }
      if (npcsWanted && (npcs.size || game.botCount)) npcAi.world.update(dt);
      if (npcsWanted && npcs.size) {
        for (const n of npcs.values()) { n.bind(app.getVolume(), g); n.update(dt, npcFrame); }
      } else for (const n of npcs.values()) n.reset();
    }
    game.update(dt, npcMod && npcsWanted ? npcFrame : null);   // the bots, the objectives, the HUD
    deaths.update();   // the killfeed: who died this frame, and to what

    takePerks();

    // the camera, with the kick and shake on top of the look
    vA.copy(player.pos).setY(player.pos.y + player.eyeHeight);
    const shake = feel.update({ dt, live: mode === 'on' && !deadSeen, eye: vA });
    povCam.zoom = mode === 'on' && !deadSeen && toolbelt ? toolbelt.zoom : 1;   // a scope (the sniper's)
    // the zoom key: while it's held the wheel zooms, as in Zoomify, instead of picking a tool
    const zooming = mode === 'on' && !deadSeen && keys.has(ZOOM_KEY);
    povCam.keyZoom = zoom.update(dt, zooming, zooming ? wheelNotches : 0);
    if (zooming) wheelNotches = 0;
    toWorld(vEye.copy(vA), vEye);
    toWorld(player.pos, vFeet);
    const pose = povCam.update({
      dt, eye: vEye, feet: vFeet, scale, speedH,
      onGround: player.onGround, inLiquid: player.inLiquid, sprinting: input.sprint && !player.crouch,
      dead: deadSeen, deadTime, box, shake,
    });
    if (pose.footfall && mode === 'on' && !deadSeen) povEvents.emit('player:step', { speed: speedH, inLiquid: player.inLiquid });
    camera.position.copy(pose.pos);
    camera.quaternion.copy(pose.quat);
    if (driving && mode === 'on') {   // Halo's third-person chase camera, swinging back behind when the mouse rests
      if (performance.now() - lookMovedAt > CHASE_IDLE_S * 1000) {
        const yaw = povCam.look.yaw, d = Math.atan2(Math.sin(vehicles.headingYaw() - yaw), Math.cos(vehicles.headingYaw() - yaw));
        povCam.setLook(yaw + d * (1 - Math.exp(-CHASE_FOLLOW_RATE * dt)), povCam.look.pitch);
      }
      vehicles.chase(camera, povCam.dir(vB));
    }
    if (Math.abs(camera.fov - pose.fov) > 1e-4) { camera.fov = pose.fov; camera.updateProjectionMatrix(); }
    camera.updateMatrixWorld();
    if (pose.done === 'in') {
      mode = 'on';
      toolbelt?.setVisible(true);
    } else if (pose.done === 'out') {
      finishExit();
      return;
    }

    // the figure: shown once the camera is out of the head
    figureShown = pose.eyeDist > FIGURE_HIDE_DIST && !driving && !player.gibbed;
    figure.setVisible(figureShown);   // the vehicle draws its driver; a body burst into meat has nothing left to draw
    figure.update(dt, {
      // Shrink: the figure at the body's size, its gait timed at the plain figure's speed for the size
      feet: vFeet, scale: scale * player.size, yaw: povCam.look.yaw, worldToGrid,
      speedH: speedH / player.size, velY: player.vel.y, onGround: player.onGround, inLiquid: player.inLiquid, headInLiquid: player.headInLiquid,
      dead: deadSeen, deadTime, heat: player.feel?.heat ?? 0, jetting: player.jetting, status: player.status, kick: player.kickPose, crouch: player.crouch,
    });
    if (player.jetting && mode === 'on') vfx?.jet(player.pos, povCam.look.yaw, dt, figure.nozzles);
    // flames licking off burning bodies (status.js BURNING), the player's and the NPCs'
    if (player.status.has('BURNING') && !player.dead) vfx?.burn(player.pos, dt);
    for (const n of npcs.values()) if (n.body.status?.has('BURNING') && !n.body.dead) vfx?.burn(n.body.pos, dt);
    viewmodel.visible = mode === 'on' && !deadSeen && pose.eyeDist <= FIGURE_HIDE_DIST && !hudHidden && !driving;
    showHeld(mode === 'on' && !deadSeen && pose.eyeDist > FIGURE_HIDE_DIST && !driving && !player.gibbed, scale * player.size);

    // the toolbelt
    const aim = ctx.aim, hv = app.hover;
    ctx.eye.copy(player.pos).setY(player.pos.y + player.eyeHeight);
    povCam.dir(ctx.dir);
    aim.valid = hv.valid;
    if (hv.valid) {
      aim.cell.copy(hv.cell); aim.face = hv.face; aim.id = hv.id; aim.T = hv.T; aim.P = hv.P;
      // distance from the eye to the nearest point of the cell
      closest.set(
        THREE.MathUtils.clamp(ctx.eye.x, hv.cell.x, hv.cell.x + 1),
        THREE.MathUtils.clamp(ctx.eye.y, hv.cell.y, hv.cell.y + 1),
        THREE.MathUtils.clamp(ctx.eye.z, hv.cell.z, hv.cell.z + 1));
      aim.dist = closest.distanceTo(ctx.eye);
    } else aim.dist = Infinity;
    interact.update(ctx.eye, ctx.dir, aim.dist, live() && mode === 'on' && !deadSeen && !driving && !editing);
    if (live() && toolbelt && !driving) {
      ctx.sim = sim;
      ctx.dt = dt;
      ctx.toolRate = player.perks.toolRate;
      ctx.stepsPerFrame = app.settings.paused ? 0 : app.settings.steps;
      const use = !editing && canUse();
      // a touch tap can start and end between frames: it still holds for one (on desktop the mouse can't)
      const tapped = touch.enabled;
      ctx.primary = use && (buttons.primary || (tapped && buttons.primaryPressed));
      ctx.secondary = use && (buttons.secondary || (tapped && buttons.secondaryPressed));
      ctx.primaryPressed = use && buttons.primaryPressed;
      ctx.secondaryPressed = use && buttons.secondaryPressed;
      ctx.wheel = wheelNotches;
      ctx.viewBobbing = app.settings.viewBobbing;
      ctx.player.pos = player.pos;
    ctx.player.body = player;
      ctx.player.vel = player.vel;
      ctx.player.onGround = player.onGround;
      ctx.player.inLiquid = player.inLiquid;
      ctx.player.body = player;   // the body itself, for a tool that hangs it on a rope (the hook: player.tether)
      try { toolbelt.update(ctx); } catch (err) { console.error('POV toolbelt update failed', err); }
    }
    // the kick: the body's (player.kick), along the aim; the leg and the view's jolt are the shell's
    if (kickQueued) {
      kickQueued = false;
      const r = live() && canUse() ? player.kick(ctx.dir) : null;
      if (r) {
        kickLeg ??= createKickLeg({ viewmodel, getScale: app.getScale });
        kickLeg.start(!!r.hit);
        if (r.hit) viewmodelRig({ viewmodel, getScale: app.getScale }).hit(HIT.KICK);
      }
    }
    kickLeg?.update(dt);
    combat.update({
      dt, player, eye: ctx.eye, dir: ctx.dir, tool: toolbelt?.selectedKey ?? null,
      live: live() && mode === 'on' && canUse() && !editing && !driving, stepsPerFrame: app.settings.paused ? 0 : app.settings.steps,
    });
    buttons.primaryPressed = buttons.secondaryPressed = false;
    wheelNotches = 0;

    // Night Vision: the goggles follow the scene's measured light (nightVision.js)
    nightVision?.update(dt, mode === 'on' && !deadSeen ? player.perks.nightGain : 0);
    if (nightVision?.on > 0) app.requestRender();   // (the grain moves)

    // effects: keep drawing while any are in flight (rendering is on demand)
    if (vfx?.update(dt)) app.requestRender();

    // the HUD
    povHud.update({
      dt, health: player.health, breath: player.breath, feel: player.feel,
      shield: player.shield, shieldMax: player.shieldMax, shieldCharging: player.shieldCharging,
      jetFuel: player.jetFuel, jetting: player.jetting, mana: toolbelt?.mana ?? null, perks: player.perks, status: player.status,
      gold: descent.goldShown,
      dead: deadSeen, cause: player.cause, respawnIn: (match?.delay ?? RESPAWN_DELAY) - deadTime,
      locked: canUse(), swooping: mode !== 'on',
      aimValid: aim.valid, aimInReach: aim.valid && aim.dist <= HAND_REACH, third: povCam.third,
    });
  }

  // The Descent map (descent/index.js): every frame, in the body or not (its
  // nuggets and shop items follow the window in the god view too)
  function descentFrame(dt) {
    const sp = npcs.size ? app.getSpawners?.() : null;
    descent.update({
      dt, time: performance.now() / 1000, player, live: mode === 'on' && live(),
      npcs: [...npcs].map(([id, n]) => ({ id, body: n.body, kind: sp?.list.find((s) => s.id === id)?.kind })),
    });
  }

  // Perk orbs (perkOrbs.js): the player looks at one and presses E (interact.js),
  // seeing what it is first; an NPC walks into one.
  interact.provide(() => {
    const orbs = app.getPerkOrbs?.();
    if (!orbs?.list.length || !player || player.dead) return [];
    return orbs.list.map((o) => {
      const p = orbs.feet(o, new THREE.Vector3());
      if (!p) return null;
      p.y += ORB_LIFT;
      const have = player.perks.count(o.key);
      return { id: `perk${o.id}`, position: p, radius: PERK_TARGET_R, title: `${perkName(o.key)}${have ? ` (have ×${have})` : ''}`,
        lines: [PERK[o.key].desc, ...(o.shrine ? ['Taking it takes the others away.'] : [])], verb: 'Take',
        use: () => { const got = orbs.take(o); if (got) gainPerk(player, got); return !!got; } };
    }).filter(Boolean);
  });
  function takePerks() {
    const orbs = app.getPerkOrbs?.();
    if (!orbs?.list.length) return;
    for (const n of npcs.values()) {
      if (n.body.dead || !n.body.perks) continue;   // a worm takes no perks
      const got = orbs.takeAt(n.body.pos);
      if (got) gainPerk(n.body, got, n.id);
    }
  }
  function gainPerk(body, { key, at }, by) {
    app.requestRender();   // the orb is gone
    const keys = grant(body.perks, key);
    const names = keys.map(perkName).join(' + ');
    povEvents.emit('perk:take', { key, keys, point: at, by });
    if (by) hud.toast(`The enemy took ${names}`);
    else if (keys.length === 1 && keys[0] === key) hud.toast(`${names}${body.perks.count(key) > 1 ? ` ×${body.perks.count(key)}` : ''}: ${PERK[key].desc}`);
    else hud.toast(`${perkName(key)}: ${names}`);
  }

  // The pick ray in grid space (for app's requestPick): the screen centre.
  // In third person it starts level with the eye, so nothing between the
  // camera and the body gets picked.
  function aimRay(ro, rd) {
    if (!active() || !player) return false;
    const scale = app.getScale();
    ro.copy(camera.position).sub(app.getVolume().position).divideScalar(scale);
    // the aim, not the shaken view: kick and shake are only felt
    if (mode === 'on' && !deadSeen) povCam.dir(rd);
    else camera.getWorldDirection(rd);
    const eye = vA.copy(player.pos).setY(player.pos.y + player.eyeHeight);
    const skip = Math.max(0, vB.subVectors(eye, ro).dot(rd));
    ro.addScaledVector(rd, skip);
    return true;
  }

  // Team games (src/game): teams of bots, the modes, their HUD
  const game = createGame({
    app, scene, renderer, camera,
    get player() { return player; },
    deaths: { heldOn: (id, by) => deaths.heldOn(id, by) },   // the killfeed's books: a kill's weapon
    get toolbelt() { return toolbelt; },
    interact,                        // look + E: the power weapons' pads and dropped guns (arsenal.js)
    active,
    locked: canUse,   // the mouse is captured (or touch): a match's "Click to play" (game/hud.js)
    loadNpcs,
    env: () => ({ renderer, scene, getSim: app.getSim, getVolume: app.getVolume, getScale: app.getScale, ballistics: toolbelt.ballistics }),
    loadPreset: () => app.loadPreset?.(app.settings.preset),
    // a respawn at `at` now (a new round, a team switch)
    respawnPlayer(at) {
      if (!player) return;
      player.spawn(at.clone());
      classes?.spawned(player);   // the class back on (none in a Halo match), before the game's game:spawn
      if (deadSeen) { deadSeen = false; toolbelt?.setVisible(mode === 'on'); }
      feel.reset();
    },
    freeMouse: () => { if (document.pointerLockElement === canvas) document.exitPointerLock(); },
  });
  // TF2's class menu opens when you join a team: a Siege match's start and a team switch
  // ('.'). A Halo match has no classes: the picker shuts (docs/halo-contract.md).
  const joinedTf2 = () => { if (game.running && game.style === 'tf2' && player?.team) classes?.open({ joined: true }); };
  povEvents.on('game:start', () => { if (game.style === 'halo') classes?.close({ relock: false }); else joinedTf2(); });
  povEvents.on('game:team', ({ id }) => { if (id === PLAYER && game.running) joinedTf2(); });

  // god-mode keys POV takes over (app.js skips them while active)
  const blocksKey = (e) => editing || (active() && !PASS_KEYS.has(e.key) && !(e.metaKey || e.ctrlKey));

  return {
    get active() { return active(); },
    get mode() { return mode; },
    get locked() { return isLocked(); },
    get player() { return player; },
    get toolbelt() { return toolbelt; },
    descent,                     // the Descent map's gold, shop, altar, pool and refresher (descent/index.js)
    interact,                    // look + E (interact.js): focus, use()
    vehicles,                    // the jeep and the hoverbike (vehicles/index.js): spawnLayout(layout), list, seated
    get classes() { return classes; },   // the class picker (classPicker.js), or null with CLASSES_ENABLED off
    get editingWand() { return editing; },
    get wandRuntime() { return toolbelt?.wandRuntime ?? null; },
    async equipWand(definition) {
      await enter();
      return active() && !!toolbelt?.equipWand(definition);
    },
    openWandEditor() { if (active()) toolbelt?.openEditor(); },
    // what the held tool shows next to the crosshair ({ name, color, T?, P?, note? } for ui/hud.js showReadout), or null
    get readout() { return live() && mode === 'on' && toolbelt ? toolbelt.readout : null; },
    get figure() { return figure; },
    get npc() { return npcs.values().next().value ?? null; },   // the first NPC, once loaded (checks)
    get npcs() { return [...npcs.values()]; },
    events: povEvents,           // the POV event bus (checks)
    game,                        // team games (src/game): start(mode), end(), useLayout(layout), state
    combat,                      // Halo combat (combat.js): frags (frag.js), throw(), red
    get vfx() { return vfx; },
    feel,
    get ctx() { return ctx; },
    camera: povCam,
    viewmodel,
    test,
    dropPoint,
    toggle() { if (mode === 'on' || mode === 'entering') exit(); else enter(); },
    enter,
    exit,
    update,
    // the world was replaced (undo, a scene load): tools drop what they carry from the old one
    worldReplaced: () => { toolsModule?.emptyLoads?.(); toolbelt?.worldReplaced(); },
    // the window moved over the world by (dx, 0, dz) cells (docs/scaling.md D11): grid positions move back.
    // The drop point stays put in the world: a respawn far away waits there
    // for the window to come (player.js).
    windowShifted(dx, dz) {
      dropPoint.x -= dx;
      dropPoint.z -= dz;
      player?.windowShifted(dx, dz);
      toolbelt?.windowShifted(dx, dz);
      combat.windowShifted(dx, dz);
    },
    aimRay,
    blocksKey,
    // close the tools menu and take the mouse back (a tool was given from it: a click, so the lock is allowed)
    closeMenu() { if (!menuOpen) return; setMenu(false); requestLock(); },
    // tests: look around without pointer lock (radians)
    setLook: (yaw, pitch) => povCam.setLook(yaw, pitch),
  };
}
