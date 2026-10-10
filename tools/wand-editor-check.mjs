// Own strict-port server, real app, native dialog and keyboard checks.
// node tools/wand-editor-check.mjs [--port 5297] [--shots /tmp/wand-editor]
import assert from 'node:assert/strict';
import { access, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const option = (key, fallback) => {
  const i = process.argv.indexOf(`--${key}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const port = option('port', '5297');
const shots = option('shots', '/tmp/wand-editor');
for (const file of ['catalog', 'compiler', 'runtime', 'world']) {
  await access(`src/pov/wands/${file}.js`).catch(() => { throw new Error(`Integration pending: src/pov/wands/${file}.js is not present. No mocks substitute for the app.`); });
}
await mkdir(shots, { recursive: true });
let browser;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', port, '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (s) => { serverLog += s; });
server.stderr.on('data', (s) => { serverLog += s; });
const url = `http://127.0.0.1:${port}`;
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Dev server exited: ${serverLog}`);
    // Wait for our own Vite startup, never attach to another process on the port.
    if (serverLog.includes(url)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!serverLog.includes(url)) throw new Error(`Dev server did not start: ${serverLog}`);
  browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('powder-toy-3d:settings', JSON.stringify({ autoRes: false, res: 0.5, liveTiles: false }));
    if (!localStorage.getItem('tpt3d.wand.v1')) localStorage.setItem('tpt3d.wand.v1', '{broken JSON');
  });
  await page.goto(`${url}/?preset=empty&size=64`);
  await page.waitForFunction(() => window.__app?.pov, null, { timeout: 45000 });
  const data = await page.evaluate(async () => {
    const { PRESETS, SPELLS } = await import('/src/pov/wands/catalog.js');
    const { WAND_STARTERS, PALETTE } = await import('/src/elements.js');
    return { presets: PRESETS.map((p) => ({ id: p.id, cards: p.cards })), spellCount: SPELLS.length,
      starterCount: WAND_STARTERS.length, starterIds: WAND_STARTERS.map((s) => s.id),
      tools: PALETTE.find((p) => p.name === 'Tools').items };
  });
  assert(data.starterCount > 0 && data.starterCount <= 20);
  assert(data.starterIds.every((id) => id <= -20 && id >= -39));
  assert(data.tools.filter((key) => key.startsWith('WAND_')).length === data.starterCount);
  const paintBefore = await page.evaluate(() => window.__app.settings.tool);
  await page.evaluate(() => window.__app.selectTool(-20));
  await page.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 45000 });
  assert.equal(await page.evaluate(() => window.__app.settings.tool), paintBefore, 'starter must not become paint tool');
  assert.equal(await page.evaluate(() => window.__app.pov.toolbelt.selectedKey), 'WAND');
  assert.equal(await page.locator('.hb-slot').count(), 10);
  for (const [i, key] of ['SHOVEL', 'BUCKET', 'AXE', 'GUN', 'PHYSGUN', 'TROWEL', 'SCANNER', 'BLOWTORCH', 'BOMB', 'PICKAXE'].entries()) {
    await page.keyboard.press(String((i + 1) % 10));
    assert.equal(await page.evaluate(() => window.__app.pov.toolbelt.selectedKey), key);
  }
  const ticks = await page.evaluate(async () => {
    const runtime = window.__app.pov.wandRuntime;
    const original = runtime.tick;
    let n = 0;
    runtime.tick = (ctx) => { n++; return original(ctx); };
    try { await new Promise((r) => setTimeout(r, 300)); return n; }
    finally { runtime.tick = original; }
  });
  assert(ticks > 0, 'wand runtime must tick while an old tool is selected');

  await page.getByRole('button', { name: 'Edit wand', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit wand' });
  await dialog.waitFor();
  assert.equal(await page.locator('.we-library li').count(), data.spellCount);
  assert.equal(await page.evaluate(() => document.pointerLockElement), null);
  for (const p of data.presets) {
    await page.getByLabel('Wand recipe').selectOption(p.id);
    assert.equal(await page.locator('.we-deck > li').count(), p.cards.length);
    assert.equal(await page.getByRole('button', { name: 'Save & equip' }).isDisabled(), false, p.id);
  }
  await page.getByLabel('Search spells').fill('no spell has this name');
  assert.match(await page.locator('.we-library').innerText(), /No spells match/);
  await page.getByLabel('Search spells').fill('');
  await page.getByRole('button', { name: 'Clear deck' }).click();
  assert.equal(await page.getByRole('button', { name: 'Save & equip' }).isDisabled(), true);
  assert.match(await page.locator('.we-preview').innerText(), /No cast yet/);
  await page.getByLabel('Wand recipe').selectOption(data.presets[0].id);
  await page.locator('.we-library button').first().click();
  assert.equal(await page.locator('.we-deck > li').count(), data.presets[0].cards.length + 1);
  const last = page.locator('.we-deck > li').last();
  await last.getByRole('button', { name: /Remove/ }).click();
  if (data.presets[0].cards.length > 1) {
    const before = await page.locator('.we-deck > li > span').allTextContents();
    await page.locator('.we-deck > li').first().getByRole('button', { name: /down/ }).click();
    const after = await page.locator('.we-deck > li > span').allTextContents();
    assert.equal(after[1], before[0]);
    await page.locator('.we-deck > li').nth(1).getByRole('button', { name: /up/ }).click();
  }
  await page.getByLabel('Max mana', { exact: true }).fill('');
  assert.equal(await page.getByRole('button', { name: 'Save & equip' }).isDisabled(), true);
  await page.getByLabel('Wand recipe').selectOption(data.presets[0].id);
  const stateBefore = await page.evaluate(() => ({ mode: window.__app.pov.mode, slot: window.__app.pov.toolbelt.selected,
    paused: window.__app.settings.paused, third: window.__app.pov.camera.third }));
  await page.locator('.we-deck-heading button').focus();
  await page.keyboard.press('f'); await page.keyboard.press('4'); await page.keyboard.press('v');
  await page.keyboard.down('w'); await page.keyboard.press('Space'); await page.waitForTimeout(100); await page.keyboard.up('w');
  const stateAfter = await page.evaluate(() => ({ mode: window.__app.pov.mode, slot: window.__app.pov.toolbelt.selected,
    paused: window.__app.settings.paused, third: window.__app.pov.camera.third }));
  assert.deepEqual(stateAfter, stateBefore, 'modal must block global game hotkeys');
  assert.equal(await page.evaluate(() => window.__app.pov.ctx.primary), false);
  await page.getByLabel('Wand recipe').selectOption(data.presets[0].id);
  await page.getByLabel('Wand name').fill('UI check wand');
  await page.screenshot({ path: `${shots}/desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'mobile dialog has no horizontal overflow');
  await page.screenshot({ path: `${shots}/mobile.png` });
  await page.getByRole('button', { name: 'Save & equip' }).click();
  assert.equal(await page.evaluate(() => window.__app.pov.wandRuntime.definition.name), 'UI check wand');
  assert.equal(await page.evaluate(() => window.__app.pov.ctx.primary), false, 'closing must not shoot');
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('tpt3d.wand.v1')));
  assert.equal(persisted.name, 'UI check wand');
  await page.keyboard.press('b');
  await dialog.waitFor();
  await page.getByLabel('Wand name').fill('Cancelled change');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__app.pov.wandRuntime.definition.name), 'UI check wand');
  const teleport = await page.evaluate(() => {
    const p = window.__app.pov.player;
    p.hurt(10, 'check'); p.jetFuel = 0.37;
    const health = p.health, breath = p.breath;
    const feet = p.pos.clone().addScalar(1);
    const ok = p.teleport(feet);
    return { ok, health: p.health === health, breath: p.breath === breath, fuel: p.jetFuel,
      moved: p.pos.equals(feet), contacts: !p.onGround && !p.inLiquid && !p.headInLiquid };
  });
  assert.deepEqual(teleport, { ok: true, health: true, breath: true, fuel: 0.37, moved: true, contacts: true });
  await page.reload();
  await page.waitForFunction(() => window.__app?.pov, null, { timeout: 45000 });
  await page.evaluate(() => window.__app.pov.enter());
  await page.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 45000 });
  await page.evaluate(() => window.__app.pov.openWandEditor());
  await page.getByLabel('Wand recipe').selectOption('saved');
  assert.equal(await page.getByLabel('Wand name').inputValue(), 'UI check wand');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, [], 'browser errors (includes GPU shader errors)');
  console.log(`PASS: ${data.presets.length} recipes, ${data.spellCount} spells, ten old slots, modal guards, editing/persistence, runtime ticking, teleport vitals, desktop/mobile layout. Screenshots: ${shots}`);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  if (server.exitCode === null) await new Promise((resolve) => server.once('exit', resolve));
}
