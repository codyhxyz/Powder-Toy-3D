import * as THREE from 'three';
import { HAND_REACH } from '../constants.js';
import { axeFrag, toolPass, shadedBox, disposeTree } from '../../shaders/povTools.js';

// Axe: a short-range swing that breaks breakable solids in a wide, shallow
// patch around the struck cell into their debris (shaders/povTools.js axeFrag
// and AXE for the energy and tuning). Weaker and less focused than the gun:
// it chops wood where it lands, smashes glass, ice and plants around that,
// and bounces off rock and metal. Every break swaps one element for its
// debris in place, so mass is conserved.
//
// A click starts the swing; the blade lands IMPACT_TIME later and strikes
// whatever is under the crosshair then, if it's within reach.

const SWING_TIME = 0.42;     // s for a whole swing, wind-up to recovery
const IMPACT_TIME = 0.12;    // s into the swing that the blade lands
const SWING_INTERVAL = 0.5;  // s between swings

// viewmodel, in cells (camera space: +x right, +y up, −z forward)
const AXE_POS = [0.6, -0.55, -1.2];
const REST_PITCH = 0.35;     // rad, held up and back
const RAISE_PITCH = 0.9;     // rad, top of the wind-up
const STRIKE_PITCH = -0.9;   // rad, blade down at impact
const REST_ROLL = -0.25;     // rad, tilted in toward the crosshair

const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
<path d="M14 3l7 7-3 3-2-2-9 9-2-2 9-9-2-2z"/><path d="M14 3c-3 0-5 2-5 5l3 1"/></svg>`;

function buildModel() {
  const root = new THREE.Group();
  const pivot = new THREE.Group();   // the hand: the axe turns about it
  root.add(pivot);
  const handle = shadedBox(0.1, 1.3, 0.1, 0x8a5a33);
  handle.position.y = 0.45;
  const head = shadedBox(0.08, 0.32, 0.5, 0x9aa1ab);
  head.position.set(0, 1.0, -0.12);
  const edge = shadedBox(0.06, 0.4, 0.08, 0xdfe5ec);
  edge.position.set(0, 1.0, -0.4);
  pivot.add(handle, head, edge);
  root.visible = false;
  return { root, pivot };
}

// Swing pose: rest → raise (wind-up) → strike at IMPACT_TIME → back to rest.
function swingPitch(t) {
  if (t < 0 || t >= SWING_TIME) return REST_PITCH;
  const windUp = IMPACT_TIME / 2;
  if (t < windUp) return THREE.MathUtils.lerp(REST_PITCH, RAISE_PITCH, t / windUp);
  if (t < IMPACT_TIME) return THREE.MathUtils.lerp(RAISE_PITCH, STRIKE_PITCH, (t - windUp) / (IMPACT_TIME - windUp));
  return THREE.MathUtils.lerp(STRIKE_PITCH, REST_PITCH, (t - IMPACT_TIME) / (SWING_TIME - IMPACT_TIME));
}

export default {
  key: 'AXE', name: 'Axe', slot: 3, icon: ICON,
  desc: 'Chops wood, smashes glass and ice, clears plants. Too weak for rock or metal.',
  create(env) {
    const model = buildModel();
    env.viewmodel.add(model.root);
    const pass = toolPass(axeFrag, () => ({ uCenter: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3() } }));
    let time = 0, swingAt = -Infinity, nextSwing = 0, struck = true;
    let lastHit = null;

    function strike(ctx) {
      const aim = ctx.aim;
      if (!aim?.valid || aim.dist > HAND_REACH || aim.cell.y < 0) return;   // air, or the floor
      const sim = ctx.sim ?? env.getSim();
      const mat = pass(sim);
      mat.uniforms.uCenter.value.copy(aim.cell).addScalar(0.5);
      mat.uniforms.uDir.value.copy(ctx.dir).normalize();
      sim.pass(mat);
      lastHit = { cell: aim.cell.clone(), id: aim.id };
    }

    return {
      update(ctx) {
        time += ctx.dt;
        model.root.visible = true;
        model.root.scale.setScalar(env.getScale());
        if (ctx.primaryPressed && time >= nextSwing) {
          swingAt = time; nextSwing = time + SWING_INTERVAL; struck = false;
        }
        if (!struck && time - swingAt >= IMPACT_TIME) { struck = true; strike(ctx); }
        model.pivot.position.set(...AXE_POS);
        model.pivot.rotation.set(swingPitch(time - swingAt), 0, REST_ROLL);
      },
      deselect() { model.root.visible = false; struck = true; },
      status: () => null,
      get lastHit() { return lastHit; },   // for checks: the cell the last swing struck
      dispose() { pass.dispose(); disposeTree(model.root); },
    };
  },
};
