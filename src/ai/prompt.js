import { ELEMENTS, E, K } from '../elements.js';
import { MAX_CELLS, MAX_FOOT } from '../constructions/runtime.js';

// The system prompt for AI-written constructions. It is generated from the
// element table and the runtime limits, so it can't drift from what the sim
// does, and it is byte-stable between runs so providers can cache it.

export const MAX_NAME_CHARS = 40; // construction names, from models and players
const WATER_DENSITY = ELEMENTS[E.WATER].dens;
const DEFAULT_MAX_SPAN = 128; // the default grid is 128³
const KIND = { [K.SOLID]: 'solid', [K.POWDER]: 'powder', [K.LIQUID]: 'liquid', [K.GAS]: 'gas' };

function elementTable() {
  const rows = ELEMENTS.filter((e) => e.id !== E.EMPTY).map((e) => {
    const notes = [];
    if (e.kind !== K.SOLID && e.kind !== K.GAS) notes.push(`density ${+(e.dens / WATER_DENSITY).toFixed(2)}× water`);
    if (e.melt) notes.push(`melts at ${e.melt} °C`);
    if (e.ignite) notes.push(`${e.key === 'GUNPOWDER' ? 'explodes' : 'ignites'} at ${e.ignite} °C`);
    if (e.temp !== 20) notes.push(`placed at ${e.temp} °C`);
    return `| ${e.key} | ${KIND[e.kind]} | ${notes.join('; ')} | ${e.desc} |`;
  });
  return ['| Element | Kind | Numbers | Behaviour |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

// relay/ai.js (the free AI proxy) recognises construction requests by this first sentence.
const API = `Your code is the body of a JavaScript function (strict mode). These names are in scope:

- \`put(x, y, z, el, opts)\`: set one cell.
- \`get(x, y, z)\`: what your code has put at a cell so far: an element name, 'AIR', or null.
- \`box(x0, y0, z0, x1, y1, z1, el, opts)\`: filled box, bounds inclusive.
- \`ball(cx, cy, cz, r, el, { sy, rough, holes, ...opts })\`: ellipsoid of radius r; sy squashes it vertically, rough frays the edge (0–1), holes leaves random gaps (0–1).
- \`disc(cx, y, cz, r, el, { rough, holes, ...opts })\`: horizontal disc.
- \`rod(a, b, r, el, opts)\`: thick segment between points a and b ([x, y, z] arrays or vec). r = 0.5 is a one-cell line.
- \`vec(x, y, z)\`: a vector with clone, add, sub, addScaledVector, multiplyScalar, normalize, lerp, cross, dot, length, distanceTo.
- \`bend(dir, angle)\`: dir turned by angle (radians) toward a random perpendicular; for branching.
- \`clamp(v, lo, hi)\`.
- \`footing(depth = ${MAX_FOOT})\`: solid cells on y = 0 grow straight down to the ground (at most ${MAX_FOOT} cells), so the build stands on uneven terrain.
- \`rnd()\`: seeded random number in [0, 1), plus rnd.range(lo, hi), rnd.int(lo, hi) (inclusive) and rnd.pick(array).
- \`T\`: size scale, 1 at the default size, about 0.5 to 3 across the player's size slider.
- \`SIZE\`: the raw size setting (1–24).

\`el\` is an element name from the table below, or 'AIR' to carve empty space (a room, a door, a window opening). \`opts\` is optional: \`{ temp }\` sets the temperature in °C; \`{ ctype }\` names the element a CLONE emits, or what LAVA cools into; \`{ soft: true }\` never overwrites a cell already placed (leaves around branches, fire between logs).

Coordinates are integers (fractions are rounded). y is up; the base sits on y = 0 on whatever surface the player clicks, and nothing may go below y = 0. Centre the build on x = 0, z = 0. The front (door, entrance, face) points toward +z; the game turns it toward the camera. Cells you never set are left as they are in the world.

Scale every dimension with T (\`const W = Math.round(17 * T)\`) so the size slider works, and take every random choice from rnd, never Math.random, so the same seed rebuilds the same thing. Limits: ${MAX_CELLS.toLocaleString('en-US')} cells, and the bounding box must fit the grid (usually ${DEFAULT_MAX_SPAN} cells per side; keep a T = 1 build under about 40).`;

const PHYSICS = `Once placed, every cell is simulated. Build with that in mind:

- Solids (WALL, ROCK, METAL, GLASS, ICE, WOOD, PLANT, CLONE) never move, even unsupported. Anything that must keep its shape is solid.
- Powders fall, pile into slopes and topple diagonally. Rest every powder cell on something, or contain it.
- Liquids flow sideways and down until level. Containers must be watertight with face-connected walls: the sim moves matter in 2×2×2 blocks, so liquid escapes through gaps that touch only at an edge or a corner. A curved wall needs a band at least 1.5 cells thick.
- Gases rise and drift away. FIRE lives only moments and needs AIR next to it. To make something burn, place the fuel above its ignition temperature with { temp } next to air.
- PLANT grows into neighbouring WATER within seconds. A CLONE emits its ctype forever into empty neighbours, so a CLONE spring floods eventually.
- WALL is indestructible and insulating: right for masonry that should survive a fire. ROCK is natural stone, drawn smooth like terrain. GLASS is clear and acid-proof.
- Heat is real: lava melts metal, ice keeps water cold, steam rises from boiling water. Pick materials as a builder would: glass windows, a stone chimney, a wooden frame that burns.`;

const QUALITY = `What makes a good construction: it is recognizable from any angle; it has real depth, not boxes with features painted on; its proportions are right; detail is concentrated on the silhouette, openings and joints; and its materials make physical sense. Carve interiors, doors and windows with AIR. Before writing code, picture the subject from every side and list its parts, their sizes in cells at T = 1, and their materials.`;

const TOOL_LOOP = `## How you work

1. Plan the build: parts, proportions, materials, and how each material will behave once simulated.
2. Call construct_exec with your code. It returns the cell counts, a physics lint report, and pictures from the front-right and the back-left.
3. Fix every ERROR in the report and anything that looks wrong in the pictures, then call construct_exec again.
4. When the latest construct_exec is clean and looks right, call finish with a short name and a one-sentence description.`;

const CHAT_OUTPUT = `## Output

Reply with exactly one \`\`\`js code block holding only your construction code (the function body). You can't run it, so check before answering that every container is sealed and every powder cell is supported.`;

export function buildSystemPrompt({ examples, mode = 'tools' }) {
  return [
    'You design constructions for Powder Toy 3D, a falling-sand physics sandbox on a 3D voxel grid. A construction is a small program that places cells of real materials. Once it is placed, the simulation takes over: powders fall, liquids flow, fire spreads by heat and ice melts. Your build has to read clearly from every side and hold up physically.',
    mode === 'tools' ? TOOL_LOOP : CHAT_OUTPUT,
    `## The construction API\n\n${API}`,
    `## Materials\n\n${elementTable()}`,
    `## Physics that matters when building\n\n${PHYSICS}`,
    `## Quality\n\n${QUALITY}`,
    `## Examples\n\nThese are the game's built-in constructions, written in the same API. Each destructures the API from its first argument and takes a variant as its second; your code uses the names directly and has no variants.\n\n\`\`\`js\n${examples.trim()}\n\`\`\``,
  ].join('\n\n');
}

// A self-contained prompt to paste into any chatbot, for players without an API key.
export function buildChatPrompt({ examples, request }) {
  return `${buildSystemPrompt({ examples, mode: 'chat' })}\n\n## Build request\n\n${request.trim()}`;
}

// Pull the construction code out of a chat reply: the first fenced block, or the whole text.
export function extractCode(text) {
  const m = /```(?:js|javascript)?\s*\n([\s\S]*?)```/.exec(text);
  return (m ? m[1] : text).trim();
}
