// Bake procedural loading portraits without occupying the player's GPU.
// Uses the actual gameplay meshes; the live preview supplies full PBR shading.
// Run: node tools/you-portrait-cpu.mjs (requires ImageMagick and cwebp).
import * as THREE from 'three';
import { SVGRenderer } from 'three/addons/renderers/SVGRenderer.js';
import { TessellateModifier } from 'three/addons/modifiers/TessellateModifier.js';
import { buildStick } from '../src/pov/figure.js';
import { buildSpartan } from '../src/pov/figureSpartan.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// SVGRenderer only needs an element tree with attributes, not a browser DOM.
globalThis.document = {
  createElementNS(namespace, tag) {
    return {
      attrs: tag === 'svg' ? { xmlns: namespace } : {},
      style: {}, childNodes: [],
      setAttribute(key, value) { this.attrs[key] = value; },
      appendChild(child) { this.childNodes.push(child); },
      removeChild(child) { this.childNodes.splice(this.childNodes.indexOf(child), 1); },
      get outerHTML() {
        return `<${tag} ${Object.entries(this.attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}>`
          + this.childNodes.map((c) => c.outerHTML).join('') + `</${tag}>`;
      },
    };
  },
};

const dir = mkdtempSync(join(tmpdir(), 'you-cpu-'));
try {
  for (const [character, build] of [['stick', buildStick], ['spartan', buildSpartan]]) {
    const rig = build(), scene = new THREE.Scene(), holder = new THREE.Group();
    rig.body.position.y = rig.hipY;
    rig.body.rotation.y = Math.PI;
    const tessellate = new TessellateModifier(0.12, 7);
    rig.body.traverse((o) => {
      if (!o.isMesh) return;
      // Small faces keep SVG's painter sorting correct where armor plates overlap.
      o.geometry = tessellate.modify(o.geometry);
      o.material = new THREE.MeshLambertMaterial({ color: new THREE.Color().setRGB(...o.userData.albedo) });
    });
    holder.add(rig.body);
    scene.add(holder);
    scene.updateMatrixWorld(true);
    // Same framing and turn as ui/youViewer.js.
    const box = new THREE.Box3().setFromObject(holder, true);
    const reach = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z));
    const centre = new THREE.Vector3(0, (box.min.y + box.max.y) / 2, 0);
    const camera = new THREE.PerspectiveCamera(20, 260 / 420, 0.1, 100);
    const half = Math.tan(THREE.MathUtils.degToRad(10));
    const dist = Math.max((box.max.y - box.min.y) / 2 / half, reach / (half * camera.aspect)) * 1.03 + reach;
    camera.position.set(0, centre.y - Math.sin(0.06) * dist, Math.cos(0.06) * dist);
    camera.lookAt(centre);
    holder.rotation.y = 0.42;
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    for (const [color, intensity, pos] of [[0xffe2c4, 0.8, [-2, 3, 3.2]], [0x5aa4ee, 0.6, [2.4, 1.8, -3]], [0x9a63db, 0.3, [-2.6, 0.6, -2]]]) {
      const light = new THREE.DirectionalLight(color, intensity);
      light.position.set(...pos).add(centre);
      light.target.position.copy(centre);
      scene.add(light, light.target);
    }
    const renderer = new SVGRenderer();
    renderer.setSize(1040, 1680);
    renderer.setPrecision(3);
    renderer.render(scene, camera);
    const svg = join(dir, `${character}.svg`), png = join(dir, `${character}.png`);
    const out = new URL(`../public/you-${character}.webp`, import.meta.url).pathname;
    writeFileSync(svg, renderer.domElement.outerHTML);
    execFileSync('magick', ['-background', 'none', svg, '-filter', 'Lanczos', '-resize', '520x840', png]);
    execFileSync('cwebp', ['-quiet', '-q', '82', '-alpha_q', '100', '-exact', png, '-o', out]);
    console.log(`520×840 → ${out} (${renderer.info.render.faces} faces, CPU only)`);
  }
} finally {
  rmSync(dir, { recursive: true });
}
