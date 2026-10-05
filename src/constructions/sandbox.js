import { EXEC_TIMEOUT_MS } from './runtime.js';

// Run untrusted construction code in a throwaway worker (exec-worker.js) and
// stop it if it runs too long. Resolves to { cells, report }.

const WORKER_START_MS = 2000; // grace for loading the worker's modules

export function execSandboxed(code, { size, seed, maxSpan }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./exec-worker.js', import.meta.url), { type: 'module' });
    const done = () => { clearTimeout(timer); worker.terminate(); };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`The code ran longer than ${EXEC_TIMEOUT_MS / 1000} s and was stopped.`));
    }, EXEC_TIMEOUT_MS + WORKER_START_MS);
    worker.onmessage = (e) => {
      done();
      if (e.data.ok) resolve({ cells: e.data.cells, report: e.data.report });
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => { done(); reject(new Error(e.message || 'The sandbox failed to start.')); };
    worker.postMessage({ code, size, seed, maxSpan });
  });
}
