# Sources: GPU architecture (shader cores, latency hiding, divergence, Apple occupancy)

All retrieved 2026-10-25 with `curl` (network only, no browser). Raw copies in `raw/`, plain text in `text/`
(PDFs: `pdftotext -layout`; blog posts: the post body plus its reader comments, extracted from the saved HTML;
Apple sessions: the transcript embedded in Apple's session page, written out with `[mm:ss]` stamps every ~20 s).
All are free copies hosted by the author, the course or Apple.

| # | Source | URL | How obtained | Files |
|---|---|---|---|---|
| 1 | Kayvon Fatahalian, "From Shader Code to a Teraflop: How GPU Shader Cores Work", SIGGRAPH 2010 Beyond Programmable Shading course, 72 slides (dated 07/29/10) | http://bps10.idav.ucdavis.edu/talks/03-fatahalian_gpuArchTeraflop_BPS_SIGGRAPH2010.pdf | The course site (idav.ucdavis.edu) timed out from here. Fetched the same URL from the Internet Archive: `https://web.archive.org/web/20170428163644id_/…` (the `id_` form returns the original bytes). | `raw/fatahalian_BPS2010_teraflop.pdf`, `text/fatahalian_BPS2010_teraflop.txt` |
| 1b | Kayvon Fatahalian, Stanford CS149 (Fall 2021) Lecture 7, "GPU Architecture & CUDA Programming", 74 slides (his CMU 15-418 lecture's successor) | https://gfxcourses.stanford.edu/cs149/fall21content/media/gpuarch/07_gpuarch.pdf (linked from https://gfxcourses.stanford.edu/cs149/fall21/lecture/gpuarch) | Direct download. Added because the 2010 slides predate a modern SM (warps, per-SM register file split among warps). | `raw/cs149_fall21_07_gpuarch.pdf`, `text/cs149_fall21_07_gpuarch.txt` |
| 2 | Fabian Giesen, "A trip through the Graphics Pipeline 2011", index + parts 1–13 (The ryg blog, July–Oct 2011) | https://fgiesen.wordpress.com/2011/07/09/a-trip-through-the-graphics-pipeline-2011-index/ ; parts at https://fgiesen.wordpress.com/2011/MM/DD/a-trip-through-the-graphics-pipeline-2011-part-N/ (07/01 p1, 07/02 p2, 07/03 p3, 07/04 p4, 07/05 p5, 07/06 p6, 07/08 p7, 07/10 p8, 07/12 p9, 07/20 p10, 08/14 p11, 09/06 p12, 10/09 p13) | Direct download of each post. | `raw/giesen_index.html`, `raw/giesen_partNN.html`, `text/giesen_*.txt` |
| 3a | Apple, "Explore GPU advancements in M3 and A17 Pro" (Tech Talk 111375, Jedd Haberstro) | https://developer.apple.com/videos/play/tech-talks/111375/ | Session page saved; transcript taken from the page. | `raw/apple_tech-talks_111375.html`, `text/apple_tech-talks_111375.txt` |
| 3b | Apple, "Discover new Metal profiling tools for M3 and A17 Pro" (Tech Talk 111374, Ruiwei / Irfan) | https://developer.apple.com/videos/play/tech-talks/111374/ | As 3a. | `raw/apple_tech-talks_111374.html`, `text/apple_tech-talks_111374.txt` |
| 3c | Apple, "Optimize GPU renderers with Metal" (WWDC23 session 10127, Gauri Jog) | https://developer.apple.com/videos/play/wwdc2023/10127/ | As 3a. | `raw/apple_wwdc2023_10127.html`, `text/apple_wwdc2023_10127.txt` |

## Reading notes (what was read, and how)

- Fatahalian 2010: all 72 slides. CS149 lecture 7: all 74 slides (slides 1–45 are history and CUDA basics; 46–72 are
  the V100 SM, warps, scheduling).
- Giesen: all 13 post bodies in full. The reader comments were searched for registers, occupancy, branches,
  latency, spills and uber shaders; the author's replies that hit are quoted in KNOWLEDGE.md. Parts 5, 10, 11 and 12
  (clipping, geometry shaders, stream-out, tessellation) were read but do not apply to a full-screen ray march.
- Apple: the three transcripts in full.

## Not obtained / substitutions

- The University of Washington copy of Fatahalian's 2011 deck (`courses.cs.washington.edu/.../05_gpuArchShaderCores_BPS_2011.pdf`)
  sits behind a UW login. Not used; the 2010 deck from the Archive is the same talk, a year earlier.
- The 2009 version of the talk (`s09.idav.ucdavis.edu/talks/02_kayvonf_gpuArchTalk09.pdf`): the host timed out
  and the Archive rate-limited us (HTTP 429). Not needed: the 2010 deck covers the same three ideas.
- Apple's Metal Feature Set Tables (SIMD-group width, threadgroup limits) were **not** fetched, to stay within the
  brief's three Apple items. Nothing below quotes a SIMD width from Apple; the 32-wide group is the brief's figure
  (and CS149's for NVIDIA warps). The `apple-metal` topic folder is the place for the tables.
- I swapped the WWDC20 "Optimize Metal apps and games with GPU counters" (10603) out for 3a after reading 3b,
  because 3a is Apple's own description of how registers and occupancy work on M3-class shader cores, which the
  brief's question needs. 10603 was downloaded and then deleted; it was not read for this file.
- None of the sources is about the M5 specifically. 3a and 3b describe "Apple family 9" (M3, A17 Pro). That the
  M5 keeps those mechanisms is an assumption, flagged wherever it matters.
