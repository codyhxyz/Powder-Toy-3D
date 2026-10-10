import { defineConfig } from 'vite';
import { worldBakePlugin } from './scripts/world-bake-plugin.mjs';

// Vite's defaults, plus the World's build-time bake (scripts/world-bake-plugin.mjs).
export default defineConfig({
  plugins: [worldBakePlugin()],
});
