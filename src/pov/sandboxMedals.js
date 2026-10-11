import { povEvents } from './events.js';
import { PLAYER } from './targets.js';
import { CAUSE } from './halo.js';
import { createMedalBook } from '../game/medals.js';
import { createMedalHud } from '../game/medalHud.js';

// Halo 3's medals in first person outside a match: the same book (src/game/medals.js)
// and the same stack (src/game/medalHud.js) as a Halo match, fed by the killfeed's
// 'kill' (pov/killfeed.js: axemen, gunners, worms, birds) and by 'blast'. Every
// body is booked, so an axeman's spree is there for a Killjoy, but only the
// player's medals show, sound (audio.js's stings, from 'game:medal') and are said
// (announcer.js). A match's medals are game/feel.js's: this stands down while one
// runs (its kills come as 'game:kill', and its 'kill's carry team: true).
//
//   createSandboxMedals({ quiet, isPlayerDead })   quiet() → a match is on;
//   update() each frame (the stack's fades)

// the sandbox's causes (vitals.js, the tools' hurt()) in the book's words (CAUSE, medals.js CAUSE_MEDALS)
const MELEE = ['Axed', 'Stabbed', 'Picked apart', 'Kicked'];   // axe, knife, pickaxe, kick: a Beat Down
function bookCause({ cause = '', icon }) {
  if (cause.startsWith('Backstabbed')) return CAUSE.ASSASSINATION;
  if (MELEE.some((p) => cause.startsWith(p))) return CAUSE.MELEE;
  if (icon === 'SNIPER') return `${cause} (sniper)`;    // shot with the sniper rifle in hand: a Sniper Kill (as feel.js names it)
  if (/burn/i.test(cause) && icon !== 'BLOWTORCH') return 'Fire';   // the world's fire; Incineration is the blowtorch's
  return cause;
}
const NO_MATCH = new Set(['FIRST_STRIKE']);   // Reach's "the match's first kill": there's no match here

export function createSandboxMedals({ quiet = () => false, isPlayerDead = () => false } = {}) {
  const book = createMedalBook({ alive: (id) => id !== PLAYER || !isPlayerDead() });
  const hud = createMedalHud({ solo: true });
  hud.show(true);
  const wall = () => performance.now() / 1000;

  function awarded(list) {
    const mine = list.filter((m) => m.id === PLAYER && !NO_MATCH.has(m.key));
    if (!mine.length) return;
    // the player's, whatever was acting (a vehicle's blast runs inside povEvents.as)
    povEvents.as(null, () => mine.forEach((m, order) => povEvents.emit('game:medal', { id: PLAYER, key: m.key, name: m.name, kind: m.kind, mine: true, order })));
    hud.award(mine, wall());
  }

  povEvents.on('kill', (e) => {
    if (e.team || quiet()) return;
    awarded(book.kill({ id: e.id, by: e.by, cause: bookCause(e), self: e.self }, wall()));
  });
  povEvents.on('blast', (e) => { if (!quiet()) awarded(book.blast(e.by ?? PLAYER, wall())); });   // no by: the player's
  povEvents.on('game:start', () => hud.clear());   // the match's own stack takes over

  return {
    update() { hud.update(wall()); },
    medals: () => book.counts(PLAYER),   // the player's this session (checks)
  };
}
