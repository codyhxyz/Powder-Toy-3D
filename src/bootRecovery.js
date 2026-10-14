// Reload the document, not the failed import: browsers remember rejected modules.
export const BOOT_RETRY = '__boot_retry';

export function bootModuleRecovery(error, { href, map, mode, save, running }, now = Date.now()) {
  const message = String(error?.message ?? error);
  if (!/Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS for/i.test(message)
      && !(error?.name === 'TypeError' && message === 'Load failed')) return null;
  const url = new URL(href);
  const automatic = !url.searchParams.has(BOOT_RETRY) && save == null && !running;
  if (map) {
    url.searchParams.set('map', map);
    url.searchParams.set('mode', mode ?? 'sandbox');
  }
  url.searchParams.set(BOOT_RETRY, String(now));
  return { automatic, href: url.href };
}

// Only after a failed boot: replace cached error/HTML responses before import.
// A document reload alone still trusts immutable asset URLs.
export async function refreshBootFiles(list, fetchFile = fetch) {
  if (!list) return;
  const files = new Set([...list.modules, ...list.styles, ...(list.retry ?? [])]);
  await Promise.all([...files].map(async (href) => {
    try {
      const response = await fetchFile(href, { cache: 'reload' });
      if (!response.ok || response.headers.get('content-type')?.includes('text/html')) {
        throw new Error(`Invalid game-file response (${response.status})`);
      }
      await response.arrayBuffer(); // finish the HTTP-cache write before import()
    } catch (cause) {
      throw new TypeError(`Failed to fetch dynamically imported module: ${href}`, { cause });
    }
  }));
}
