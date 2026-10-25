# Working in this repo

Many Claude sessions and their subagents work here at the same time, some in this checkout and some in their own worktrees. Leave things as tidy as you found them.

## Recovery checkout — all agents

On Cody's Mac, `/Users/codyhergenroeder/code/claude/threejs-tpt-gpu` is a preserved recovery checkout, not the current source.
Do not edit, commit, build, or deploy from that directory.
Do not reset, clean, stash, or merge it.
The clean local `main` checkout is `/Users/codyhergenroeder/code/claude/threejs-tpt-gpu-main`.
Use it for navigation, not concurrent edits.
Create a task worktree from fetched `origin/main` before new work.
Keep existing task worktrees intact; check their base before resuming.
Pass these rules, the task worktree path, and the base commit to every subagent.

## Start here — every session and worktree

Before code investigation, profiling, edits, or delegation:

1. Run `git fetch origin`. If it fails, report that freshness is unverified.
2. Run `git status --short --branch` and `git rev-list --left-right --count HEAD...origin/main`.
3. Read the current instructions with `git show origin/main:CLAUDE.md`.
4. For new live-site work, create an isolated worktree from the fetched `origin/main`, not local `main` or `HEAD`.
5. Report the starting commit and any divergence. Give subagents the verified worktree and base commit.

For resumed work, compare its base with the fetched remote before continuing.
An explicit request for a local branch or historical commit overrides the base choice, not the freshness check.
Preserve shared edits and local-only commits. Never reset, clean, stash, or merge the dirty shared checkout automatically.
Fetching updates `origin/main`; it does not update local `main`. A branch name is not proof of production freshness.

## Shared checkout and deployment

- Stop what you start. When you're done with a dev server (vite, `wrangler dev`), a headless browser or a test script, stop it, and before you hand back a result. Kill only your own processes, by PID or by your own port. Never use a broad `pkill`, because it takes down other sessions' runs.
- Use your own port. Start servers on an unusual port with `--strictPort` (not 5173 or 8787), so you never attach to someone else's server or collide with theirs.
- Commit only your own changes. This checkout often holds other sessions' uncommitted work. Don't stage, revert or reformat files you didn't touch.
- Deploy completed fixes by default; do not stop at “fixed locally” unless the user explicitly asks for local-only work. Deployment and a live-site check are part of finishing.
- Deploying means pushing `main` to GitHub: a GitHub Action builds it and ships it to https://tpt3d.codyh.xyz. Never run `wrangler pages deploy` yourself. `git fetch` first, and if `origin/main` has commits you don't (PRs merged on GitHub), merge them in before you push. Then watch the run (`gh run watch`) and check the live site.

## Headless GPU budget — all agents

The user plays on this Mac while agents work. Headless tests can disrupt the game.

- Limit each GPU slot to **25 seconds total**, including startup, compilation, warmup, assertions, and cleanup.
- Plan the command, purpose, run count, expected setup time, and total occupancy before launch.
- Report measured occupancy afterward. Do not call a short measurement interval the total test time.
- Do not extend the limit or repeat runs silently.
- Use CPU checks first. Reuse existing evidence.
- `tools/browser.mjs` rejects budgets over 25 seconds. Its independent watchdog stops only the test's own process tree.
- The launcher releases its slot if the player uses the GPU. It does not hold the slot while waiting for the player.
- Never set `TPT_IGNORE_PLAYER` without explicit user approval.
- If another test holds the slot, identify its owner and require compliance. Do not kill unrelated processes.

- Use `launchBrowser` and `newTestPage` / `newTestContext` from `tools/browser.mjs`, not another raw Chromium launcher. The deploy enforces it: `tools/check-browser-launch.mjs` fails on any script in `tools/` or `scripts/` that launches a browser itself, except the legacy list in that file, which only shrinks.
- Pick the cheapest mode that preserves the assertion:
  - `manual`: numerical tests. The app loop is parked at boot. Step explicitly through `__app.test.step(n)` or existing `sim.step()` calls.
  - `ui`: UI-only tests. Starts paused, with normal browser animation callbacks and on-demand rendering.
  - `preview` (helper default): live gameplay checks. Simulation and input keep their cadence; presentation runs at 10 Hz.
  - `visual`: screenshot regression and performance measurements. Full presentation cadence and unchanged quality.
- Use `ready(page)` instead of a fixed boot sleep. For a full-quality checkpoint in a cheap mode, use `await render(page)` before `page.screenshot()`. It parks the app and converges the view without stepping physics. Resume explicitly after the screenshot if needed. Model, world-generation, and audio readiness still require their own checks.
- Park the main loop with `__app.test.park()` while inspecting results. Resume with `__app.test.resume()` when live gameplay is required. Do not park during a test interval that is meant to advance gameplay.
- Do not shrink physics fixtures or lower the global FPS cap to save GPU work. Do not replace global rAF in new interaction tests: Playwright clicks need it.
- Close browsers in `finally`. `TPT_TEST_TIMEOUT_MS` can shorten the 25-second slot limit, but cannot extend it.
- Keep GPU-heavy suites short and run benchmarks without competing GPU tests. Existing cross-build benchmarks retain their explicit legacy frame pumps.
- Direct browser URLs support `?test=manual|ui|preview|visual` and `&paused=1`. These flags are not persisted and normal gameplay is unchanged.
- Existing worktrees and already-running scripts must adopt this revision before these defaults apply. See `docs/headless-testing-cost.md`; check with `node tools/headless-check.mjs --port YOUR_PORT`.

## Profiler — all agents

For any performance question, run the profiler. Don't write your own timing.

- `node tools/profile.mjs --map <key> [--poses "default;landDown;sky;horizon"] [--target ms | --compare old/profile.json] [--view realistic] [--frames 30] [--out dir]`. One 25 s slot prints a ranked waterfall (GPU ms per pass with median and spread, CPU ms per phase, frame interval, compiles in flight, GPU memory, what bounds the frame) and writes JSON and HTML. On a Mac it also records Metal's per-encoder times (tools/gpu-counters.mjs), which become the trusted per-pass ms; `--no-counters` skips them. With several poses it fits ms per counter category (an estimate, or the reason it can't). With a target it says what must drop to reach it. In the browser, use `?profile=1` or `__app.prof.report()`.
- Trust only a report that says `PROFILE (trusted)`. An UNTRUSTED report names its reasons (compiles, a shared GPU, missing timestamps, too few frames, pass times past the frame, passes with no trusted ms). A pass with no trusted ms shows `–` and says why. Never read its timestamp instead.
- If the report lacks what you need, improve the profiler (a pass label, a counter, a report line) so every later agent gets it. Don't work around it. See `docs/profiler.md`.

## Same features in every world — all agents

A feature, fix or look applies everywhere the player can meet it: every map and scene, small and big (a big map's window and the distance pass past it), and every view.

- Ship it everywhere in the same task. "Box only for now", "World later" and "V2 not yet" are unfinished work, not a scope choice, and the task isn't done until they're closed.
- Every small-map vs big-map difference is a row in `src/mapKind.js`, and code reads its row instead of testing the map kind itself (`tools/check-frame-wires.mjs` reports strays). A new difference is a new row there.
- A difference is allowed only when the user asked for it or it belongs to a gamemode. Mark it at the branch with who decided and why: `// Intentional (user request, 2026-10-20): ...` or `// Intentional (gamemode: Halo): ...`.
- Different code that looks and plays the same to the player (World reads its atlas, Box reads V2 state) isn't a deviation. Say so in a comment anyway, so the next agent doesn't take it for one.
- If you find an undocumented difference, close it. If it might be wanted, ask the user. Never report it as a limitation and stop.
- List every intentional deviation in your final report.

# Design touchstones

The game's major inspirations are Cruelty Squad, Minecraft, Noita, The Powder Toy, Team Fortress 2, Rust, Garry's Mod and Halo 3 (README, "Inspirations"). When a feature needs a rule, a number or a feel, borrow it from one of these first and cite it in a comment.
