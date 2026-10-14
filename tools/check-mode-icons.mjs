// CPU-only: the menu silently renders nothing for a missing MODEICONS entry.
// Read the real catalogue so a new gamemode cannot ship without its emblem.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GAMEMODES } from '../src/maps.js';
import { MODEICONS, MODEICON_BOX, MODEICON_CREDIT } from '../src/ui/modeicons.js';

const arity = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const token = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

function validPath(d, key) {
  assert.equal(typeof d, 'string', `${key}: missing SVG path`);
  assert.ok(d.trim(), `${key}: empty SVG path`);
  assert.equal(d.replace(token, '').replace(/[\s,]/g, ''), '', `${key}: invalid SVG tokens`);
  const tokens = d.match(token);
  assert.ok(tokens && /^[Mm]$/.test(tokens[0]), `${key}: path must begin with moveto`);
  let drawn = false;
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++].toUpperCase();
    assert.ok(Object.hasOwn(arity, command), `${key}: expected path command`);
    const values = [];
    while (i < tokens.length && !/^[a-z]$/i.test(tokens[i])) {
      const n = Number(tokens[i++]);
      assert.ok(Number.isFinite(n), `${key}: nonfinite path coordinate`);
      values.push(n);
    }
    const size = arity[command];
    if (size === 0) {
      assert.equal(values.length, 0, `${key}: closepath takes no coordinates`);
      continue;
    }
    assert.ok(values.length > 0 && values.length % size === 0, `${key}: incomplete ${command} command`);
    if (command === 'A') {
      for (let j = 0; j < values.length; j += size) {
        assert.ok(values[j] >= 0 && values[j + 1] >= 0, `${key}: negative arc radius`);
        assert.ok([0, 1].includes(values[j + 3]) && [0, 1].includes(values[j + 4]), `${key}: invalid arc flags`);
      }
    }
    drawn ||= command !== 'M' || values.length > 2;
  }
  assert.ok(drawn, `${key}: path draws no segments`);
}

export function checkModeIcons(modes, icons, credit = MODEICON_CREDIT) {
  // Saves and map-kind icons share the menu's incumbent icon system.
  const keys = new Set([...modes.map(mode => mode.key), 'saves', 'box', 'world', ...Object.keys(icons)]);
  assert.match(credit, /game-icons\.net.*CC BY 3\.0/);
  for (const key of keys) {
    const icon = icons[key];
    assert.ok(icon, `${key}: missing menu icon`);
    validPath(icon.d, key);
    assert.match(icon.src, /^[a-z]+(?:-[a-z]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/, `${key}: missing library source`);
    const author = icon.src.split('/')[0].split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
    assert.equal(icon.by, author, `${key}: missing or incorrect author`);
    assert.ok(credit.includes(icon.by), `${key}: author absent from attribution`);
  }
}

test('every current gamemode and menu utility has a valid credited 512-unit icon', () => {
  assert.equal(MODEICON_BOX, 512);
  checkModeIcons(GAMEMODES, MODEICONS);
  assert.equal(new Set(GAMEMODES.map(mode => MODEICONS[mode.key].src)).size, GAMEMODES.length, 'gamemode emblems must be distinct');
});

test('the original missing emblems are rejected, individually and together', () => {
  const original = { ...MODEICONS };
  for (const key of ['factory', 'crueltySquad', 'animalCrossing']) {
    const missing = { ...MODEICONS };
    delete missing[key];
    delete original[key];
    assert.throws(() => checkModeIcons(GAMEMODES, missing), new RegExp(`${key}: missing menu icon`));
  }
  assert.throws(() => checkModeIcons(GAMEMODES, original), /factory: missing menu icon/);
});

test('future unrepresented gamemodes are rejected', () => {
  assert.throws(() => checkModeIcons([...GAMEMODES, { key: 'futureMode' }], MODEICONS), /futureMode: missing menu icon/);
});

test('empty, malformed, non-drawing and uncredited icons are rejected', () => {
  for (const d of ['', 'M0 0L', 'M0 0L1', 'M0 0X1 2', 'M0 0', 'M0 0A1 1 0 2 0 3 4']) {
    assert.throws(() => checkModeIcons(GAMEMODES, { ...MODEICONS, factory: { ...MODEICONS.factory, d } }));
  }
  for (const field of ['by', 'src']) {
    assert.throws(() => checkModeIcons(GAMEMODES, { ...MODEICONS, factory: { ...MODEICONS.factory, [field]: '' } }));
  }
  assert.throws(() => checkModeIcons(GAMEMODES, MODEICONS, 'Uncredited icons'));
});
