# Working in this repo

Many Claude sessions and their subagents work here at the same time, some in this checkout and some in their own worktrees. Leave things as tidy as you found them.

- Stop what you start. When you're done with a dev server (vite, `wrangler dev`), a headless browser or a test script, stop it, and before you hand back a result. Kill only your own processes, by PID or by your own port. Never use a broad `pkill`, because it takes down other sessions' runs.
- Use your own port. Start servers on an unusual port with `--strictPort` (not 5173 or 8787), so you never attach to someone else's server or collide with theirs.
- Commit only your own changes. This checkout often holds other sessions' uncommitted work. Don't stage, revert or reformat files you didn't touch.
- Deploy completed fixes by default; do not stop at “fixed locally” unless the user explicitly asks for local-only work. Deployment and a live-site check are part of finishing.
- Deploying means pushing `main` to GitHub: a GitHub Action builds it and ships it to https://tpt3d.codyh.xyz. Never run `wrangler pages deploy` yourself. `git fetch` first, and if `origin/main` has commits you don't (PRs merged on GitHub), merge them in before you push. Then watch the run (`gh run watch`) and check the live site.

## Headless GPU budget — all agents

The user plays the game on this same Mac's GPU while agents work, and headless runs wreck their frame rate. `tools/browser.mjs` enforces two rules: one headless browser machine-wide at a time (others queue on `~/.cache/tpt-headless/slot`), and none while the GPU is busy with something that isn't a test: the user playing. Holding the slot, the launcher reads the GPU's utilization from the IO Registry and waits (up to `TPT_GPU_WAIT_MS`, 10 min) while its median is 50 % or more, then fails with "the user is likely playing". An idle Mac runs tests freely; there is no hourly allowance. Runs last at most 3 minutes (`TPT_TEST_TIMEOUT_MS`). Check on the CPU first, batch what you need into one run, and close every browser the moment you have your answer. Never set `TPT_IGNORE_PLAYER` unless the user says so.

- Use `launchBrowser` and `newTestPage` / `newTestContext` from `tools/browser.mjs`, not another raw Chromium launcher. The deploy enforces it: `tools/check-browser-launch.mjs` fails on any script in `tools/` or `scripts/` that launches a browser itself, except the legacy list in that file, which only shrinks.
- Pick the cheapest mode that preserves the assertion:
  - `manual`: numerical tests. The app loop is parked at boot. Step explicitly through `__app.test.step(n)` or existing `sim.step()` calls.
  - `ui`: UI-only tests. Starts paused, with normal browser animation callbacks and on-demand rendering.
  - `preview` (helper default): live gameplay checks. Simulation and input keep their cadence; presentation runs at 10 Hz.
  - `visual`: screenshot regression and performance measurements. Full presentation cadence and unchanged quality.
- Use `ready(page)` instead of a fixed boot sleep. For a full-quality checkpoint in a cheap mode, use `await render(page)` before `page.screenshot()`. It parks the app and converges the view without stepping physics. Resume explicitly after the screenshot if needed. Model, world-generation, and audio readiness still require their own checks.
- Park the main loop with `__app.test.park()` while inspecting results. Resume with `__app.test.resume()` when live gameplay is required. Do not park during a test interval that is meant to advance gameplay.
- Do not shrink physics fixtures or lower the global FPS cap to save GPU work. Do not replace global rAF in new interaction tests: Playwright clicks need it.
- Close browsers in `finally`. The launcher also closes its browsers on uncaught failures/signals and enforces a 10-minute lifetime (`TPT_TEST_TIMEOUT_MS` overrides it).
- Keep GPU-heavy suites short and run benchmarks without competing GPU tests. Existing cross-build benchmarks retain their explicit legacy frame pumps.
- Direct browser URLs support `?test=manual|ui|preview|visual` and `&paused=1`. These flags are not persisted and normal gameplay is unchanged.
- Existing worktrees and already-running scripts must adopt this revision before these defaults apply. See `docs/headless-testing-cost.md`; check with `node tools/headless-check.mjs --port YOUR_PORT`.

# Design touchstones

The game's major inspirations are Cruelty Squad, Minecraft, Noita, The Powder Toy, Team Fortress 2, Rust, Garry's Mod and Halo 3 (README, "Inspirations"). When a feature needs a rule, a number or a feel, borrow it from one of these first and cite it in a comment.
