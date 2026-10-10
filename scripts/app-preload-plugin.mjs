// A Vite plugin that tells the start menu what the game is made of, so the
// page can fetch it while the menu is up (src/preload.js). The built
// index.html gets a JSON list: the app chunk (src/app.js, which src/main.js
// imports on Start), the chunks and CSS it imports, and the workers it starts.
// The dev server has no bundle, so it gets no list and the game loads on Start.

export const PRELOAD_LIST = 'app-preload';   // the list's element id (src/preload.js reads it)

export function appPreloadPlugin({ entry = 'src/app.js' } = {}) {
  let base = '/';
  return {
    name: 'app-preload',
    apply: 'build',
    configResolved(config) { base = config.base; },
    transformIndexHtml: {
      order: 'post',
      handler(html, { bundle }) {
        const app = Object.values(bundle ?? {}).find((f) => f.type === 'chunk' && f.facadeModuleId?.replaceAll('\\', '/').endsWith(`/${entry}`));
        if (!app) { console.warn(`[app-preload] no chunk for ${entry}: the menu will not preload the game`); return html; }
        // the app chunk and every chunk it imports, but not the page's own (already loaded)
        const chunks = new Map();
        const walk = (c) => {
          if (chunks.has(c.fileName)) return;
          chunks.set(c.fileName, c);
          for (const f of c.imports) walk(bundle[f]);
        };
        walk(app);
        const loaded = [...chunks.values()].filter((c) => !c.isEntry);
        const styles = new Set(loaded.flatMap((c) => [...(c.viteMetadata?.importedCss ?? [])]));
        // workers: the scripts the chunks name as files (new Worker(new URL('./x.js', import.meta.url)))
        const workers = Object.values(bundle).filter((f) => f.type === 'asset' && f.fileName.endsWith('.js')
          && loaded.some((c) => c.code.includes(f.fileName)));
        const list = {
          modules: loaded.map((c) => base + c.fileName),
          styles: [...styles].map((f) => base + f),
          workers: workers.map((f) => base + f.fileName),
        };
        return { html, tags: [{ tag: 'script', attrs: { type: 'application/json', id: PRELOAD_LIST }, children: JSON.stringify(list), injectTo: 'body' }] };
      },
    },
  };
}
