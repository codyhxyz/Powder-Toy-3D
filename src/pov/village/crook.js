// Animal Crossing's doorstep loan, through a man who treats signatures as permanent proof.
export const TIM_CROOK = Object.freeze({
  name: 'Tim Crook', species: 'tanuki', color: '#b88a60', shirt: '#e6c38b', pitch: 0.92,
});
export const CROOK_BALANCE = -56000;
export const CROOK_LINES = Object.freeze([
  {
    text: 'Ah, there you are. Tim Crook. I’ve got your keys. The previous owner still comes round, but don’t let him in. He sold the house. I watched him sign. Now he says he wasn’t himself that day. Well, who was he, then? Whose money did I give him?',
    answers: ['What does he want?', 'I didn’t buy a house.'],
    replies: [
      'His house. His money. An apology. He’s had two of those already.',
      'No, I arranged it. You weren’t here. Someone had to get things moving.',
    ],
  },
  {
    text: 'He’ll tell you he grew up here. That his father built the place. He knows which stair creaks. All true. None of it changes the signature. I’ve asked him to stop bringing photographs.',
    answers: ['Maybe you should hear him out.', 'Does he still have a key?'],
    replies: [
      'I did. In my office. Then outside my office. Then through the letterbox.',
      'He says he lost it. Keep yours on you.',
    ],
  },
  {
    text: 'I’ve put your name on everything. House, land, account. Check the spelling now. Once I’ve copied it into the book, I won’t change it. I used to allow corrections. People corrected themselves right out of houses.',
    answers: ['The name is right.', 'Take my name off.'],
    replies: [
      'Good. Say it again while I check.',
      'Then whose name goes there? His? We’ve just got him out.',
    ],
  },
  {
    text: 'Fifty-six thousand. That’s what you owe. I paid him before you arrived. He counted it at this very door. Twice. I stayed for the second count because I could see he was getting ideas.',
    answers: ['You spent that without asking me?', 'I don’t have fifty-six thousand.'],
    replies: [
      'If I’d waited, he might not have sold. You wouldn’t have a house.',
      'Neither do I. Not anymore.',
    ],
  },
  {
    text: 'You can pay later. I’m not asking for it today. But I need you to understand it’s your account. He keeps telling people I owe him. I can’t have both of you doing that.',
    answers: ['This sounds like your problem.', 'What happens if I don’t pay?'],
    replies: [
      'It was. Then I put your name down.',
      'I’ll come and speak to you. I’ll keep coming. It helps to catch people before they’ve gone out.',
    ],
  },
  {
    text: 'I have the agreement if you want to see it. His signature, my signature. There’s a mark where he pressed too hard. You can see it on the next three sheets. A man doesn’t do that by accident.',
    answers: ['Where’s my signature?', 'Pressing hard doesn’t mean he agreed.'],
    replies: [
      'You haven’t signed. I know. He brings that up every time.',
      'I gave him another sheet. He wouldn’t use it. That’s the one he wanted.',
    ],
  },
  {
    text: 'Anyway. Your keys. Nothing to pay today. Get yourself settled. If he comes round, don’t agree to anything. He’ll start with something small. Ask if you remember him. Ask if he can come inside. Tell him to speak to me. Don’t sign anything he brings.',
    answers: ['Goodbye, Tim.'],
  },
]);
export function initialCrookState() {
  return { version: 1, started: false, step: 0, complete: false, balance: 0 };
}
export function validCrookState(s) {
  return !!s && s.version === 1 && typeof s.started === 'boolean' && typeof s.complete === 'boolean'
    && Number.isInteger(s.step) && s.step >= 0 && s.step < CROOK_LINES.length
    && (!s.complete || (s.started && s.step === CROOK_LINES.length - 1))
    && (s.started || s.step === 0) && s.balance === (s.complete ? CROOK_BALANCE : 0)
    // Existing v1 saves have no reply; keep their progress and balance.
    && (s.reply === undefined || (s.started && s.step > 0 && Number.isInteger(s.reply)
      && s.reply >= 0 && s.reply < CROOK_LINES[s.step - 1].replies.length));
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
  const reply = state.reply === undefined ? '' : CROOK_LINES[state.step - 1].replies[state.reply];
  return { text: reply ? `${reply}\n\n${line.text}` : line.text,
    choices: line.answers.map((label, index) => ({ id: `crook-${state.step}-${index}`, label })) };
}
export function startCrook(state) {
  return validCrookState(state) && !state.complete ? { ...state, started: true } : state;
}
export function answerCrook(state, choiceId) {
  const reply = crookDialogue(state)?.choices.findIndex(c => c.id === choiceId) ?? -1;
  if (!state.started || reply < 0) return state;
  // Reactions rejoin the next stage; old/double clicks cannot advance it again.
  return state.step < CROOK_LINES.length - 1 ? { ...state, step: state.step + 1, reply }
    : { ...state, complete: true, balance: CROOK_BALANCE };
}
