// CPU-only regression for the screenshot shortcut and POV key routing, through
// the keymap the handlers and the Controls sheet share (src/keys.js).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KEYS, is } from '../src/keys.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const ev = (key, code = key, o = {}) => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
assert(is(ev('F2'), KEYS.screenshot), 'F2 is the screenshot key');
assert(!is(ev('p', 'KeyP'), KEYS.screenshot) && !is(ev('P', 'KeyP'), KEYS.screenshot), 'P is not');
assert(!is(ev('F2', 'F2', { metaKey: true }), KEYS.screenshot), '⌘F2 is not');
const app = read('../src/app.js'), pov = read('../src/pov/index.js'), hud = read('../src/ui/hud.js');
assert.match(app, /else if \(is\(e, KEYS\.screenshot\)\) \{ e\.preventDefault\(\); if \(!e\.repeat\) actions\.screenshot\(\); \}/, 'app: F2 screenshots once per press');
assert.match(pov, /const PASS_KEYS = \[[^\]]*KEYS\.screenshot[^\]]*\];/, 'F2 passes through the body to the app');
assert.match(hud, /row\('Screenshot', KEYS\.screenshot\)/, 'the Controls sheet shows it');
console.log('PASS: F2 screenshots in god/POV, no repeat downloads, P not bound, help reads the keymap.');
