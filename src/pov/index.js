import * as THREE from 'three';
import { BODY_HEIGHT, BODY_WIDTH, HAND_REACH } from './constants.js';
import { createPovCamera, ENTRY_PITCH, FIGURE_HIDE_DIST, RESPAWN_SWOOP_S, SWOOP_S } from './camera.js';
import { createCameraArm } from './cameraArm.js';
import { ELEMENTS } from '../elements.js';
import { createBody } from './figureReal.js';
import { characterForMode } from './character.js';
import { STICK_HAND } from './figure.js';
import { createHeld } from './held.js';
import { gearByKey } from './tools/catalog.js';
import { createPovHud } from './hud.js';
import { createPovAudio, voiceBus } from './audio.js';
import { createFeel } from './feel.js';
import { createVfx } from './vfx.js';
import { povEvents } from './events.js';
import './pov.css';
import './potions.js';   // Noita's potion statuses: stains and drinks (registers them)
import { addTarget, bodyTarget, PLAYER } from './targets.js';
import { grant, PERK } from './perks.js';
import { createInteract } from './interact.js';
import { overlapsLadder } from './ladder.js';
import { createImportedInteractions } from './importedInteractions.js';
import { ORB_LIFT } from '../perkOrbs.js';
import { CLASSES_ENABLED } from './classes.js';
import { createClassPicker, applyClassTo } from './classPicker.js';
import { createBallistics } from './ballistics.js';
import { createVehicles } from './vehicles/index.js';
import { createNightVision } from './nightVision.js';
import { KICK_KEY, createKickLeg } from './kick.js';
import { createCombat } from './combat.js';
import { viewmodelRig, HIT } from './viewmodel.js';
import { createGame } from '../game/index.js';
import { createMission, residentIn } from '../game/mission.js';
import { createMissionHud } from '../game/missionHud.js';
import { createMarkers } from '../game/markers.js';
import { createDeathWatch } from './killfeed.js';
import { createSandboxMedals } from './sandboxMedals.js';
import { connectAnnouncer, announceMatches } from './announcer.js';
import { SPAWNER, ENEMY_KINDS } from '../spawners.js';
import { createZoom, ZOOM_KEY } from './zoom.js';
import { createTouchControls } from './touch.js';
import { createDescent } from './descent/index.js';
import { preparePov, volumeLight } from './gpu.js';
import { leash } from '../net/protocol.js';
import { createVillage } from './village/index.js';
import { gridSpace } from './space.js';
import { SMALL_MAP, kindOfGrid } from '../mapKind.js';

// First-person (POV) mode: drop into the world with V (Garry's Mod's noclip
// key), walk around in it, pop back out to the god view's
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
// cells: in the eyes, the march (render.js uMarchNear) draws nothing closer, so grains
// falling past the face aren't drawn as sheets across the view. Source's VIEW_NEARZ, 7
// units against its hull's 16-unit half-width, on this body's half-width.
const EYE_CLIP = (7 / 16) * (BODY_WIDTH / 2);
// Buried (the head in powder or solid: player.js buriedId), the first-person view is
// Minecraft's in-wall overlay: the matter's colour at its 0.1 brightness (ScreenEffectRenderer)
const BURIED_SHADE = 0.1;
const shadeHex = (hex, k) => `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('')}`;
const BURIED_COLOR = ELEMENTS.map((e) => shadeHex(e.color, BURIED_SHADE));
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
const REAL_HAND = 'hand_r';             // the realistic body's right-hand bone (figureReal.js)
const VEHICLE_KEY = 'KeyE';             // get in, get out, or right a vehicle (vehicles/index.js; Halo's and most shooters' use key)
// Driving, the chase camera swings back behind the vehicle once the mouse rests (GTA's and most driving games')
const CHASE_PITCH = -0.22;              // rad, the look on getting in: a little down onto the vehicle
const CHASE_IDLE_S = 1.2;               // s without mouse look before it swings back behind
const CHASE_FOLLOW_RATE = 2.5;          // 1/s, how fast it swings
// god-mode keys that stay live in POV: help, settings, screenshot, closing menus.
// In a TF2-style match (Siege) comma is the class key instead (classPicker.js, classesOn below).
const PASS_KEYS = new Set(['Escape', '?', ',', 'F2']);

// app = { renderer, scene, camera, controls, canvas, hud, settings, mp, isTyping, post (gfx/post.js: night vision),
//         getSim, getVolume, getScale, hover, pointerHover (() => bool), pickRay (ro, rd → Promise<hit>),
//         requestRender, mapKind (() => what differs on this map, small or big: src/mapKind.js),
//         showToolsMenu (the palette's first-person tools brought into view: Q), hideToolsMenu (Q closed) }
export function createPov(app) {
  const { renderer, scene, camera, controls, canvas, hud } = app;
  const mapKind = () => app.mapKind?.() ?? SMALL_MAP;
  const createPlayer = playerModule?.createPlayer;
  const createToolbelt = toolsModule?.createToolbelt;

  const povCam = createPovCamera({
    fov: () => app.settings.povFov, sensitivity: () => app.settings.sensitivity, bobbing: () => app.settings.viewBobbing,
  });
  // the third-person and death cameras' spring arms, traced in the grid (cameraArm.js)
  const cameraArm = createCameraArm({ renderer, cellAt: (x, y, z) => player.cellAt(x, y, z), top: () => app.getSim().g.ny });
  const armFrom = new THREE.Vector3(), armTo = new THREE.Vector3();
  const arm = {
    want: (k, from, to) => cameraArm.want(k, armFrom.copy(from).applyMatrix4(worldToGrid), armTo.copy(to).applyMatrix4(worldToGrid), player.size),
    share: (k) => cameraArm.share(k),
  };
  let marchNear = 0;          // cells (render.js uMarchNear), this frame's
  const zoom = createZoom();   // C (zoom.js)
  const povHud = createPovHud();
  const interact = createInteract({ getMode: () => app.gamemode?.() ?? 'sandbox' });   // live gamemode, not POV's on/exiting state
  // the Descent map's Holy Mountain and gold (descent/index.js); idle off that map
  const descent = createDescent({ app, scene, hud, interact, events: povEvents, getToolbelt: () => toolbelt });
  // feedback: everything here hears povEvents (events.js) and the body's events
  const feel = createFeel({ hud: povHud });
  const nightVision = app.post ? createNightVision(app.post) : null;   // the Night Vision perk's goggles (the local player's view)
  let vfx = null;                        // three.quarks effects, built on the first drop-in
  let figure = null, player = null, toolbelt = null;
  const npcs = new Map();   // enemy spawner id → its NPC (npc.js)
  let npcBallistics = null;
  let npcMod = null, npcAi = null, npcLoading = null;   // npc.js and what NPCs share, loaded on first use
  // the killfeed's books (killfeed.js): who hurt whom last, and every body that can die
  const bodyById = (id) => [...npcs.values(), ...game.bots, ...mission.actors].find((n) => n.id === id) ?? null;
  const deaths = createDeathWatch({
    heldBy: (id) => (id === PLAYER ? toolbelt?.selectedKey ?? null : bodyById(id)?.agent?.intent.tool ?? bodyById(id)?.agent?.weapon ?? null),
    bodies: () => [...(player ? [[PLAYER, player]] : []), ...[...npcs.values(), ...mission.actors].map((n) => [n.id, n.body, n.kind])],
    quiet: () => game.running,   // a team game posts its own (src/game/index.js died)
  });
  // Halo 3's medals outside a match (sandboxMedals.js; a match's are src/game/feel.js's)
  const medals = createSandboxMedals({ quiet: () => game.running, isPlayerDead: () => !!player?.dead });
  const loadNpcs = () => (npcLoading ??= import('./npc.js').then((m) => { npcAi = m.createAi({ renderer, getSim: app.getSim }); npcMod = m; return { mod: m, ai: npcAi }; })
    .catch((err) => { console.error('NPCs failed to load', err); npcLoading = null; throw err; }));
  // the player as something weapons hit (an NPC's axe and gun; the player's own never hit it)
  addTarget(bodyTarget(PLAYER, () => player, {
    alive: () => !!player && !player.dead && mode === 'on',
    facing: (out) => povCam.dir(out),   // where the player looks
    damageScale: PLAYER_DAMAGE_TAKEN, knockback: PLAYER_KNOCKBACK, knockUp: PLAYER_KNOCK_UP,
    onHurt: (amount) => povEvents.emit('player:hit', { amount }),   // inside the attacker's povEvents.as(): carries its id
  }));
  const character = () => characterForMode(game.running ? game.mode : 'sandbox', app.settings.character);
  // the jeep and the hoverbike (vehicles/index.js): Rapier loads on the first one
  const vehicles = createVehicles({
    renderer, scene, hud, getSim: app.getSim, getVolume: app.getVolume, getScale: app.getScale,
    getSpawners: app.getSpawners, requestRender: app.requestRender, getCharacter: character,
  });
  const viewmodel = new THREE.Group();
  viewmodel.name = 'pov-viewmodel';
  viewmodel.userData.presentationOverlay = true;   // drawn over the frame: a presentation effect (gfx/presentation.js) doesn't bend it
  camera.add(viewmodel);
  viewmodel.visible = false;
  // Halo's grenades (G), red reticle and hitmarker in a Halo match (combat.js; the melee is kick.js)
  const combat = createCombat({
    scene, viewmodel, hud: povHud, getSim: app.getSim, getVolume: app.getVolume, getScale: app.getScale, getCharacter: character,
    ballistics: () => toolbelt?.ballistics ?? null, world: () => npcAi?.world ?? null,
    active: () => mode === 'on', isTyping: app.isTyping,
  });

  // the tool in hand, drawn on the body once the camera is out of the head (the
  // viewmodel shows it in first person): held.js, the body's arms on it
  const held = createHeld({ scene });
  const hands = new WeakMap();           // a body's root → its right hand
  let figureShown = false;               // the figure is drawn this frame (the camera is out of the head)
  // the shown figure's right hand (a bone), or null
  function rightHand() {
    const body = figure?.model;
    // Paper bag uses the male mesh. The procedural stickman only stands in while that mesh loads.
    const gltfHand = ['real', 'woman'].includes(figure.showing) || (figure.showing === 'stick' && figure.loaded);
    if (body && !hands.has(body)) hands.set(body, body.getObjectByName(gltfHand ? REAL_HAND : STICK_HAND));
    return (body && hands.get(body)) ?? null;
  }
  // the right hand in the world while the figure is drawn, else null: a wand's casts are drawn from it in third person (tools/index.js)
  function handWorld(out) {
    const hand = figureShown ? rightHand() : null;
    if (!hand) return null;
    hand.updateWorldMatrix(true, false);
    return hand.getWorldPosition(out);
  }

  let mode = 'off';                      // off | entering | on | exiting
  let editing = false;
  let starting = false;                  // waiting for the drop point
  let locked = false;
  let deadSeen = false, deadTime = 0;
  const dropPoint = new THREE.Vector3();
  const saved = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), target: new THREE.Vector3(), fov: 40, near: 0.05 };
  const enteredAt = new THREE.Vector3();   // the drop point in world cells (exit, in a larger world)

  // input
  const keys = new Set();
  let villageTools = null, villageToolTap = false;
  let grappleQueued = false;
  let kickQueued = false, kickLeg = null;   // the kick key went down; the kicking leg in the viewmodel (kick.js)
  const buttons = { primary: false, secondary: false, primaryPressed: false, secondaryPressed: false };
  let wheelAcc = 0, wheelNotches = 0, wheelLast = -Infinity, wheelDir = 0;
  const test = { assumeLocked: false };   // headless tests can't lock the pointer

  const active = () => mode !== 'off';
  const live = () => mode === 'on' && !player?.dead;
  const isLocked = () => locked || test.assumeLocked;
  // Phones and tablets (touch.js): no pointer lock; the thumbs fill the same inputs instead
  const touch = createTouchControls({
    canvas, active: () => live() && !village.blocked,
    turn(dx, dy) { povCam.turn(dx, dy); lookMovedAt = performance.now(); },
    button(name, down, cancelled) {
      buttons[name] = down;
      if (down) buttons[`${name}Pressed`] = true;
      if (cancelled) buttons[`${name}Pressed`] = false;
    },
    wheel: (notches) => { wheelNotches += notches; },
    kick: () => { if (mode === 'on') { if (village.enabled) void village.kick(); else kickQueued = true; } },
    useVehicle,
  });
  const coop = () => app.mp.replica || (!mapKind().coopEntities && app.mp.role === 'host');
  const coopHint = () => hud.toast('Co-op exploration: walk, jump and jet. Use god view to edit; weapons, vehicles, perks and progression require solo play.');
  const canUse = () => !village.enabled && !coop() && (!mission.engaged || mission.active) && (isLocked() || touch.enabled);
  // Intentional (gamemode: Cruelty Squad, Sandbox): E's grapple is Cruelty Squad's Grappendix (docs/grappendix.md),
  // and Sandbox has every tool; Halo/team matches, Noita's wands-only run, Animal Crossing and Factory keep their own move sets.
  const canGrapple = () => !coop() && live() && !editing && canUse() && !vehicles.seated
    && !game.running && ['sandbox', 'crueltySquad'].includes(app.gamemode?.() ?? 'sandbox') && !app.industryBuilding?.();
  const village = createVillage({ app, getPlayer: () => player, live, camera: povCam, releaseInput, releaseActions,
    onEnabled: on => { syncVillageTools(on); toolbelt?.setVisible(mode === 'on'); if (on) setMenu(false); },
    onTool: key => { toolbelt?.restrict(key ? [key] : [], key); },
    useTool: button => { villageToolTap = true; buttons[`${button}Pressed`] = true; },
    toolReadout: () => toolbelt?.readout,
    freeMouse: () => { setMenu(false); if (document.pointerLockElement === canvas) document.exitPointerLock(); },
  });
  function syncVillageTools(on) {
    if (!toolbelt) return;
    if (on && !villageTools) {
      villageTools = { restricted: toolbelt.restricted, selected: toolbelt.selectedKey };
      toolbelt.restrict(village.tool ? [village.tool] : [], village.tool);
    } else if (!on && villageTools) {
      toolbelt.restrict(villageTools.restricted, villageTools.selected);
      if (villageTools.selected) toolbelt.select(villageTools.selected);
      villageTools = null;
    }
  }
  const audio = createPovAudio({ camera, getVolume: app.getVolume, getScale: app.getScale, state: () => ({
    active: active(), player, toolbelt, sprintMusic: app.settings.sprintMusic,
  }) });
  connectAnnouncer(voiceBus);   // the announcer (announcer.js) speaks through the same chain...
  announceMatches();            // ...and calls the matches' moments

  // ---- grid ↔ world
  const { toWorld, toGrid } = gridSpace(app);
  const worldToGrid = new THREE.Matrix4();
  const box = { min: new THREE.Vector3(), max: new THREE.Vector3(), margin: 0 };

  // ---- pointer lock
  function requestLock() {
    if (editing || village.blocked || (mission.engaged && !mission.active) || touch.enabled || document.pointerLockElement === canvas) return;
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
    player?.cancelJump();
    keys.clear();
    releaseActions();
    touch.reset();
  }
  function releaseActions() {
    buttons.primary = buttons.secondary = buttons.primaryPressed = buttons.secondaryPressed = false;
    wheelNotches = wheelAcc = 0; villageToolTap = false; kickQueued = grappleQueued = false;
    toolbelt?.grapple?.release();
    // A buffered dig must not finish after pockets open or furniture takes the hands.
    if (village.enabled) toolbelt?.tool(toolbelt.selectedKey)?.deselect?.();
  }

  // Q: the spawn menu, Garry's Mod's: the mouse is freed and the palette shows
  // where it was left. A tool picked goes in hand (app.js giveGear); anything
  // else loads the tool gun (app.js loadToolGun). Q again, a click on the world
  // or a pick closes it.
  let menuOpen = false;
  function setMenu(v) {
    if (v && app.gamemode?.() === 'factory') return; // Q opens Build; spawning is the Sandbox cheat
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
    if (coop() && [KICK_KEY, 'KeyG', 'KeyQ'].includes(e.code)) { if (!e.repeat) coopHint(); return; }
    if (e.code === VEHICLE_KEY && !e.repeat) {
      e.preventDefault();
      if (coop()) { coopHint(); return; }
      if (!(mode === 'on' && interact.use()) && !useVehicle() && canGrapple()) grappleQueued = true;
    }
    if (e.code === KICK_KEY && !e.repeat && mode === 'on') kickQueued = true;   // the kick (kick.js): always to hand, no slot
    // Sprint: Toggle (the setting): Shift flips sprinting on and off instead of being held
    if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !e.repeat && app.settings.sprintMode === 'toggle') sprintOn = !sprintOn;
    // F1, as in Minecraft: hide the HUD and the hand, for a clean view or a screenshot
    if (e.code === 'F1') { e.preventDefault(); if (!e.repeat) setHudHidden(!hudHidden); }
    // (not in a Halo match: no sandbox tools, no spawn menu, docs/halo-contract.md)
    if (e.code === 'KeyQ' && !e.repeat && mode === 'on' && game.style !== 'halo' && !mission.engaged) {
      if (menuOpen) { setMenu(false); requestLock(); } else setMenu(true);
    }
    // settings and help need the mouse
    if (((e.key === ',' && !classesOn()) || e.key === '?') && document.pointerLockElement === canvas) document.exitPointerLock();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', releaseInput);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseInput(); });   // (a phone's app switch)
  // E (or the touch Vehicle button): get in, out, or right one
  function useVehicle() {
    if (coop()) { coopHint(); return true; }
    if (village.enabled) { village.act({ type: 'interact' }); return true; }
    const used = live() ? vehicles.use(player) : null;
    if (used === 'enter') povCam.setLook(vehicles.headingYaw(), CHASE_PITCH);
    return !!used;
  }

  // TF2's class picker on its key, comma (classPicker.js, docs/classes.md). Made
  // now, so its keys are heard before the toolbelt's digits. Classes are TF2's, so
  // they exist only in a TF2-style match (Siege): no picker, tip or class elsewhere.
  const classesOn = () => !!classes && game.running && game.style === 'tf2';
  const classes = CLASSES_ENABLED ? createClassPicker({
    isActive: () => active() && mode !== 'exiting' && !village.enabled,
    getBody: () => player,
    getToolbelt: () => toolbelt,
    lock: requestLock,
    unlock: () => { if (document.pointerLockElement === canvas) document.exitPointerLock(); },
    isLocked: () => locked,
    toast: (text, opts) => { if (!village.enabled) hud.toast(text, opts); },
    allowed: () => classesOn(),
    inRoom: () => game.inSpawnRoom(),                         // Siege: the side's respawn room, or setup (TF2)
  }) : null;

  canvas.addEventListener('mousedown', (e) => {
    if (editing || !active()) return;
    if (!isLocked()) { if (mode !== 'exiting') requestLock(); return; }   // the click that locks doesn't fire
    if (coop()) { coopHint(); return; }
    if (village.enabled && !village.canAct) return;
    if ((e.button === 0 || e.button === 2) && toolbelt?.confirmSelection?.()) return;   // picks from the slot selector, as in HL2
    if (e.button === 0) { buttons.primary = true; buttons.primaryPressed = true; }
    if (e.button === 2) { buttons.secondary = true; buttons.secondaryPressed = true; }
  });
  addEventListener('mouseup', (e) => {
    if (e.button === 0) buttons.primary = false;
    if (e.button === 2) buttons.secondary = false;
  });
  document.addEventListener('mousemove', (e) => {
    if (editing || village.blocked || !active() || !locked || mode === 'exiting') return;
    povCam.turn(e.movementX, e.movementY);
    lookMovedAt = performance.now();
  });
  canvas.addEventListener('wheel', (e) => {
    if (editing || !active()) return;
    e.preventDefault();
    if (!isLocked() || (village.enabled && !village.canAct)) return;
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
      figure = createBody({ choice: character });
      scene.add(figure.root);
    }
    figure.bind(volumeLight(app.getVolume()), app.getSim().g);
    return figure.compile(renderer, camera, scene);
  }
  // The body's and the tools' kernels (pov/gpu.js), built for each grid the
  // body is in, on entering POV (docs/webgpu.md B5, W18): a session that
  // never drops in builds none of them. Until they are built, its edits and
  // probes are skipped, so the drop-in waits for them as it does for the figure.
  let kernelsFor = null, kernelsBuilt = null;
  function ensureKernels() {
    const sim = app.getSim();
    if (sim !== kernelsFor) {
      kernelsFor = sim;
      kernelsBuilt = preparePov(sim);
      kernelsBuilt.catch((err) => console.error('POV kernels failed to build', err));
    }
    return kernelsBuilt;
  }
  // Optional prewarm must not compile invisible bodies during headless samples.
  // Entering POV still awaits ensureFigure() below.
  if (createPlayer && app.getSim()?.gpu?.testMode == null) {
    const idle = globalThis.requestIdleCallback ?? ((fn) => setTimeout(fn, PREWARM_DELAY_MS));
    setTimeout(() => idle(() => { if (app.getSim()) ensureFigure(); }), PREWARM_DELAY_MS);
  }
  function ensureParts() {
    if (!player) {
      player = createPlayer({ renderer, getSim: app.getSim, readOnly: () => app.mp.replica });
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
    if (!toolbelt && createToolbelt && !app.mp.replica) {
      try {
        toolbelt = createToolbelt({
          renderer, scene,
          getSim: app.getSim, getWorld: app.getWorld, getVolume: app.getVolume, getScale: app.getScale, getCharacter: character,
          hud, viewmodel, handWorld, heldOnBody: () => held.holding !== null,
          getAimCamera: () => povCam.pose.eyeDist <= FIGURE_HIDE_DIST ? camera : null,
          interact,                            // Descent's wand and spell pickups (wands/loot.js)
          getScene: () => (mapKind().presets ? null : app.settings.scene),   // the world scene loaded (Descent levels are world scenes)
          getMode: () => app.gamemode?.() ?? 'sandbox',   // the gamemode playing: Noita's wands only in it
          toolGun: app.toolGun,   // the god view's click at the crosshair (app.js), for the tool gun
          isActive: () => live() && !editing && !coop(),
          getStepsPerFrame: () => app.nativeToolSteps ?? (app.settings.paused ? 0 : app.settings.steps),
          requestRender: app.requestRender,
          getPost: () => app.post,   // its settings: the wand's halo tone maps itself by them (tools/index.js)
          releaseInput,
          requestLock,
          onEditorOpenChange(open) { editing = open; releaseInput(); sprintOn = false; app.requestRender(); },
        });
      } catch (err) { console.error('POV toolbelt failed to start', err); }
    }
    if (village.enabled) syncVillageTools(true);
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
  // the god view (a match: 0, Halo's cut straight to the eyes);
  // opts.at: drop in with the feet here (grid cells) and keep the body as it
  // is, health, fuel and statuses (player.teleport): a Descent level change
  let dropping = null;
  function enter(opts) { return starting ? dropping : (dropping = dropIn(opts)); }
  async function dropIn(opts = {}) {
    const { swoop = SWOOP_S } = opts;
    if (mode === 'on' || mode === 'entering' || starting) return;
    if (app.mp.replica && (!app.mp.isGuest || !app.mp.terrainReady || app.mp.metadata?.mode !== 'world' || app.mp.stale)) {
      hud.toast('Wait for a live World snapshot from the host before dropping in.'); return;
    }
    const entryMap = app.mp.metadata?.id;
    if (app.mp.isGuest) {
      const m = app.mp.metadata, g = app.getSim().g;
      opts = { ...opts, at: new THREE.Vector3(...leash(m, [g.nx, g.ny, g.nz], m.focus).target).sub(app.getSim().origin) };
      coopHint();
    }
    if (mode === 'exiting') {   // changed our mind halfway out: fly back in
      mode = 'entering';
      povCam.startSwoop('in', camPose());
      requestLock();
      return;
    }
    if (!createPlayer) { hud.toast('First-person mode is still being built', { kind: 'error' }); return; }
    if (!coop() && app.getMode() === 'animalCrossing' && app.getWorld()?.scene.key === 'willowCove') village.setEnabled(true, app.getWorld().P);
    requestLock();   // while the key press still counts as a user gesture
    starting = true;
    if (coop()) coopHint();
    const fromSim = app.getSim();
    const foundAt = new THREE.Vector3();   // the window's origin when the drop point was found (docs/scaling.md D11)
    try {
      await Promise.all([(opts.at ? Promise.resolve(dropPoint.copy(opts.at)) : findDropPoint(dropPoint)).then(() => foundAt.copy(app.getSim().origin)), ensureFigure(), ensureKernels()]);
      // a new grid meanwhile (another map), or the caller's own reason to give up (opts.valid)
      if (fromSim !== app.getSim() || opts.valid?.() === false || (entryMap && (app.mp.metadata?.id !== entryMap || !app.mp.isGuest))) {
        starting = false;
        if (document.pointerLockElement === canvas) document.exitPointerLock();
        return;
      }
      ensureParts();
      // the figure may compile for a while, and a world's window move meanwhile
      const o = app.getSim().origin;
      dropPoint.x += foundAt.x - o.x;
      dropPoint.z += foundAt.z - o.z;
    } catch (err) {
      console.error('POV failed to start', err);
      hud.toast("Couldn't drop in here", { kind: 'error' });
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
    povCam.setLook(village.enabled ? 0 : Math.atan2(-fwd.x, -fwd.z), village.enabled ? -0.24 : ENTRY_PITCH);
    povCam.reset();
    zoom.reset();
    feel.reset();
    if (opts.at && !player.dead) player.teleport(dropPoint.clone());
    else player.spawn(dropPoint.clone());
    if (app.mp.isGuest) {
      player.perks.clear(); player.speedScale = player.aimScale = 1; player.spawn(dropPoint.clone());
      networkPending = true; networkWarp++;
    } else classes?.spawned(player);
    enteredAt.copy(dropPoint).add(app.getSim().origin);
    deadSeen = false;
    povCam.startSwoop('in', camPose(), { duration: swoop });
    camera.near = POV_NEAR * app.getScale();
    camera.updateProjectionMatrix();
    mode = 'entering';
    document.body.classList.add('pov-on');
    povHud.show(true);
    app.requestRender();
  }

  function exit(instant = false) {
    viewmodel.userData.rig?.resetFlap();
    if (mission.engaged) { mission.end(); void app.setMode('sandbox'); }
    village.setEnabled(false);
    if (!active()) return;
    vehicles.reset(player);
    setMenu(false);
    toolbelt?.setVisible(false);
    viewmodel.visible = false;
    held.drop(viewmodel);
    classes?.close({ relock: false });
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    releaseInput();
    // In a world larger than the grid, the god view comes back over where the
    // body is now, as it was framed over the drop point, not across the world
    // where it went in (the window would have to go all the way back).
    if (mapKind().streamed && player) {
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
    for (const n of npcs.values()) n.setVisible(true);
    vehicles.reset(player);
    game.setVisible(false);
    viewmodel.visible = false;
    held.drop(viewmodel);
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
  const input = { move: { x: 0, z: 0 }, jump: false, sprint: false, down: false, crouch: false, ladder: false, climb: new THREE.Vector3() };
  const ladderFeet = new THREE.Vector3();
  let sprintOn = false;     // Sprint: Toggle's state
  const vEye = new THREE.Vector3(), vFeet = new THREE.Vector3(), vA = new THREE.Vector3(), vB = new THREE.Vector3();
  const closest = new THREE.Vector3();
  let speedH = 0;
  let wasDriving = false, lookMovedAt = 0;

  function readInput() {
    input.move.x = input.move.z = 0;
    input.jump = input.sprint = input.down = input.crouch = false;
    input.ladder = false;
    input.climb.set(0, 0, 0);
    input.chargeJump = village.enabled;
    input.jumpYaw = povCam.look.yaw;
    input.cancelJump = true;
    const d = vehicles.drive;
    d.throttle = d.steer = 0; d.brake = d.boost = false;
    if ((app.mp.replica && (app.mp.stale || networkPending)) || (mission.engaged && !mission.active)
      || editing || village.blocked || mode !== 'on' || player.dead || app.isTyping()) return;
    if (vehicles.seated) {   // the keys drive: W/S throttle, A/D steer (+ is left), Space brake or hop, Shift boost
      const t = touch.state;   // (the touch stick drives too: forward throttles, sideways steers)
      d.throttle = THREE.MathUtils.clamp((keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0) + t.z, -1, 1);
      d.steer = THREE.MathUtils.clamp((keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0) - t.x, -1, 1);
      d.brake = keys.has('Space') || t.jump;
      d.boost = keys.has('ShiftLeft') || keys.has('ShiftRight') || t.sprint;
      return;
    }
    const t = touch.state;   // the touch stick adds in, analog (touch.js)
    input.cancelJump = false;
    const f = THREE.MathUtils.clamp((keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0) + t.z, -1, 1);
    const r = THREE.MathUtils.clamp((keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0) + t.x, -1, 1);
    if (f || r) {
      const fw = povCam.forwardH(vA), rt = povCam.rightH(vB);
      // The body normalizes Noita movement; Cruelty Squad keeps diagonal air acceleration.
      input.move.x = fw.x * f + rt.x * r;
      input.move.z = fw.z * f + rt.z * r;
    }
    input.jump = keys.has('Space') || t.jump;
    input.sprint = t.sprint || (app.settings.sprintMode === 'toggle' ? sprintOn : keys.has('ShiftLeft') || keys.has('ShiftRight'));
    input.crouch = input.down = keys.has(CROUCH_KEY) || t.down;   // crouched on land, swimming down in liquid
    const ladders = app.getWorld()?.scene.importManifest?.interactions?.ladders;
    if (ladders?.length) {
      ladderFeet.copy(player.pos).add(app.getSim().origin);
      input.ladder = overlapsLadder(ladders, ladderFeet, player.width, player.height);
      if (input.ladder) povCam.dir(input.climb).multiplyScalar(f);
    }
  }

  // The same entities belong to the scene, not to its current camera mode.
  function updateEntities(dt, { vehiclesUpdated = false } = {}) {
    if (coop()) return null;
    const sim = app.getSim(), vol = app.getVolume(), scale = app.getScale();
    if (!sim || !vol) return null;
    importedInteractions.update(dt);
    const g = sim.g;
    vol.updateMatrixWorld();
    worldToGrid.copy(vol.matrixWorld).invert();
    if (!vehiclesUpdated) vehicles.update(dt, { player: active() ? player : null, live: live() && mode === 'on', worldToGrid });
    // the NPCs: one per enemy spawner, with every tool you have, in a box or a World. A World's
    // NPC appears once the window covers its spawner, stays put in the world as the window moves
    // (windowShifted below) and waits, unsimulated, while outside it, as a mission's does (game/mission.js).
    const sp = app.getSpawners?.();
    const npcFrame = { player: mode === 'on' || mode === 'entering' ? player : null, holding: toolbelt?.selectedKey ?? null, toWorld, worldToGrid, scale, stepsPerFrame: app.nativeToolSteps ?? (app.settings.paused ? 0 : app.settings.steps) };
    const npcsWanted = !!sp;
    const homes = npcsWanted && !mission.engaged ? ENEMY_KINDS.flatMap((k) => sp.of(k)).filter((s) => s.oneShot || !game.running) : [];   // a team game (src/game) has its own bots
    if (homes.some((s) => !s.consumed)) {
      ensureKernels();
      npcBallistics ??= createBallistics({ renderer });
      npcBallistics.prepare(sim);
      if (!npcMod) loadNpcs().then(() => app.requestRender()).catch(() => {});
    }
    if (npcMod) {
      for (const s of homes) {
        if (npcs.has(s.id) || s.consumed || (kindOfGrid(g).streamed && !sp.feet(s))) continue;   // (a World spawner outside the window: later)
        const spec = {
          env: { renderer, scene, getSim: app.getSim, getVolume: app.getVolume, getScale: app.getScale, ballistics: npcBallistics },
          ai: npcAi, oneShot: s.oneShot,
          home: () => sp.feet(s),   // it appears, and comes back, on its spawner
        };
        const worm = s.kind === SPAWNER.WORM || s.kind === SPAWNER.GIANT_WORM;
        const n = worm ? npcMod.createWorm({ ...spec, size: s.kind === SPAWNER.GIANT_WORM ? 'giant' : 'small' })
          : npcMod.createNpc({ ...spec, style: s.kind === SPAWNER.GUNNER ? 'gunner' : 'axeman' });
        scene.add(n.root);
        n.body.on('death', () => sp.consume(s));
        n.body.on('revenge', ({ point }) => povEvents.emit('blast', { point }));
        n.bind(volumeLight(app.getVolume()), g);
        n.compile(renderer, camera, scene).then(() => app.requestRender()).catch((err) => console.error('NPC figure failed to compile', err));
        npcs.set(s.id, n);
        // Spawn even on a paused editor frame; dt=0 only poses the new body.
        n.update(0, npcFrame);
        if (s.oneShot) s.snapshot = () => ({ consumed: n.body.dead,
          world: [n.body.pos.x + sim.origin.x, n.body.pos.y, n.body.pos.z + sim.origin.z] });
      }
      // a spawner taken away takes its NPC with it
      for (const [id, n] of npcs) {
        const home = homes.find((s) => s.id === id);
        if (!n.finished && (home || (npcsWanted === false && sp?.list.some((s) => s.id === id)))) continue;
        if (home?.oneShot) sp.remove(home);   // the corpse finished; no invisible body keeps the editor awake
        scene.remove(n.root); n.dispose(); npcs.delete(id);
      }
      if ((npcsWanted && (npcs.size || game.botCount)) || mission.active) npcAi.world.update(dt);
      if (npcsWanted && npcs.size) {
        for (const n of npcs.values()) {
          const resident = residentIn(n.body.pos, g);
          if (!resident) { n.setVisible(false); continue; }
          n.bind(volumeLight(app.getVolume()), g); n.update(dt, npcFrame);
        }
      } else for (const n of npcs.values()) n.setVisible(false);
    }
    if (npcBallistics && dt > 0) npcBallistics.update({ sim, dt, stepsPerFrame: npcFrame.stepsPerFrame });
    return npcFrame;
  }

  let networkPending = false, networkWarp = 0;
  function networkCatchup(feet) {
    player?.teleport(feet); dropPoint.copy(feet); networkPending = true; networkWarp++;
    povCam.reset(); feel.reset();
  }
  function update(dt) {
    touch.update({
      live: live() && !village.blocked, tool: village.enabled ? null : toolbelt?.selectedKey, inLiquid: !!player?.inLiquid,
      wantsWheel: !!toolbelt?.wantsWheel, driving: !!vehicles.seated, vehicleKind: vehicles.seated?.kind, vehicles: vehicles.list.length > 0,
    });
    descentFrame(dt);
    if (!active()) return;
    const sim = app.getSim(), vol = app.getVolume(), scale = app.getScale();
    const g = sim.g;
    ensureKernels();   // (a new grid: its kernels)
    vol.updateMatrixWorld();
    worldToGrid.copy(vol.matrixWorld).invert();
    box.min.copy(vol.position);
    box.max.set(g.nx, g.ny, g.nz).multiplyScalar(scale).add(vol.position);
    box.margin = 0.5 * scale;

    // the body
    readInput();
    input.cruelty = !coop() && app.gamemode?.() === 'crueltySquad';
    if (!canGrapple()) toolbelt?.grapple?.release();
    app.coopMove?.(false);
    if (!coop()) { vehicles.beforeBody(player); village.beforeBody(input, dt); }
    const waiting = app.mp.replica && (app.mp.stale || networkPending);
    // Bus streaming temporarily moves the window away from the held departure
    // body. Do not run gravity/damage against outside-window cells in transit.
    player.update(waiting || village.bus.holding ? 0 : dt, input);
    if (app.mp.isGuest && networkPending && !app.mp.stale) {
      const clear = player.clearance();
      if (clear === true) networkPending = false;
      else if (clear === false) {
        // Probe each candidate before allowing movement. Search above a buried
        // anchor; never respawn at an old outside-window dropPoint.
        const next = player.pos.clone(); next.y += 2;
        if (next.y > g.ny - 7) {
          next.y = 1; next.x += 3;
          const m = app.mp.metadata, b = leash(m, [g.nx, g.ny, g.nz], next.clone().add(sim.origin).toArray());
          if (next.x + sim.origin.x > b.hi[0]) next.x = b.lo[0] - sim.origin.x;
        }
        player.teleport(next);
      }
    }
    app.coopMove?.(true);
    if (!coop()) {
      village.afterBody();
      vehicles.update(dt, { player, live: live() && mode === 'on', worldToGrid });
      vehicles.afterBody(player);
    }
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
      if (!mission.engaged && (deadTime >= (match?.delay ?? RESPAWN_DELAY) || asked) && mode === 'on') {
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

    const npcFrame = updateEntities(dt, { vehiclesUpdated: true });
    if (!coop()) {
      game.update(dt, npcMod ? npcFrame : null);   // team bots retain their own lifecycle
      mission.update(dt, npcMod ? npcFrame : null);
    }

    deaths.update();   // the killfeed: who died this frame, and to what
    medals.update();   // the sandbox's medal stack (its fades)

    if (!coop()) takePerks();

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
      onGround: player.onGround, inLiquid: player.inLiquid, sprintRush: driving ? 0 : player.sprintRush,
      dead: deadSeen, deadTime, box, shake, arm,
    });
    cameraArm.trace(sim);
    const inEyes = pose.eyeDist <= FIGURE_HIDE_DIST && !driving;   // (driving, the chase camera has the view)
    marchNear = inEyes ? EYE_CLIP * player.size : 0;
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
      toolbelt?.setVisible(!coop());
    } else if (pose.done === 'out') {
      finishExit();
      return;
    }

    // the figure: shown once the camera is out of the head
    figureShown = pose.eyeDist > FIGURE_HIDE_DIST && !driving && !player.gibbed;
    figure.setVisible(figureShown && !village.enabled);   // the vehicle draws its driver; a body burst into meat has nothing left to draw
    // the tool in hand on it (held.js; the wand has no model)
    const holding = held.pick(figureShown && !village.enabled && mode === 'on' && !deadSeen ? gearByKey(toolbelt?.selectedKey)?.model ?? null : null, dt);
    figure.update(dt, {
      // Shrink: the figure at the body's size, its gait timed at the plain figure's speed for the size
      feet: vFeet, scale: scale * player.size, yaw: povCam.look.yaw, worldToGrid,
      speedH: speedH / player.size, velY: player.vel.y, onGround: player.onGround, inLiquid: player.inLiquid, headInLiquid: player.headInLiquid,
      dead: deadSeen, deadTime, heat: player.feel?.heat ?? 0, jetting: player.jetting, status: player.status, kick: player.kickPose, crouch: player.crouch,
      sprintRush: driving ? 0 : player.sprintRush, flap: player.flap,
      look: { pitch: povCam.look.pitch, spine: holding.spine }, lift: holding.lift, ride: holding.ride,
    });
    held.bind(volumeLight(vol), g);
    held.frame({ figure, yaw: povCam.look.yaw, pitch: povCam.look.pitch, scale: scale * player.size, feet: vFeet, worldToGrid, camera, viewmodel });
    village.update(dt, figureShown, povCam.look.yaw);
    if (player.jetting && mode === 'on' && !village.enabled) vfx?.jet(figure.nozzles, dt);
    // flames licking off burning bodies (status.js BURNING), the player's and the NPCs'
    if (player.status.has('BURNING') && !player.dead) vfx?.burn(player.pos, dt);
    for (const n of npcs.values()) if (n.body.status?.has('BURNING') && !n.body.dead) vfx?.burn(n.body.pos, dt);
    viewmodel.visible = !coop() && (!village.enabled || (village.canAct && !!village.tool)) && mode === 'on' && !deadSeen && pose.eyeDist <= FIGURE_HIDE_DIST && !hudHidden && !driving;

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
    interact.update(ctx.eye, ctx.dir, aim.dist, !coop() && live() && mode === 'on' && !deadSeen && !driving && !editing && !village.enabled);
    if (village.enabled) {
      if (wheelNotches) { village.cycleTool(wheelNotches); wheelNotches = 0; }
      if (!village.tool && buttons.primaryPressed && !editing && (isLocked() || touch.enabled)) void village.punch();
      village.usingTool = village.canAct && !!village.tool && (buttons.primary || buttons.primaryPressed || buttons.secondary || buttons.secondaryPressed);
    }
    if (live() && toolbelt && !driving && !coop()) {
      ctx.sim = sim;
      ctx.peaceful = village.enabled;   // mining tools must not turn village play into body combat
      ctx.dt = dt;
      ctx.toolRate = player.perks.toolRate;
      ctx.nativeDt = sim.compact ? (app.nativeToolSteps ?? 0) / 60 : undefined;
      ctx.stepsPerFrame = app.nativeToolSteps ?? (app.settings.paused ? 0 : app.settings.steps);
      const use = !editing && (village.enabled ? village.canAct && !!village.tool && (isLocked() || touch.enabled || villageToolTap) : canUse()) && !app.industryBuilding?.();
      if (village.enabled && !use) toolbelt.tool(toolbelt.selectedKey)?.deselect?.();
      // a touch tap can start and end between frames: it still holds for one (on desktop the mouse can't)
      const tapped = touch.enabled || villageToolTap;
      ctx.primary = use && (buttons.primary || (tapped && buttons.primaryPressed));
      ctx.secondary = use && (buttons.secondary || (tapped && buttons.secondaryPressed));
      ctx.primaryPressed = use && buttons.primaryPressed;
      ctx.secondaryPressed = use && buttons.secondaryPressed;
      ctx.grappleEnabled = canGrapple() && use;
      ctx.grapplePressed = ctx.grappleEnabled && grappleQueued;
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
    grappleQueued = false;
    held.place({ figure, viewmodel, dt });   // the tools have moved: the held model, and the hands on it
    // After the tools: the body is hidden in the eyes, so the wingbeat has to be on the viewmodel arms.
    if (viewmodel.visible) {
      viewmodelRig({ viewmodel, getScale: app.getScale }).poseFlap(player.flap ?? 0, dt);
    } else viewmodel.userData.rig?.resetFlap();
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
    if (!coop()) combat.update({
      dt, player, eye: ctx.eye, dir: ctx.dir, tool: toolbelt?.selectedKey ?? null,
      live: live() && mode === 'on' && canUse() && !editing && !driving, stepsPerFrame: app.nativeToolSteps ?? (app.settings.paused ? 0 : app.settings.steps),
    });
    buttons.primaryPressed = buttons.secondaryPressed = false;
    wheelNotches = 0; villageToolTap = false;

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
      pogo: village.enabled ? player.jumpCharge : toolbelt?.selectedKey === 'POGO' ? player.pogoCharge : null,
      pogoLabel: village.enabled ? 'Jump charge — release to leap' : 'Pogo charge',
      dead: deadSeen, cause: player.cause, respawnIn: (match?.delay ?? RESPAWN_DELAY) - deadTime,
      mission: mission.engaged,
      locked: isLocked() || touch.enabled, swooping: mode !== 'on',
      grappleEnabled: canGrapple(),
      aimValid: aim.valid, aimInReach: aim.valid && aim.dist <= HAND_REACH, third: povCam.third,
      buried: mode === 'on' && !deadSeen && inEyes && player.buriedId >= 0 ? BURIED_COLOR[player.buriedId] : null,
    });
  }

  // The Descent map (descent/index.js): every frame, in the body or not (its
  // nuggets and shop items follow the window in the god view too)
  function descentFrame(dt) {
    if (coop()) return;
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
        lines: [PERK[o.key].desc], verb: 'Take', proximity: !!o.shrine,
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
  function aimRay(ro, rd, presentation = false) {
    if (!active() || !player) return false;
    toGrid(camera.position, ro);
    // the aim, not the shaken view: kick and shake are only felt
    if (mode === 'on' && !deadSeen) povCam.dir(rd);
    else camera.getWorldDirection(rd);
    const eye = vA.copy(player.pos).setY(player.pos.y + player.eyeHeight);
    // Visible targeting advances on the displayed ray to the displayed eye
    // (a presentation effect: app.presentationPoint). Collision, camera-arm
    // and ballistic queries keep the default flat path.
    if (presentation) app.presentationPoint(eye, eye);
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
    active: () => active() && !village.enabled,
    locked: () => isLocked() || touch.enabled,   // the mouse is captured (or touch): a match's "Click to play" (game/hud.js)
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
  const mission = createMission({
    app, scene,
    get player() { return player; },
    get toolbelt() { return toolbelt; },
    loadNpcs,
    env: () => ({ renderer, scene, getSim: app.getSim, getVolume: app.getVolume, getScale: app.getScale, ballistics: toolbelt.ballistics }),
    respawnPlayer(at) {
      player.spawn(at);
      player.team = null;
      if (player.cls) applyClassTo(player, null);
      classes?.close({ relock: false });
      deadSeen = false; deadTime = 0;
      toolbelt?.setVisible(mode === 'on');
      feel.reset();
    },
    compile(n) {
      n.bind(volumeLight(app.getVolume()), app.getSim().g);
      n.compile(renderer, camera, scene).then(() => app.requestRender()).catch((err) => console.error('Mission NPC figure failed to compile', err));
    },
    bind: (n) => n.bind(volumeLight(app.getVolume()), app.getSim().g),
    freeMouse: () => { releaseInput(); if (document.pointerLockElement === canvas) document.exitPointerLock(); },
    markers: createMarkers({ scene, getVolume: app.getVolume, getScale: app.getScale }),
    hud: createMissionHud({ retry: () => mission.retry(), leave: () => exit(true) }),
  });

  const importedInteractions = createImportedInteractions({ app, interact,
    getBodies: () => [player, ...npcs.values()].map(n => n?.body ?? n).concat(mission.actors.map(n => n.body), game.bots.map(n => n.body)),
    toast: text => hud.toast?.(text),
  });

  // TF2's class menu opens when you join a team: a Siege match's start and a team switch
  // ('.'). A Halo match has no classes: the picker shuts (docs/halo-contract.md).
  const joinedTf2 = () => { if (game.running && game.style === 'tf2' && player?.team) classes?.open({ joined: true }); };
  povEvents.on('game:start', () => { if (game.style === 'halo') classes?.close({ relock: false }); else joinedTf2(); });
  povEvents.on('game:team', ({ id }) => { if (id === PLAYER && game.running) joinedTf2(); });
  // the match over, the class comes off with it (its perks and scales), and the picker shuts
  povEvents.on('game:stop', ({ style }) => {
    if (style !== 'tf2') return;
    classes?.close({ relock: false });
    if (player?.cls) applyClassTo(player, null);
  });

  // god-mode keys POV takes over (app.js skips them while active)
  const blocksKey = (e) => editing || (active() && !(PASS_KEYS.has(e.key) && !(e.key === ',' && classesOn())) && !(e.metaKey || e.ctrlKey));

  return {
    get active() { return active(); },
    get networkLook() { return povCam.look; },
    get networkPending() { return networkPending; },
    get networkWarp() { return networkWarp; },
    networkCatchup,
    audio,
    get mode() { return mode; },
    get locked() { return isLocked(); },
    get player() { return player; },
    get toolbelt() { return toolbelt; },
    village,                     // Tinker Creek's homes, pockets and peaceful neighbors
    descent,                     // the Descent map's gold, shop, altar, pool and refresher (descent/index.js)
    interact,                    // look + E (interact.js): focus, use()
    importedInteractions,        // source-map doors (exclusive voxel cells, not AABB carves)
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
    get readout() { return live() && mode === 'on' && toolbelt && (!village.enabled || village.tool) ? toolbelt.readout : null; },
    get marchNear() { return active() ? marchNear : 0; },   // cells: the view's near clip (render.js uMarchNear)
    get figure() { return figure; },
    held,                        // the tool in hand on the body (held.js): holding, weight (checks)
    get npc() { return npcs.values().next().value ?? null; },   // the first NPC, once loaded (checks)
    get npcs() { return [...npcs.values(), ...mission.actors]; },
    mission,
    events: povEvents,           // the POV event bus (checks)
    medals,                      // the sandbox's medals (sandboxMedals.js): medals() the player's counts
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
    updateEntities,
    get entitiesPending() {
      const sp = app.getSpawners?.();
      return vehicles.pending || !!sp?.list.some((s) => !s.consumed && (s.oneShot || !game.running) && ENEMY_KINDS.includes(s.kind) && !npcs.has(s.id)
        && (!kindOfGrid(app.getSim()?.g).streamed || sp.feet(s)));   // (a World's spawner outside the window waits for it)
    },
    // the world was replaced (undo, a scene load): tools drop what they carry from the old one
    worldReplaced: () => {
      mission.end();
      village.setEnabled(false); toolsModule?.emptyLoads?.(); toolbelt?.worldReplaced();
      for (const n of npcs.values()) { scene.remove(n.root); n.dispose(); }
      npcs.clear();
      npcBallistics?.clear();
      vehicles.worldReplaced();
    },
    // the window moved over the world by (dx, 0, dz) cells (docs/scaling.md D11): grid positions move back.
    // The drop point stays put in the world: a respawn far away waits there
    // for the window to come (player.js).
    windowShifted(dx, dz) {
      dropPoint.x -= dx;
      dropPoint.z -= dz;
      player?.windowShifted(dx, dz);
    mission.windowShifted(dx, dz);
      for (const n of npcs.values()) n.windowShifted(dx, dz);   // the sandbox's NPCs (updateEntities)
      npcBallistics?.windowShifted(dx, dz);
    if (app.mp.replica && (dx || dz)) player?.invalidateProbe();
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
