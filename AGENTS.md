# Instructions for all coding agents

Read `CLAUDE.md` before investigation, edits, tests, or delegation.
It contains the shared rules for this repository, regardless of agent type.

Fetch `origin` and read `git show origin/main:CLAUDE.md` before each task.
If the fetch fails, report that freshness is unverified.
Create new task worktrees from fetched `origin/main`, not local `main` or `HEAD`.
For resumed tasks, compare the task base with fetched `origin/main`.
Preserve all unrelated commits, worktrees, and uncommitted changes.
Pass the verified task path and base commit to every subagent.
