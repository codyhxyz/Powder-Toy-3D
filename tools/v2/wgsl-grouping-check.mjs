// CPU-only negative controls for Chromium-compatible expression grouping.
import assert from 'node:assert/strict';
import { wgslGroupingErrors } from './wgsl-grouping.mjs';

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
console.log('WGSL grouping negative controls passed; CPU only');
