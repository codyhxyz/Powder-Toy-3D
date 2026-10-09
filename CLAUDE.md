# Working in this repo

Many Claude sessions and their subagents work here at the same time, some in this checkout and some in their own worktrees. Leave things as tidy as you found them.

- Stop what you start. When you're done with a dev server (vite, `wrangler dev`), a headless browser or a test script, stop it, and before you hand back a result. Kill only your own processes, by PID or by your own port. Never use a broad `pkill`, because it takes down other sessions' runs.
- Use your own port. Start servers on an unusual port with `--strictPort` (not 5173 or 8787), so you never attach to someone else's server or collide with theirs.
- Commit only your own changes. This checkout often holds other sessions' uncommitted work. Don't stage, revert or reformat files you didn't touch.
- Deploying means pushing `main` to GitHub: a GitHub Action builds it and ships it to https://tpt3d.codyh.xyz. Never run `wrangler pages deploy` yourself. `git fetch` first, and if `origin/main` has commits you don't (PRs merged on GitHub), merge them in before you push. Then watch the run (`gh run watch`) and check the live site.
