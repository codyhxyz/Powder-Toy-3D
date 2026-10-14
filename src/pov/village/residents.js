import { ITEMS } from './catalog.js';
// Authored Animal Crossing-style neighbor conversations; no clocks, storage or RNG.
export const RESIDENTS = Object.freeze([
  Object.freeze({ name: 'Maple', species: 'bear', home: 1, color: '#c59471', shirt: '#c87362', pitch: 0.85 }),
  Object.freeze({ name: 'Clover', species: 'rabbit', home: 2, color: '#e8d8b8', shirt: '#8da76b', pitch: 1.3 }),
  Object.freeze({ name: 'Pippin', species: 'cat', home: 3, color: '#d9a66a', shirt: '#679fab', pitch: 1.1 }),
]);

const STORIES = {
  Maple: {
    greetings: [
      'Welcome in. Mind the shavings; I made the chair legs even, but not the floor tidy.',
      'I put the kettle on before checking the joints today. A small victory for visitors.',
      'Your usual spot is clear. I almost sanded it again, then remembered chairs are for sitting.',
    ],
    warm: 'I left the crooked little stool out. With you here, it feels like a story rather than a mistake.',
    morning: 'Morning light catches every scratch. It also makes the honey look lovely, so I try to look at both.',
    evening: 'No more measuring tonight. If the table can hold two mugs, it has done enough.',
    furnished: 'That chair is facing the company, not the wall. The grain can wait its turn to be admired.',
    sparse: 'An empty corner is all right. A guest should never have to squeeze around my ambitions.',
    topics: {
      stool: {
        label: 'How is the little stool?',
        lines: [
          'The stool has one pale knot. Strong as anything, but I keep turning that side toward the wall. Would you?',
          'I nearly replaced the knotted seat this morning. It fits so well, though. Is hiding it really an improvement?',
        ],
        choices: [
          { id: 'keep-knot', label: 'Let the knot show.', text: 'Then I shall call it a landmark. Perhaps someone small will trace it with a paw while we talk.', recall: 'You called the knot worth keeping. I have stopped turning the stool toward the wall.' },
          { id: 'sand-again', label: 'Refine it if it matters to you.', text: 'It does matter. Thank you for not making care sound silly. One more pass, then I will put the tools away for tea.', recall: 'I took your advice about refining the stool. One pass, not twelve. That last part was difficult.' },
        ],
      },
      guests: {
        label: 'Making things or hosting friends?',
        lines: [
          'Clover would fill every window with seedlings. I want a clear place to set a visitor’s cup. Am I being fussy?',
          'I can build another shelf, or invite someone over with the room unfinished. The shelf is easier to be brave about.',
        ],
        choices: [
          { id: 'invite-now', label: 'Invite them before it is finished.', text: 'All right. No apology at the door, either. Well, one small apology about the glue. It is still wet.', recall: 'I tried inviting company before everything was ready, like you suggested. Nobody inspected the joints.' },
          { id: 'make-space', label: 'A thoughtful space is a gift.', text: 'Yes! A smooth edge says “rest your elbow here.” I just must remember to let an actual elbow arrive.', recall: 'Your thought about space being a gift stayed with me. I made room for a guest, not another project.' },
        ],
      },
      wood: {
        label: 'Where did you learn woodworking?',
        lines: [
          'My first teacher kept a bowl of imperfect offcuts. “Useful yet,” she said. I still have the smallest one.',
          'That scrap on my shelf is not rubbish. It is the first piece I cut straight, except for the end that is not.',
        ],
        choices: [
          { id: 'use-scrap', label: 'Make something with it.', text: 'A little handle, perhaps. Then I could hold that afternoon in my paw whenever I open a drawer.', recall: 'I sketched a handle for the old offcut you wanted me to use. I am not ready to cut it yet.' },
          { id: 'save-scrap', label: 'Some things can simply be kept.', text: 'Oh. Yes. Not everything has to earn its shelf space. I wish I were quicker to remember that.', recall: 'The offcut is still on the shelf. You helped me stop calling it clutter.' },
        ],
      },
    },
  },
  Clover: {
    greetings: [
      'Come look! Nothing has sprouted yet. That is technically news, though not my favorite kind.',
      'I promised the seedlings I would stop checking. Excellent timing: please distract me!',
      'You are back! I saved the sunny spot for you. The fern objected, but it has three others.',
    ],
    warm: 'I can admit this to you now: sometimes I dig up a seed just to check. I am trying to trust the quiet part.',
    morning: 'Morning inspection! Damp soil, bright leaves, and one rabbit practicing not poking things.',
    evening: 'The leaves fold up at night without asking if they did enough. I am taking notes.',
    furnished: 'A plant in a room is a living roommate. A quiet one, unless you count my half of the conversation.',
    sparse: 'You do not need a jungle to belong here. One pot, or just a sunny place to sit, counts.',
    topics: {
      seeds: {
        label: 'Any news from the seed tray?',
        lines: [
          'The moonflower packet said “soon.” How many mornings is soon? Should I sow another tray or give this one a chance?',
          'Still no moonflowers. I labeled the tray PATIENCE. It has not improved either of us. What would you do?',
        ],
        choices: [
          { id: 'wait-seeds', label: 'Give the roots time.', text: 'Roots first, applause later. Right. If waiting is hard for you too, we can be terrible at it together.', recall: 'I left the moonflowers alone, as you suggested. No sprouts yet, but I did not dig them up!' },
          { id: 'try-tray', label: 'Try a second tray, carefully.', text: 'An experiment! Same light, different soil. I like a question I can label. The first tray still gets its chance.', recall: 'The second tray you suggested has its own notebook now. No winner yet; that is data too, apparently.' },
        ],
      },
      room: {
        label: 'Should every corner be green?',
        lines: [
          'Maple wants room for mugs. I want room for leaves! But a guest should not need pruning shears to reach the sofa.',
          'Pippin calls my windowsill a competitive forest. I laughed, then moved the biggest pot. It was shading the others.',
        ],
        choices: [
          { id: 'more-green', label: 'I like the wild corners.', text: 'Me too! A little tangle feels generous. I will keep the path clear, though. Wild should not mean unwelcome.', recall: 'I kept a wild corner for you. The path is still clear; I checked with my widest basket.' },
          { id: 'less-green', label: 'Leave a little breathing room.', text: 'Fair. I get excited and forget other people need sunlight too. Shall we make a seat by the window?', recall: 'I opened up that sunny seat after our talk. It turns out I like sitting there myself.' },
        ],
      },
      wilt: {
        label: 'What if a plant does not thrive?',
        lines: [
          'My old fern lost three leaves. I knew all the instructions! Knowing and helping are annoyingly different things.',
          'I kept the fern’s empty pot. Not a trophy, obviously. A reminder to ask what something needs before doing everything.',
        ],
        choices: [
          { id: 'listen-first', label: 'Look closely before changing things.', text: 'Yes. Not every droop is an emergency. That goes for neighbors too. You can have a quiet day here without being fixed.', recall: 'I am practicing your “look first” advice. Today I noticed new growth before I noticed the brown edge.' },
          { id: 'share-failure', label: 'I have lost plants too.', text: 'Oh, thank you for telling me. I was about to give you a lecture on drainage. Tea would be kinder, wouldn’t it?', recall: 'I remember what you told me about losing plants. It made this feel less like an exam.' },
        ],
      },
    },
  },
  Pippin: {
    greetings: [
      'Hey, come in. The clock can wait.',
      'Good to see you. Pull up a seat.',
      'Oh, hey. Let me put these tools down.',
    ],
    warm: 'I’m glad you stopped by. It gets quiet in here.',
    morning: 'Want some tea? I’ve just put the kettle on.',
    evening: 'I’m done for tonight. Stay for a bit?',
    furnished: 'There’s room at the desk if you want to sit with me.',
    sparse: 'It’s a bit empty in here. I’m still getting things sorted.',
    topics: {
      clock: {
        label: 'How’s the clock?',
        lines: [
          'It loses a minute every hour. I think one of the gears is worn. Worth another try, do you think?',
          'It was my father’s. I’d like to get it running again, but I’m worried about damaging it. Maybe I should leave it alone.',
        ],
        choices: [
          { id: 'fix-clock', label: 'Try one more repair.', text: 'All right. I’ll take it slowly this time. Would you help me keep track of the pieces?', recall: 'I tried another repair, like you suggested. The clock’s keeping better time now.' },
          { id: 'retire-clock', label: 'You can keep it without fixing it.', text: 'Yeah. It was my father’s, so I’d keep it either way. It can stay on the shelf for now.', recall: 'I’ve left the clock on the shelf, like we talked about. I still like having it here.' },
        ],
      },
      comfort: {
        label: 'How’s the room coming along?',
        lines: [
          'I’ve been moving things around. I need somewhere to work, but I’d like it to feel less like a shed.',
          'Clover offered me a few plants. I could fit one by the window if I moved the lamp. What do you think?',
        ],
        choices: [
          { id: 'practical', label: 'Keep your workspace clear.', text: 'You’re right. I’ll sort the tools first. I keep losing the small screwdriver.', recall: 'I cleared the desk after we talked. Found the screwdriver, too. It was under my notes.' },
          { id: 'beautiful', label: 'Make room for something you like.', text: 'I’d like a bit of green in here. I’ll ask Clover which plant is hardest to kill.', recall: 'I’ve saved a spot by the window for one of Clover’s plants. You were right about making the room feel nicer.' },
        ],
      },
      keepsake: {
        label: 'What’s that bell?',
        lines: [
          'It’s from my first bicycle. I bent it when I fell off coming down the hill. It still rings, though.',
          'I cleaned up the old bicycle bell today. I hadn’t thought about that summer in ages.',
        ],
        choices: [
          { id: 'ring-bell', label: 'Can I hear it?', text: 'Here, give it a try. Not much of a ring left, is there? I used to think everyone should hear me coming.', recall: 'I put the bicycle bell out after you tried it. It’s nice to have it where I can see it.' },
          { id: 'keep-private', label: 'You don’t have to tell me about it.', text: 'Thanks. Maybe another time. For now, I’m just glad you’re here.', recall: 'Thanks for letting me keep that story to myself. You’re always welcome here.' },
        ],
      },
    },
  },
};

function storyFor(resident) {
  const name = typeof resident === 'string' ? resident : resident?.name;
  if (!Object.hasOwn(STORIES, name)) throw new RangeError('Unknown village resident');
  return { name, story: STORIES[name] };
}

// One memory per resident. Accept parsed JSON or a storage string; never mutate it.
// Unknown versions reset locally; callers decide whether an unreadable save is writable.
export function hydrateMemory(raw, resident) {
  const { name, story } = storyFor(resident);
  const fresh = { version: 1, resident: name, visits: 0, node: 'topics', lastTopic: null, lastChoice: null,
    rotations: Object.fromEntries(Object.keys(story.topics).map(key => [key, 0])) };
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value || value.version !== 1 || value.resident !== name) return fresh;
    const topics = Object.keys(story.topics);
    const validTopic = key => topics.includes(key);
    const count = n => Number.isSafeInteger(n) && n >= 0 ? Math.min(n, 1000000) : 0;
    fresh.visits = count(value.visits);
    fresh.node = validTopic(value.node) ? value.node : 'topics';
    fresh.lastTopic = validTopic(value.lastTopic) ? value.lastTopic : null;
    const choices = fresh.lastTopic ? story.topics[fresh.lastTopic].choices : [];
    fresh.lastChoice = choices.some(c => c.id === value.lastChoice) ? value.lastChoice : null;
    for (const key of topics) fresh.rotations[key] = count(value.rotations?.[key]);
  } catch { /* Unreadable memory must not prevent meeting a neighbor. */ }
  return fresh;
}

const menu = story => Object.entries(story.topics).map(([id, topic]) => ({ id, label: topic.label }));
function situation(story, resident, context) {
  if (Number.isFinite(context?.hour) && context.hour >= 0 && context.hour < 24) {
    if (context.hour < 11) return story.morning;
    if (context.hour >= 18) return story.evening;
  }
  // Only comment on furnishing when the caller explicitly supplies this room.
  const home = RESIDENTS.find(r => r.name === resident).home;
  if (context?.home === home && Array.isArray(context.furniture)) {
    const kind = { Maple: 'chair', Clover: 'plant', Pippin: 'desk' }[resident];
    if (context.furniture.some(item => item?.kind === kind || ITEMS[item?.kind]?.family === kind)) return story.furnished;
    if (context.furniture.length === 0) return story.sparse;
  }
  return '';
}

// create = a new visit; advance = one offered choice, never another visit.
// Return {text, choices:[{id,label}], memory}; persist memory, pass text/choices to UI.
// Optional context: {hour: 0..23, home: 1..3, furniture: [{kind: 'chair'}, ...]}.
export function createConversation(resident, rawMemory, context = {}) {
  const { name, story } = storyFor(resident), memory = hydrateMemory(rawMemory, resident);
  const visit = memory.visits;
  memory.visits = Math.min(visit + 1, 1000000);
  memory.node = 'topics';
  const recall = story.topics[memory.lastTopic]?.choices.find(c => c.id === memory.lastChoice)?.recall;
  // Animal Crossing-style short turns: one greeting and one follow-up, not a pile of barks.
  const followUp = recall || (visit >= 3 ? story.warm : situation(story, name, context));
  const text = [story.greetings[visit % story.greetings.length], followUp].filter(Boolean).join(' ');
  return { text, choices: menu(story), memory };
}

export function advanceConversation(resident, rawMemory, choiceId, context = {}) {
  const { name, story } = storyFor(resident), memory = hydrateMemory(rawMemory, resident);
  if (memory.node === 'topics' && Object.hasOwn(story.topics, choiceId)) {
    const topic = story.topics[choiceId], turn = memory.rotations[choiceId] || 0;
    memory.node = choiceId;
    memory.lastTopic = choiceId;
    memory.lastChoice = null;
    memory.rotations[choiceId] = (turn + 1) % topic.lines.length;
    return { text: topic.lines[turn % topic.lines.length], choices: topic.choices.map(({ id, label }) => ({ id, label })), memory };
  }
  const topic = story.topics[memory.node];
  const choice = topic?.choices.find(c => c.id === choiceId);
  if (choice) {
    memory.lastChoice = choice.id;
    memory.node = 'topics';
    return { text: choice.text, choices: menu(story), memory };
  }
  // Stale/double-clicked choices neither advance visits nor erase remembered choices.
  if (topic) {
    const turn = memory.rotations[memory.node] || 0;
    return { text: topic.lines[(turn + topic.lines.length - 1) % topic.lines.length],
      choices: topic.choices.map(({ id, label }) => ({ id, label })), memory };
  }
  return { text: situation(story, name, context) || story.greetings[Math.max(0, memory.visits - 1) % story.greetings.length],
    choices: menu(story), memory };
}

// Local room coordinates; fixed dresser is supplied separately by the caller.
// Theme-prefixed instance IDs remain distinct from catalog kinds.
const LAYOUTS = {
  1: [
    ['cottageBed', 'bed', -6, 5, 0],
    ['cottageTable', 'table', -6, -3, 0],
    ['cottageChair', 'chair', -6, -7, 0],
    ['cottageSofa', 'sofa', 6, -5, 1],
    ['cottageLamp', 'lamp', 8, 2, 0],
    ['cottageShelf', 'shelf', 4, 2, 1],
  ],
  2: [
    ['botanicalBed', 'bed', -6, 6, 1],
    ['botanicalShelf', 'shelf', -6, 2, 0],
    ['botanicalTable', 'table', -6, -3, 0],
    ['botanicalPlant', 'plant', -7, -7, 0],
    ['botanicalFern', 'plant', -4, -7, 0],
    ['botanicalDesk', 'desk', 6, -7, 0],
    ['botanicalChair', 'chair', 6, -4, 0],
    ['botanicalLamp', 'lamp', 7, 1, 0],
    ['botanicalSprout', 'plant', 4, 1, 0],
  ],
  3: [
    ['workshopBed', 'bed', -6, -5, 0],
    ['workshopDesk', 'desk', -6, 1, 0],
    ['workshopChair', 'chair', -6, 4, 0],
    ['workshopShelf', 'shelf', -6, 7, 0],
    ['workshopSofa', 'sofa', 6, -5, 1],
    ['workshopLamp', 'lamp', 7, 1, 0],
    ['workshopPlant', 'plant', 4, 1, 0],
  ],
};
export function residentFurniture(home) {
  const theme = { 1: 'cottage', 2: 'botanical', 3: 'workshop' }[home];
  return (Object.hasOwn(LAYOUTS, home) ? LAYOUTS[home] : []).map(([id, family, x, z, rotation]) =>
    ({ id, kind: theme + family[0].toUpperCase() + family.slice(1), x, z, rotation }));
}
