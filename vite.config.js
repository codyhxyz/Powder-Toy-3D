import { defineConfig } from 'vite';
import { worldBakePlugin } from './scripts/world-bake-plugin.mjs';
import { appPreloadPlugin } from './scripts/app-preload-plugin.mjs';

// Vite's defaults, plus the World's build-time bake (scripts/world-bake-plugin.mjs)
// and the start menu's list of what to preload (scripts/app-preload-plugin.mjs).
//
// The dev server also serves the GPU harness pages (tools/harness/*.html,
// docs/webgpu.md I1) like any file under the root. The build ships only the
// game: its one input is index.html, so no harness page reaches dist/. Mode
// 'harness' (tools/vite-server.mjs) leaves out the World's bake, which those
// pages never import and which keeps a CPU busy while it runs.
export default defineConfig(({ mode }) => ({
  plugins: [mode === 'harness' ? null : worldBakePlugin(), appPreloadPlugin()].filter(Boolean),
  // harness mode: scan only the harness pages for dependencies to pre-bundle (the game imports the bake)
  optimizeDeps: mode === 'harness' ? { entries: ['tools/harness/*.html'] } : {},
  build: {
    rollupOptions: { input: 'index.html' },
  },
}));
