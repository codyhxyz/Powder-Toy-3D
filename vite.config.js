import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import { worldBakePlugin } from './scripts/world-bake-plugin.mjs';
import { appPreloadPlugin } from './scripts/app-preload-plugin.mjs';

// Vite's defaults, plus the World's build-time bake (scripts/world-bake-plugin.mjs),
// the start menu's list of what to preload (scripts/app-preload-plugin.mjs), and
// WebAssembly's ESM integration (vite-plugin-wasm) for Rapier's binary .wasm
// (@dimforge/rapier3d-simd imports it as a module; it ships as a file of its
// own, fetched and compiled as it streams, on the first vehicle).
export default defineConfig({
  plugins: [wasm(), worldBakePlugin(), appPreloadPlugin()],
});
