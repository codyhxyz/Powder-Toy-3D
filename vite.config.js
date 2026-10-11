import { defineConfig } from 'vite';
import { worldBakePlugin } from './scripts/world-bake-plugin.mjs';
import { appPreloadPlugin } from './scripts/app-preload-plugin.mjs';

// Vite's defaults, plus the World's build-time bake (scripts/world-bake-plugin.mjs)
// and the start menu's list of what to preload (scripts/app-preload-plugin.mjs).
export default defineConfig({
  plugins: [worldBakePlugin(), appPreloadPlugin()],
  // fonts stay files (src/fonts.css): a small subset inlined into the page's
  // CSS would be downloaded by every visitor, needed or not
  build: { assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined) },
});
