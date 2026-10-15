// Source-native WORD comparison, not float comparison or a new physics rule.
// One invocation per original 4³ brick; jobs pair per-cell aux presence flags.
// Raw: six storage bindings. Aux: eight (baseline WebGPU limit).
export const worldLightingDeltaLayouts = aux => Array.from({length:aux?8:6},(_,binding)=>({binding,visibility:4,buffer:{type:binding===(aux?6:4)?'storage':'read-only-storage'}}));
export const worldLightingDeltaWGSL = aux => /* wgsl */ `
${(aux?['oldFlow','newFlow','oldAer','newAer','oldDeco','newDeco']:['oldA','newA','oldB','newB']).map((n,i)=>`@group(0) @binding(${i}) var<storage, read> ${n}: array<u32>;`).join('\n')}
@group(0) @binding(${aux?6:4}) var<storage, read_write> delta: array<atomic<u32>>;
@group(0) @binding(${aux?7:5}) var<storage, read> jobs: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id:vec3u) {
  let j=id.x*132u;
  if(j>=arrayLength(&jobs)){return;}
  let a=jobs[j]; let b=jobs[j+1u]; let out=jobs[j+2u];
  var changed=false;
  for(var s=0u;s<64u;s++){
    let x=a+s; let y=b+s;
    ${aux?`let p=jobs[j+4u+2u*s]; let q=jobs[j+5u+2u*s];
    changed=changed || p!=q;
    if((p&q&1u)!=0u){for(var k=0u;k<2u;k++){changed=changed || oldFlow[2u*x+k]!=newFlow[2u*y+k];}}
    if((p&q&2u)!=0u){for(var k=0u;k<2u;k++){changed=changed || oldAer[2u*x+k]!=newAer[2u*y+k];}}
    if((p&q&4u)!=0u){changed=changed || oldDeco[x]!=newDeco[y];}`:`for(var k=0u;k<4u;k++){changed=changed || oldA[4u*x+k]!=newA[4u*y+k] || oldB[4u*x+k]!=newB[4u*y+k];}`}
  }
  if(changed){atomicOr(&delta[out],1u);}
}`;
export const WGSL_CHECK=()=>[false,true].map(aux=>({name:`worldLightingDelta.${aux?'aux':'raw'}`,kind:'compute',grids:false,warm:false,code:()=>worldLightingDeltaWGSL(aux),layouts:()=>[worldLightingDeltaLayouts(aux)],workgroupSize:[64,1,1],dispatch:()=>[1,1,1]}));
