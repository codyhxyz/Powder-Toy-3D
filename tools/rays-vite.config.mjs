// Vite config for tools/rays-gpu.mjs. Until branch `farids` lands, shaders/far.js
// refuses more than 32 element ids at import, and the radioactive elements make
// 33: this serves it with that refusal turned into a warning, for a box-mode
// test only (the far field draws only in World). The repo's far.js is untouched.
//   npx vite --config tools/rays-vite.config.mjs --port 5417 --strictPort
import { fileURLToPath } from 'node:url';

export default {
  root: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [{
    name: 'far-id-cap-warn',
    transform(code, id) {
      if (!id.endsWith('/src/shaders/far.js')) return null;
      return code.replace('throw new Error(`far.js: ', 'console.warn(`far.js (test server, cap not enforced): ');
    },
  }],
};
