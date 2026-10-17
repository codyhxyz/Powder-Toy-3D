# v2 Week 0: running the ruler on your devices

The container has no GPU, so everything it measured ran on SwiftShader, a CPU renderer. Those numbers are useless
for timing, so these runs are what count. Each one prints a table or JSON. Paste it back.

Set up once on the Mac:

```sh
git fetch origin && git worktree add ../tpt-v2 origin/claude/v2 && cd ../tpt-v2 && npm ci
npx playwright install chromium            # the tools drive a real Chrome on the Apple GPU
git worktree add ../tpt-v1 c953a6c && (cd ../tpt-v1 && npm ci)   # today's build, frozen, for comparisons
```

## 1. Raster bench (removed)

It decided MSAA vs TAAU for P1, and P1's block renderer was rejected on 2026-10-14 (`docs/v2.md`). The page and its
run instructions are in `git show a700d765:bench/raster.html` and `git show a700d765:docs/v2/week0.md`.

## 2. Outcome bench (what the physics does; P2's gate)

```sh
node tools/outcomes.mjs --json outcomes-mac.json      # ~19 tests on today's build, a few minutes on the Apple GPU
```

It exits 0 when everything matches the record of today's build, `tools/outcomes/expected-v1.json` (5 pass, 13 fail as
expected). `--group liquids`, `--tests utube,hole` and `--list` pick tests. `node tools/outcomes.mjs --engine lean`
runs the CPU prototype for comparison (no browser).

## 3. Power (today's baseline, about 10 minutes)

```sh
sudo powermetrics --samplers gpu_power,cpu_power -i 500 -o /tmp/tpt3d-power.txt     # terminal 1, leave running
node tools/power.mjs --power-file /tmp/tpt3d-power.txt --root ../tpt-v1 --out power-today.json   # terminal 2
```

Run it on mains power with other apps quit. A scenario marked FAIL didn't do what its name says (for example, the walk
got stuck), so its watts don't count.

## 4. Side by side (judges every phase from P1 on)

```sh
node tools/side-by-side.mjs --a-dir ../tpt-v1 --b-dir . --out ~/Desktop/sbs && open ~/Desktop/sbs/index.html
```

It captures 15 shots: 7 stills, plus 5 s action clips at 1280×720 and 30 fps, with the same scene, camera, seed and
game time on both sides. Until P1 both sides are today's game, so the sheet should show identical pairs. That checks
the tool on the Mac's GPU. `--shots stills` or `--shots clips` run half at a time. `--links https://<build>/` prints
the `?shot=` links for the phone.
