// A Vite plugin that ships the World's build-time bake (scripts/world-bake.mjs,
// src/world/bake.js) as the virtual module 'virtual:world-bake'.
//
// The bake runs in a child process (a fresh module graph each time) when the
// build or the dev server starts, and in dev again whenever a file it depends
// on changes. The module exports the bake only when its key is the key of the
// sources as they are now (recomputed from the files on every load), else
// null, so an edit since the bake can never hand a page stale results: the
// page computes them itself until the next bake lands.

import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bakeKey, sourceClosure } from './world-bake.mjs';

const ID = 'virtual:world-bake';
const RESOLVED = `\0${ID}`;
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'world-bake.mjs');
const MAX_OUTPUT = 1 << 24;   // bytes of JSON the bake may print

export function worldBakePlugin() {
  let pending = null, server = null, closure = new Set();
  const bake = () => (pending = new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], { maxBuffer: MAX_OUTPUT }, (err, out) => {
      if (err) { console.warn(`[world-bake] the bake failed, pages will compute it: ${err.message}`); resolve(null); return; }
      const b = JSON.parse(out);
      closure = new Set(b.files.map((f) => path.resolve(f)));
      resolve(b);
    });
  }));
  const invalidate = () => {
    const mod = server?.moduleGraph.getModuleById(RESOLVED);
    if (mod) server.moduleGraph.invalidateModule(mod);
  };
  return {
    name: 'world-bake',
    configureServer(s) { server = s; },
    buildStart() { if (!pending) bake(); },
    resolveId(id) { return id === ID ? RESOLVED : null; },
    async load(id) {
      if (id !== RESOLVED) return null;
      const b = await (pending ?? bake());
      const fresh = b && b.key === bakeKey(b.size, b.seed, sourceClosure());
      const { files, ...data } = b ?? {};
      return `export default ${fresh ? JSON.stringify(data) : 'null'};\n`;
    },
    // dev: a file the bake depends on changed: the module serves null at once, and the new bake when it lands
    handleHotUpdate({ file }) {
      if (!closure.has(path.resolve(file))) return;
      invalidate();
      bake().then(invalidate);
    },
  };
}
