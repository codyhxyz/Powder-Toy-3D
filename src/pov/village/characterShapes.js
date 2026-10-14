import * as THREE from 'three';

// Wild World / City Folk: low-poly silhouettes with painted details, not bead-like parts.
// Rings run from crown to hem; one indexed skin joins every ring, including the rear.
export function loft(rings, segments = 16) {
  const positions = [], uv = [], indices = [], top = rings[0][0], bottom = rings.at(-1)[0];
  rings.forEach(([y, rx, rz, z = 0], row) => {
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments - 0.5) * Math.PI * 2;
      positions.push(i === 0 || i === segments ? 0 : Math.sin(a) * rx, y, z - Math.cos(a) * rz);
      uv.push(i / segments, (y - bottom) / (top - bottom));
      if (row && i < segments) {
        const a = (row - 1) * (segments + 1) + i, b = row * (segments + 1) + i;
        indices.push(a, b + 1, b, a, a + 1, b + 1);
      }
    }
  });
  for (const [row, up] of [[0, true], [rings.length - 1, false]]) {
    const centre = positions.length / 3, [y, , , z = 0] = rings[row];
    positions.push(0, y, z); uv.push(0.5, up ? 1 : 0);
    for (let i = 0; i < segments; i++) {
      const a = row * (segments + 1) + i;
      indices.push(centre, up ? a + 1 : a, up ? a : a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(indices); g.computeVertexNormals();
  // Smooth the duplicated UV seam. Otherwise the garment has a vertical lighting crack.
  const n = g.attributes.normal;
  rings.forEach((_, row) => {
    const a = row * (segments + 1), b = a + segments;
    const v = new THREE.Vector3().fromBufferAttribute(n, a).add(new THREE.Vector3().fromBufferAttribute(n, b)).normalize();
    n.setXYZ(a, v.x, v.y, v.z); n.setXYZ(b, v.x, v.y, v.z);
  });
  return g;
}

export function hairGeometry(girl) {
  // Front is angle zero. The long rear edge covers the skull to the nape;
  // the short front edge has authored angular bangs, not a horizontal helmet cut.
  const outline = girl
    ? [[-Math.PI, 2.35], [-2.55, 2.4], [-2.12, 2.44], [-1.6, 2.17], [-1.15, 1.9], [-0.9, 1.42],
      [-0.72, 1.23], [-0.42, 1.21], [-0.13, 1.17], [0.16, 1.03], [0.35, 0.89],
      [0.49, 1.15], [0.75, 1.35], [1.05, 1.86], [1.6, 2.17], [2.12, 2.44], [2.55, 2.4], [Math.PI, 2.35]]
    : [[-Math.PI, 2.27], [-2.3, 2.22], [-1.6, 1.97], [-1.18, 1.6], [-0.92, 1.3],
      [-0.74, 1.13], [-0.48, 1.25], [-0.31, 1.06], [-0.04, 1.25], [0.14, 1.04],
      [0.38, 1.17], [0.59, 0.98], [0.8, 1.19], [1.18, 1.6], [1.6, 1.97], [2.3, 2.22], [Math.PI, 2.27]];
  const segments = 48, rows = 8, p = [0, 5.59, 0], index = [], shade = [1];
  for (let row = 1; row <= rows + 1; row++) for (let i = 0; i < segments; i++) {
    const a = -Math.PI + i / segments * Math.PI * 2;
    const right = outline.findIndex(([angle]) => angle > a);
    const [a0, h0] = outline[right - 1], [a1, h1] = outline[right];
    const edge = THREE.MathUtils.lerp(h0, h1, (a - a0) / (a1 - a0));
    const t = Math.min(row, rows) / rows, theta = edge * t;
    const rim = row > rows, wave = Math.sin(theta);
    // Broad cut planes give the bob volume; no separate spherical fringe or ponytails.
    const flare = girl ? 1 + 0.1 * Math.max(0, theta - 1) : 1;
    const ridge = 1 + 0.018 * Math.cos(a * (girl ? 7 : 5) + t * 0.7) * wave;
    const r = flare * ridge * (rim ? 0.8 : 1);
    p.push(Math.sin(a) * 1.46 * wave * r, 4.12 + 1.47 * Math.cos(theta) + (rim ? 0.025 : 0),
      -Math.cos(a) * 1.27 * wave * r);
    // Broad painted locks like the DS/Wii hair textures, not individual glossy strands.
    shade.push(1 - 0.17 * Math.sin(a * 4 + t * 0.8) ** 8 * t);
    const current = 1 + (row - 1) * segments + i, next = 1 + (row - 1) * segments + (i + 1) % segments;
    if (row === 1) index.push(0, next, current);
    else {
      const upper = current - segments, upperNext = next - segments;
      index.push(upper, next, current, upper, upperNext, next);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('shade', new THREE.Float32BufferAttribute(shade, 1));
  g.setIndex(index); g.computeVertexNormals();
  return g;
}

// Small coloured surface patches follow the face, instead of floating eyeballs.
function facePoint(x, y, depth) {
  return [x, y, -1.19 * Math.sqrt(Math.max(0.005, 1 - (x / 1.4) ** 2 - ((y - 4.08) / 1.36) ** 2)) - depth];
}
export function faceEllipse(x, y, rx, ry, depth = 0.015) {
  const p = facePoint(x, y, depth), indices = [], segments = 24, rows = 3;
  for (let row = 1; row <= rows; row++) for (let i = 0; i < segments; i++) {
    const a = i / segments * Math.PI * 2, r = row / rows;
    p.push(...facePoint(x + Math.cos(a) * rx * r, y + Math.sin(a) * ry * r, depth));
    const current = 1 + (row - 1) * segments + i, next = 1 + (row - 1) * segments + (i + 1) % segments;
    if (row === 1) indices.push(0, next, current);
    else {
      const a = current - segments, b = next - segments;
      indices.push(a, next, current, a, b, next);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setIndex(indices); g.computeVertexNormals(); return g;
}
export function faceStroke(points, width = 0.035, depth = 0.02) {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, y]) => new THREE.Vector3(x, y, 0)));
  const p = [], indices = [], steps = 20;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, at = curve.getPoint(t), tangent = curve.getTangent(t);
    for (const side of [-1, 1])
      p.push(...facePoint(at.x - tangent.y * width * side, at.y + tangent.x * width * side, depth));
    if (i) { const a = (i - 1) * 2; indices.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setIndex(indices); g.computeVertexNormals(); return g;
}
export function noseGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.18, 3.8, -1.2, 0.18, 3.8, -1.2, 0, 4.06, -1.18, 0, 3.86, -1.47,
  ], 3));
  g.setIndex([0, 2, 3, 2, 1, 3, 0, 3, 1, 0, 1, 2]); g.computeVertexNormals(); return g;
}

export function clothTexture(color, kind) {
  const size = 128, pixels = new Uint8Array(size * size * 4);
  const base = new THREE.Color(color), cream = new THREE.Color('#fff0ce');
  const shade = base.clone().multiplyScalar(0.7), light = base.clone().lerp(cream, 0.3);
  // Convert once, not once per texel. DataTexture is sRGB, vertex colours are linear.
  const bytes = c => { const s = c.clone().convertLinearToSRGB(); return [s.r, s.g, s.b].map(v => Math.round(v * 255)); };
  const colors = [base, kind === 'rings' ? new THREE.Color('#604738') : shade, light, cream].map(bytes);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size, v = (y + 0.5) / size;
    let ink = 0;
    if (kind === 'plaid') {
      const vertical = x % 32 < 5, horizontal = y % 24 < 4;
      ink = vertical && horizontal ? 3 : vertical ? 2 : horizontal ? 1 : 0;
    } else if (kind === 'stripe') ink = y % 28 < 9 ? 3 : 0;
    else if (kind === 'rings') ink = y % 32 < 16 ? 1 : 0;
    else if (kind === 'flower') {
      // Repeated hem flowers continue around the back; no blank or intersecting skirt panel.
      const dx = (u * 6 % 1 - 0.5) * 2, dy = (v - 0.23) * 12;
      const r = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
      if (r < 0.65 + 0.18 * Math.cos(a * 5)) ink = 3;
      if (r < 0.19) ink = 1;
      if (v < 0.045) ink = 1;
    } else if (kind === 'cardigan') {
      if (Math.abs(u - 0.5) < 0.075) ink = 3;
      if (Math.abs(u - 0.5) < 0.018 && Math.abs(v * 4 % 1 - 0.5) < 0.06) ink = 1;
      if (v < 0.06) ink = 1;
    }
    if (kind !== 'rings' && v > 0.91) ink = 3;
    const i = (y * size + x) * 4;
    pixels.set([...colors[ink], 255], i);
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.needsUpdate = true;
  return texture;
}
