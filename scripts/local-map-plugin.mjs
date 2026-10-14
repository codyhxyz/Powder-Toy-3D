import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { CRUELTY_PROFILES } from '../src/world/import/crueltyProfiles.js';

// Local game-derived imports are served ONLY by Vite's dev server. Keeping
// them outside public/ ensures Vite never copies these assets into dist/.
export function localMapPlugin() {
  return {
    name: 'local-user-map', apply: 'serve',
    configureServer(server) {
      const root = resolve(server.config.root, '.tmp-cruelty-import');
      const files = Object.fromEntries(CRUELTY_PROFILES.filter((p) => !p.blocked).flatMap((p) => ['json', 'bin'].map((extension) => [`/local-maps/${p.id}.${extension}`, `${p.id}.${extension}`])));
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split('?')[0];
        if (!pathname?.startsWith('/local-maps/')) return next();
        const file = Object.hasOwn(files, pathname) ? files[pathname] : null;
        if (!file || !['GET', 'HEAD'].includes(req.method)) { res.statusCode = 404; res.end(); return; }
        try {
          const path = await realpath(resolve(root, file));
          if (dirname(path) !== await realpath(root)) { res.statusCode = 404; res.end(); return; }
          const info = await stat(path);
          if (!info.isFile()) { res.statusCode = 404; res.end(); return; }
          res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
          res.setHeader('Content-Length', info.size);
          res.setHeader('Cache-Control', 'no-store');
          if (req.method === 'HEAD') { res.end(); return; }
          const stream = createReadStream(path);
          stream.on('error', () => res.destroy());
          res.on('close', () => stream.destroy());
          stream.pipe(res);
        } catch (error) {
          if (error.code === 'ENOENT') { res.statusCode = 404; res.end(); }
          else next(error);
        }
      });
    },
  };
}
