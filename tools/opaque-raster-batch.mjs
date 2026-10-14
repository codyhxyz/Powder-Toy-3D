// Prepared, NOT automatically run. Import into the parent's single guarded
// tools/browser.mjs batch after ready(page), with a parked realistic BOX scene.
// No browser/server is launched here. Call on dry crisp walls first, then on
// partial water/glass/smoke in front of the same walls. Parent owns the page.
// Returns pixel differences and fenced submit-to-completion times, NOT GPU
// timestamps. Do not enable by default unless visuals and total frame cost win.
export async function opaqueRasterAB(page) {
  return page.evaluate(async () => {
    const a = window.__app;
    if (!a?.test || a.settings.view !== 0) throw Error('Requires a test page in realistic view');
    a.test.park();
    const old = { raster: a.vol.opaqueRaster, taa: a.post.settings.taa, adapt: a.post.settings.adapt, auto: a.autoRes.enabled };
    try {
      a.autoRes.enabled = false;
      a.post.settings.taa = false;
      a.post.settings.adapt = false;
      a.vol.opaqueRaster = true;
      await a.test.renderOnce(); // requests this camera's raster variant
      await a.gpu.settled();
      await a.test.renderOnce(); // extracts faces once its compute pipelines exist
      await a.gpu.settled();
      if (!a.view.opaqueRasterDrawn || !a.vol.opaqueRasterStats?.opaque) throw Error('No raster draw: need a box containing opaque faces');
      const shot = async (on) => {
        a.vol.opaqueRaster = on;
        a.test.resetView();
        return a.test.renderOnce({ capture: true });
      };
      const ref = await shot(false), candidate = await shot(true);
      if (ref.data.length !== candidate.data.length) throw Error('A/B target resized');
      let maxByte = 0, sum = 0, changed = 0;
      for (let i = 0; i < ref.data.length; i++) {
        const d = Math.abs(ref.data[i] - candidate.data[i]);
        maxByte = Math.max(maxByte, d); sum += d; changed += d > 2 ? 1 : 0;
      }
      // Restore normal temporal presentation for the cost sample. No physics.
      a.post.settings.taa = old.taa;
      const ms = { reference: [], candidate: [] };
      for (let i = 0; i < 3; i++) for (const on of [false, true]) {
        a.vol.opaqueRaster = on;
        const t = performance.now();
        await a.test.renderOnce();
        ms[on ? 'candidate' : 'reference'].push(performance.now() - t);
      }
      return { maxByte, meanByte: sum / ref.data.length, shareOver2: changed / ref.data.length, ms, faces: a.vol.opaqueRasterStats };
    } finally {
      a.vol.opaqueRaster = old.raster;
      a.post.settings.taa = old.taa;
      a.post.settings.adapt = old.adapt;
      a.autoRes.enabled = old.auto;
      a.test.resetView();
      a.test.park();
    }
  });
}
