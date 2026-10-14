import assert from 'node:assert/strict';
import { BOOT_RETRY, bootModuleRecovery, refreshBootFiles } from '../src/bootRecovery.js';
import { appPreloadPlugin } from '../scripts/app-preload-plugin.mjs';

const failed = new TypeError('Failed to fetch dynamically imported module: https://tpt3d.codyh.xyz/assets/app-old.js');
const pick = { href: 'https://tpt3d.codyh.xyz/', map: 'island', mode: 'slayer' };
const recovery = bootModuleRecovery(failed, pick, 123);
assert(recovery.automatic);
const url = new URL(recovery.href);
assert.equal(url.searchParams.get('map'), 'island');
assert.equal(url.searchParams.get('mode'), 'slayer');
assert.equal(url.searchParams.get(BOOT_RETRY), '123');
assert(!bootModuleRecovery(failed, { ...pick, href: recovery.href }, 124).automatic, 'never reload in a loop');

const link = 'https://tpt3d.codyh.xyz/?join=ABCD&size=world&map=volcano&mode=slayer#camera';
const direct = new URL(bootModuleRecovery(failed, { href: link }, 456).href);
for (const [key, value] of new URL(link).searchParams) assert.equal(direct.searchParams.get(key), value);
assert.equal(direct.hash, '#camera');
assert(!bootModuleRecovery(failed, { ...pick, save: new Uint8Array([1]) }).automatic, 'do not discard an imported save');
assert(!bootModuleRecovery(failed, { ...pick, save: 'local-save-id' }).automatic);
assert(!bootModuleRecovery(failed, { ...pick, running: true }).automatic, 'do not auto-reload a running game');

for (const message of [
  'error loading dynamically imported module: https://example.com/app.js',
  'Importing a module script failed.',
  'Load failed',
  'Unable to preload CSS for /assets/app-old.css',
]) assert(bootModuleRecovery(new TypeError(message), pick)?.automatic, message);
for (const error of [
  new Error('GPU device lost'),
  new SyntaxError('Unexpected token'),
  new TypeError('Cannot read properties of undefined'),
  new TypeError('Failed to fetch'), // unrelated API/network request inside module evaluation
]) assert.equal(bootModuleRecovery(error, pick), null, error.message);
console.log('PASS: bounded module reload, browser error variants, selection/link preservation, save/game safety, unrelated errors');

const files = { modules: ['/assets/app.js'], styles: ['/assets/app.css'], retry: ['/assets/app.js', '/assets/shot.js'] };
const requests = [], consumed = [];
await refreshBootFiles(files, async (href, options) => {
  requests.push([href, options.cache]);
  return { ok: true, headers: new Headers({ 'content-type': 'application/javascript' }), arrayBuffer: async () => { consumed.push(href); } };
});
assert.deepEqual(requests, [['/assets/app.js', 'reload'], ['/assets/app.css', 'reload'], ['/assets/shot.js', 'reload']]);
assert.deepEqual(consumed, requests.map(([href]) => href), 'wait for complete response bodies');
await refreshBootFiles(null, () => assert.fail('development has no manifest'));
for (const fetchFile of [
  async () => { throw new TypeError('Failed to fetch'); },
  async () => ({ ok: false, status: 404 }),
  async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/html' }) }),
  async () => ({ ok: true, headers: new Headers(), arrayBuffer: async () => { throw new TypeError('Load failed'); } }),
]) {
  await assert.rejects(() => refreshBootFiles(files, fetchFile), error => {
    assert(bootModuleRecovery(error, { ...pick, href: recovery.href }));
    assert(!bootModuleRecovery(error, { ...pick, href: recovery.href }).automatic);
    assert(error.cause);
    return true;
  });
}
console.log('PASS: bypass poisoned caches; network, HTTP, HTML and interrupted-body failures offer manual retry');

const chunk = (fileName, imports = [], dynamicImports = []) => ({
  type: 'chunk', fileName, imports, dynamicImports, code: '', viteMetadata: { importedCss: new Set() },
});
const bundle = {
  'app.js': { ...chunk('app.js', ['shared.js'], ['shot.js']), facadeModuleId: '/src/app.js' },
  'shared.js': chunk('shared.js'),
  'shot.js': chunk('shot.js', ['app.js'], ['physics.js']),
  'physics.js': chunk('physics.js'),
};
const plugin = appPreloadPlugin();
plugin.configResolved({ base: '/' });
const list = JSON.parse(plugin.transformIndexHtml.handler('<html></html>', { bundle }).tags[0].children);
assert.deepEqual(list.modules, ['/app.js', '/shared.js'], 'normal preload does not download optional features');
assert.deepEqual(list.retry, ['/app.js', '/shared.js', '/shot.js', '/physics.js'], 'retry repairs transitive optional imports too');
console.log('PASS: retry-only optional graph; normal preload unchanged; cycles terminate');
