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
  const mesh = new THREE.Mesh(sphere, mat);
  mesh.renderOrder = 10;
  mesh.visible = false;
  mesh.frustumCulled = false;
  return {
    mesh,
    set({ visible, position, radius, shape, color }) {
      mesh.visible = visible;
      if (!visible) return;
      mesh.geometry = shape === 1 ? box : sphere;
      mat.uniforms.uCube.value = shape;
      mesh.position.copy(position);
      mesh.scale.setScalar(radius);
      mat.uniforms.uColor.value.set(color).convertSRGBToLinear();
    },
  };
}
