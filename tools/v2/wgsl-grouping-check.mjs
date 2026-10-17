// CPU-only negative controls for Chromium-compatible expression grouping and
// the shared Naga helper every native WGSL check relies on.
import assert from 'node:assert/strict';
import { wgslGroupingErrors, nagaErrors, assertNaga } from './wgsl-grouping.mjs';

const shader=expression=>`fn f(a:u32,b:u32,c:u32)->u32 { return ${expression}; }`;
for(const expression of ['a*b ^ c','a ^ b*c','a | b<<c','a & b+c','a ^ b|c']) {
  assert.ok(wgslGroupingErrors(shader(expression)).length,expression);
}
for(const expression of ['(a*b) ^ c','a ^ (b*c)','a | (b<<c)','a & (b+c)','a ^ (b|c)',
  '(a ^ b)*c','a+b*c','a ^ b ^ c','(a>>b) & c']) {
  assert.deepEqual(wgslGroupingErrors(shader(expression)),[],expression);
}
assert.ok(wgslGroupingErrors('fn f(a:u32,b:u32)->bool { return a & b == 0u; }').length);
assert.deepEqual(wgslGroupingErrors('fn f(a:u32,b:u32)->bool { return (a & b) == 0u; }'),[]);
assert.equal(nagaErrors('fn f(a:u32)->u32 { return a; }'),'');
assert.match(nagaErrors('fn f(a:u32)->u32 { return b; }'),/\S/,'Naga rejects an unknown identifier');
assert.throws(()=>assertNaga('fn f()->u32 { }','missing return'),/missing return/);
console.log('WGSL grouping and Naga negative controls passed; CPU only');
