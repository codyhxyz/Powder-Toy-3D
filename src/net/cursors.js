import * as THREE from 'three';
import { createBrushCursor } from '../brush.js';
import { toolById } from '../elements.js';
import { inkFor } from '../ui/dom.js';

// Time constant (s) for easing a remote cursor toward its latest reported
// position, so 20 Hz updates read as smooth motion.
const SMOOTHING_S = 0.06;

// Other players' brushes, the usual multiplayer-cursor way: each player has
// one colour, used for their brush bubble and their name tag, so they never
// look like your own brush. A swatch on the tag shows the tool they hold.
export function createRemoteCursors({ scene, camera, getVolume }) {
  const layer = Object.assign(document.createElement('div'), { className: 'net-cursors' });
  document.body.append(layer);
  const peers = new Map();
  const world = new THREE.Vector3();
  const ndc = new THREE.Vector3();

  function remove(id) {
    const p = peers.get(id);
    if (!p) return;
    scene.remove(p.brush.mesh);
    p.brush.mesh.geometry.dispose();
    p.brush.mesh.material.dispose();
    p.label.remove();
    peers.delete(id);
  }

  return {
    // msg: { c: [x, y, z] in grid cells, or null when their brush is hidden; r, shape, tool, painting }
    set(id, { name, color }, msg) {
      let p = peers.get(id);
      if (!p) {
        const brush = createBrushCursor();
        scene.add(brush.mesh);
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
        const onScreen = Math.abs(ndc.z) <= 1;
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
}
