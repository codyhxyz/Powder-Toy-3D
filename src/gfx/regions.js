import * as THREE from 'three';

// Drawing a pass over flagged regions of its target only (docs/scaling.md D9:
// the derived passes over changed bricks; D8: the sim passes over awake
// supertiles).
//
// On a tile-based GPU a pass costs about what the hardware tiles (32×32 texels
// here) it touches cost: one tile of a 2048×1024 target ~0.04 ms, all of it
// ~0.53 ms. So a pass that only needs some regions draws one instanced quad per
// region, and the vertex shader drops the regions whose flag is off: their
// texels keep their values and their tiles are never loaded. Clustered regions
// cost about half what scattered ones do, so a region should cover whole
// hardware tiles. Instancing every region costs 1.3–3.4× one full-screen quad,
// so when most regions are on the pass draws a single full-screen quad
// instead. That choice is made on the GPU too, from a share the caller computes
// in an earlier pass, so nothing is read back.
//
// Every pass drawn this way (a material made with regionMaterial, drawn with
// Simulation.run(mat, target, quads)) draws instance 0 as the full-screen quad
// and instance i > 0 as region i - 1, each only when chosen. Its fragment
// shader is the pass's own: it sees gl_FragCoord only, exactly as with a
// full-screen quad. A texel it skips keeps its value, so a target that
// ping-pongs must already hold the same value in both copies there. A region
// is coarser than what flags it: a pass whose output lasts beyond the frame
// must not write a texel whose inputs this frame's passes didn't all compute
// (the field passes' last stage discards outside its bricks).
//
// The caller describes its regions in GLSL (regionsGLSL), with any uniforms
// they read (the flag and share textures):
//   #define REGION_COUNT n       regions (instances 1..n)
//   vec2 regionTarget()          the target's size in texels
//   bool regionsFull()           draw the full-screen quad instead of the regions
//   bool regionOn(int i)         draw region i (0 <= i < REGION_COUNT)?
//   vec4 regionRect(int i)       its texel rectangle: (x0, y0, x1, y1), x1 and y1 exclusive

export const regionVert = (regionsGLSL) => /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
${regionsGLSL}
uniform bool uRegionsOff;   // draw the full-screen quad only (RegionQuads.fullOnly)
in vec3 position;           // corner of the unit quad: 0 or 1 in x and y
// a clip position outside the view volume: the quad's triangles are dropped
const vec4 CULLED = vec4(2.0, 2.0, 2.0, 1.0);
void main() {
  bool full = uRegionsOff || regionsFull();
  vec4 r;
  if (gl_InstanceID == 0) {
    if (!full) { gl_Position = CULLED; return; }
    r = vec4(vec2(0.0), regionTarget());
  } else {
    int i = gl_InstanceID - 1;
    if (full || !regionOn(i)) { gl_Position = CULLED; return; }
    r = regionRect(i);
  }
  gl_Position = vec4(mix(r.xy, r.zw, position.xy) / regionTarget() * 2.0 - 1.0, 0.0, 1.0);
}
`;

// The instanced quads that draw a set of regions: render `scene` (its one mesh
// takes the pass's material) into the target with any camera.
export class RegionQuads {
  constructor(count) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 2, 1, 3]);
    this.count = count;
    this.mesh = new THREE.Mesh(geo);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    // shared by every material drawn with these quads (regionMaterial)
    this.uniforms = { uRegionsOff: { value: false } };
    this.fullOnly = false;
  }

  // Draw only the full-screen quad, with no region instances at all.
  get fullOnly() { return this.uniforms.uRegionsOff.value; }
  set fullOnly(v) {
    this.uniforms.uRegionsOff.value = v;
    this.mesh.geometry.instanceCount = v ? 1 : this.count + 1;
  }

  dispose() { this.mesh.geometry.dispose(); }
}

// A pass's material for drawing with `quads`: fragment shader `frag` (GLSL 3,
// gl_FragCoord only), regions described by `regionsGLSL`, uniforms `uniforms`
// (those of the region GLSL included). Its uniforms object shares the quads'.
export function regionMaterial(quads, frag, regionsGLSL, uniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: regionVert(regionsGLSL),
    fragmentShader: frag,
    uniforms: { ...uniforms, ...quads.uniforms },
    depthTest: false,
    depthWrite: false,
  });
}
