import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import { worldBakePlugin } from './scripts/world-bake-plugin.mjs';
import { appPreloadPlugin } from './scripts/app-preload-plugin.mjs';
import { localMapPlugin } from './scripts/local-map-plugin.mjs';

// Vite's defaults, plus the World's build-time bake (scripts/world-bake-plugin.mjs),
// the start menu's list of what to preload (scripts/app-preload-plugin.mjs), and
// WebAssembly's ESM integration (vite-plugin-wasm) for Rapier's binary .wasm
// (@dimforge/rapier3d-simd imports it as a module; it ships as a file of its
// own, fetched and compiled as it streams, on the first vehicle).
//
// The dev server also serves the GPU harness pages (tools/harness/*.html,
// docs/webgpu.md I1) like any file under the root. The build ships the game
// (index.html) and the v2 raster bench (bench/raster.html, a standalone page
// that imports nothing from src/: dist/bench/raster.html), so no harness page
// reaches dist/. Mode
// 'harness' (tools/vite-server.mjs) bakes the World only when a page imports
// 'virtual:world-bake' (a world harness page), not when the server starts:
// most harness pages never import it, and the bake keeps a CPU busy a while.
export default defineConfig(({ mode }) => ({
  plugins: [wasm(), mode === 'harness' ? lazyBake(worldBakePlugin()) : worldBakePlugin(), gameOnly(appPreloadPlugin()), localMapPlugin()],
  optimizeDeps: {
    // harness mode: scan only the harness pages for dependencies to pre-bundle (the game imports the bake)
    ...(mode === 'harness' ? { entries: ['tools/harness/*.html'] } : {}),
    // fengari (the console's Lua, src/console/lua.js) reads process.env.FENGARICONF
    // as it loads; the build replaces process.env, the dev server's pre-bundle
    // doesn't, and the browser has no process: no config means its defaults
    rolldownOptions: { transform: { define: { 'process.env.FENGARICONF': 'undefined' } } },
  },
  build: {
    rollupOptions: { input: { main: 'index.html', raster: 'bench/raster.html' } },
    // fonts stay files (src/fonts.css): a small subset inlined into the page's
    // CSS would be downloaded by every visitor, needed or not
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
  },
}));

// The bake plugin without its eager start: its load() bakes on first use.
function lazyBake(plugin) {
  const { buildStart, ...rest } = plugin;
  return rest;
}

// The start menu's preload list belongs to the game's page: the raster bench
// (bench/raster.html) is standalone and never reads it.
function gameOnly(plugin) {
  const { handler, ...hook } = plugin.transformIndexHtml;
  return { ...plugin, transformIndexHtml: { ...hook, handler: (html, ctx) => (ctx.path === '/index.html' ? handler(html, ctx) : html) } };
}
