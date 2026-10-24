# Big-map distance detail

A big map's volume (the WORLD renderer) draws every cell it has loaded. Behind it,
`world/far.js` draws the far field: a brick-resolution grid of the whole world
(`shaders/far.js`), marched in one full-screen pass after the sky, depth tested but
never written. The volume draws over it wherever it has cells; the coarse grid shows
only where the volume has nothing (a brick not loaded yet, one the page budget
dropped, or past what it asks for). This is the usual LOD and virtual-texture rule:
a missing fine page falls back to a coarser one that is always resident (UE5 virtual
textures, Nanite's root pages; Tanner et al. 1998, "The Clipmap").

- The coarse pass shades opaque ground (its element, the sun through the far shadow
  heights, sky over it), liquids and their beds, the open sea or plain beyond the world,
  and the sky.
- Its lighting group is the window volume's with the far grid, tops and shadow heights
  attached (`FarField.attachVolume`).
- The far grid fills in from the scene a chunk a frame, nearest the window first, and
  follows the window's edits (a leaving slab, a sweep while the simulation changes it).

History: until 2026-10-23 opaque terrain past the window was owned by full-detail
surface meshes built in workers (`world/detail.js`, removed). They were never drawn
behind the WORLD volume, so the coarse pass, which had stopped shading opaque ground
for them (9fef2822), showed sea and sky where land was.
