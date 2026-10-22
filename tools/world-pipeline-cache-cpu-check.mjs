// CPU-only: World lighting producers build their pipelines once per device and grid
// (gfx/pipelineCache.js). Each lighting transaction made new producers, and with them
// new shader modules and pipelines; a rebuild froze Descent for 11.6 s (real Chrome, 2026-10-22).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cachedPipelines } from '../src/gfx/pipelineCache.js';

test('one build per device and key; a failed build is retried; devices never share', async () => {
  const a = {}, b = {};let builds = 0;
  const build = () => { builds++; return { ready: Promise.resolve('pipe') }; };
  const first = cachedPipelines(a, 'k', build);
  assert.equal(cachedPipelines(a, 'k', build), first);assert.equal(builds, 1);
  cachedPipelines(b, 'k', build);cachedPipelines(a, 'other', build);assert.equal(builds, 3);
  let fail = true;
  const flaky = () => { builds++; return { ready: fail ? Promise.reject(new Error('lost')) : Promise.resolve('ok') }; };
  const bad = cachedPipelines(a, 'flaky', flaky);await bad.ready.catch(() => {});await new Promise(r => setImmediate(r));
  fail = false;const good = cachedPipelines(a, 'flaky', flaky);
  assert.notEqual(good, bad);assert.equal(await good.ready, 'ok');
});

test('GI, glow and sun producers take their pipelines from the cache', () => {
  for (const file of ['worldGI.js', 'worldGlow.js', 'worldSunLighting.js']) {
    const src = readFileSync(new URL(`../src/gfx/${file}`, import.meta.url), 'utf8');
    assert.match(src, /cachedPipelines\(device,/, `${file} builds its pipelines through cachedPipelines`);
  }
});
