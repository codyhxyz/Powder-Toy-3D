import { defineConfig } from 'vite';
import { worldBakePlugin } from './scripts/world-bake-plugin.mjs';
import { appPreloadPlugin } from './scripts/app-preload-plugin.mjs';

// Vite's defaults, plus the World's build-time bake (scripts/world-bake-plugin.mjs)
// and the start menu's list of what to preload (scripts/app-preload-plugin.mjs).
export default defineConfig({
  plugins: [worldBakePlugin(), appPreloadPlugin()],
});
