# Research agent brief (shared)

Goal: replace "I've heard of this paper" with knowledge from the actual text, applied to our code.
The user's words: "you're citing these books like you know them front to back, whereas I know you do not…
we are not perfect and probably have missed key points of these resources."

## Steps
1. Fetch every source for your topic into `<topic>/raw/`, convert to `<topic>/text/` (pdftotext -layout,
   or `lit parse`; for web pages save the HTML and a readable text version; for WWDC sessions save Apple's
   transcript from the session page). Record each in `<topic>/sources.md` (URL, date, how obtained).
   Free, author- or publisher-hosted copies only. If a source is paywalled or not legally available, say
   so in sources.md and use the closest legal substitute (author's slides, talk, tech report).
2. Read the cached text fully. Write `<topic>/KNOWLEDGE.md`:
   - **What it says**: the key mechanisms, rules of thumb and numbers, each with a short quote and a
     location (section, page, slide, timestamp). Nothing from memory without a quote.
   - **Our renderer against it**: compare with the code (read-only; see "Code" below). For each key point:
     do we follow it, violate it, or not apply? Cite our file:line.
   - **What we missed**: concrete, ranked by likely frame-time impact, each with the source's evidence.
   - **Open questions** the text could not settle.
3. Report back in plain words (no internal jargon): the top findings, what we missed, and what you could
   not obtain.

## Code (read-only; never edit, build, run a dev server or a GPU test)
- Current live code: `/Users/codyhergenroeder/code/claude/tpt-swp` (origin/main). Key files:
  `src/shaders/render.js` (realisticTraceWGSL, the ray loop), `src/shaders/world/march.js` (the world
  march and its split stages), `src/shaders/world/copy.js` (world copy), `src/shaders/world/fields.js`
  (smooth-surface fields), `src/shaders/world/light.js`, `src/shaders/dda.js`, `src/gfx/worldView.js`,
  `tools/profile.mjs` + `docs/profiler.md` (how we measure), `docs/march-spill.md`.
- In-progress rebuild: branch `arch/wavefront` in `/Users/codyhergenroeder/code/claude/tpt-split`
  (another agent is editing it right now: read with `git -C <path> show arch/wavefront:<file>` or read
  files, never write there). It splits the march into a lean pass plus per-material passes
  (Laine, Karras & Aila 2013).
- Measured facts so far (2026-10-25, Apple M5, 2560×1600 canvas, scene ×0.667 = 1.82 M pixels traced):
  knockout (frame span drop when a pass is skipped) is the trusted measure; Metal per-encoder ms
  under-report the march 2–3×. Island default: march ~15 ms of a ~27 ms frame; Lab: ~28 of ~33.
  Split branch: Lab lean 6.2 ms + event 17.5; Island lean 10.6 + event 12.4. Turning off the 8-tap
  cubic field filter changed nothing; 4–5× fewer cell reads changed nothing; cost tracks loop
  iterations on water/glass/smoke/crystal pixels (~800 lane-cycles per iteration).

## Rules
- Network + CPU only. No GPU runs, no browsers launched through tools/browser.mjs, no dev servers.
- Write only inside `/Users/codyhergenroeder/code/claude/threejs-tpt-gpu/research/<your topic>/`.
- Plain words in the report. Quote the source for every claim about it.
