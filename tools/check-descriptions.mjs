// CPU check: every spawn-menu tile's desc (the hover card) is written in The
// Powder Toy's voice (docs/elements.md, "Descriptions: The Powder Toy's
// voice"): the item's name first, then flat facts, each a sentence. Elements,
// brush tools, spawners, constructions, first-person gear and starter wands
// alike. No GPU, no browser: run it after adding or rewording a tile.
//
//   node tools/check-descriptions.mjs
import { ELEMENTS, TOOLS, BUILDS, GEAR_ITEMS, WAND_STARTERS } from '../src/elements.js';

// What may follow the name: TPT writes "Sand, Heavy particles.", "Diamond.
// Indestructible." and "Plasma, extremely hot." alike.
const AFTER_NAME = /^[.,:]\s/;
const SENTENCE_END = /[.!?)]$/;

const items = [...ELEMENTS, ...TOOLS, ...BUILDS, ...GEAR_ITEMS, ...WAND_STARTERS];
const bad = [];
for (const it of items) {
  const d = it.desc ?? '';
  if (!d) bad.push(`${it.key}: no desc`);
  else if (!d.startsWith(it.name) || !AFTER_NAME.test(d.slice(it.name.length))) bad.push(`${it.key}: starts "${d.slice(0, 40)}", not with its name "${it.name}" and a stop or comma`);
  else if (!SENTENCE_END.test(d)) bad.push(`${it.key}: doesn't end a sentence: "...${d.slice(-30)}"`);
  else if (/\s{2,}/.test(d) || d !== d.trim()) bad.push(`${it.key}: stray whitespace`);
}
if (bad.length) {
  console.error(`${bad.length} desc(s) break the rule (docs/elements.md, "Descriptions"):\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log(`descriptions: all ${items.length} tiles start with their name (${ELEMENTS.length} elements, ${TOOLS.length} tools, ${BUILDS.length} constructions, ${GEAR_ITEMS.length} gear, ${WAND_STARTERS.length} wands)`);
