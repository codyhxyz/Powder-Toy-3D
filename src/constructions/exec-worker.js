// Sandbox worker for construction code from models, players and imported files.
// One worker runs one piece of code and is then thrown away (sandbox.js).
//
// The API key never reaches this worker. Before any untrusted code runs, it
// removes every way out it has: network APIs, storage, nested workers and its
// own postMessage (a private handle is kept for the single reply).

import { execConstruction, cellBuffers } from './runtime.js';
import { lint } from './lint.js';

const reply = self.postMessage.bind(self);
const BLOCKED = ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebTransport', 'EventSource', 'importScripts',
  'indexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker', 'navigator', 'postMessage'];
for (const name of BLOCKED) {
  for (let o = self; o; o = Object.getPrototypeOf(o)) {
    if (!Object.getOwnPropertyDescriptor(o, name)) continue;
    try { Object.defineProperty(o, name, { value: undefined, writable: false, configurable: false }); } catch {
      try { delete o[name]; } catch { /* not removable; the shadowing in runtime.js still hides it */ }
    }
  }
}

// new Function puts two header lines and our "use strict" line above the code.
const HEADER_LINES = 3;
function describe(err) {
  const msg = err?.message ?? String(err);
  const m = /<anonymous>:(\d+):(\d+)/.exec(err?.stack ?? '');
  return m ? `${msg} (line ${Number(m[1]) - HEADER_LINES}, column ${m[2]})` : msg;
}

self.onmessage = (e) => {
  const { code, size, seed, maxSpan } = e.data;
  try {
    const cells = execConstruction(code, { size, seed });
    reply({ ok: true, cells, report: lint(cells, { maxSpan }) }, cellBuffers(cells));
  } catch (err) {
    reply({ ok: false, error: describe(err) });
  }
};
