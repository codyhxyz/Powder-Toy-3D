// Rapier in node: the package the game ships (@dimforge/rapier3d-simd), for
// the CPU-only checks. Its modules are written for a bundler: imports without
// extensions ("./exports", "./dynamics") and the .wasm imported as a module
// (WebAssembly's ESM integration, which vite-plugin-wasm provides in the
// build). Node 22 does neither, so two module hooks fill in: the extensions,
// and in place of rapier_wasm3d.js the same glue the plugin generates (compile
// the .wasm with the bindings' module as its imports, hand it the instance).
// usage: import RAPIER from './rapier-node.mjs';   (initialised; no init())
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PKG = '/node_modules/@dimforge/rapier3d-simd/';
const inPkg = (url) => typeof url === 'string' && url.startsWith('file:') && url.includes(PKG);
const GLUE = `
import { readFileSync } from 'node:fs';
import * as bg from './rapier_wasm3d_bg.js';
const bytes = readFileSync(new URL('./rapier_wasm3d_bg.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(bytes, { './rapier_wasm3d_bg.js': bg });
bg.__wbg_set_wasm(instance.exports);
export * from './rapier_wasm3d_bg.js';
`;

registerHooks({
  resolve(specifier, context, next) {
    if (inPkg(context.parentURL) && specifier.startsWith('.') && !/\.(js|wasm)$/.test(specifier)) {
      const base = new URL(specifier, context.parentURL).href;
      return next(existsSync(fileURLToPath(`${base}.js`)) ? `${base}.js` : `${base}/index.js`, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!inPkg(url)) return next(url, context);
    if (url.endsWith('/rapier_wasm3d.js')) return { format: 'module', source: GLUE, shortCircuit: true };
    return { ...next(url, { ...context, format: 'module' }), format: 'module' };   // the package has no "type": "module"
  },
});

const RAPIER = (await import('@dimforge/rapier3d-simd/rapier.js')).default;   // its entry is "module", which node doesn't read
export default RAPIER;
