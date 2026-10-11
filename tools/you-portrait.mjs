// The loading screen's "This is you." (src/ui/menu.js): the realistic body in
// his wizard hat and purple boxers, rendered once on the GPU by
// tools/you-portrait.page.js and saved as a transparent WebP at public/you.webp.
// Rerun after changing the body's model or the hat.
// Needs a dev server: `node_modules/.bin/vite --port 5611 --strictPort`, then
// usage: node tools/you-portrait.mjs [--port 5611] [--png path]   (--png: also keep the full-size render)
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchBrowser, newTestPage } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5611');
const keepPng = opt('png', null);
const OUT = join(new URL('..', import.meta.url).pathname, 'public/you.webp');

const SHOWN_W = 260, SHOWN_H = 420;   // CSS px the loading screen shows him at, at most (menu.css .mm-you)
const DENSITY = 2;                     // the file's px per CSS px: sharp on a 2x screen
const SUPERSAMPLE = 2;                 // rendered this much bigger, then scaled down: smooth edges on the hat and hair
const QUALITY = 82;                    // webp quality (alpha kept lossless at its edges by cwebp's -exact)

const W = SHOWN_W * DENSITY, H = SHOWN_H * DENSITY;
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'visual', viewport: { width: 400, height: 300 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  // the bare page is the start menu: no game boots behind it
  await page.goto(`http://localhost:${port}/`);
  const url = await page.evaluate(async ([w, h]) => {
    const { render } = await import('/tools/you-portrait.page.js');
    return render({ width: w, height: h });
  }, [W * SUPERSAMPLE, H * SUPERSAMPLE]);
  if (errs.length) throw new Error(errs.join('\n'));
  const dir = mkdtempSync(join(tmpdir(), 'you-portrait-'));
  const big = join(dir, 'big.png'), small = join(dir, 'small.png');
  writeFileSync(big, Buffer.from(url.split(',')[1], 'base64'));
  if (keepPng) writeFileSync(keepPng, Buffer.from(url.split(',')[1], 'base64'));
  execFileSync('magick', [big, '-filter', 'Lanczos', '-resize', `${W}x${H}`, small]);
  execFileSync('cwebp', ['-quiet', '-q', String(QUALITY), '-alpha_q', '100', '-exact', small, '-o', OUT]);
  rmSync(dir, { recursive: true });
  console.log(`${W}×${H} → ${OUT}`);
} finally {
  await browser.close();
}
