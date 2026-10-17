// CPU-only production/minification regression. No browser or GPU.
import assert from 'node:assert/strict';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { contactPrelude, contactEntry } from './contact-prelude.mjs';
import { wgslGroupingErrors, assertNaga, importMinified } from './wgsl-grouping.mjs';
// Chromium's WGSL parser rejects ungrouped arithmetic mixed with XOR, even
// though Naga accepts it. Check the real emitted seed expression before bundling.
const seedExpression=contactWGSL.match(/fn ctSeed[^]*?return bitcast<i32>\(([^;]+)\);/)[1];
assert.deepEqual(seedExpression.split(' ^ '),[
  '(u32(position.x)*73856093u)','(u32(position.y)*19349663u)',
  '(u32(position.z)*83492791u)','(tick*2654435761u)',
]);
const minified = await importMinified('src/shaders/v2/contact.js');
assert.equal(minified.contactWGSL, contactWGSL, 'minification cannot change generated WGSL');
const source=contactPrelude + minified.contactWGSL + contactEntry;
assert.deepEqual(wgslGroupingErrors(source),[],'production contact mixed operators require grouping');
assertNaga(source, 'contact');
console.log('Production minified native contact bundle: identical WGSL; Naga valid; no GPU');
