// Prints the announcer's lines (src/pov/announcer.js LINES) as JSON for the voice
// generator: [{ key, text, file }], one clip per line, saved as
// public/announcer/<KEY>.mp3 (file). The game plays a clip when its file is
// there; without it a medal falls back to the browser's synthesized voice
// (src/game/medalHud.js) and a match line stays silent, so a partial set works.
// usage: node tools/announcer-lines.mjs > lines.json
//        node tools/announcer-lines.mjs --missing   (only the lines with no clip yet)
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LINES } from '../src/pov/announcer.js';

const ROOT = new URL('..', import.meta.url).pathname;
const missing = process.argv.includes('--missing');
const lines = Object.entries(LINES)
  .map(([key, text]) => ({ key, text, file: `public/announcer/${key}.mp3` }))
  .filter((l) => !missing || !existsSync(join(ROOT, l.file)));
console.log(JSON.stringify(lines, null, 2));
