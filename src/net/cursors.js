import * as THREE from 'three/webgpu';
import { createBrushCursor } from '../brush.js';
import { getMeshGpu } from '../gfx/meshLight.js';
import { toolById } from '../elements.js';
import { inkFor } from '../ui/dom.js';

// Time constant (s) for easing a remote cursor toward its latest reported
// position, so 20 Hz updates read as smooth motion.
const SMOOTHING_S = 0.06;

// Other players' brushes, the usual multiplayer-cursor way: each player has
// one colour, used for their brush bubble and their name tag, so they never
// look like your own brush. A swatch on the tag shows the tool they hold.
//
// Each brush is the brush's pipeline (brush.js), drawn into the scene pass
// with everything else of ours (docs/webgpu.md F1): src/wire/mesh.js's scene
// hook calls drawRemoteCursors(rp). `gpu` defaults to the app's device
// (gfx/meshLight.js setMeshGpu), looked up whenever a brush is made: the
// multiplayer wire boots before the mesh wire sets it (src/wire/index.js
// WIRES), so a device read once at creation would stay null. `scene` is no
// longer used (nothing joins it).

const sets = new Set();   // every live createRemoteCursors, for drawRemoteCursors

/**
 * Draws every player's brush into the scene pass (after the volume, like
 * your own brush: no depth test).
 * @param {GPURenderPassEncoder} rp
 */
export function drawRemoteCursors(rp) {
  for (const s of sets) s.draw(rp);
}

export function createRemoteCursors({ camera, getVolume, gpu = null }) {
  const device = () => gpu ?? getMeshGpu();
  const layer = Object.assign(document.createElement('div'), { className: 'net-cursors' });
  document.body.append(layer);
  const peers = new Map();
  const world = new THREE.Vector3();
  const ndc = new THREE.Vector3();

  function remove(id) {
    const p = peers.get(id);
    if (!p) return;
    p.label.remove();
    peers.delete(id);
  }

  const cursors = {
    // msg: { c: [x, y, z] in grid cells, or null when their brush is hidden; r, shape, tool, painting }
    set(id, { name, color }, msg) {
      let p = peers.get(id);
      if (!p) {
        const dev = device();
        if (!dev) return;   // (no device yet: the peer's next message places it)
        const brush = createBrushCursor(dev);
        const label = Object.assign(document.createElement('div'), { className: 'net-cursor', textContent: name });
        label.style.setProperty('--peer', color);
        label.style.setProperty('--peer-ink', inkFor(color));
        layer.append(label);
        p = { brush, label, color, pos: new THREE.Vector3(), target: null };
        peers.set(id, p);
      }
      const shown = Array.isArray(msg.c);
      if (shown && !p.target) p.pos.fromArray(msg.c); // appear in place rather than sliding in
      p.target = shown ? new THREE.Vector3().fromArray(msg.c) : null;
      Object.assign(p, { radius: msg.r, shape: msg.shape, tool: msg.tool, painting: !!msg.painting });
    },
    remove,
    clear() { for (const id of [...peers.keys()]) remove(id); },
    /** Draws the shown brushes into the scene pass (drawRemoteCursors). */
    draw(rp) { for (const p of peers.values()) p.brush.draw(rp); },
    /** Every brush and tag gone, and these cursors out of drawRemoteCursors. */
    dispose() { cursors.clear(); layer.remove(); sets.delete(cursors); },
    update(dt) {
      const vol = getVolume();
      if (!vol) return;
      const ease = 1 - Math.exp(-dt / SMOOTHING_S);
      for (const p of peers.values()) {
        const tool = toolById(p.tool);
        if (!p.target || !tool) {
          p.brush.set({ visible: false });
          p.label.hidden = true;
          continue;
        }
        p.pos.lerp(p.target, ease);
        world.copy(p.pos).applyMatrix4(vol.matrixWorld);
        p.brush.set({ visible: true, position: world, radius: p.radius * vol.scale.x, shape: p.shape, color: p.color });
        ndc.copy(world).project(camera);
        // in front of the camera and short of its far plane (WebGPU's depth runs 0..1, WebGL's -1..1)
        const onScreen = ndc.z <= 1 && ndc.z >= (camera.coordinateSystem === THREE.WebGPUCoordinateSystem ? 0 : -1);
        p.label.hidden = !onScreen;
        if (onScreen) {
          p.label.style.translate = `${((ndc.x + 1) / 2) * innerWidth}px ${((1 - ndc.y) / 2) * innerHeight}px`;
          p.label.classList.toggle('painting', p.painting);
          p.label.style.setProperty('--tool', tool.color);
          p.label.title = tool.name;
        }
      }
    },
  };
  sets.add(cursors);
  return cursors;
}
