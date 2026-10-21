// CPU only: compile the exact modules built by the production producer driver.
import assert from 'node:assert/strict';
import { gridLayout } from '../../src/sim.js';
import { nativeWeatherParams, nativeWeatherEvaluateWGSL, nativeWeatherCommitWGSL } from '../../src/v2/nativeWeather.js';
import { waveDemoEdit } from '../../src/world/waveDemo.js';
import { WeatherParams, weatherUpdateWGSL, weatherDeclsWGSL, WEATHER_SOURCE_LAYOUT } from '../../src/shaders/elementWeather.js';
import { BoltParams, boltUpdateWGSL, boltDeclsWGSL } from '../../src/shaders/lightning.js';
import { assertNaga } from './wgsl-grouping.mjs';
export const specs = {
 wave: waveDemoEdit,
 weather: { nativePrecipitation:true, params:WeatherParams, update:weatherUpdateWGSL, decls:weatherDeclsWGSL, layout:WEATHER_SOURCE_LAYOUT },
 bolt: { params:BoltParams, update:boltUpdateWGSL, decls:boltDeclsWGSL },
};
let count=0;
for(const dims of [[32,32,32],[48,16,32]]) for(const [name,spec] of Object.entries(specs)) {
 const g=gridLayout(...dims), params=nativeWeatherParams(name,spec);
 for(const stage of ['evaluate','material','air','sourcePlan']) {
  const code=stage==='evaluate'?nativeWeatherEvaluateWGSL(g,spec,params):nativeWeatherCommitWGSL(g,params,stage);
  assert.ok([...code.matchAll(/var<storage,/g)].length<=8,`${name}/${stage} storage budget`);
  assertNaga(code,`${name}/${stage}`); count++;
 }
}
console.log(`${count} generated native weather/wave/lightning modules validated; <=8 storage bindings; no GPU`);
