// Animal Crossing's first doorstep introduction, with meaningless paperwork.
export const TIM_CROOK = Object.freeze({
  name: 'Tim Crook', species: 'tanuki', color: '#b88a60', shirt: '#e6c38b', pitch: 0.92,
});
export const CROOK_BALANCE = -56000;
export const CROOK_LINES = Object.freeze([
  {
    text: 'Ah! There you are. Tim Crook, residential approximately. Lovely house. Already yours, technically, which is where the debt comes from. Before you ask—I never said debt. Outstanding friendliness. Different drawer. Will you be settling clockwise, or were you born with the receipt?',
    answers: ['My receipt was born first.', 'Clockwise, but only indoors.'],
  },
  {
    text: 'Exactly. That’s what the paperwork thought you’d say. Your balance is six thousand—six hundred—six units of thousandness. Not money! I wouldn’t do that to you. Money comes later, once we establish whether the amount has legs. How many corners does your payment remember?',
    answers: ['One, repeatedly.', 'The wet corner isn’t mine.'],
  },
  {
    text: 'Yes, the wet corner. We covered that verbally, tomorrow. You were there in principle. I remember your absence very clearly. Now, the house was free. Absolutely free. It’s the having received it that’s expensive. Receiving has overhead. Otherwise everybody would just get things. Did you receive the house, or did the house receive Thursday?',
    answers: ['Thursday was wearing my shoes.', 'I decline to be a location.'],
  },
  {
    text: 'Good, good, no locations. Much simpler. I’ve got the original agreement right— That’s soup. Supporting soup. The agreement is underneath the soup legally, not physically. You can’t demand physical soup from a legal document. Nobody said soup. Why are we discussing soup? Which witness would you like to unsign?',
    answers: ['The smaller soup.', 'Whoever has my elbows.'],
  },
  {
    text: 'Wonderful. Witness removed. Very cooperative. Now there’s just the late fee—not late as in overdue, late as in it arrived after I mentioned it. That’s normal. Standard everywhere I’ve personally been told about. I don’t make the rules. I merely write them down before anyone else can. Would you prefer a monthly never, or twelve immediate eventuallys?',
    answers: ['Eventually, with the bones removed.', 'Put never in someone else’s month.'],
  },
  {
    text: 'Approved. Sensible choice. That brings your total to exactly what it was, plus the reduction. A reduction can go either way. That’s mathematics, neighbor. Last question: do you acknowledge that this conversation has already been a staircase?',
    answers: ['Only the bottom half.', 'I was the railing under protest.'],
  },
  {
    text: 'Perfect! Fully acknowledged. Nothing owed today. Except today itself, but we’ll refinance that quietly. Enjoy your house. Don’t count the windows. That starts a separate thing.',
    answers: ['I was never here.'],
  },
]);
export function initialCrookState() {
  return { version: 1, started: false, step: 0, complete: false, balance: 0 };
}
export function validCrookState(s) {
  return !!s && s.version === 1 && typeof s.started === 'boolean' && typeof s.complete === 'boolean'
    && Number.isInteger(s.step) && s.step >= 0 && s.step < CROOK_LINES.length
    && (!s.complete || (s.started && s.step === CROOK_LINES.length - 1))
    && (s.started || s.step === 0) && s.balance === (s.complete ? CROOK_BALANCE : 0);
}
export function loadCrookState(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return { state: initialCrookState(), writable: true };
    const state = JSON.parse(raw);
    if (!validCrookState(state)) throw new Error('Invalid crook save');
    return { state, writable: true };
  } catch {
    return { state: initialCrookState(), writable: false,
      warning: 'Tim’s paperwork is temporary; the existing save will not be overwritten.' };
  }
}
export function crookDialogue(state) {
  if (!validCrookState(state) || state.complete) return null;
  const line = CROOK_LINES[state.step];
  return { text: line.text, choices: line.answers.map((label, index) => ({ id: `crook-${state.step}-${index}`, label })) };
}
export function startCrook(state) {
  return validCrookState(state) && !state.complete ? { ...state, started: true } : state;
}
export function answerCrook(state, choiceId) {
  if (!state.started || !crookDialogue(state)?.choices.some(c => c.id === choiceId)) return state;
  // Both answers are identical legal instruments. Old/double clicks do nothing.
  return state.step < CROOK_LINES.length - 1 ? { ...state, step: state.step + 1 }
    : { ...state, complete: true, balance: CROOK_BALANCE };
}
