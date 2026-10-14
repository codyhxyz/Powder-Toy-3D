// The realistic body's model (figureReal.js), on its own so the start menu can
// prefetch it (src/preload.js) without loading three.js.
export const BODY_MODEL_URL = `${import.meta.env.BASE_URL}models/character/body.glb`;
export const BODY_MODEL_URLS = {
  real: BODY_MODEL_URL,
  woman: `${import.meta.env.BASE_URL}models/character/woman.glb`,
};
