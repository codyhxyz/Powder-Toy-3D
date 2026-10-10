import * as THREE from 'three';

const MAX = 384;
const COLORS = {
  spark: 0x70bcff, dig: 0xe4bb79, emit: 0x75d8f5, absorb: 0x56e3b0,
  heat: 0xff722e, cool: 0xb0eaff, pressure: 0xffc777, erase: 0xa966ec,
  light: 0xffe9aa, teleport: 0xaa82ff, ignite: 0xffae42, place: 0x90cae0,
  attract: 0xb882ff, repel: 0x87cbff, scan: 0x65f7c5,
};

// One instanced draw for every orb/field, one line draw for beams. No lights,
// meshes or materials are allocated per spell; illumination uses world.setLights.
export function createWandVisuals(env) {
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.65,
    depthWrite: false, blending: THREE.AdditiveBlending });
  const orbs = new THREE.InstancedMesh(geometry, material, MAX);
  orbs.name = 'wand-orbs'; orbs.frustumCulled = false; orbs.count = 0;
  orbs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const linesGeometry = new THREE.BufferGeometry();
  const positions = new Float32Array(MAX * 6), colors = new Float32Array(MAX * 6);
  linesGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  linesGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
  linesGeometry.setDrawRange(0, 0);
  const linesMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true,
    opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending });
  const lines = new THREE.LineSegments(linesGeometry, linesMaterial);
  lines.name = 'wand-beams'; lines.frustumCulled = false;
  env.scene?.add(orbs, lines);
  const matrix = new THREE.Matrix4(), quat = new THREE.Quaternion();
  const p = new THREE.Vector3(), size = new THREE.Vector3(), color = new THREE.Color();
  const pulses = [];
  let count = 0;
  return {
    pulse(position, effect, radius = 0.6, from = null) {
      if (pulses.length >= MAX) pulses.shift();
      pulses.push({ position: position.clone(), from: from?.clone(), effect, radius, life: 0.15 });
    },
    update(items, dt) {
      for (let i = pulses.length - 1; i >= 0; i--) if ((pulses[i].life -= dt) <= 0) pulses.splice(i, 1);
      const scale = env.getScale?.() ?? 1;
      const origin = env.getVolume?.()?.position;
      let n = 0, l = 0;
      for (const item of [...items, ...pulses]) {
        if (n >= MAX) break;
        color.setHex(COLORS[item.effect] ?? COLORS.spark).multiplyScalar(2);
        p.copy(item.position).multiplyScalar(scale);
        if (origin) p.add(origin);
        size.setScalar(Math.max(0.08, item.radius ?? 0.3) * scale);
        matrix.compose(p, quat, size);
        orbs.setMatrixAt(n, matrix); orbs.setColorAt(n++, color);
        if (item.from && l < MAX) {
          p.toArray(positions, l * 6 + 3);
          p.copy(item.from).multiplyScalar(scale);
          if (origin) p.add(origin);
          p.toArray(positions, l * 6);
          color.toArray(colors, l * 6); color.toArray(colors, l * 6 + 3);
          l++;
        }
      }
      orbs.count = n; orbs.instanceMatrix.needsUpdate = true;
      if (orbs.instanceColor) orbs.instanceColor.needsUpdate = true;
      linesGeometry.setDrawRange(0, l * 2);
      linesGeometry.attributes.position.needsUpdate = true;
      linesGeometry.attributes.color.needsUpdate = true;
      count = n;
    },
    windowShifted(dx, dz) {
      for (const pulse of pulses) for (const v of [pulse.position, pulse.from]) {
        if (v) { v.x -= dx; v.z -= dz; }
      }
    },
    clear() { pulses.length = 0; orbs.count = 0; linesGeometry.setDrawRange(0, 0); count = 0; },
    get active() { return pulses.length > 0; },
    get stats() { return { instances: count, capacity: MAX, drawCalls: 2 }; },
    dispose() {
      orbs.removeFromParent(); lines.removeFromParent();
      geometry.dispose(); material.dispose(); linesGeometry.dispose(); linesMaterial.dispose();
      pulses.length = 0;
    },
  };
}
