// Production R5 alone binds the complete immutable EV contact tail. Dynamics
// binds only its motion prefix: shared state/phase emission must stay unchanged.
import { E, ELEMENTS } from '../../elements.js';
import { CONTACT_ROWS, CONTACT_REACTIONS } from '../../v2/contact.js';
import { PHASE_ROWS, phaseOffsetPerQuantum } from '../../v2/phase.js';
import { CONTACT_ROW_SCHEMA, contactTableLayout } from '../../v2/contactTable.js';
import { phaseWGSL } from './phase.js';

const count = CONTACT_ROWS.length;
const layout = contactTableLayout(count, CONTACT_REACTIONS.length);
const names = ['phaseHotQ', 'phaseColdQ', 'phaseHotLatent', 'phaseColdLatent',
  'phaseOffsetPerQuantum', 'phaseCapacityPerQuantum', 'phaseLavaOffsetPerQuantum'];
const load = (key, id = 'id') => {
  const field = CONTACT_ROW_SCHEMA.findIndex(([name]) => name === key);
  if (field < 0 || CONTACT_ROW_SCHEMA[field][1] !== 'i32') throw Error(`phase EV field: ${key}`);
  return `bitcast<i32>(EV[${layout.rowOffset / 4 + Math.floor(field / 4)}u+${id}*${layout.rowStride / 4}u].${'xyzw'[field % 4]})`;
};
let replacements;
function lookups() {
  if (replacements) return replacements;
  if (count !== PHASE_ROWS.length || count !== ELEMENTS.length) throw Error('phase EV row count mismatch');
  // These are data-domain proofs, not a new physical rule. Refuse generation
  // if future content no longer has this exact packed representation.
  for (let id = 0; id < count; id++) {
    const row = CONTACT_ROWS[id], phase = PHASE_ROWS[id];
    const source = row.meltQ === 65536 ? CONTACT_ROWS[E.STONE] : row;
    const product = (source.capacity - CONTACT_ROWS[E.LAVA].capacity) * source.meltQ;
    const lava = source.offset + product;
    if (row.hotOut < 0 ? phase.hotQ !== 0 : phase.hotQ !== row.hotQ) throw Error('phase hot threshold mapping');
    if (row.coldOut < 0 ? phase.coldQ !== 0 : phase.coldQ !== row.coldQ) throw Error('phase cold threshold mapping');
    if (row.capacity !== Math.max(1, Math.round(ELEMENTS[id].cap * 64)) ||
        phase.hotLatent !== row.hotL || phase.coldLatent !== row.coldL || phase.offset !== row.offset ||
        !Number.isInteger(product) || product < -2147483648 || product > 2147483647 ||
        lava < -2147483648 || lava > 2147483647 || lava !== phaseOffsetPerQuantum(E.LAVA, id)) {
      throw Error('phase EV mapping or signed-domain mismatch');
    }
  }
  const returns = [
    `if(${load('hotOut')}<0){return 0;} return ${load('hotQ')};`,
    `if(${load('coldOut')}<0){return 0;} return ${load('coldQ')};`,
    `return ${load('hotL')};`, `return ${load('coldL')};`,
    `return ${load('offset')};`, `return ${load('capacity')};`,
    `var source=id;
 if(${load('meltQ', 'source')}==65536){source=${E.STONE}u;}
 return ${load('offset', 'source')}+(${load('capacity', 'source')}-${load('capacity', `${E.LAVA}u`)})*${load('meltQ', 'source')};`,
  ];
  replacements = names.map((name, i) => {
    const original = phaseWGSL.match(new RegExp(`const ${name}Table = [^\\n]+\\nfn ${name}\\(id:u32\\)->i32 \\{[^\\n]+\\}`))?.[0];
    if (!original) throw Error(`phase lookup shape: ${name}`);
    return [original, `fn ${name}(id:u32)->i32 {
 if(id>=${count}u){return 0;}
 ${returns[i]}
}`];
  });
  return replacements;
}

export function contactPhaseLookups(source) {
  for (const [original, replacement] of lookups()) {
    if (source.split(original).length !== 2) throw Error('phase lookup must occur exactly once');
    source = source.replace(original, replacement);
  }
  return source;
}
