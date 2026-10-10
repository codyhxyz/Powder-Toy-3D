// Every headless test launches its browser through tools/browser.mjs (launchBrowser,
// newTestPage, newTestContext), which picks a GPU-cheap test mode and closes the
// browser on failure (CLAUDE.md, "Headless GPU budget"; docs/headless-testing-cost.md).
// The deploy runs this check, so a new script that launches Chromium itself can't ship.
//
// LEGACY lists the scripts that predate the rule. Move one onto tools/browser.mjs and
// delete it from the list; never add to it.
//
// usage: node tools/check-browser-launch.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['tools', 'scripts'];
const HELPER = 'tools/browser.mjs';
// a direct launch: Playwright's chromium, firefox or webkit calling launch, launchPersistentContext or launchServer
const DIRECT = /\b(chromium|firefox|webkit)\s*\.\s*(launch|launchPersistentContext|launchServer)\s*\(/;

const LEGACY = new Set([
  'tools/arena-check.mjs', 'tools/bench.mjs', 'tools/birds-shots.mjs', 'tools/burrower-laser-check.mjs',
  'tools/cave-refl-check.mjs', 'tools/caves-check.mjs', 'tools/classes-check.mjs', 'tools/combat-check.mjs',
  'tools/creatures-check.mjs', 'tools/crystal-check.mjs', 'tools/dock-check.mjs', 'tools/elec-gpu-check.mjs',
  'tools/elements-gpu-check.mjs', 'tools/far-regress.mjs', 'tools/flask-check.mjs', 'tools/gibs-check.mjs',
  'tools/headless-cost.mjs', 'tools/island-dump.mjs', 'tools/keys-check.mjs', 'tools/kick-hook-check.mjs',
  'tools/landforms-gpu.mjs', 'tools/lights-check.mjs', 'tools/map-thumbs.mjs', 'tools/menu-check.mjs',
  'tools/modes-check.mjs', 'tools/nt-mat-gpu.mjs', 'tools/perks-check.mjs', 'tools/rays-gpu.mjs',
  'tools/rock-check.mjs', 'tools/scene-check.mjs', 'tools/status-check.mjs', 'tools/structures-check.mjs',
  'tools/tool-selection-check.mjs', 'tools/topbar-check.mjs', 'tools/torch-look.mjs', 'tools/vehicles-check.mjs',
  'tools/weapons-check.mjs', 'tools/world-load-time.mjs',
]);

const offenders = [], migrated = [];
for (const dir of DIRS) {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (!/\.(mjs|js|cjs)$/.test(name)) continue;
    const rel = `${dir}/${name}`;
    if (rel === HELPER) continue;
    const direct = DIRECT.test(readFileSync(join(ROOT, rel), 'utf8'));
    if (direct && !LEGACY.has(rel)) offenders.push(rel);
    if (!direct && LEGACY.has(rel)) migrated.push(rel);
  }
}
for (const rel of migrated) console.log(`note: ${rel} no longer launches a browser itself; delete it from LEGACY`);
if (offenders.length) {
  console.error(`These launch a browser directly. Use launchBrowser and newTestPage from ${HELPER} (CLAUDE.md, "Headless GPU budget"):`);
  for (const rel of offenders) console.error(`  ${rel}`);
  process.exit(1);
}
console.log(`browser launches OK: new scripts use ${HELPER} (${LEGACY.size - migrated.length} legacy left to migrate)`);
