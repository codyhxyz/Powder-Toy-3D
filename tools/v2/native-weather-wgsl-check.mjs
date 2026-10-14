// CPU only: compile the exact modules built by the production producer driver.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gridLayout } from '../../src/sim.js';
import { nativeWeatherParams, nativeWeatherEvaluateWGSL, nativeWeatherCommitWGSL } from '../../src/v2/nativeWeather.js';
import { oceanEventsEdit } from '../../src/shaders/oceanEvents.js';
import { WeatherParams, weatherUpdateWGSL, weatherDeclsWGSL, WEATHER_SOURCE_LAYOUT } from '../../src/shaders/elementWeather.js';
import { BoltParams, boltUpdateWGSL, boltDeclsWGSL } from '../../src/shaders/lightning.js';
export const specs = {
 ocean: oceanEventsEdit,
 weather: { nativePrecipitation:true, params:WeatherParams, update:weatherUpdateWGSL, decls:weatherDeclsWGSL, layout:WEATHER_SOURCE_LAYOUT },
 bolt: { params:BoltParams, update:boltUpdateWGSL, decls:boltDeclsWGSL },
};
const dir=mkdtempSync(join(tmpdir(),'native-weather-')); let count=0;
try {
 for(const dims of [[32,32,32],[48,16,32]]) for(const [name,spec] of Object.entries(specs)) {
  const g=gridLayout(...dims), params=nativeWeatherParams(name,spec);
  for(const stage of ['evaluate','material','air','sourcePlan']) {
   const code=stage==='evaluate'?nativeWeatherEvaluateWGSL(g,spec,params):nativeWeatherCommitWGSL(g,params,stage);
   assert.ok([...code.matchAll(/var<storage,/g)].length<=8,`${name}/${stage} storage budget`);
   const path=join(dir,`${name}-${stage}.wgsl`); writeFileSync(path,code);
   const result=spawnSync('naga',[path],{encoding:'utf8'});
   assert.equal(result.status,0,`${name}/${stage}: ${result.error??result.stderr}`); count++;
  }
 }
 console.log(`${count} generated native weather/ocean/lightning modules validated; <=8 storage bindings; no GPU`);
} finally { rmSync(dir,{recursive:true,force:true}); }
