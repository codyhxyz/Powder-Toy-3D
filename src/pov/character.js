// Halo's four modes use armor; Siege and sandbox keep the chosen body.
export function characterForMode(mode, choice = 'real') {
  return ['slayer', 'ctf', 'koth', 'infection'].includes(mode)
    ? 'spartan' : ['real', 'woman', 'stick'].includes(choice) ? choice : 'real';
}

// Who the loading screen shows: the body you will see, not the physics stand-in.
// Animal Crossing hides that body and draws the village boy or girl (village/index.js).
export function previewCharacter(mode, choice = 'real', village = 'boy') {
  if (mode === 'animalCrossing') return village === 'girl' ? 'girl' : 'boy';
  return characterForMode(mode, choice);
}

// The player's gender, picked once on the first visit (ui/characterPick.js) and kept with the
// settings. It is what's remembered: every world dresses
// the player from it, the male or female wizard here, the village boy or girl in Animal Crossing.
export const GENDERS = ['male', 'female'];
export const genderOf = (character) => character === 'woman' ? 'female' : 'male';
// The bodies a gender wears. The paper-bag guy is the male wizard in a bag, so a man keeps it.
export function bodiesFor(gender, character = 'real') {
  return gender === 'female'
    ? { gender, character: 'woman', villageCharacter: 'girl' }
    : { gender: 'male', character: character === 'stick' ? 'stick' : 'real', villageCharacter: 'boy' };
}

// Skyrim's loading screen: the wheel moves the camera in and out. 1 is the framed distance;
// scroll down (positive deltaY) moves out.
export const YOU_ZOOM_MIN = 0.34;
export const YOU_ZOOM_MAX = 2.4;
const YOU_ZOOM_WHEEL = 0.0015; // per px of deltaY
export function nextYouZoom(zoom, deltaY) {
  if (!deltaY) return zoom;
  return Math.min(YOU_ZOOM_MAX, Math.max(YOU_ZOOM_MIN, zoom * Math.exp(deltaY * YOU_ZOOM_WHEEL)));
}
