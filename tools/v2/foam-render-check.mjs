// CPU-only Naga validation of the actual smooth renderer, not a foam stub.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gridLayout } from '../../src/sim.js';
import { volumeFrag } from '../../src/shaders/render.js';
import { allDetailDefines, detailDefines, detailDefaults } from '../../src/gfx/detail.js';
import { liquidDetailGLSL, WORLD_NATIVE } from '../../src/shaders/gfx/liquidDetail.js';
import { nativeAirWGSL } from '../../src/shaders/renderSource.js';
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

test('WORLD under V2 draws the same foam and air: its programs compile the foam and the molten layer, its source carries V2 air',()=>{
  const g={nx:3072,ny:128,nz:1024,sourceAppearance:false,sourceGrid:[128,0,128]}, molten=/if \(stop && true && hitK == HIT_SMOOTH && s.ch == CH_MOLTEN && KIND\(s.id\) == K_LIQUID\)/;
  for(const enabled of [false,true]) {
    const v1=volumeFrag(g,{backend:'world',detail:{DETAIL_LIQ_FOAM:+enabled}});
    const v2=volumeFrag(g,{backend:'world',detail:{DETAIL_LIQ_FOAM:+enabled,[WORLD_NATIVE]:true}});
    assert.equal(/fn liquidFoam\(/.test(v1),enabled,'V1 World foam stays behind Whitewater');
    assert.doesNotMatch(v1,/s.ch == CH_MOLTEN/,'V1 has no molten foam');
    assert.match(v2,/let f = worldAeration\(c\);/,'World reads its atlas');
    assert.match(v2,/liquidFoam\(hp, &n, id, col, trans\);/,'liquid surfaces foam');
    assert.match(v2,molten,'molten liquids foam, without a format test');
    assert.match(v2,/foamTrans \* \(c - s.emit\) \+ s.emit/,'incandescence retained');
    assertNaga(v2,`world v2 whitewater ${enabled}`);
  }
  // (its foam: v2/nativeAeration.js, tools/v2/world-native-foam-check.mjs)
  const air=nativeAirWGSL(gridLayout(32,32,32));
  // V1's B as V2 holds it: a grain's fall and a liquid's flux in their cells, the air elsewhere (shaders/v2/viewRead.js)
  assert.match(air,/airB\[s\] = nativeMotionB\(A\[s\], fetchBs\(s\)\);/);
  assert.match(air,/let air = B\[\(s >> 6u\) \* 2u\];/,'coarse air in V1 units, as the Box Pressure/Flow views read it');
  assertNaga(air,'world v2 air export');
});
