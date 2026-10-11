// A private Vite dev server for one tool run (docs/webgpu.md I1): Vite's JS
// API on 127.0.0.1, a port nobody else holds, `strictPort` so the tool never
// attaches to another session's server, no file watching and no HMR (a reload
// in the middle of a run would restart the page). Close it in `finally`.
//
//   const vite = await startVite({ harness: true });
//   try { await page.goto(vite.url('/tools/harness/foundation.html')); } finally { await vite.close(); }
//
// The port is `port`, else --port N on the command line, else TPT_VITE_PORT,
// else one the OS hands out (a tool that starts two servers passes `port` to
// the second). `harness: true` serves the harness pages (tools/harness/) in
// Vite's 'harness' mode, which bakes the World only when a page imports it
// (vite.config.js): most don't, and the bake costs a CPU for a while.
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A port the OS says is free right now on 127.0.0.1. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** The --port argument of this process, or null. */
export function argPort(argv = process.argv) {
  const i = argv.indexOf('--port');
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : null;
}

/**
 * Starts a Vite dev server rooted at the repository.
 * @param {{ port?: number, harness?: boolean, quiet?: boolean }} [opts]
 * @returns {Promise<{ port: number, origin: string, url: (path?: string) => string, close: () => Promise<void> }>}
 */
export async function startVite({ port, harness = false, quiet = true } = {}) {
  const { createServer } = await import('vite');
  port ??= argPort() ?? (process.env.TPT_VITE_PORT ? Number(process.env.TPT_VITE_PORT) : await freePort());
  const server = await createServer({
    root: ROOT,
    configFile: join(ROOT, 'vite.config.js'),
    mode: harness ? 'harness' : 'development',
    logLevel: quiet ? 'warn' : 'info',
    clearScreen: false,
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null },
  });
  await server.listen();
  // WebGPU needs a secure origin: http://127.0.0.1 and http://localhost are secure
  const origin = `http://127.0.0.1:${port}`;
  return {
    port,
    origin,
    url: (path = '/') => origin + (path.startsWith('/') ? path : `/${path}`),
    close: () => server.close(),
  };
}
