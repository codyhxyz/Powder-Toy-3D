import BAKE from 'virtual:world-bake';
import { useWorldBake, useStructureWorker } from './bake.js';

// The browser's half of world/bake.js: the build's bake (null when the plugin
// found it stale), and a worker that places structures off the main thread.
// Imported by the app before it makes a world; node tools never import it,
// so they compute everything themselves.
useWorldBake(BAKE);
useStructureWorker((P) => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./structuresWorker.js', import.meta.url), { type: 'module' });
  const done = () => worker.terminate();
  worker.onmessage = ({ data }) => { done(); if (data.ok) resolve(data.list); else reject(new Error(data.error)); };
  worker.onerror = (e) => { done(); reject(new Error(e.message || 'the structures worker failed to start')); };
  worker.postMessage({ P, bake: BAKE });
}));
