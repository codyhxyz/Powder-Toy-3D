import { ELEMENTS } from '../elements.js';
import { VITALS } from './vitals.js';
import { povEvents } from './events.js';

// Drinking (Noita's ingestion): what a gulp of each element does to a body.
// The flask (tools/flask.tool.js) hands over a drink as doses, one per element
// it held, and every dose runs through the same two steps:
//
//   1. Heat, for every element alike: a drink trades heat with the body. The
//      skin moves toward the drink's temperature by INGEST_HEAT_SHARE of the gap
//      for a full drink (cold water cools a burning body, a hot drink warms it),
//      and a drink hotter than INGEST_SCALD_T burns from the inside.
//   2. The element's own row, by element key (registerIngestion). An element
//      without a row does only step 1. A row for an element that doesn't exist
//      yet (another branch adds it) simply never runs until it does.
//
// Rows run before the heat step, so a row that kills names the death.
//
//   registerIngestion('WHISKEY', (body, dose) => { ... });
//   ingest(body, doses);   // doses: [{ id, n, share, T }]
//
// dose: { id, key, name, n: cells drunk, share: n / a full drink (Noita's 10%
// of a flask: 1 = a full drink), T: their mean temperature, °C }.
// body: a first-person body (player.js): hurt(amount, cause, { shielded,
// lethal }), skinT (read and write), dead. Phase 2's statuses (status.js) give
// it body.status, and rows then add statuses instead of acting at once.
//
// Events: 'drunk' { seconds } (feel.js sways the view; an NPC's carries by).

// ---- heat (every drink)
const INGEST_HEAT_SHARE = 0.5;   // share of the skin-to-drink temperature gap a full drink closes
const INGEST_SCALD_T = 65;       // °C: a drink hotter than this burns inside (IARC's "very hot beverages", above 65 °C)...
const INGEST_BURN = 0.004;       // ...health per °C above it, per full drink (boiling water ≈ 0.14, lava kills from a sip)

// ---- the built-in rows (Noita's ingestion effects, without a status system yet)
const ACID_DRINK_DAMAGE = 0.5;   // health per full drink of acid (Noita: Poisoned): two drinks kill
const OIL_SICK_DAMAGE = 0.08;    // health per full drink of oil (Noita: Poisoned and Food Poisoning)
export const DRUNK_PER_DRINK = 30;   // s of Drunk per full drink of whiskey (Noita: 30 s per 10% of a flask)

const lower = (id) => ELEMENTS[id].name.toLowerCase();
const fmtT = (T) => `${Math.round(T).toLocaleString('en-US')} °C`;
// a hurt from inside: no shield stands between a drink and the stomach
const inside = { shielded: false };

const ROWS = new Map();   // element key → effect(body, dose)
export function registerIngestion(key, effect) { ROWS.set(key, effect); }
export const ingestionRow = (key) => ROWS.get(key) ?? null;

// Water quenches: a burning skin is put out at once (Noita's water puts out fire), then cools toward the water.
registerIngestion('WATER', (body) => { if (body.skinT > VITALS.BODY_T) body.skinT = VITALS.BODY_T; });
// Acid eats the gut.
registerIngestion('ACID', (body, d) => body.hurt?.(ACID_DRINK_DAMAGE * d.share, 'Dissolved from inside by acid', inside));
// Lava kills, however little: molten rock in the throat (Noita: Internal Fire).
registerIngestion('LAVA', (body, d) => body.hurt?.(1, `Drank lava, ${fmtT(d.T)}`, { ...inside, lethal: true }));
// Oil makes you sick.
registerIngestion('OIL', (body, d) => body.hurt?.(OIL_SICK_DAMAGE * d.share, 'Sick from oil', inside));
// Whiskey makes you drunk (the element comes with branch nt-mat): the view sways (feel.js).
registerIngestion('WHISKEY', (body, d) => povEvents.emit('drunk', { seconds: DRUNK_PER_DRINK * d.share }));

// Run a drink's doses on a body. Returns the doses with their keys and names filled in.
export function ingest(body, doses) {
  const out = doses.filter((d) => d.n > 0 && ELEMENTS[d.id]).map((d) => ({
    ...d, key: ELEMENTS[d.id].key, name: ELEMENTS[d.id].name,
  }));
  for (const d of out) {
    if (body.dead) break;
    ROWS.get(d.key)?.(body, d);
    if (body.dead) break;
    const k = Math.min(1, INGEST_HEAT_SHARE * d.share);
    if (typeof body.skinT === 'number') body.skinT += (d.T - body.skinT) * k;
    if (d.T > INGEST_SCALD_T) body.hurt?.(INGEST_BURN * (d.T - INGEST_SCALD_T) * d.share, `Burned inside by ${lower(d.id)}, ${fmtT(d.T)}`, inside);
  }
  return out;
}

export const INGEST = { INGEST_HEAT_SHARE, INGEST_SCALD_T, INGEST_BURN, ACID_DRINK_DAMAGE, OIL_SICK_DAMAGE, DRUNK_PER_DRINK };
