// CPU-only Naga validation of the actual smooth renderer, not a foam stub.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gridLayout } from '../../src/sim.js';
import { volumeFrag } from '../../src/shaders/render.js';
import { allDetailDefines, detailDefines, detailDefaults } from '../../src/gfx/detail.js';
import { liquidDetailGLSL } from '../../src/shaders/gfx/liquidDetail.js';

test('compact high-byte foam is independent of legacy Whitewater; v1 eligibility is unchanged',()=>{
  for(const enabled of [false,true]) {
    const source=liquidDetailGLSL({DETAIL_LIQ_FOAM:+enabled});
    assert.match(source,/f32\(core.x >> 24u\) \/ 255.0/);
    assert.match(source,/KIND\(i32\(core.x & 255u\)\) != K_LIQUID/);
    assert.match(source,/SURFCH\(id\) == CH_LIQUID && id != E_ICE/,'legacy ripple/meniscus eligibility');
    assert.ok(source.includes(`H.format == 2u || H.format == 3u || ${enabled}`));
    assert.match(source,/let w = aeration\[gAerCopy \* SLOTS \+ slotOf\(c\)\]/,'legacy field remains intact');
    assert.doesNotMatch(source,/fn liquidCapillary|fn liquidMeniscus/,'disabled legacy quality switches stay disabled');
  }
});

test('actual realistic renderer compiles both liquid channels at off/default/full/curved quality',()=>{
  const dir=mkdtempSync(join(tmpdir(),'native-foam-render-'));
  const variants=[['off',{},false],['default',detailDefines(detailDefaults()),false],['full',allDetailDefines(),false],['curved',{},true]];
  try {
    for(const dims of [[32,32,32],[48,16,32]]) for(const [name,detail,curved] of variants) {
      const source=volumeFrag(gridLayout(...dims),{detail,curved});
      assert.match(source,/n = liquidDetail\(hp, n, lid, &col, &trans\)/,'CH_LIQUID smooth interface');
      assert.match(source,/s.ch == CH_MOLTEN && KIND\(s.id\) == K_LIQUID/,'native molten only');
      assert.match(source,/c = shadeSurf\(s, shadeRd\)/,'base material optics retained');
      assert.match(source,/foamTrans \* \(c - s.emit\) \+ s.emit/,'incandescence retained');
      assert.match(source,/f32\(core.x >> 24u\) \/ 255.0/,'no legacy foam conversion');
      const path=join(dir,`${name}-${dims.join('x')}.wgsl`);writeFileSync(path,source);
      const result=spawnSync('naga',[path],{encoding:'utf8'});
      assert.equal(result.status,0,`${name}: ${result.error??result.stderr}`);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
