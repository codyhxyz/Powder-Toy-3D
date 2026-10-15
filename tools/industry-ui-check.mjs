// UI-only Industry checks. The layout case seeds economy only to present locked
// catalog entries; the operations case buys native parts from the real canvas.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DEVICE_TYPES } from '../src/industry/catalog.js';
import { E } from '../src/elements.js';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const testCase = arg('case', 'layout');
if (!['layout', 'operations'].includes(testCase)) throw new Error('--case must be layout or operations');
const base = arg('url', `http://127.0.0.1:${arg('port', '19543')}/`);
const out = arg('out', '/tmp/factory-ui-review');
mkdirSync(out, { recursive: true });

// The launcher enforces the absolute 25 s slot cap and its busy-player guard.
// Keep all work inside 20 s, leaving time for explicit browser cleanup.
const workDeadline = Date.now() + 20_000;
let stage = 'browser launch';
const remaining = () => Math.max(0, workDeadline - Date.now());
async function bounded(label, fn, maxMs = 1_500) {
  stage = label;
  const ms = Math.min(maxMs, remaining());
  if (!ms) throw new Error(`Industry UI work deadline reached at ${label}`);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out at ${label} (${ms} ms)`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}
const waitFor = (page, label, predicate, argValue, maxMs = 1_200) => bounded(label, () =>
  page.waitForFunction(predicate, argValue, { polling: 50, timeout: Math.min(maxMs, remaining()) }), maxMs + 100);
const placeableTypes = Object.keys(DEVICE_TYPES).filter(type => !DEVICE_TYPES[type].factoryLegacy);
let browser, page;
const pageErrors = [], browserFailures = [];
try {
  browser = await launchBrowser({ lifetimeMs: 24_500 });
  page = await newTestPage(browser, { mode: 'ui', viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(1_000);
  page.setDefaultNavigationTimeout(3_000);
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error') browserFailures.push({ kind: 'console', message: message.text() });
  });
  page.on('requestfailed', request => browserFailures.push({ kind: 'request', url: request.url(), error: request.failure()?.errorText ?? 'failed' }));
  const url = new URL(base);
  url.pathname = '/';
  url.search = '?map=quarry&mode=factory&view=plain';
  await bounded('navigate', () => page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 3_000 }), 3_200);
  // __app is published only after the real grid/render pipelines compile.
  // Let cold startup use more of the existing work window, never a longer slot.
  await bounded('app ready', () => ready(page), 12_000);
  await bounded('fonts ready', () => page.evaluate(() => document.fonts.ready), 1_000);
  await waitFor(page, 'Factory Industry ready', () => window.__app?.current().mode === 'factory'
    && window.__app.industry?.state.progression
    && window.__app.scene.getObjectByName('Industry')?.visible, null, 4_000);
  await bounded('park and camera fixture', () => page.evaluate(() => {
    const a = window.__app;
    a.test.park();
    const w = p => new a.THREE.Vector3(...p).multiplyScalar(a.scale).add(a.volume.position);
    a.camera.position.copy(w([73, 38, 82]));
    a.controls.target.copy(w([50, 10, 53]));
    a.controls.update();
  }));

  const refresh = () => page.evaluate(() => window.__app.industry.update(0, false));
  const capture = async name => {
    await bounded(`${name}: refresh`, refresh);
    await bounded(`${name}: render`, () => render(page), 2_000);
    await bounded(`${name}: screenshot`, () => page.screenshot({ path: `${out}/${name}.png` }), 1_500);
    if (name === 'sandbox') {
      assert(await page.locator('.industry').isHidden());
      assert(await page.locator('.industry-build').isHidden());
      return;
    }
    const bounds = await bounded(`${name}: panel bounds`, () => page.locator('.industry').boundingBox());
    const viewport = page.viewportSize();
    assert(bounds && bounds.x >= -1 && bounds.y >= -1
      && bounds.x + bounds.width <= viewport.width + 1
      && bounds.y + bounds.height <= viewport.height + 1, `${name}: Industry panel must fit viewport`);
  };
  const result = { case: testCase, ok: true, pageErrors, browserFailures, fixtures: [] };

  if (testCase === 'layout') {
    const machine = type => page.locator(`[data-machine="${type}"]`);
    const unobscured = locator => locator.evaluate(el => {
      const r = el.getBoundingClientRect();
      return [[r.left + 3, r.top + 3], [r.right - 3, r.top + 3],
        [r.left + 3, r.bottom - 3], [r.right - 3, r.bottom - 3]].every(([x, y]) => el.contains(document.elementFromPoint(x, y)));
    });
    await capture('closed');
    await page.locator('.industry-build').click(); await bounded('open construction', refresh);
    assert.equal(await page.evaluate(() => window.__app.industry.building), true);
    assert.equal(await page.locator('[data-machine]').count(), placeableTypes.length, 'catalog IDs come from the real placeable catalog');
    for (const type of placeableTypes) assert.equal(await machine(type).count(), 1, `${type} is in the current catalog`);
    assert.equal(await machine('heater').count(), 0, 'legacy heater is hidden');
    await machine('belt').focus();
    const paused = await page.evaluate(() => window.__app.settings.paused);
    await page.keyboard.press('Space'); await bounded('keyboard selection refresh', refresh);
    assert.equal(await page.evaluate(() => window.__app.settings.paused), paused, 'Space activates a UI button without toggling simulation');
    assert.equal(await page.evaluate(() => window.__app.industry.state.selected), 'belt');
    const rotation = await page.evaluate(() => window.__app.industry.state.rotation);
    await page.locator('.industry [data-action="rotate"]').click(); await bounded('rotate refresh', refresh);
    assert.equal(await page.evaluate(() => window.__app.industry.state.rotation), (rotation + 1) % 4);
    await page.evaluate(() => {
      const a = window.__app;
      Object.assign(a.hover, { valid: true, face: 2, id: 1 });
      a.hover.cell.set(48, 7, 48); // Deliberately overlap the starter belt; layout-only fixture.
      a.industry.update(0, false);
    });
    assert.match(await page.locator('.industry').innerText(), /occupies|occupied/i);
    await capture('desktop');

    // Presentation-only unlock fixture: no economy seed is used in operations.
    await page.evaluate(() => {
      const a = window.__app, s = a.industry.toJSON(), p = s.progression;
      p.credits += 96; p.earned += 96; p.delivered.nuggets += 96;
      a.industry.fromJSON(s);
      a.hover.valid = false;
      a.industry.update(0, false);
    });
    result.fixtures.push('presentation-only +96-credit economy unlock for layout screenshots');
    await page.locator('.industry-build').click(); await bounded('reopen after economy fixture', refresh);
    await machine('hearth').click(); await bounded('select hearth', refresh);
    assert.equal(await page.evaluate(() => window.__app.industry.state.selected), 'hearth');
    await page.setViewportSize({ width: 740, height: 740 });
    await capture('compact');
    assert(await unobscured(page.locator('.industry [data-action="cancel"]')), 'compact Done stays reachable');
    await page.setViewportSize({ width: 390, height: 844 });
    await capture('phone');
    await machine('hearth').scrollIntoViewIfNeeded(); await machine('hearth').focus();
    assert(await unobscured(machine('hearth')), 'phone catalog can reveal every machine');
    await page.keyboard.press('Space'); await bounded('phone keyboard selection refresh', refresh);
    assert(await unobscured(machine('hearth')), 'keyboard selection must keep its focused button visible');

    await page.setViewportSize({ width: 1280, height: 800 });
    await machine('separator').click(); await bounded('separator selection refresh', refresh);
    await page.getByRole('combobox', { name: 'Separator output material' }).focus();
    await page.keyboard.press('b'); await bounded('separator typeahead refresh', refresh);
    assert.equal(await page.evaluate(() => window.__app.industry.building), true, 'native filter typeahead must not close construction');
    await page.evaluate(() => document.activeElement.blur());
    await page.evaluate(async () => {
      const a = window.__app;
      await a.setMode('sandbox'); a.industry.update(0, false);
    });
    await page.keyboard.press('b');
    assert.equal(await page.evaluate(() => window.__app.industry.building), false);
    await page.keyboard.press('Shift+b'); await bounded('sandbox hotkey refresh', refresh);
    assert.equal(await page.evaluate(() => window.__app.industry.building), false);
    assert.equal(await page.evaluate(() => window.__app.settings.paused), paused);
    await capture('sandbox');

    await page.evaluate(async () => {
      const a = window.__app;
      await a.setMode('factory');
      a.test.resume();
      await a.pov.enter({ at: new a.THREE.Vector3(48, 8, 84), swoop: 0, hint: false });
    });
    await waitFor(page, 'enter POV', () => window.__app.pov.mode === 'on', null, 2_000);
    await page.locator('.industry-build').click();
    await waitFor(page, 'open POV construction', () => window.__app.industry.building, null, 1_000);
    await page.evaluate(() => window.__app.test.park());
    await capture('pov');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__app.industry.building), false);
    assert.deepEqual(pageErrors, []);
    result.screenshots = ['closed', 'desktop', 'compact', 'phone', 'sandbox', 'pov'];
    result.fixtures.push('camera/hover overlap fixture; not physical-placement evidence');
  } else {
    // UI mode keeps physics paused. Real picking needs the normal app callbacks,
    // unlike the layout case's explicitly refreshed screenshot fixtures.
    await page.evaluate(() => {
      const a = window.__app;
      if (!a.settings.paused) throw new Error('operations fixture requires paused physics');
      a.test.resume();
    });
    const state = () => page.evaluate(() => window.__app.industry.state);
    const waitState = (label, predicate, maxMs = 1_500, argValue = null) => waitFor(page, label,
      predicate, argValue, maxMs);
    const project = cells => bounded('project real canvas aim', () => page.evaluate(targets => {
      const a = window.__app;
      return targets.map(([x, y, z]) => {
        const p = new a.THREE.Vector3(x + .5, y + .5, z + .5).multiplyScalar(a.scale)
          .add(a.volume.position).project(a.camera);
        const px = (p.x + 1) * innerWidth / 2, py = (1 - p.y) * innerHeight / 2;
        return { cell: [x, y, z], x: px, y: py,
          onCanvas: document.elementFromPoint(px, py) === a.renderer.domElement };
      });
    }, cells));
    const framePair = () => bounded('wait for normal app frames', () => page.evaluate(() => new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)))), 500);
    const occupiedCell = async cell => bounded('read one native cell', () => page.evaluate(async xyz => {
      const [a] = await window.__app.sim.readCell(...xyz);
      return Array.from(a);
    }, cell), 900);
    const canvasPointForPart = async key => {
      const { nx, ny, nz } = await page.evaluate(() => window.__app.sim.g);
      const points = [];
      for (const y of [8, 12, 16, 20]) for (const z of [64, 68, 72, 76, 80]) for (const x of [40, 44, 48, 52, 56, 60, 64]) {
        if (x < nx && y < ny && z < nz) points.push([x, y, z]);
      }
      for (const point of await project(points)) {
        if (!point.onCanvas || point.x < 380 || point.x >= 1275 || point.y < 70 || point.y >= 795) continue;
        await bounded(`move to ${key} canvas target`, () => page.mouse.move(point.x, point.y), 700);
        await framePair();
        const candidate = await page.evaluate(() => {
          const a = window.__app, s = a.industry.state;
          if (!a.hover.valid || !s.partCandidate || !s.partCandidateResult?.ok) return null;
          return { cell: [s.partCandidate.x, s.partCandidate.y, s.partCandidate.z], type: s.partCandidate.type,
            hover: [a.hover.cell.x, a.hover.cell.y, a.hover.cell.z, a.hover.face, a.hover.id] };
        });
        if (!candidate || candidate.type !== key) continue;
        const [x, y, z] = candidate.cell;
        const device = await occupiedCell(candidate.cell);
        if (Math.round(device[0]) !== E.EMPTY) continue;
        const afterRead = await page.evaluate(() => {
          const a = window.__app, s = a.industry.state;
          return { valid: a.hover.valid, part: s.part, cell: s.partCandidate && [s.partCandidate.x, s.partCandidate.y, s.partCandidate.z], result: s.partCandidateResult?.ok };
        });
        if (!afterRead.valid || afterRead.part !== key || !afterRead.result || String(afterRead.cell) !== String(candidate.cell)) continue;
        return { point, cell: [x, y, z], hover: candidate.hover };
      }
      throw new Error(`No real canvas placement target found for ${key} before the work deadline`);
    };
    const placePartThroughCanvas = async (key, threshold, spentBefore, expectedMaterial) => {
      await page.locator(`[data-part="${key}"]`).click();
      await waitState(`${key}: select through DOM`, () => window.__app.industry.state.part === key, 700);
      if (key === 'TSNS') {
        const input = page.getByRole('spinbutton', { name: 'Temperature sensor threshold in degrees Celsius' });
        await input.fill(String(threshold));
        assert.equal(await input.getAttribute('aria-invalid'), 'false');
        assert.equal((await state()).partThreshold, threshold);
        await input.fill(String(Number(await input.getAttribute('min')) - 1));
        assert.equal(await input.getAttribute('aria-invalid'), 'true');
        assert.equal((await state()).partThreshold, threshold, 'invalid threshold does not replace the bounded controller value');
        assert(await page.locator('.industry').isVisible(), 'threshold validation keeps the Factory panel visible');
        await input.fill(String(threshold));
        await page.keyboard.press('q');
        assert.equal((await state()).building, true, 'focused number input keeps Q as text input');
      }
      const aim = await canvasPointForPart(key);
      await bounded(`${key}: click actual canvas`, () => page.mouse.click(aim.point.x, aim.point.y), 700);
      const expectedSpend = spentBefore + (key === 'TSNS' ? 3 : 2);
      await waitState(`${key}: confirmed purchase`, expected => {
        const s = window.__app.industry.state;
        return !s.pending && s.progression?.partsSpent === expected;
      }, 2_500, expectedSpend);
      const native = await occupiedCell(aim.cell);
      assert.equal(Math.round(native[0]), expectedMaterial, `${key}: clicked cell contains the native material`);
      if (key === 'TSNS') assert.ok(Math.abs(native[1] - threshold) < .01, 'native TSNS cell stores the bounded threshold');
      const economy = await page.evaluate(() => window.__app.industry.state.progression);
      assert.equal(economy.partsSpent, expectedSpend, `${key}: confirmed paid ledger`);
      assert.equal(economy.credits, 24 - economy.partsSpent, `${key}: initial Factory credit debit`);
      return { cell: aim.cell, threshold: key === 'TSNS' ? native[1] : null, partsSpent: economy.partsSpent };
    };
    const clickDeviceAt = async (type, desiredId) => {
      const device = (await state()).devices.find(d => d.id === desiredId && d.type === type);
      assert(device, `registered ${type} exists`);
      const aim = (await project([[device.x + 1, device.y, device.z + 1]]))[0];
      assert(aim.x > 380 && aim.x < 1275 && aim.y > 70 && aim.y < 795, `${type} fixture projects onto the canvas`);
      assert(aim.onCanvas, `${type} fixture is not covered by a UI panel`);
      await bounded(`aim at registered ${type}`, () => page.mouse.move(aim.x, aim.y), 700);
      await framePair();
      await bounded(`inspect registered ${type} on canvas`, () => page.mouse.click(aim.x, aim.y), 700);
      await waitState(`inspection of ${type}`, id => window.__app.industry.state.inspection?.device?.id === id, 2_000, desiredId);
    };
    const inspectCellAt = async (cell, material) => {
      const aim = (await project([cell]))[0];
      assert(aim.x > 380 && aim.x < 1275 && aim.y > 70 && aim.y < 795, 'native cell projects onto the unobscured canvas');
      assert(aim.onCanvas, 'native cell is not covered by a UI panel');
      await bounded('aim at native control cell', () => page.mouse.move(aim.x, aim.y), 700);
      await framePair();
      const hit = await page.evaluate(() => ({ valid: window.__app.hover.valid, id: window.__app.hover.id,
        cell: [window.__app.hover.cell.x, window.__app.hover.cell.y, window.__app.hover.cell.z] }));
      assert.equal(hit.valid, true, 'real canvas ray hits a cell');
      assert.deepEqual(hit.cell, cell, 'real canvas ray selects the purchased cell');
      assert.equal(hit.id, material, 'real canvas ray sees the purchased native material');
      await bounded('inspect native control cell on canvas', () => page.mouse.click(aim.x, aim.y), 700);
      await waitState('native switch inspection', () => window.__app.industry.state.inspection?.controlPart?.type === 'SWITCH', 2_000);
    };

    await page.locator('.industry-build').click();
    await waitState('open Factory panel', () => window.__app.industry.building);
    const tsns = await placePartThroughCanvas('TSNS', 350, 0, E.TSNS);
    await page.keyboard.press('Escape');
    await waitState('Escape cancels focused-part placement', () => !window.__app.industry.building, 700);
    assert(await page.locator('.industry').isHidden(), 'Escape closes the builder after the canvas blurs the input');
    await page.keyboard.press('q');
    await waitState('Q reopens Factory builder', () => window.__app.industry.building, 700);
    const swch = await placePartThroughCanvas('SWITCH', null, 3, E.SWITCH);
    await page.keyboard.press('q');
    await waitState('Q cancels active construction', () => !window.__app.industry.building, 700);
    assert.equal((await state()).progression.partsSpent, 5);

    await page.locator('.industry-build').click();
    await waitState('open for native switch inspection', () => window.__app.industry.building, 700);
    await page.locator('.industry-inspect-toggle').click();
    await waitState('enable native switch inspection', () => window.__app.industry.state.inspectMode, 700);
    await inspectCellAt(swch.cell, E.SWITCH);
    const switchButton = page.locator('.industry-switch-toggle');
    assert(await switchButton.isVisible(), 'inspection exposes the real switch toggle');
    await switchButton.click();
    await waitState('toggle real native switch', () => window.__app.industry.state.inspection?.controlPart?.on === true, 1_500);
    const switchedCell = await occupiedCell(swch.cell);
    assert.equal(Math.round(switchedCell[0]), E.SWITCH);
    assert.equal(switchedCell[2], 10, 'switch toggle changed the native SWCH life state');

    // The gate is a serialized UI fixture replacing the starter-belt registration.
    // It tests gate controls/round-trip only; no native gate hardware or flow is claimed.
    const gateFixture = await page.evaluate(() => {
      const a = window.__app, saved = a.industry.toJSON();
      const belt = saved.devices.find(d => d.id === 'starter-belt');
      if (!belt) throw new Error('Starter belt is unavailable for the gate UI fixture');
      const id = 'ui-fixture-gate';
      saved.devices = saved.devices.filter(d => d.id !== belt.id);
      saved.paid = saved.paid.filter(paidId => paidId !== belt.id);
      saved.progression.owned.belt--;
      saved.progression.credits += 2 - 4;
      saved.devices.push({ id, type: 'gate', x: belt.x, y: belt.y, z: belt.z, rotation: 0, gateMode: 'open', gateClosed: false });
      saved.paid.push(id);
      saved.progression.owned.gate++;
      a.industry.fromJSON(saved);
      return { id, x: belt.x, y: belt.y, z: belt.z };
    });

    await page.locator('.industry-build').click();
    await waitState('reopen before inspection', () => window.__app.industry.building, 700);
    await page.locator('.industry-inspect-toggle').click();
    await waitState('enable real inspection mode', () => window.__app.industry.state.inspectMode, 700);
    const driveDeviceId = (await state()).devices.find(d => d.id === 'starter-output')?.id;
    assert(driveDeviceId, 'starter conveyor remains registered');
    await clickDeviceAt('belt', driveDeviceId);
    const drive = page.locator('.industry-drive');
    assert(await drive.isVisible());
    await drive.click();
    await waitState('native-drive UI state', id => window.__app.industry.state.devices.find(d => d.id === id)?.powered === true, 700, driveDeviceId);

    await clickDeviceAt('gate', gateFixture.id);
    for (const mode of ['closed', 'signal']) {
      await page.locator(`.industry-gate-mode[data-gate-mode="${mode}"]`).click();
      assert.equal((await state()).devices.find(d => d.id === gateFixture.id)?.gateMode, mode);
    }
    await waitState('gate actions settled before save', () => !window.__app.industry.state.pending, 1_500);
    const savedIndustry = await page.evaluate(() => window.__app.industry.toJSON());
    const ledgerBeforeRestore = { paid: savedIndustry.paid, partsSpent: savedIndustry.progression.partsSpent, gateMode: savedIndustry.devices.find(d => d.id === 'ui-fixture-gate').gateMode };
    await page.locator('.industry-gate-mode[data-gate-mode="open"]').click();
    await waitState('change gate mode before restore', () => window.__app.industry.state.devices.find(d => d.id === 'ui-fixture-gate')?.gateMode === 'open' && !window.__app.industry.state.pending, 1_500);
    await bounded('restore serialized Industry fixture', () => page.evaluate(saved => window.__app.industry.fromJSON(saved), savedIndustry));
    await waitState('restored header actions settled', () => !window.__app.industry.state.pending, 1_500);
    const restored = await page.evaluate(() => {
      const d = window.__app.industry.toJSON();
      return { paid: d.paid, partsSpent: d.progression.partsSpent, gateMode: d.devices.find(x => x.id === 'ui-fixture-gate')?.gateMode };
    });
    assert.deepEqual(restored, ledgerBeforeRestore, 'Industry serialization preserves paid ledger, control-part spend, and gate mode');
    assert.deepEqual(pageErrors, []);
    result.parts = { TSNS: tsns, SWITCH: swch };
    result.nativeDrive = { deviceId: driveDeviceId, powered: true };
    result.gateModeRoundTrip = ledgerBeforeRestore;
    result.fixtures.push('camera projection with real canvas clicks; serialized gate fixture over the starter-belt footprint for UI/save-state only');
    result.coverage = ['TSNS DOM selection and valid/invalid threshold', 'native TSNS/SWITCH canvas placement and single-cell readback',
      'confirmed credits/partsSpent', 'switch inspection/toggle and native cell assertion', 'Escape/Q cancellation and focused-input Q handling',
      'native drive button state', 'gate-mode buttons and industry.toJSON/fromJSON paid-ledger round trip'];
  }

  assert.deepEqual(browserFailures.filter(event => event.kind === 'console'
    && /GPUValidationError|uncaptured|createComputePipeline|parsing WGSL|shader compilation|device lost/i.test(event.message)),
  [], 'no native GPU validation errors');
  result.pageErrors = pageErrors;
  result.browserFailures = browserFailures;
  writeFileSync(`${out}/${testCase}.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} catch (error) {
  const failure = { case: testCase, ok: false, stage, message: error?.message ?? String(error), pageErrors, browserFailures };
  // A short read-only probe distinguishes cold pipeline startup from an app
  // exception. It never waits past the existing work/cleanup boundary.
  if (page && !page.isClosed() && remaining() > 300) {
    let timer;
    try {
      failure.startup = await Promise.race([
        page.evaluate(() => ({ readyState: document.readyState, app: !!window.__app, sim: !!window.__app?.sim,
          mode: window.__app?.current().mode,
          marks: performance.getEntriesByType('mark').slice(-30).map(mark => ({ name: mark.name, at: mark.startTime })) })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ probe: 'timed out' }), 250); }),
      ]);
    } catch {}
    finally { clearTimeout(timer); }
  }
  writeFileSync(`${out}/${testCase}.json`, `${JSON.stringify(failure, null, 2)}\n`);
  console.error(JSON.stringify(failure));
  console.error(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
