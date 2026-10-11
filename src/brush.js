import * as THREE from 'three';

// Brush cursor: a soft glass bubble (or box) with a bright rim, drawn on top
// of everything so it stays visible inside piles.
const vert = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying vec3 vLocal;
void main() {
  vLocal = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const frag = /* glsl */ `
uniform vec3 uColor;
uniform float uCube;
varying vec3 vN;
varying vec3 vV;
varying vec3 vLocal;
void main() {
  float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.5);
  float a = 0.05 + 0.55 * rim;
  if (uCube > 0.5) {
    // bright box edges
    vec3 q = abs(vLocal);
    float e = max(min(q.x, q.y), max(min(q.y, q.z), min(q.x, q.z)));
    a = 0.05 + 0.75 * smoothstep(0.9, 0.985, e);
  }
  gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.25) * a, a);
}`;

export function createBrushCursor() {
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: { uColor: { value: new THREE.Color() }, uCube: { value: 0 } },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const sphere = new THREE.SphereGeometry(1, 48, 24);
  const box = new THREE.BoxGeometry(2, 2, 2);
  const tube = new THREE.CylinderGeometry(1, 1, 2, 48, 1, true);   // a line's body between its two ends
  const ghost = (geometry) => Object.assign(new THREE.Mesh(geometry, mat), { renderOrder: 10, visible: false, frustumCulled: false });
  const mesh = ghost(sphere);
  // A line's other end and its body (TPT's Shift-drag preview, GameView.cpp RenderLine).
  const start = ghost(sphere), body = ghost(tube);
  const up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3();
  const show = (m, shape, at, radius) => {
    m.visible = true;
    m.geometry = shape === 1 ? box : sphere;
    m.position.copy(at);
    m.quaternion.identity();
    m.scale.setScalar(radius);
  };
  const paint = (shape, color) => {
    mat.uniforms.uCube.value = shape;
    mat.uniforms.uColor.value.set(color).convertSRGBToLinear();
  };
  return {
    mesh,
    extras: [start, body],   // (the scene holds them beside mesh)
    set({ visible, position, radius, shape, color }) {
      mesh.visible = visible;
      start.visible = body.visible = false;
      if (!visible) return;
      show(mesh, shape, position, radius);
      paint(shape, color);
    },
    // a line being dragged (scene units): the brush at both ends and swept between
    setLine({ from, to, radius, shape, color }) {
      show(mesh, shape, to, radius);
      show(start, shape, from, radius);
      dir.subVectors(to, from);
      const len = dir.length();
      body.visible = len > 0;
      if (len > 0) {
        body.geometry = shape === 1 ? box : tube;
        body.position.addVectors(from, to).multiplyScalar(0.5);
        body.quaternion.setFromUnitVectors(up, dir.divideScalar(len));
        body.scale.set(radius, len / 2, radius);
      }
      paint(shape, color);
    },
    // a box being dragged (TPT's Ctrl-drag preview, RenderRect): its centre and half size (scene units)
    setBox({ position, half, color }) {
      start.visible = body.visible = false;
      show(mesh, 1, position, 1);
      mesh.scale.copy(half);
      paint(1, color);
    },
  };
}
