// A World lighting producer's bind group layouts and compute pipelines, kept per
// device and per source: every lighting transaction makes its producers anew
// (wire/worldRender.js run), and each made new shader modules and pipelines. A
// rebuild froze Descent's page for 11.6 s (real Chrome, 2026-10-22). The layouts
// stay with their pipelines, so a producer's bind groups always match them. A
// failed build is dropped, so the next producer tries again (a lost device's
// successor is a new key anyway).
const caches = new WeakMap();
export function cachedPipelines(device, key, build) {
  let cache = caches.get(device);
  if (!cache) caches.set(device, cache = new Map());
  let entry = cache.get(key);
  if (!entry) {
    entry = build();
    cache.set(key, entry);
    Promise.resolve(entry.ready).catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  }
  return entry;
}
