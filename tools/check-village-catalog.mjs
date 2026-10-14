import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ITEMS } from '../src/pov/village/catalog.js';
import { furniture } from '../src/pov/village/furnitureModels.js';

// CPU only: no DOM, renderer, browser, or WebGL context.
const entries = Object.entries(ITEMS), signatures = new Map(), families = new Set();
assert(entries.length >= 37);
assert.equal(new Set(entries.map(([id]) => id)).size, entries.length);
const sizes = { chair: [2, 2], bed: [4, 6], sofa: [6, 3], table: [4, 4],
  lamp: [2, 2], plant: [2, 2], shelf: [4, 2], desk: [4, 2] };
for (const theme of ['cottage', 'botanical', 'workshop']) for (const [family, size] of Object.entries(sizes)) {
  const item = ITEMS[theme + family[0].toUpperCase() + family.slice(1)];
  assert.deepEqual([item.w, item.d], size);
  assert.equal(item.family, family); assert.equal(item.theme, theme);
}
const legacy = {
  bed: ['Patchwork bed', 4, 6, 2.85, '#7ba995'], chair: ['Oak chair', 2, 2, 3.4, '#cf9c62'],
  table: ['Round table', 4, 4, 3.05, '#d4ac77'], sofa: ['Sage sofa', 6, 3, 3.1, '#81a994'],
  lamp: ['Sunflower lamp', 2, 2, 4.2, '#e5bd66'], plant: ['Leafy plant', 2, 2, 3.5, '#568c61'],
  dresser: ['Oak dresser', 4, 3, 3.65, '#c99562'],
};
for (const [id, expected] of Object.entries(legacy)) {
  const i = ITEMS[id]; assert.deepEqual([i.name, i.w, i.d, i.h, i.color], expected);
}
for (const [id, item] of entries) {
  for (const field of ['family', 'theme', 'name', 'color']) assert.equal(typeof item[field], 'string', `${id}.${field}`);
  for (const field of ['w', 'd', 'h']) assert(Number.isFinite(item[field]) && item[field] > 0);
  families.add(item.family);
  const root = furniture(id), signature = [], resources = [];
  assert(root.isGroup);
  root.updateMatrixWorld(true);
  root.traverse(o => {
    if (!o.isMesh) return;
    assert.equal(o.renderOrder, 1);
    for (const attr of Object.values(o.geometry.attributes)) for (const v of attr.array) assert(Number.isFinite(v), `${id}: finite attribute`);
    // No color/material data: structural differences must survive recoloring.
    signature.push([o.geometry.type, o.geometry.parameters, o.position.toArray(), o.scale.toArray(), o.quaternion.toArray()]);
    for (const resource of [o.geometry, o.material]) {
      const record = { disposed: false }; resource.addEventListener('dispose', () => { record.disposed = true; }); resources.push(record);
    }
  });
  assert(signature.length > 0);
  signatures.set(id, JSON.stringify(signature));
  const bounds = new THREE.Box3().setFromObject(root);
  const eps = 0.015;
  assert(bounds.min.y >= -eps && bounds.min.y <= 0.12, `${id}: grounded ${bounds.min.y}`);
  assert(bounds.max.y <= item.h + eps, `${id}: height ${bounds.max.y} > ${item.h}`);
  assert(bounds.min.x >= -item.w / 2 - eps && bounds.max.x <= item.w / 2 + eps, `${id}: width ${bounds.min.x},${bounds.max.x}`);
  assert(bounds.min.z >= -item.d / 2 - eps && bounds.max.z <= item.d / 2 + eps, `${id}: depth ${bounds.min.z},${bounds.max.z}`);
  for (const field of ['seatHeight', 'lyingHeight']) if (field in item) assert.equal(root.userData[field], item[field]);
  if (id === 'dresser') {
    const drawer = root.userData.drawer; assert(drawer?.isGroup && drawer.parent === root);
    const initial = new THREE.Box3().setFromObject(drawer);
    drawer.position.z -= 0.8; root.updateMatrixWorld(true);
    const moved = new THREE.Box3().setFromObject(drawer);
    assert(Math.abs(moved.min.z - initial.min.z + 0.8) < 1e-6);
  }
  root.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
  assert(resources.every(r => r.disposed), `${id}: all resources disposed`);
}
assert.equal(new Set(signatures.values()).size, entries.length, 'every piece has distinct construction');
for (const family of Object.keys(sizes)) {
  const themed = ['cottage', 'botanical', 'workshop'].map(t => signatures.get(t + family[0].toUpperCase() + family.slice(1)));
  assert.equal(new Set(themed).size, 3, `${family}: three structural themes`);
}
assert.throws(() => furniture('missing'), RangeError);
console.log(`PASS ${entries.length} distinct furniture models; ${families.size} families; metadata, bounds, finite geometry, themes, drawer and disposal (CPU only).`);
