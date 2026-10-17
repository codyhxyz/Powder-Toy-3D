// CPU only. Execute the emitted scalar WGSL, compare with independent rational
// BigInt arithmetic, and exercise the emitted limiter and canonical raw sender.
import assert from 'node:assert/strict';
import { gridLayout } from '../../src/sim.js';
import { FULL, MAX_FILL, share } from '../../src/v2/layout.js';
import { v2LimitWGSL, v2GatherWGSL, liquidTransportWGSL } from '../../src/shaders/v2.js';
import { energyShare, shareUnsigned, limbs, signed } from './integer-transport-reference.mjs';
import { wgslGroupingErrors, assertNaga, importMinified } from './wgsl-grouping.mjs';

const F = Math.fround, K = 65535, D = 2048;
const g = gridLayout(16,16,16), shader = v2LimitWGSL(g);
function fn(text, name) {
  const start = text.indexOf(`fn ${name}(`); assert(start >= 0, name);
  const open = text.indexOf('{', start); let level = 1, end = open + 1;
  while (level) { if (text[end] === '{') level++; if (text[end] === '}') level--; end++; }
  return text.slice(open + 1, end - 1).replace(/\/\/[^\n]*/g, '');
}
// Small typed scalar-expression evaluator: divisions, remainders and each f32
// operation obey WGSL semantics. It consumes actual emitted expressions, not a
// hand-maintained duplicate of acceptedAmount's algorithm.
function expression(source, env, typed = false) {
  const tokens = source.match(/\d+(?:\.\d+)?u?|[A-Za-z_]\w*|==|[()+*/%,\-]/g) ?? [];
  let pos = 0;
  const value = (v,t) => ({v,t});
  const precedence = {'==':1,'+':2,'-':2,'*':3,'/':3,'%':3};
  function parse(min = 0) {
    let t = tokens[pos++], a;
    if (t === '(') { a = parse(); assert.equal(tokens[pos++], ')'); }
    else if (/^\d/.test(t)) a = value(Number(t.replace(/u$/, '')), t.endsWith('u') ? 'u' : t.includes('.') ? 'f' : 'u');
    else if (tokens[pos] === '(') {
      pos++; const args=[];
      do { args.push(parse()); if (tokens[pos] !== ',') break; pos++; } while (true);
      assert.equal(tokens[pos++], ')');
      if (t === 'f32') a = value(F(args[0].v),'f');
      else if (t === 'u32') a = value(Math.trunc(args[0].v) >>> 0,'u');
      else if (t === 'floor') a = value(Math.floor(args[0].v), args[0].t);
      else if (t === 'max') a = value(Math.max(...args.map(x=>x.v)), args[0].t);
      else throw Error(`Unsupported scalar builtin ${t}`);
    } else { assert(t in env, t); a = env[t]; }
    while ((precedence[tokens[pos]] ?? -1) >= min) {
      const op = tokens[pos++], b = parse(precedence[op] + 1), type = a.t === 'f' || b.t === 'f' ? 'f' : 'u';
      let v;
      switch (op) {
        case '+': v=a.v+b.v; break; case '-': v=a.v-b.v; break;
        case '*': v=a.v*b.v; break; case '/': v=type==='u'?Math.trunc(a.v/b.v):a.v/b.v; break;
        case '%': v=a.v%b.v; break; case '==': v=a.v===b.v; break;
      }
      a = value(op==='=='?v:type==='f'?F(v):v>>>0,op==='=='?'bool':type);
    }
    return a;
  }
  const result = parse(); assert.equal(pos,tokens.length,source); return typed ? result : result.v;
}
const acceptedBody = fn(shader,'acceptedAmount');
assert.equal(acceptedBody,fn(liquidTransportWGSL,'acceptedAmount'));
function accepted(q,k) {
  const env={q:{v:F(q),t:'f'},k:{v:k,t:'u'}};
  const statements=acceptedBody.match(/let\s+\w+\s*=\s*[^;]+;|if\s*\([^{}]+\)\s*\{\s*return\s+[^;]+;\s*\}|return\s+[^;]+;/g);
  for(const s of statements) {
    let m;
    if((m=s.match(/^let\s+(\w+)\s*=\s*(.*);$/))) {
      env[m[1]]=expression(m[2],env,true);
    } else if((m=s.match(/^if\s*\((.*)\)\s*\{\s*return\s+(.*);\s*\}$/))) {
      if(expression(m[1],env))return expression(m[2],env);
    } else return expression(s.match(/^return\s+(.*);$/)[1],env);
  }
  throw Error('missing return');
}
const rational = (q,k) => Number(BigInt(q*D)*BigInt(k)/(BigInt(D)*BigInt(K)));
function half(bits) { const e=bits>>>10, m=bits&1023; return e ? (1+m/1024)*2**(e-15) : m*2**-24; }
const active=Array.from({length:0x7c00-0x3800},(_,i)=>half(i+0x3800));
const selected=[0,1,2,16383,32767,32768,49151,65534,65535];
let comparisons=0;
for(const q of [0,...active])for(const k of selected) {
  assert.equal(accepted(q,k),rational(q,k),`q=${q}, k=${k}`); comparisons++;
  assert.equal(accepted(-q,k),0);
}
assert.equal(comparisons,156681); // 156672 active-half comparisons plus zero.
assert.equal(65504*K < 2**32,true);
assert.equal((K-1)*D+(D-1)*(K-1) < 2**28,true);
assert.equal(6*65504*D < 2**30,true);
assert.equal(MAX_FILL*D <= 2**31,true);
// K estimate: exact fl*2048, rounded out, division and multiplication. Even
// allowing four relative errors 2^-24, absolute K error < .016; minus one
// guarantees k <= exact K*. Deficit < 2+.016; six floors lose <6 more.
const kError=K*((1+2**-24)**4-1);
const tailBound=6+(2+kError)*6*65504/K;
assert(kError<0.016 && tailBound<19 && tailBound<32);
// k <= K* => sum floor(q_i*k/K) <= fill. Conversely K*-k < 2+error;
// six per-face truncations lose <6, giving the bound above. Adding the exact
// tail recovers fill; admitting any subset therefore cannot overdraw a source.

// Execute the production accounting loop (only syntax adaptation). The scalar
// evaluator handles the actual K expression so JS doubles cannot mask f32 bugs.
const block=shader.slice(shader.indexOf('    let fl = cFill(c);'),shader.indexOf('    let payload = payloadOf(c);'));
const kExpr=block.match(/      kq = (.*);/)[1];
const translated=block.replace('let fl = cFill(c);','let fl = fill;')
  .replace(`kq = ${kExpr};`,'kq = estimate(fill, out);')
  .replace(/\bvar\b/g,'let').replace(/\b(\d+)u\b/g,'$1')
  .replaceAll('f32(a6[i])','a6[i]') + '\nreturn {kq,tag};';
const runLimit=new Function('fill','out','a6','acceptedAmount','estimate',translated);
function limit(q,fill) {
  const weights=q.map(x=>x*D), out=weights.reduce((a,b)=>a+b,0);
  const {kq,tag}=runLimit(fill,out,weights,accepted,(fl,out)=>expression(kExpr,{fl:{v:fl,t:'u'},out:{v:out,t:'u'}}));
  const face=tag&7, tail=tag>>>3;
  const amounts=q.map((x,i)=>accepted(x,kq)+(kq<K&&i===face?tail:0));
  assert(tail<32 && amounts.every(n=>n>=0));
  assert(amounts.reduce((a,b)=>a+b,0)<=fill);
  if(out>fill*D) {
    assert.equal(amounts.reduce((a,b)=>a+b,0),fill);
    assert.equal(face,weights.indexOf(Math.max(...weights)),'first largest complete weight wins');
    assert(BigInt(kq)*BigInt(out)<=BigInt(fill*D)*BigInt(K));
    assert.equal(tail,fill-q.reduce((sum,x)=>sum+rational(x,kq),0));
  } else {
    assert.equal(kq,K);assert.equal(tail,0);assert.deepEqual(amounts,q.map(Math.floor));
  }
  return {kq,tag,amounts};
}
let seed=0x1cd24b54;
const rnd=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
let sixways=0, changed=0, maxTail=0;
for(let i=0;i<12000;i++) {
  const q=Array.from({length:6},()=>i%3?active[rnd()%active.length]:0);
  const total=q.reduce((a,b)=>a+b,0);
  const fill=[0,1,FULL,MAX_FILL,Math.floor(total),Math.max(0,Math.ceil(total)-1),rnd()%(MAX_FILL+1)][i%7];
  const r=limit(q,fill);maxTail=Math.max(maxTail,r.tag>>>3);
  changed+=q.some(x=>accepted(x,r.kq)!==Math.floor(Math.floor(x)*r.kq/K))?1:0;
  for(let f=0;f<6;f++)assert.equal(accepted(q[f],r.kq),rational(q[f],r.kq));
  // Prefix partitions telescope for unsigned payload and both signed energies,
  // including latent/formation energy and signed-bank extremes.
  if(fill>0)for(const energy of [-2147483648n,2147483647n,BigInt(rnd())*BigInt(fill)]) {
    let prefix=0,heat=0n,fuel=0;const payload=rnd()&65535;
    for(const n of r.amounts) {
      heat+=signed(energyShare(limbs(energy),prefix,n,fill));
      fuel+=shareUnsigned(payload,prefix,n,fill);prefix+=n;
    }
    assert.equal(heat,share(energy,0,prefix,fill));
    assert.equal(fuel,Number(share(payload,0,prefix,fill)));
  }
  sixways++;
}
assert(changed>0);assert(maxTail<32);
for(const q of [[0,0,0,0,0,0],[.5,.5,.5,.5,.5,.5],[1.5,1.5,1.5,1.5,1.5,1.5],[65504,65504,65504,65504,65504,65504]])
  for(const fill of [0,1,2,3,5,FULL,MAX_FILL])limit(q,fill);
// Fractional ordering is deliberate (old integer weights chose the first 1).
assert.equal(limit([1,1.5,1,1,1,1],5).tag&7,1);

// Actual rawSendOf body: both endpoints and jets see identical frozen source,
// sign-reversed face and tag, including negative-owned faces.
const rawBody=fn(liquidTransportWGSL,'rawSendOf')
  .replace('isLiq(snapshot(slotOf(p)).core)','p.liquid').replace('liquidScratch[slotOf(p)]','p.scratch')
  .replaceAll('a.x','a[0]').replace('faceQ(p, face)','p.q[face]')
  .replace(/\bvar\b/g,'let').replace(/\b(\d+)u\b/g,'$1');
const raw=new Function('p','face','acceptedAmount',rawBody);
for(let i=0;i<200;i++) {
  const q=Array.from({length:6},()=>active[rnd()%active.length]),fill=rnd()%(MAX_FILL+1),r=limit(q,fill);
  const p={liquid:true,scratch:[(r.kq|(r.tag<<16))>>>0],q};
  for(let face=0;face<6;face++) {
    const n=raw(p,face,accepted);assert.equal(n,r.amounts[face]);
    const ownerQ=(face&1)?-q[face]:q[face];
    assert.equal(accepted((face&1)?-ownerQ:ownerQ,r.kq)+(r.kq<K&&(r.tag&7)===face?r.tag>>>3:0),n);
  }
}
for(const q of [-65504,-.5,0,.5,1.5,65504])assert.equal(accepted(q,K),Math.floor(Math.max(q,0)));

// Run the emitted faceFlux body with all-liquid fixtures. Exact room/6 integer
// division and f16 round-to-nearest packing reproduce its actual cap contract.
// The canonical admission below ALSO covers tails which exceed that cap and
// arbitrary finite gravity; it does not rely on a shipped-slider gravity bound.
const constant=name=>Number(shader.match(new RegExp(`const ${name}: f32 = ([^;]+);`))[1]);
const ACC=constant('ACC'), COMP=constant('COMP'), DEADQ=constant('DEADQ'), QMIN=constant('QMIN'), Q_MAX=constant('Q_MAX');
const faceBody=fn(shader,'faceFlux')
  .replaceAll('mEdge(pj + mDown(vec3f(pj)+0.5))','pj').replaceAll('mEdge(pi + mDown(vec3f(pi)+0.5))','pi')
  .replaceAll('mDown(vec3f(pi)+0.5)[a]','downAxis')
  .replace('room / 6u','Math.floor(room / 6)')
  .replace('drive += mFaceDrive(pi, a);','drive = F(drive + mFaceDrive(pi, a));')
  .replace('headOf(ci) - headOf(cj)','F(headOf(ci) - headOf(cj))')
  .replace('q + ACC * drive','F(q + F(ACC * drive))')
  .replace('v *= 0.5','v = F(v * 0.5)').replace('v *= 1.0 - damp','v = F(v * F(1.0 - damp))')
  .replace(/\bvar\b/g,'let').replace(/\b(\d+)u\b/g,'$1');
const faceRun=new Function('pi','ci','pj','cj','a','qold','downAxis','mFaceDrive','headOf','stiffOf','F','events','slotOf','isLiq','cid','ctypeOf','claimOf','markBusy','dampOf','yieldOf','cFill','wetAt','f32','min','max','abs','clamp','ACC','COMP','DEADQ','QMIN','Q_MAX','FULLF','MAX_FILL','FILM',faceBody);
const head=c=>c.fill<=FULL?F(c.fill/FULL):F(1+F(F(c.fill-FULL)/F(COMP*FULL)));
function flux(srcFill,dstFill,qold,drive,downAxis=1) {
  return faceRun(0,{id:1,fill:srcFill},1,{id:1,fill:dstFill},0,qold,downAxis,()=>drive,head,c=>c.fill>FULL?F(1/COMP):1,F,[0,0],x=>x,()=>true,c=>c.id,()=>0,()=>[1,0],()=>{},()=>.015,()=>0,c=>c.fill,()=>true,F,Math.min,Math.max,Math.abs,(x,lo,hi)=>Math.max(lo,Math.min(hi,x)),ACC,COMP,DEADQ,QMIN,Q_MAX,FULL,MAX_FILL,FULL>>>3);
}
function packHalf(x) {
  if(!x)return 0;
  const sign=Math.sign(x),a=Math.abs(x);let lo=0,hi=active.length-1;
  if(a<.5)return 0; // faceFlux's QMIN contract.
  while(lo<hi) {const mid=(lo+hi)>>>1;if(active[mid]<a)lo=mid+1;else hi=mid;}
  const b=active[lo],prev=lo?active[lo-1]:0;
  return sign*(a-prev<b-a?prev:a-prev>b-a?b:(lo&1)?prev:b);
}
let fluxCases=0;
for(const fill of [0,1,FULL,MAX_FILL-120,MAX_FILL-18,MAX_FILL-12,MAX_FILL-6,MAX_FILL])
  for(const source of [1,FULL,MAX_FILL])for(const gravity of [0,-2.4,2.4,-1e6,1e6])for(const old of [-43008,0,43008]) {
    const q=packHalf(flux(source,fill,old,gravity));
    if(q>0)assert(q<=Math.floor((MAX_FILL-fill)/6),'packed faceFlux respects its receiver cap');
    const reverse=packHalf(flux(fill,source,-old,-gravity));
    assert(q===-reverse,'reversed owner computes the same signed flux');fluxCases++;
  }

// Execute canonical sendOf itself, with independent exact energy/payload
// primitives. Rejection precedes ANY debit at BOTH endpoints and jets consume
// this same helper. The defensive admission is needed even if flux was valid.
const sendBody=fn(liquidTransportWGSL,'sendOf')
  .replaceAll('mEdge(p + face6(i32(face)))','neighbor(p,face)')
  .replace('room / 6u','Math.floor(room / 6)')
  .replace(/\bvar\b/g,'let').replace(/\b(\d+)u\b/g,'$1');
const sendRun=new Function('p','face','rawSendOf','snapshot','slotOf','neighbor','prefixOf','transportedEnergy','energyPacketFits','conductsNative','payloadOf','shareUnsigned','cFill','cid','markBusy','TransportPacket','vec2u','MAX_FILL','min',sendBody);
let admissions=0;
function admitted(q,fill,dstFill,face=0,kFull=false) {
  admissions++;
  const r=kFull?{kq:K,tag:0}:limit(q,fill),source={core:{fill,payload:12345},energy:-2147483648n};
  const donor={liquid:true,scratch:[(r.kq|(r.tag<<16))>>>0],q};
  const dst={core:{fill:dstFill,payload:0}};let busy=0;
  const rawFace=f=>raw(donor,f,accepted);
  const evaluate=()=>sendRun(0,face,(_,f)=>rawFace(f),s=>s?dst:source,x=>x,(_,f)=>f+1,(_,f)=>q.slice(0,f).reduce((n,_,i)=>n+rawFace(i),0),(s,p,n)=>share(s.energy,p,n,fill),()=>true,()=>false,c=>c.payload,shareUnsigned,c=>c.fill,()=>1,()=>busy++,(amount,heat,fuel)=>({amount,heat,fuel}),()=>0n,MAX_FILL,Math.min);
  const packet=evaluate();
  assert(packet.amount<=Math.floor(Math.max(0,MAX_FILL-dstFill)/6));
  if(rawFace(face)>Math.floor(Math.max(0,MAX_FILL-dstFill)/6)) {
    assert.deepEqual(packet,{amount:0,heat:0n,fuel:0});assert.equal(busy,1);
  }
  assert.deepEqual(evaluate(),packet,'source debit, destination credit and jets reconstruct the same frozen packet');
  // Independent rational prefix reference for every admitted heat/fuel packet.
  if(packet.amount) {
    const prefix=q.slice(0,face).reduce((sum,_,f)=>sum+rawFace(f),0);
    assert.equal(packet.heat,share(source.energy,prefix,packet.amount,fill));
    assert.equal(packet.fuel,Number(share(source.core.payload,prefix,packet.amount,fill)));
  }
  assert(fill-packet.amount>=0);
  return {packet,raw:rawFace(face)};
}
for(const dstFill of [0,FULL,MAX_FILL-120,MAX_FILL-18,MAX_FILL-12,MAX_FILL-6,MAX_FILL-1,MAX_FILL,MAX_FILL+1]) {
  let inbound=0;
  for(let face=0;face<6;face++) {
    // Largest complete weight on each orientation. 1 vs .99951171875 floors
    // to zero under K: the tail exceeds faceFlux's cap for room=12.
    const q=Array(6).fill(half(0x3bff));q[face]=1;
    const r=admitted(q,5,dstFill,face);inbound+=r.packet.amount;
    if(dstFill===MAX_FILL-12) {assert.equal(r.raw,5);assert.equal(r.packet.amount,0);}
  }
  if(dstFill<=MAX_FILL)assert(dstFill+inbound<=MAX_FILL);
}
// Six admitted largest-face tails exactly consume headroom at the boundary.
// Every packet <= floor(room/6) => summed ingress <= room for ANY gravity;
// outgoing packets only increase room. No final fill clamp is involved.
{
  let ingress=0;
  for(let face=0;face<6;face++) {
    const q=Array(6).fill(half(0x3dff));q[face]=1.5;
    const {packet,raw}=admitted(q,8,MAX_FILL-18,face);
    assert.equal(raw,3);assert.equal(packet.amount,3);ingress+=packet.amount;
    assert.equal(admitted(q,8,MAX_FILL-17,face).packet.amount,0);
  }
  assert.equal(MAX_FILL-18+ingress,MAX_FILL);
}
// Simultaneous source/destination ledgers use frozen receiver fill, not a
// sequentially depleted headroom. Accepted/rejected packets coexist.
for(const dstFill of [FULL,MAX_FILL-18,MAX_FILL-12,MAX_FILL]) {
  const packets=Array.from({length:6},(_,face)=>admitted([.5,1.5,2.5,3.5,4.5,5.5],18,dstFill,face).packet);
  const sourceEnergy=-2147483648n,sourceFuel=12345;
  const afterEnergy=packets.map(p=>sourceEnergy-p.heat),afterFuel=packets.map(p=>sourceFuel-p.fuel);
  const receiverEnergy=packets.reduce((s,p)=>s+p.heat,0n),receiverFuel=packets.reduce((s,p)=>s+p.fuel,0);
  assert.equal(afterEnergy.reduce((a,b)=>a+b,0n)+receiverEnergy,6n*sourceEnergy);
  assert.equal(afterFuel.reduce((a,b)=>a+b,0)+receiverFuel,6*sourceFuel);
  assert(dstFill+packets.reduce((s,p)=>s+p.amount,0)<=MAX_FILL);
}
// Ordinary full-K packets far from MAX_FILL stay byte-for-byte unchanged.
for(const q of [.5,1.5,43008]) {
  const r=admitted([q,0,0,0,0,0],FULL,0,0,true);
  assert.equal(r.packet.amount,Math.floor(q));
}
console.log(`${fluxCases} actual faceFlux signed/cap cases; ${admissions} canonical headroom admissions, six simultaneous inbound/tail/MAX/above-MAX cases; exact signed heat/fuel ledgers`);

// Validate the actual generated shaders, not a standalone substitute helper.
const minified=await importMinified('src/shaders/v2.js');
assert.equal(minified.v2LimitWGSL(g),shader,'minification preserves full limiter');
assert.equal(minified.v2GatherWGSL(g),v2GatherWGSL(g),'minification preserves full gather');
for(const [name,code] of [['limit',shader],['gather',v2GatherWGSL(g)]]) {
  assert.deepEqual(wgslGroupingErrors(code),[]);
  assertNaga(code,name);
}
console.log(`${comparisons} emitted-WGSL/BigInt half checks; ${sixways} randomized six-way f32 limits; max tail ${maxTail} (analytic <${tailBound.toFixed(3)}); complete-weight ordering, signed ownership, packet telescoping and Naga passed; no GPU`);
