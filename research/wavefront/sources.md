# Sources: wavefront / megakernel split

All retrieved 2026-10-25 with `curl` (author- or publisher-hosted, free), converted with `pdftotext -layout`.
Raw PDFs in `raw/`, text in `text/` (both git-ignored). Every file was read in full.

| # | Source | URL | Cached as | Availability |
|---|---|---|---|---|
| 1 | Laine, Karras, Aila. "Megakernels Considered Harmful: Wavefront Path Tracing on GPUs". HPG 2013 | https://research.nvidia.com/sites/default/files/pubs/2013-07_Megakernels-Considered-Harmful/laine2013hpg_paper.pdf | `raw/laine2013hpg_paper.pdf`, `text/laine2013hpg_paper.txt` | NVIDIA Research, author-hosted. 7 pages. Text complete (two-column order checked against the plain `pdftotext` output) |
| 2 | Aila, Laine. "Understanding the Efficiency of Ray Traversal on GPUs". HPG 2009 | https://research.nvidia.com/sites/default/files/pubs/2009-08_Understanding-the-Efficiency/aila2009hpg_paper.pdf | `raw/aila2009hpg_paper.pdf`, `text/aila2009hpg_paper.txt` | NVIDIA Research, author-hosted |
| 3 | Aila, Laine, Karras. "Understanding the Efficiency of Ray Traversal on GPUs – Kepler and Fermi Addendum". NVIDIA Tech Report NVR-2012-02 (HPG 2012 poster) | https://research.nvidia.com/sites/default/files/pubs/2012-06_Understanding-the-Efficiency/nvr-2012-02.pdf | `raw/nvr-2012-02.pdf`, `text/nvr-2012-02.txt` | NVIDIA Research, author-hosted. 4 pages |
| 4 (extra) | Wald. "Active Thread Compaction for GPU Path Tracing". HPG 2011, pp. 51–58 | https://diglib.eg.org/bitstreams/13ec1e67-e5a9-4435-856e-5b9bf32288e9/download (record: https://diglib.eg.org/handle/10.2312/14908) | `raw/wald2011hpg_active_thread_compaction.pdf`, `text/wald2011hpg_active_thread_compaction.txt` | Eurographics Digital Library, free download. Cited by [1] (§2) as the work on compaction vs idle threads. Chosen because it measures exactly "compact the live rays or leave idle lanes masked" |
| 5 (extra) | Padilla, Webster, Kim. "Megakernel vs Wavefront GPU Path Tracing". arXiv:2605.27323v1, 26 May 2026 | https://arxiv.org/pdf/2605.27323 | `raw/arxiv2605.27323.pdf`, `text/arxiv2605.27323.txt` | arXiv, free. A follow-up that cites [1], not cited by it. Weak evidence: one scene, one GPU (RTX 3060 Ti), 4 pages, reads like a course project. Used only for "does wavefront still pay on a modern GPU" |

Not fetched (over the 2-extra limit): van Antwerpen 2011 (HPG, "Improving SIMD efficiency for parallel Monte Carlo
light transport on the GPU"), Hoberock et al. 2009 ("Stream compaction for deferred shading"), Novák et al. 2010
(path regeneration), Aila & Karras 2010 ("Architecture considerations for tracing incoherent rays"). [1] and [4]
summarise what they need from them, quoted in KNOWLEDGE.md. The 2012 addendum's kernels were at a
code.google.com URL, which no longer exists. Not needed.
