import { E, ELEMENTS } from '../../elements.js';
import { CELL_M } from '../../scale.js';
import { PHYS } from '../../physics.js';
import { contactKernelWGSL } from './contact-kernel.js';
import { CONTACT_ROWS, CONTACT_PRODUCTS, CONTACT_REACTIONS, CONTACT_RX_INDEX, DUST_MIN_FALL_AGE, DUST_MIN_FALL_SPEED, CONTACT_G_TICK, CONTACT_HZ, CONTACT_ELEMENT_COUNT, CONTACT_CONSTANTS,
  CONTACT_DAMP_REACH, CONTACT_DAMP_DRY_Q, CONTACT_CEDAR_BASE, CONTACT_DUST_MEC_NB, CONTACT_DUST_RICH_AIR, CONTACT_TSNS_MARGIN_Q, CONTACT_PUFF_UNIT } from '../../v2/contact.js';
import { EDGE } from '../../simModes.js';
import { CONTACT_ROW_SCHEMA, CONTACT_RX_SCHEMA, contactTableLayout } from '../../v2/contactTable.js';
import { packetTouchWGSL } from './state.js';
import { PARTICLE_CAP } from '../../v2/dynamics-reference.js';

const float = n => Number.isInteger(n) ? `${n}.0` : `${n}`;
const layout = contactTableLayout(CONTACT_ROWS.length, CONTACT_REACTIONS.length);
// Read the immutable tail of the existing EV buffer. No constant struct arrays
// for the backend to inline; signed bounds/defaults and field precision persist.
const table = (name, struct, count, schema, offset, stride) => `fn ${name}(id:i32)->${struct} {
 if(id<0 || id>=${count}){return ${struct}(${schema.map(([, type]) => type === 'i32' ? '0' : '0.0').join(',')});}
 let base=${offset / 4}u+u32(id)*${stride / 4}u;
 return ${struct}(${schema.map(([, type], i) => {
   const load = `EV[base+${Math.floor(i / 4)}u].${'xyzw'[i % 4]}`;
   return `bitcast<${type}>(${load})`;
 }).join(',')});
}`;

// These functions use an intentionally restricted source subset: no JS object
// literals, closures, implicit integer division or dynamic member operations.
// Naga validates the result with the explicit foundation ABI test fixture.
export function emitContactKernel(fn, types, result) {
  const source = fn.toString();
  const match = source.match(/^function (\w+)\(([^)]*)\) \{([\s\S]*)\}$/);
  if (!match) throw Error(`not a scalar contact kernel: ${fn.name}`);
  const args = match[2].split(',').map(s => s.trim()).filter(Boolean);
  if (args.length !== types.length) throw Error(`contact signature: ${fn.name}`);
  let body = match[3]
    .replace(/\bconst\b/g, 'let').replace(/\blet\b/g, 'var')
    .replace(/===/g, '==').replace(/!==/g, '!=')
    .replace(/Math\.(min|max|abs|exp|floor)/g, '$1')
    .replace(/\bctI\(/g, 'i32(').replace(/\bctF\(/g, 'f32(')
    .replace(/E\.([A-Z_]+)/g, (_, key) => `CT_${key}`)
    .replace(/\bof\b/g, 'sourceType').replace(/\bfrom\b/g, 'fromId');
  // WGSL requires braces, including for one-line conditionals. The kernel
  // source uses single statements only (no nested unbraced if statements).
  const wrap = (text, keyword) => {
    const re = new RegExp(`\\b${keyword}\\s*\\(`, 'g');
    let out = '', at = 0, m;
    while ((m = re.exec(text))) {
      let end = re.lastIndex, depth = 1;
      for (; end < text.length && depth; end++) { if (text[end] === '(') depth++; if (text[end] === ')') depth--; }
      let begin = end; while (/\s/.test(text[begin])) begin++;
      if (text[begin] === '{') continue;
      const semi = text.indexOf(';', begin);
      if (semi < 0) throw Error(`unbraced ${keyword} in ${fn.name}`);
      out += text.slice(at, begin) + '{ ' + text.slice(begin, semi + 1) + ' }';
      at = semi + 1; re.lastIndex = at;
    }
    return out + text.slice(at);
  };
  body = wrap(body, 'if');
  body = body.replace(/\belse\s+(?!if\b|\{)([^;{}]+;)/g, 'else { $1 }');
  // WGSL logical precedence disallows comparisons mixed with bitwise without
  // explicit grouping; all bitwise kernel writes already use assignment RHS.
  return `fn ${match[1]}(${args.map((a, i) => `${a === 'of' ? 'sourceType' : a === 'from' ? 'fromId' : a}:${types[i]}`).join(',')})->${result} {${body}\n}`;
}
// Preserve the three-neighbor traversal while avoiding backend expansion of
// large rule bodies. Valid native event buffers always contain at least 8 slots.
const generated = contactKernelWGSL.replaceAll('k < 3;', 'k < ctNeighborCount();');

// Standalone dynamics-facing declarations; importing these does not pull the
// contact rule kernel, storage bindings or activity/ledger functions into air.
export const specialContactWGSL = /* wgsl */ `
fn contactNuclearMaterial(core:vec4u)->u32 {
 let id=core.x&255u;let ctype=core.y>>24u;
 if(id==${E.LAVA}u && ctype>0u && ctype<${ELEMENTS.length}u){return ctype;}return id;
}
fn contactVacuum(core:vec4u)->f32 {
 if((core.x&255u)==${E.SINGULARITY}u){return max(${float(PHYS.P_MIN)},-${float(PHYS.SING_P_PER_MASS)}*f32(core.y&65535u)/256.0);}
 return 0.0;
}
// (energy J, product ID, product C, product ctype); caller recognizes DUST/SING
// by ID, not energy>0: zero-mass SING must consume its terminal request too.
fn contactSpecialExplosion(core:vec4u,gunpowderEnergyJ:f32)->vec4f {
 let id=core.x&255u;
 if(id!=${E.DUST}u && id!=${E.SINGULARITY}u){return vec4f(0.0);}
 let temperature=f32(phaseTq(id,(core.x>>8u)&65535u))*0.25-273.25;
 let mass=f32(core.y&65535u)/256.0;
 var pressure=${float(PHYS.DUST_P)};
 var productT=max(temperature,${float(PHYS.DUST_FLAME_T)});
 if(id==${E.SINGULARITY}u){
  if(mass==0.0){return vec4f(0.0,${float(E.EMPTY)},temperature,0.0);}
  pressure=${float(PHYS.SING_BURST_P_PER_MASS)}*mass;productT=${float(PHYS.SING_BURST_T)};
 }
 let ratio=min(${float(PHYS.P_MAX)},pressure)/${float(ELEMENTS[E.GUNPOWDER].blast.P)};
 return vec4f(gunpowderEnergyJ*ratio*ratio,${float(E.FIRE)},productT,0.0);
}
`;

// Two requests on one cell: their flags together, the larger unconsumed puff
// (v2/contact.js ctPuff). The block pass stores every request word through it.
export const requestMergeWGSL = /* wgsl */ `
fn ctMergeRequest(a:u32,b:u32)->u32 { return ((a|b)&${CONTACT_PUFF_UNIT - 1}u)|(max(a/${CONTACT_PUFF_UNIT}u,b/${CONTACT_PUFF_UNIT}u)*${CONTACT_PUFF_UNIT}u); }
`;
export const contactWGSL = /* wgsl */ `
${Object.entries(E).map(([k, id]) => `const CT_${k}:i32=${id};`).join('\n')}
const DUST_MIN_FALL_SPEED:f32=${DUST_MIN_FALL_SPEED};
const DUST_MIN_FALL_AGE:i32=${DUST_MIN_FALL_AGE};
const CONTACT_G_TICK:f32=${CONTACT_G_TICK};
const CONTACT_ELEMENT_COUNT:i32=${CONTACT_ELEMENT_COUNT};
const CONTACT_DAMP_REACH:i32=${CONTACT_DAMP_REACH};
const CONTACT_DAMP_DRY_Q:i32=${CONTACT_DAMP_DRY_Q};
const CONTACT_CEDAR_BASE:i32=${CONTACT_CEDAR_BASE};
const CONTACT_DUST_MEC_NB:i32=${CONTACT_DUST_MEC_NB};
const CONTACT_DUST_RICH_AIR:i32=${CONTACT_DUST_RICH_AIR};
const CONTACT_TSNS_MARGIN_Q:f32=${float(CONTACT_TSNS_MARGIN_Q)};
const CONTACT_PUFF_UNIT:i32=${CONTACT_PUFF_UNIT};
${Object.entries(CONTACT_CONSTANTS).map(([k, [type, v]]) => `const ${k}:${type}=${type === 'f32' ? float(Math.fround(v)) : v};`).join('\n')}
${requestMergeWGSL}struct CTCell { id:i32,tq:i32,raw:i32,fill:i32,life:i32,ctype:i32,spark:i32,age:i32,fallSpeed:f32,burning:i32,valid:i32,bank:i32,state:i32,request:i32,busy:i32,done:i32,pending:i32,pendingOf:i32,pendingGas:i32,source:vec2u,sink:vec2u }
struct CTPair { a:CTCell,b:CTCell,changed:i32 }
fn ctNeighborCount()->i32 { return i32(min(3u,arrayLength(&events))); }
struct CTRow { ${CONTACT_ROW_SCHEMA.map(([key, type]) => `${key}:${type}`).join(',')} }
struct CTRx { ${CONTACT_RX_SCHEMA.map(([key, type]) => `${key}:${type}`).join(',')} }
${table('ctRow', 'CTRow', CONTACT_ROWS.length, CONTACT_ROW_SCHEMA, layout.rowOffset, layout.rowStride)}
${table('ctRx', 'CTRx', CONTACT_REACTIONS.length, CONTACT_RX_SCHEMA, layout.rxOffset, layout.rxStride)}
fn ctRxAt(a:i32,b:i32)->i32 {
 switch a*${ELEMENTS.length}+b {
 ${Array.from(CONTACT_RX_INDEX).flatMap((v, i) => v ? [`case ${i}: { return ${v}; }`] : []).join('\n')}
 default: { return 0; }
 }
}
fn ctProduct(at:i32,r:f32)->i32 {
 switch at {
 ${CONTACT_PRODUCTS.map((_, i) => {
   let cases = ''; for (let j = i; j < CONTACT_PRODUCTS.length; j++) {
     const p = CONTACT_PRODUCTS[j]; cases += `if(r<${float(p.limit)}){return ${p.id};}`;
     if (p.limit === 1) break;
   }
   return `case ${i}: { ${cases} return -1; }`;
 }).join('\n')}
 default: { return -1; }
 }
}
fn ctRoll(seed:i32,salt:i32)->f32 {
 var h=bitcast<u32>(seed)^(u32(salt)*0x9e3779b9u);
 h^=h>>16u;h*=0x7feb352du;h^=h>>15u;h*=0x846ca68bu;h^=h>>16u;
 return f32(h>>8u)/16777216.0;
}
fn ctCopy(c:CTCell)->CTCell{return c;}
fn ctLife(c:CTCell)->f32{return lifeOf(ctMaterial(c).core);}
fn ctWithLife(input:CTCell,value:f32)->CTCell{var c=input;c.life=i32(payloadOf(withLife(ctMaterial(c).core,value)));return c;}
fn ctDiv(a:i32,b:i32)->i32{return a/b;}
fn ctNew(id:i32,tq:i32,fill:i32)->CTCell {
 var life=ctRow(id).spawnLife;
 if(ctRow(id).kind==3){life=i32(phaseDiv(energyMul(u32(life),u32(fill)),vec2u(65536u,0u)).x);}
 return CTCell(id,tq,tq,fill,life,select(0,CT_STONE,id==CT_LAVA),0,0,0.0,0,1,0,0,0,0,0,-1,0,0,vec2u(0u),vec2u(0u));
}
fn ctPairValue(a:CTCell,b:CTCell,changed:i32)->CTPair{return CTPair(a,b,changed);}
fn ctMaterial(c:CTCell)->Material {
 var core=vec4u(u32(c.id)|(u32(c.raw)<<8u),u32(c.fill)|(u32(c.ctype)<<24u),0u,0u);
 if(ctRow(c.id).kind!=3){core.y=u32(c.life)|(u32(c.ctype)<<16u);}else{core.w=u32(c.life)<<16u;}
 return Material(core,c.bank);
}
fn ctOffset(c:CTCell)->vec2u{return phaseMaterialOffsetEnergy(u32(c.id),u32(ctAmount(c)),u32(c.ctype));}
fn ctEnergy(c:CTCell)->vec2u{return energyOf(ctMaterial(c));}
fn ctAdd(a:vec2u,b:vec2u)->vec2u{return energyAdd(a,b);}
fn ctSub(a:vec2u,b:vec2u)->vec2u{return energySub(a,b);}
fn ctSigned(n:i32)->vec2u{return energySigned(n);}
fn ctMul(a:i32,b:i32)->vec2u{return energyMul(u32(a),u32(b));}
fn ctLess(a:vec2u,b:vec2u)->bool{return phaseLess(a,b);}
fn ctSmall(d:vec2u)->i32{return bitcast<i32>(d.x);}
fn ctFits(c:CTCell,energy:vec2u)->bool {return energyFits(ctMaterial(c),energy);}
fn ctSetEnergy(input:CTCell,energy:vec2u)->CTCell {
 var c=input; let m=withEnergy(ctMaterial(c),energy);
 c.raw=i32((m.core.x>>8u)&65535u);c.tq=i32(phaseTq(u32(c.id),u32(c.raw)));c.bank=m.bank;return c;
}
fn ctPastPhase(c:CTCell,hot:bool)->bool {
 let row=ctRow(c.id);
 let baseline=energyAdd(energyMul(u32(ctCapacity(c)),u32(select(row.coldQ,row.hotQ,hot))),ctOffset(c));
 let latent=energyMul(u32(select(row.coldL,row.hotL,hot)),u32(ctAmount(c)));
 if(hot){return !phaseLess(ctEnergy(c),energyAdd(baseline,latent));}
 return !phaseLess(energySub(baseline,latent),ctEnergy(c));
}
fn ctCeilEnergy(energy:vec2u,divisor:i32)->i32{return i32(phaseDiv(energyAdd(energy,energySigned(divisor-1)),vec2u(u32(divisor),0u)).x);}
fn ctCommonQ(energy:vec2u,a:CTCell,b:CTCell)->i32 {
 let sensible=energySub(energySub(energy,ctOffset(a)),ctOffset(b));
 if(phaseLess(sensible,vec2u(0u))){return 0;}
 return i32(phaseDiv(sensible,vec2u(u32(ctCapacity(a)+ctCapacity(b)),0u)).x);
}
fn ctRemainder(energy:vec2u,a:CTCell,b:CTCell)->vec2u{return energySub(energySub(energy,ctEnergy(a)),ctEnergy(b));}
${generated}

fn ctUnpack(core:vec4u,bank:i32)->CTCell {
 let id=i32(core.x&255u);let row=ctRow(id);let liquid=row.kind==3;
 var c=ctNew(id,i32(phaseTq(u32(id),(core.x>>8u)&65535u)),65536);
 c.raw=i32((core.x>>8u)&65535u);c.bank=bank;c.age=i32(core.x>>24u);c.fallSpeed=fallVelocity(core)/${CELL_M * CONTACT_HZ};
 c.burning=i32((core.y>>24u)&1u);c.ctype=i32((core.y>>16u)&255u);c.life=i32(core.y&65535u);c.state=bitcast<i32>(core.z);
 if(row.conductor!=0){c.spark=i32(core.w&4095u);}
 if(liquid){
  c.fill=i32(core.y&0xffffffu);c.ctype=i32(core.y>>24u);c.age=0;c.burning=0;c.life=i32(core.w>>16u);
  if(row.burn>0){c.burning=c.ctype>>7;c.ctype&=127;}
  if(row.conductor!=0){c.spark=i32((core.w>>16u)&4095u);c.life=0;}
 }
 return c;
}
fn ctPack(c:CTCell,original:vec4u)->vec4u {
 var core=original;if(c.id!=i32(original.x&255u)){core=vec4u(0u);}
 let row=ctRow(c.id);let liquid=row.kind==3;
 let age=select(u32(c.age),core.x>>24u,liquid || row.kind==2);
 core.x=u32(c.id)|(u32(c.raw)<<8u)|(age<<24u);
 if(liquid){
  core.y=u32(c.fill)|(u32(c.ctype)<<24u);
  if(row.burn>0 && c.burning!=0){core.y|=0x80000000u;}
  if(row.conductor!=0){core.w=(core.w&0xf000ffffu)|(u32(c.spark&4095)<<16u);}
  else{core.w=(core.w&65535u)|(u32(c.life)<<16u);}
 }else{
  core.y=(core.y&0xfe000000u)|(u32(c.burning)<<24u)|u32(c.life)|(u32(c.ctype)<<16u);
  if(row.conductor!=0){core.w=(core.w&0xfffff000u)|u32(c.spark);}
 }
 return core;
}
${specialContactWGSL}
// a flying packet's touch on a cell this tick (v2/contact.js ctPacketTouch; the airborne react stage's mark)
${packetTouchWGSL(PARTICLE_CAP)}
fn contactDensity(core:vec4u)->f32 {
 let id=i32(core.x&255u);let row=ctRow(id);
 if(row.kind==0 || row.kind==4){return row.density*f32(row.spawnQ)/max(4.0,f32(phaseTq(u32(id),(core.x>>8u)&65535u)));}
 return row.density;
}
fn contactBoundary(material:Material,openFaces:u32,ambientQ:u32,position:vec3i)->Material {
 if(!inGrid(position)){return material;}
 let c=ctBoundary(ctUnpack(material.core,material.bank),i32(openFaces),i32(ambientQ));
 if(any(c.source!=vec2u(0u))){noteEnergySource(position,c.source);}
 if(any(c.sink!=vec2u(0u))){noteEnergySink(position,c.sink);}
 if(c.busy!=0){markBusy(position);}
 return Material(ctPack(c,material.core),c.bank);
}

// contactAmbientQ (v2/contact.js) and the boundary wrapper's encoding of P.ambient.
fn contactAmbientQ()->i32 { return i32(clamp(round((P.ambient+273.25)*4.0),0.0,65535.0)); }
fn ctSeed(position:vec3i,tick:u32)->i32 {
 return bitcast<i32>((u32(position.x)*73856093u) ^ (u32(position.y)*19349663u) ^ (u32(position.z)*83492791u) ^ (tick*2654435761u));
}
// A one-sided pair rule both ways round (i on j, then j on i) as one inlined copy of the rule: a loop
// of CT_PAIR_ORDERS trips whose bound Metal can't fold, so it doesn't unroll into two copies (cold
// compile, docs/webgpu.md B5; the airborne stage's dReact does the same). Events hold at least one
// 64-cell brick: the loop runs exactly twice.
const CT_PAIR_ORDERS:u32=2u;
fn ctPairOrders()->u32 { return min(CT_PAIR_ORDERS,arrayLength(&events)); }
fn contactBlock(cores:ptr<function,array<vec4u,8>>,banks:ptr<function,array<i32,8>>,positions:array<vec3i,8>,requests:ptr<function,array<u32,8>>) {
 var cells:array<CTCell,8>;
 // Native event storage has at least one 64-cell brick. Keep the bound
 // runtime-backed so Metal need not duplicate every contact rule eight times.
 let count=min(8u,arrayLength(&events));
 for(var i=0u;i<count;i++){
  cells[i]=ctUnpack((*cores)[i],(*banks)[i]);cells[i].request=i32((*requests)[i]);
  cells[i].valid=select(0,1,inGrid(positions[i]));
  if((cells[i].request&5)!=0){cells[i].done=1;cells[i].busy=1;}
 }
 for(var i=0u;i<count;i++){
  for(var axis=0u;axis<u32(ctNeighborCount());axis++){
   let j=i^(1u<<axis);if(j<=i || cells[i].valid==0 || cells[j].valid==0){continue;}
   var flux=0;if(ctConducts(cells[i],cells[j],i32(P.ambientHeat))){flux=ctFlux(cells[i],cells[j]);}
   if(flux!=0){flux=-ctHeatRoom(cells[j],-ctHeatRoom(cells[i],flux));}
   if(flux!=0){cells[i]=ctHeat(cells[i],flux);cells[j]=ctHeat(cells[j],-flux);cells[i].busy=1;cells[j].busy=1;}
   let seed=ctSeed(positions[i],P.tick)^i32(j);
   var pair=ctReaction(cells[i],cells[j],seed);
   // acid, then swallow, each i on j and then j on i (ctPairOrders)
   for(var order=0u;order<ctPairOrders();order++){
    if(pair.changed!=0){continue;}
    var a=pair.a;var b=pair.b;if(order==1u){a=pair.b;b=pair.a;}
    let r=ctAcid(a,b,seed);pair=r;if(order==1u){pair=ctPairValue(r.b,r.a,r.changed);}
   }
   for(var order=0u;order<ctPairOrders();order++){
    if(pair.changed!=0){continue;}
    var a=pair.a;var b=pair.b;if(order==1u){a=pair.b;b=pair.a;}
    let r=ctSwallow(a,b,seed);pair=r;if(order==1u){pair=ctPairValue(r.b,r.a,r.changed);}
   }
   cells[i]=pair.a;cells[j]=pair.b;
  }
 }
 let snapshot=cells;
 for(var i=0u;i<count;i++){
  if(cells[i].valid==0){continue;}
  let ns=array<CTCell,3>(snapshot[i^1u],snapshot[i^2u],snapshot[i^4u]);
  // Frozen pre-block atmosphere, never a global core read during R5.
  let outside=liquidScratch[slotOf(positions[i])].x&255u;
  // V1 react.js counts the box's solid floor as a surface (its sides and lid don't).
  let onFloor=select(0,1,positions[i].y==0 && P.edge==${EDGE.SOLID}u);
  // a flying packet in a partner's cell, as V1's react saw a moving neighbour: the react stage's mark here
  let touch=packetTouchNow(slotOf(positions[i]));
  cells[i]=ctStepAtmosphere(cells[i],ns,ctSeed(positions[i],P.tick),i32(outside&3u),i32((outside>>2u)&3u),i32((outside>>4u)&3u),i32((outside>>6u)&3u),onFloor,contactAmbientQ(),touch);
 }
 for(var i=0u;i<count;i++){
  for(var axis=0u;axis<u32(ctNeighborCount());axis++){
   let j=i^(1u<<axis);if(j<=i || cells[i].valid==0 || cells[j].valid==0){continue;}
   var pair=ctPairValue(cells[i],cells[j],0);
   for(var order=0u;order<ctPairOrders();order++){
    if(pair.changed!=0){continue;}
    var a=pair.a;var b=pair.b;if(order==1u){a=pair.b;b=pair.a;}
    let r=ctResolvePhase(a,b);pair=r;if(order==1u){pair=ctPairValue(r.b,r.a,r.changed);}
   }
   cells[i]=pair.a;cells[j]=pair.b;
  }
 }
 for(var i=0u;i<count;i++){
  if(cells[i].valid==0){continue;}
  cells[i]=ctAmbient(cells[i],contactAmbientQ(),i32(P.ambientHeat));
  (*cores)[i]=ctPack(cells[i],(*cores)[i]);(*banks)[i]=cells[i].bank;(*requests)[i]=ctMergeRequest((*requests)[i],u32(cells[i].request));
  if(any(cells[i].source!=vec2u(0u))){noteEnergySource(positions[i],cells[i].source);}
  if(any(cells[i].sink!=vec2u(0u))){noteEnergySink(positions[i],cells[i].sink);}
  if(cells[i].busy!=0){markBusy(positions[i]);}
 }
}
`;
