# Cheaper headless testing

## Implemented

Make test execution demand-driven. Keep real GPU physics, but stop drawing frames that nobody checks.
Use three explicit test modes: manual physics, low-frequency preview, and full visual regression.
Normal gameplay must keep its current behavior.

The app and shared launcher now support these modes. The tracked browser tools use explicit modes where appropriate.
Screenshot and performance tools retain full presentation cadence.
Existing custom cross-build frame pumps remain intact.

### Use it

```js
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';

const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'manual' });
  await page.goto('http://127.0.0.1:54873/?size=64&preset=empty');
  await ready(page);
  await page.evaluate(() => window.__app.test.step(24));
  // Inspect state here. Only render if the test needs an image.
  await render(page);
  await page.screenshot({ path: '/tmp/check.png' });
} finally {
  await browser.close();
}
```

| Mode | Starts paused | App loop | Presentation |
|---|---|---|---|
| `manual` | Yes | Parked | Explicit `render(page)` |
| `ui` | Yes | Live, including UI callbacks | Full cadence, only until settled |
| `preview` (helper default) | No | Live | At most 10 Hz |
| `visual` | No | Live | Original full cadence |

`newTestContext` accepts the same mode for tests that create their own contexts.
Direct URLs accept `?test=MODE`. A URL mode overrides the helper's injected mode.
`&paused=1` starts any mode paused, before its first frame.
No flags or preferences are persisted. Normal browsing does not enter a test mode automatically.

`__app.test.park()` stops the main app loop without changing the UI's pause setting.
`__app.test.resume()` resumes the loop without changing that setting.
`__app.test.step(n)` requires a parked local page and accepts 0–10000 physics steps per call.
Manual stepping does not advance player, tool, audio, or multiplayer logic.
Use preview mode when the assertion needs those systems.

The `render(page)` checkpoint parks the app, then converges full-quality derived fields and TAA without advancing gameplay.
It waits for delayed base-detail changes and the requested detail shader to compile, then converges again.
It leaves the app parked so the subsequent screenshot captures that frame.
After capture, use `__app.test.resume()` if the test needs live gameplay again.
It does not wait for unrelated model, world-generation, or audio loading.
Changing presentation cadence still changes temporal history. Use visual mode for pixel-regression baselines.

The helper closes its browsers on uncaught exceptions, rejected promises, and termination signals.
Each browser has a ten-minute lifetime by default. `TPT_TEST_TIMEOUT_MS` can raise that limit.
Explicit `finally` cleanup is still preferred.
The NPC suite sets a lifetime that covers its requested match count.

### Rollout

New runs in this checkout receive the migrated defaults.
Existing processes retain their launch configuration. Other worktrees need this revision merged first.
Tests against an older deployed app do not gain modes that the old app does not implement.
This change does not deploy the site, kill other agents' tests, or impose a machine-wide scheduler.

Verify against a private Vite server:

```sh
node tools/headless-check.mjs --port 54873
```

The check covers physics equality, presentation frequency, animation time, parked UI clicks, snapshots, paused boot, and failure cleanup.

## Measured before and after

Machine: Apple M5, 10 GPU cores. Browser: Playwright Chromium, ANGLE Metal.
Scenario: seeded Lab, 128³ cells, 1280×800 viewport, DPR 1, default graphics, automatic resolution disabled.
Each trial runs exactly 96 physics steps. Each mode repeats three times in alternating order.
Shader warmup and full-state hashing are outside the timed region.

| Mode | Median completion time | App draw calls | Rendered views |
|---|---:|---:|---:|
| Before: render after every four steps | 2,156.6 ms | 1,896 | 24 |
| Preview: render after every 24 steps | 1,046.5 ms | 956 | 4 |
| Physics only: no presentation | 668.4 ms | 768 | 0 |

- Preview: **51.5% less elapsed time**, **49.6% fewer draw calls**, **2.06× throughput**.
- Physics only: **69.0% less elapsed time**, **59.5% fewer draw calls**, **3.23× throughput**.
- The full decoded simulation state has identical SHA-256 hashes across all nine trials.
- A held page issued **zero app draw calls during a one-second wait**.
- With ordinary app ticks enabled, a paused scene also issued **zero draws across 60 ticks after convergence**.
- At a nominal 60 simulation ticks/second, the preview cadence corresponds to 10 rendered views/second.
  This experiment does not establish an achievable live frame rate under contention.

Trial times, in milliseconds:

| Mode | Trial 1 | Trial 2 | Trial 3 |
|---|---:|---:|---:|
| Every tick | 2278.5 | 2021.6 | 2156.6 |
| Every sixth tick | 999.3 | 1046.8 | 1046.5 |
| Physics only | 801.3 | 668.4 | 633.3 |

A second complete 128³ run produced medians of **4136.2 / 1561.5 / 1085.4 ms**, respectively.
That is **2.65× preview throughput** and **3.81× physics-only throughput**.
Draw counts stayed identical, all physics hashes matched, and both idle checks passed.
The substantial absolute-time change demonstrates why these results cannot predict an exact machine-wide utilization percentage.

### Limits of these numbers

These are GPU-synchronized completion times, not hardware GPU execution times or utilization percentages.
They include CPU submission, readback overhead, and contention from other agents.
Each four-step batch ends with the same synchronization boundary.

The machine reported 99% GPU utilization during inspection.
One process snapshot contained eight headless browsers before this benchmark started.
Other agents continued their tests throughout measurement.

A later 64³ run had medians of 2120.7, 1806.9, and 1219.1 ms for the same three modes.
Its physics hashes also matched within that grid size.
Load changed substantially between runs: smaller grids did not produce a reliable timing gain in this measurement.
An eightfold reduction in cell count is **not** evidence of an eightfold speedup.

The benchmark checks simulation state, not visual equivalence or full POV behavior.
Sparse presentation changes temporal filter history. Screenshot regression must keep its prescribed render sequence.
The preview experiment also does not exercise pointer lock, asynchronous transfers, multiplayer, audio, or NPC timing.

## What causes the waste

1. **Headless still uses the real GPU.**
   The test scripts launch Chromium with `--use-angle=metal --enable-gpu --ignore-gpu-blocklist`.
   Hiding the window does not remove simulation, raymarching, shadows, GI, or post-processing.

2. **The attempted paused boot does not work.**
   Several scripts save `{ paused: true }` in localStorage.
   `src/app.js` excludes `paused` from `PERSIST`, assigns `settings.paused = false`, and calls `setPaused(false)` during boot.
   The benchmark confirmed `paused === false` despite the saved value.
   Examples include `tools/regress.mjs`, `tools/derived-check.mjs`, and `tools/detail-bench.mjs`.

3. **Waits leave the game running.**
   Scripts commonly wait 1.5–3 seconds after boot. `tools/view.mjs` defaults to six seconds.
   `tools/shots.mjs` runs scenes for five or eight seconds.
   During those waits, `src/app.js` advances four physics steps per frame.
   Changing state then triggers derived fields, shadows, GI, raymarching, and post-processing.

4. **There is no shared test execution policy.**
   The audit found 32 Chromium launch sites in `tools/`, excluding this new benchmark.
   Some tests already hold rAF before boot: `bench.mjs`, `activity-check.mjs`, and `state-hash.mjs`.
   Other tests continuously run the application.

5. **Cleanup is inconsistent.**
   Many scripts call `browser.close()` only on their success path.
   This is a failure-path risk, not proof that the observed browsers were abandoned.
   The inspected browsers had active test parents.

## Design and coverage boundaries

### 1. Stop idle work first

- Add an explicit paused-start URL option.
  The boot call can use `setPaused(params.get('paused') === '1')`.
  This preserves the current running default without changing saved-game semantics.
- For UI-only tests, use `?size=64&preset=empty&paused=1` where that scene meets the test requirements.
- Reuse the existing render-on-demand code in `src/gfx/pacing.js`.
  A paused scene must finish its derived-field and TAA convergence before rendering stops.
- Replace arbitrary startup sleeps with readiness checks.
- Close pages and browsers in `finally`. Add a bounded test lifetime with cleanup.

This is the smallest first change. It does not require a new renderer or a new test framework.

### 2. Make numerical tests manual

- Reuse the held-frame approach from `tools/bench.mjs`.
- Advance an exact number of physics steps, then inspect the result.
- Run derived passes only when the assertion needs them.
- Render only when the test requests an image.
- Preserve seeds, scene size, timestep, and test-specific assertions.

Existing physics-only tests already use this approach. Those tests do not receive another 3.23× gain from adopting it again.

For general browser tests, expose an app-loop control rather than replacing global rAF.
Playwright actionability checks and UI animations can require live rAF callbacks.
Asynchronous readbacks also need the event loop to progress.

### 3. Separate live preview from simulation

- Keep simulation, player updates, tools, and required probes at their existing cadence.
- Limit the presentation group to 10 Hz by default for explicit preview tests.
- Gate derived fields, shadows, GI, raymarching, and post together.
  Skipping only `post.render()` leaves much of the GPU work intact.
- Consume pacer convergence counts only when the corresponding passes actually run.
- Preserve elapsed-time semantics when frames are skipped.
- For a screenshot checkpoint, render the required full-quality convergence frames before capture.

**Do not simply change `MAX_FPS` from 60 to 10.**
Physics currently advances per app frame. That change also makes the simulation six times slower at the nominal rate.

Do not infer this mode from `navigator.webdriver`: visual regression also runs through WebDriver-style automation.

### 4. Keep expensive coverage explicit

- Keep full-resolution visual regression, large-world tests, and performance measurements.
- Use small grids only for tests whose geometry and assertions support them.
- Use reduced resolution for previews, not for pixel-regression baselines.
- Reuse a browser within a suite to avoid repeated launches.
  This does not make concurrently active pages share their simulation or render work.
- Keep benchmark runs isolated from other active GPU tests when trustworthy timing is required.

## Parallel capacity

The measured throughput ratios suggest roughly **2× preview work** or **3× numerical work** per elapsed-time budget in this scenario.
They are estimates for scheduling, not verified concurrent-browser capacity.

The larger gain comes from idle time: parked test pages do not continuously compete for GPU work.
For example, one second of active work in a ten-second interval removes nine seconds of unnecessary continuous execution.
That duty-cycle example is arithmetic, not a measured end-to-end suite result.

Many pages can remain open, but active physics still has a real cost.
For sustained load control, a machine-wide runner must bound active GPU work across worktrees.
Park waiting pages and permit a small number of active GPU batches.
Browser-count limits alone do not guarantee a utilization ceiling.

Neither these changes nor a local benchmark justify promising “99% GPU becomes 10%.”
If agents consume every saved cycle with additional work, utilization can stay high while throughput improves.
Idle pages also retain GPU memory until their contexts close.

## Reproduce

Start a private server:

```sh
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 54873 --strictPort
```

Run the experiment in another terminal:

```sh
node tools/headless-cost.mjs --port 54873
```

Stop the private server after the run.
The benchmark closes its own browser in `finally`.
It blocks WebSockets to prevent multiplayer activity and HMR reloads during measurement.
It checks exact physics equality, expected draw cadence, parked-page inactivity, and paused-scene inactivity after convergence.
