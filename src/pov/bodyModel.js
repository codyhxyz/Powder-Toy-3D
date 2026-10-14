// The realistic body's model (figureReal.js), on its own so the start menu can
// prefetch it (src/preload.js) without loading three.js.
const BASE = import.meta.env?.BASE_URL ?? '/';
export const BODY_MODEL_URL = `${BASE}models/character/body.glb`;
export const BODY_MODEL_URLS = {
  real: BODY_MODEL_URL,
  // The paper-bag guy is the same body, without the wizard hat.
  stick: BODY_MODEL_URL,
  woman: `${BASE}models/character/woman.glb`,
};
