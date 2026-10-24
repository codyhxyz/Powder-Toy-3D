// CPU-only Naga validation of the actual smooth renderer, not a foam stub.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gridLayout } from '../../src/sim.js';
import { volumeFrag } from '../../src/shaders/render.js';
import { allDetailDefines, detailDefines, detailDefaults } from '../../src/gfx/detail.js';
import { liquidDetailGLSL } from '../../src/shaders/gfx/liquidDetail.js';
import { nativePackWGSL } from '../../src/shaders/renderSource.js';
import { assertNaga } from './wgsl-grouping.mjs';

test('compact high-byte foam is independent of legacy Whitewater; v1 eligibility is unchanged',()=>{
  for(const enabled of [false,true]) {
    const source=liquidDetailGLSL({DETAIL_LIQ_FOAM:+enabled});
    assert.match(source,/return fetchNativeAeration\(c\)/);
    assert.doesNotMatch(source,/\bA\s*\[/,'raw state reads stay in checked accessors');
    const integrated=volumeFrag(gridLayout(32,32,32),{detail:{DETAIL_LIQ_FOAM:+enabled}});
    assert.match(integrated,/f32\(core.x >> 24u\) \/ 255.0/);
    assert.match(integrated,/KIND\(i32\(core.x & 255u\)\) != K_LIQUID/);
    assert.match(source,/SURFCH\(id\) == CH_LIQUID && id != E_ICE/,'legacy ripple/meniscus eligibility');
    assert.ok(source.includes(`H.format == 2u || H.format == 3u || ${enabled}`));
    assert.match(source,/let w = aeration\[gAerCopy \* SLOTS \+ slotOf\(c\)\]/,'legacy field remains intact');
    assert.doesNotMatch(source,/fn liquidCapillary|fn liquidMeniscus/,'disabled legacy quality switches stay disabled');
  }
});

test('actual realistic renderer compiles both liquid channels at off/default/full/curved quality',()=>{
  const variants=[['off',{},false],['default',detailDefines(detailDefaults()),false],['full',allDetailDefines(),false],['curved',{},true]];
  for(const dims of [[32,32,32],[48,16,32]]) for(const [name,detail,curved] of variants) {
    const source=volumeFrag(gridLayout(...dims),{detail,curved});
    assert.match(source,/n = liquidDetail\(hp, n, lid, &col, &trans\)/,'CH_LIQUID smooth interface');
    assert.match(source,/s.ch == CH_MOLTEN && KIND\(s.id\) == K_LIQUID/,'native molten only');
    assert.match(source,/c = shadeHit\(s, shadeRd, floorLit, floorHp, floorFw\)/,'base material optics retained (shadeSurf\'s, through the hit or floor\'s one shadeHit)');
    assert.match(source,/foamTrans \* \(c - s.emit\) \+ s.emit/,'incandescence retained');
    assert.match(source,/f32\(core.x >> 24u\) \/ 255.0/,'no legacy foam conversion');
    assertNaga(source,name);
  }
});

test('the big-map source pack carries V2 air',()=>{
  const pack=nativePackWGSL(gridLayout(32,32,32));
  // V1's B as V2 holds it: a grain's fall and a liquid's flux in their cells, the air elsewhere (shaders/v2/viewRead.js)
  assert.match(pack,/nativeMotionB\(core, nativeAirB\(s\)\)/);
  assert.match(pack,/fn nativeAirB\(s: u32\) -> vec4f \{\n  let air = fetchNativeAirS\(s\);/,'coarse air in V1 units, as the Box Pressure/Flow views read it');
  assertNaga(pack,'world v2 source pack');
});
