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

- A GPU slot is **25 seconds total** by default, including startup, compilation, warmup, assertions, and cleanup. A test that needs longer (a full big-map load runs ~2 min) passes `lifetimeMs`, up to the 10-minute hung-test ceiling (user, 2026-10-22: "just remove the cap").
- Plan the command, purpose, run count, expected setup time, and total occupancy before launch.
- Report measured occupancy afterward. Do not call a short measurement interval the total test time.
- Do not repeat runs silently. Ask for only the time the assertion needs.
- Use CPU checks first. Reuse existing evidence.
- `tools/browser.mjs` rejects budgets over 10 minutes. Its independent watchdog stops only the test's own process tree.
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
- Close browsers in `finally`. `TPT_TEST_TIMEOUT_MS` sets the slot length (25 s default, 10 minutes at most).
- Keep GPU-heavy suites short and run benchmarks without competing GPU tests. Existing cross-build benchmarks retain their explicit legacy frame pumps.
- Direct browser URLs support `?test=manual|ui|preview|visual` and `&paused=1`. These flags are not persisted and normal gameplay is unchanged.
- Existing worktrees and already-running scripts must adopt this revision before these defaults apply. See `docs/headless-testing-cost.md`; check with `node tools/headless-check.mjs --port YOUR_PORT`.

## Same features in every world — all agents

A feature, fix or look applies everywhere the player can meet it: every map and scene, both renderers (Box and World, including World's far field), both physics engines (V1 and V2), and every view.

- Ship it everywhere in the same task. "Box only for now", "World later" and "V2 not yet" are unfinished work, not a scope choice, and the task isn't done until they're closed.
- A difference is allowed only when the user asked for it or it belongs to a gamemode. Mark it at the branch with who decided and why: `// Intentional (user request, 2026-10-20): ...` or `// Intentional (gamemode: Halo): ...`.
- Different code that looks and plays the same to the player (World reads its atlas, Box reads V2 state) isn't a deviation. Say so in a comment anyway, so the next agent doesn't take it for one.
- If you find an undocumented difference, close it. If it might be wanted, ask the user. Never report it as a limitation and stop.
- List every intentional deviation in your final report.

# Design touchstones

The game's major inspirations are Cruelty Squad, Minecraft, Noita, The Powder Toy, Team Fortress 2, Rust, Garry's Mod and Halo 3 (README, "Inspirations"). When a feature needs a rule, a number or a feel, borrow it from one of these first and cite it in a comment.
