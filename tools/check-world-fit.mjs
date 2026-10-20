// CPU only: every World map's world fits the WORLD renderer at WebGPU's default limits.
// A world the renderer can't hold never draws, so its loading screen would wait forever
// (2026-10-20: Descent's 4128-wide ring overflowed the 128 MiB world book). This builds the
// same WorldRenderAtlas installWorldRender builds (src/wire/worldRender.js), on a device
// double that allocates nothing, plus the Sun book's tiles across the day.
// Run: node tools/check-world-fit.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { WorldRenderAtlas, DEFAULT_WORLD_LIMITS } from '../src/world/renderAtlas.js';
import { worldFeedbackExtraWords } from '../src/wire/worldRender.js';
import { worldSunProjection, WORLD_SUN_BOOK_WORDS } from '../src/world/worldSun.js';
import { WORLD_SCENES } from '../src/world/scenes/index.js';
import { WORLD_SIZE } from '../src/shaders/farShared.js';

const MIB = 1024 ** 2;
// worldSunLighting.js: the Sun book is one binding, capped at the default 128 MiB.
const SUN_BINDING = Math.min(128 * MIB, DEFAULT_WORLD_LIMITS.maxStorageBufferBindingSize);
// Sun directions across a day: noon, low morning/evening light from each side, and a grazing sun
// (the projection is widest when the sun is low; tools/world-backend-cpu-check.mjs uses [1,.01,0]).
const SUN_DIRECTIONS = [[0, 1, 0], [1, .01, 0], [0, .01, 1], [1, .01, 1], [-1, .2, .5], [.7, .7, 0]];

function deviceDouble() {
  const limits = { ...DEFAULT_WORLD_LIMITS };
  const sized = (what, bytes) => assert.ok(bytes <= limits.maxBufferSize, `${what} ${bytes} B over maxBufferSize`);
  const device = {
    limits,
    createBuffer(d) { sized(`buffer ${d.label ?? ''}`, d.size); return { ...d, destroy() {} }; },
    createTexture(d) { return { ...d, createView: (v) => ({ texture: d, ...v }), destroy() {} }; },
    createCommandEncoder() { return { copyTextureToTexture() {}, copyBufferToBuffer() {}, finish: () => [] }; },
    queue: { writeBuffer() {}, writeTexture() {}, submit() {}, onSubmittedWorkDone: () => Promise.resolve() },
  };
  return { device };
}

// Every World world: the registered scenes (a scene without its own size uses World's) and
// the converted source levels, whose manifests carry their size (world/import/localMap.js).
const worlds = new Map();
const add = (size, key) => { const k = size.join('×'); if (!worlds.has(k)) worlds.set(k, { size, keys: [] }); worlds.get(k).keys.push(key); };
for (const scene of WORLD_SCENES) add([...(scene.size ?? WORLD_SIZE)], scene.key);
const LOCAL = new URL('../public/local-maps/', import.meta.url);
for (const file of readdirSync(LOCAL).filter((f) => f.endsWith('.json'))) {
  const manifest = JSON.parse(readFileSync(new URL(file, LOCAL)));
  if (Array.isArray(manifest.size)) add(manifest.size, manifest.id ?? file);
}

const failures = [];
for (const { size, keys } of worlds.values()) {
  const name = `${size.join('×')} (${keys.length > 3 ? `${keys.slice(0, 3).join(', ')} and ${keys.length - 3} more` : keys.join(', ')})`;
  try {
    const atlas = new WorldRenderAtlas(deviceDouble(), { worldSize: size, feedbackExtraWords: worldFeedbackExtraWords(size) });
    for (const direction of SUN_DIRECTIONS) {
      const { tiles } = worldSunProjection(size, direction);
      assert.ok(tiles[2] * tiles[3] * WORLD_SUN_BOOK_WORDS * 4 <= SUN_BINDING, `Sun book over its binding for sun ${direction}`);
    }
    console.log(`ok ${name}: world book ${(atlas.bookLayout.bytes / MIB).toFixed(1)} of ${128} MiB`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}
assert.deepEqual(failures, [], `World maps the WORLD renderer can't hold (they would never finish loading):\n${failures.join('\n')}`);
console.log(`PASS ${worlds.size} World world sizes fit the WORLD renderer at default WebGPU limits`);
