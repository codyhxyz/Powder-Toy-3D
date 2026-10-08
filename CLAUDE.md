# Working in this repo

Many Claude sessions and their subagents work here at the same time, some in this checkout and some in their own worktrees. Leave things as tidy as you found them.

- Stop what you start. When you're done with a dev server (vite, `wrangler dev`), a headless browser or a test script, stop it, and before you hand back a result. Kill only your own processes, by PID or by your own port. Never use a broad `pkill`, because it takes down other sessions' runs.
- Use your own port. Start servers on an unusual port with `--strictPort` (not 5173 or 8787), so you never attach to someone else's server or collide with theirs.
- Commit only your own changes. This checkout often holds other sessions' uncommitted work. Don't stage, revert or reformat files you didn't touch.
- Production is shared. Before deploying, check what's live and deploy from a clean worktree, not this checkout.
