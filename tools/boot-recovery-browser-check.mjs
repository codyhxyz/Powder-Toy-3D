// npm run build && node tools/boot-recovery-browser-check.mjs
// Actual built entry + HTTP cache. Stub only app.js, so no simulation runs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, extname } from 'node:path';
import { launchBrowser, newTestContext } from './browser.mjs';

const dist = resolve('dist'), html = readFileSync(resolve(dist, 'index.html'), 'utf8');
const manifest = JSON.parse(html.match(/<script[^>]*id="app-preload"[^>]*>(.*?)<\/script>/s)[1]);
const appPath = manifest.modules.find(p => /\/app-[^/]+\.js$/.test(p));
assert(appPath, 'production manifest contains the app module');
assert(existsSync(resolve(dist, '404.html')), 'disable Pages SPA fallback for missing assets');
let state;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/') {
    state.documents++;
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
    res.end(html);
    return;
  }
  if (path === appPath) {
    state.requests.push({ cache: req.headers['cache-control'] ?? '', pragma: req.headers.pragma ?? '' });
    if (state.broken && (state.persistent || state.requests.length === 1)) {
      // Pages' old missing-file behavior: a successful HTML response cached
      // immutably under a JavaScript URL. A plain reload cannot repair it.
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.end('<!doctype html><title>Wrong cached response</title>');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.end(state.runtimeError
        ? 'throw new TypeError("Unrelated app bug");'
        : 'window.__moduleTestBooted = true; export const current = () => ({});');
    }
    return;
  }
  const file = resolve(dist, `.${path}`);
  if (!file.startsWith(dist + '/') || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  const type = { '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' }[extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser, launchedAt, slotAt, checksDone;
const launchAt = Date.now();
try {
  browser = await launchBrowser();
  launchedAt = Date.now();
  const slot = resolve(homedir(), '.cache/tpt-headless/slot');
  if (Number(readFileSync(slot, 'utf8')) === process.pid) slotAt = statSync(slot).mtimeMs;
  const origin = `http://127.0.0.1:${server.address().port}`;
  const run = async (config, test) => {
    state = { documents: 0, requests: [], ...config };
    const context = await newTestContext(browser, { mode: 'ui' });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?map=empty&mode=sandbox&join=KEEP#view`);
      await test(page);
    } finally { await context.close(); }
  };
  await run({ broken: true }, async page => {
    await page.waitForFunction(() => window.__moduleTestBooted, null, { timeout: 30000 });
    assert.equal(state.documents, 2, 'exactly one automatic document reload');
    assert.equal(state.requests.length, 2, 'retry replaces the poisoned HTTP-cache entry');
    assert(/no-cache|max-age=0/.test(state.requests[1].cache) || state.requests[1].pragma === 'no-cache');
    const url = new URL(page.url());
    assert.equal(url.searchParams.get('map'), 'empty');
    assert.equal(url.searchParams.get('join'), 'KEEP');
    assert.equal(url.hash, '#view');
    console.log('PASS: real cached-HTML module failure recovered with one reload; selection/link preserved');
  });
  await run({ broken: true, persistent: true }, async page => {
    await page.locator('#error button').waitFor({ timeout: 30000 });
    assert.equal(state.documents, 2, 'persistent failure stops after one automatic retry');
    assert.match(await page.locator('#error').innerText(), /game files could not be downloaded/);
    state.broken = false;
    await page.getByRole('button', { name: 'Reload page' }).click();
    await page.waitForFunction(() => window.__moduleTestBooted, null, { timeout: 30000 });
    assert.equal(state.documents, 3, 'explicit retry works after connection recovers');
    console.log('PASS: persistent error offers manual recovery without a reload loop');
  });
  await run({ runtimeError: true }, async page => {
    await page.waitForFunction(() => document.getElementById('error')?.textContent.includes('Unrelated app bug'));
    assert.equal(state.documents, 1, 'unrelated module evaluation error does not trigger reload');
    console.log('PASS: ordinary code errors remain visible, not disguised as download failures');
  });
} finally {
  checksDone = Date.now();
  await browser?.close();
  await new Promise(r => server.close(r));
  console.log('TIMING', JSON.stringify({
    launchAndGuardMs: (launchedAt ?? checksDone) - launchAt,
    checksMs: launchedAt ? checksDone - launchedAt : 0,
    slotOccupancyMs: slotAt ? Math.ceil(Date.now() - slotAt) : null,
    simulationSteps: 0, shaderCompiles: 0, browserStarted: !!browser,
  }));
}
