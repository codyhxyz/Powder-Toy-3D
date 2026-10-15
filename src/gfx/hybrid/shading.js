import { hybridLightingEntries, hybridLightingLayout, hybridLightingWGSL } from './lighting.js';
import { shadowReceiverWGSL } from '../../shaders/hybrid/shadows.js';
import { hybridReflectionsWGSL } from '../../shaders/hybrid/reflections.js';
import { ddaGLSL } from '../../shaders/gfx/core.js';
import { skyGLSL, skyViewGLSL } from '../sky.js';
import { uniformStruct } from '../../gpu/params.js';

export const HybridControls = uniformStruct('HybridControls',{ reflectionSteps:'u32' });

export function createHybridShading(gpu,sim,{materials,shadows,controls,gate=null,binding=0,reflections=true}) {
  const sampler=gpu.device.createSampler({label:'hybrid shared probes',minFilter:'linear',magFilter:'linear'});
  const light=binding+4,shadow=binding+10,control=binding+13;
  const layout=[
    ...materials.layoutEntries({binding}),...hybridLightingLayout({binding:light}),
    ...shadows.bindingDescriptors({binding:shadow}),
    {binding:control,visibility:2,buffer:{type:'uniform'}},
    ...(gate?[{binding:control+1,visibility:2,buffer:{type:'read-only-storage'}}]:[]),
  ];
  const entries=[
    ...materials.entries({binding}),...hybridLightingEntries(sim.derived.views,sampler,{binding:light}),
    ...shadows.bindings({binding:shadow}),{binding:control,resource:{buffer:controls.buffer}},
    ...(gate?[{binding:control+1,resource:{buffer:gate}}]:[]),
  ];
  const wgsl=[
    materials.shader({binding}),hybridLightingWGSL({binding:light}),shadowReceiverWGSL({binding:shadow}),
    HybridControls.wgsl,`@group(2) @binding(${control}) var<uniform> HC: HybridControls;`,
    gate?`@group(2) @binding(${control+1}) var<storage,read> hybridGate:array<u32>;`:'',
    'const PI_L: f32 = 3.141592653589793;',skyGLSL(),skyViewGLSL(),
    `fn hybridHitRadiance(id:i32,a:vec4f,p:vec3f,n:vec3f,view:vec3f)->vec3f {
      var m=hybridMaterialStateLod(id,fract(a.w),p,n,a.y,i32(floor(a.w)),0.0);
      m.opacity=1.0;
      return hybridShade(m,p,n,m.normal,view,vec3f(hybridSunVisibility(p,n)),1.0).rgb;
    }`,
    reflections ? [
      ddaGLSL(sim.g),
      `fn hybridReflectionShade(id:i32,seed:f32,temperature:f32,p:vec3f,n:vec3f,incident:vec3f)->vec3f {
        // The callback ABI's seed omits ctype. Read the actual hit state so
        // reflected sparks, lava and lamps retain their live appearance.
        let a=fetchA(vec3i(floor(p-n*0.01)));
        return hybridHitRadiance(id,a,p,n,-incident);
      }`,
      hybridReflectionsWGSL({maxSteps:32}),
    ].join('\n') : '',
    `fn hybridOpaqueShade(id:i32,a:vec4f,p:vec3f,ng:vec3f,footprint:f32)->vec4f {
      ${gate?'if (hybridGate[0] != 0u) { discard; }':''}
      let m=hybridMaterialStateLod(id,fract(a.w),p,ng,a.y,i32(floor(a.w)),hybridMaterialFootprintLod(id,footprint));
      var reflected=vec4f(0.0);
      ${reflections ? `if (m.roughness < 0.3 && HC.reflectionSteps > 0u) {
        let pixels=1.0/max(footprint*footprint,1e-8);
        reflected=vec4f(hrReflection(p,p-FU.cam,ng,m.roughness,pixels,m.f0,HC.reflectionSteps),1.0);
      }` : ''}
      return hybridShadeSpecular(m,p,ng,m.normal,FU.cam-p,vec3f(hybridSunVisibility(p,ng)),1.0,reflected);
    }
    fn shadeSmooth(p:vec3f,n:vec3f,id:i32,a:vec4f,footprint:f32)->vec3f {
      return hybridOpaqueShade(id,a,p,n,footprint).rgb;
    }`,
  ].join('\n');
  return {wgsl,layout,entries};
}
