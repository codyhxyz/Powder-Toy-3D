// `npm run harness`: serves the GPU harness pages until interrupted and
// prints their URL (docs/webgpu.md I4, Mac checkpoint M1). The port is
// --port N, else TPT_VITE_PORT, else a free one.
//
// usage: npm run harness [-- --port 5310]
import { startVite } from '../vite-server.mjs';

const vite = await startVite({ harness: true, quiet: false });
console.log(`GPU harness: ${vite.url('/tools/harness/index.html')}`);
console.log('Ctrl-C stops the server.');
const stop = async () => { await vite.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
