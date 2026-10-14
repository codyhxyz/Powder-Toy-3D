// The loading screen's "This is you." still (src/ui/menu.js), shown until the live
// one (src/ui/youViewer.js) is up: the selected body, rendered once on the GPU by
// tools/you-portrait.page.js and saved as a transparent WebP at public/you.webp.
// Rerun after changing the body's model or the hat.
// Needs a dev server: `node_modules/.bin/vite --port 5611 --strictPort`, then
// usage: node tools/you-portrait.mjs [--port 5611] [--character real|stick|spartan] [--png path]
// --character also accepts a comma-separated list, baked in one GPU slot.
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchBrowser, newTestPage } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5611');
const keepPng = opt('png', null);
const characters = opt('character', 'real').split(',');
if (characters.some((c) => !['real', 'stick', 'spartan'].includes(c))) throw new Error('Unknown character');

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
  // A blank same-origin page: neither the game nor menu preloading needs the GPU.
  await page.route('**/__portrait', (route) => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto(`http://localhost:${port}/__portrait`);
  for (const character of characters) {
    const OUT = join(new URL('..', import.meta.url).pathname, `public/you${character === 'real' ? '' : `-${character}`}.webp`);
    const url = await page.evaluate(async ([w, h, character]) => {
      const { render } = await import('/tools/you-portrait.page.js');
      return render({ width: w, height: h, character });
    }, [W * SUPERSAMPLE, H * SUPERSAMPLE, character]);
    if (errs.length) throw new Error(errs.join('\n'));
    const dir = mkdtempSync(join(tmpdir(), 'you-portrait-'));
    try {
      const big = join(dir, 'big.png'), small = join(dir, 'small.png');
      writeFileSync(big, Buffer.from(url.split(',')[1], 'base64'));
      if (keepPng) writeFileSync(keepPng, Buffer.from(url.split(',')[1], 'base64'));
      execFileSync('magick', [big, '-filter', 'Lanczos', '-resize', `${W}x${H}`, small]);
      execFileSync('cwebp', ['-quiet', '-q', String(QUALITY), '-alpha_q', '100', '-exact', small, '-o', OUT]);
    } finally {
      rmSync(dir, { recursive: true });
    }
    console.log(`${W}×${H} → ${OUT}`);
  }
} finally {
  await browser.close();
}
