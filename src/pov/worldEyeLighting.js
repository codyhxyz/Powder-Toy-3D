// One-eye WORLD lighting only. No readback, local-window substitute, or GPU work.
export class WorldEyeIncomplete extends Error {
  constructor(reason) { super(`WORLD eye lighting not ready: ${reason}`); this.name = 'WorldEyeIncomplete'; this.code = 'WORLD_EYE_INCOMPLETE'; }
}
const fail = reason => { throw new WorldEyeIncomplete(reason); };
const token = (v, name) => { if (v == null || (typeof v === 'number' && !Number.isFinite(v))) fail(name); return v; };
const vector = (v, n, name) => {
  if (!v || v.length !== n) fail(name);
  const a = Array.from(v);
  if (!a.every(x => typeof x === 'number' && Number.isFinite(x) && Number.isFinite(Math.fround(x)))) fail(name);
  return Object.freeze(a);
};
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Capture at the synchronous consumer boundary, never consult live App state. */
export function captureWorldEye(input) {
  if (!input?.sample || !input.frame) fail('missing point sample/frame');
  const { sample, frame } = input;
  const publication = token(input.publication, 'publication');
  if (typeof publication !== 'object') fail('publication identity');
  const identity = token(frame.identity, 'frame identity');
  const scene = token(frame.scene, 'scene identity');
  const epoch = token(frame.epoch, 'epoch'), domain = token(frame.domain, 'domain');
  if (sample.publication !== publication || sample.frameIdentity !== identity) fail('publication/frame pairing');
  const position = vector(input.position, 3, 'global position');
  if (!equal(position, vector(sample.position, 3, 'sample position'))) fail('position pairing');
  const words = vector(sample.words, 20, '80-byte point words');
  if (words[19] !== 1) fail('incomplete point');
  if (!Number.isSafeInteger(frame.order) || frame.order < 0 || !Number.isFinite(frame.time)) fail('frame order/time');
  const sunDirection = vector(frame.sunDirection, 3, 'Sun direction');
  if (!sunDirection.some(x => x !== 0)) fail('zero Sun direction');
  const sunColor = vector(frame.sunColor, 3, 'Sun color'), keyLight = vector(frame.keyLight, 3, 'key light');
  const exposure = frame.settings?.exposure ?? 0, raw = frame.settings?.raw ?? false;
  if (!Number.isFinite(exposure) || typeof raw !== 'boolean') fail('image settings');
  return Object.freeze({ publication, identity, scene, epoch, domain, order: frame.order, time: frame.time,
    sampleIdentity: token(sample.identity, 'sample identity'), position, words, sunDirection, sunColor, keyLight,
    settings: Object.freeze({ exposure, raw }) });
}

export function sameWorldEye(a, b) {
  return a && b && ['publication','identity','scene','epoch','domain','order','time','sampleIdentity'].every(k => a[k] === b[k]) &&
    ['position','words','sunDirection','sunColor','keyLight'].every(k => equal(a[k], b[k])) &&
    a.settings.exposure === b.settings.exposure && a.settings.raw === b.settings.raw;
}

/** Only commit adopts easing. Concurrent candidates are based on one accepted revision. */
export function createWorldEyeLighting(tau) {
  let accepted = null, revision = 0;
  return Object.freeze({
    stage(frame) {
      if (accepted && (frame.order <= accepted.order || frame.time < accepted.time)) fail('stale frame');
      const base = revision;
      const reset = !accepted || accepted.epoch !== frame.epoch || accepted.domain !== frame.domain;
      const k = reset ? 1 : 1 - Math.exp(-Math.min(frame.time - accepted.time, 1) / tau);
      const bands = Object.freeze(frame.words.slice(0, 16).map((v, i) => reset ? v : accepted.bands[i] + (v - accepted.bands[i]) * k));
      const sunRGB = Object.freeze(frame.words.slice(16, 19).map((v, i) => reset ? v : accepted.sunRGB[i] + (v - accepted.sunRGB[i]) * k));
      const sunColor = Object.freeze(sunRGB.map((v, i) => v * frame.sunColor[i] * frame.keyLight[i]));
      let status = 'staged';
      const canCommit = () => status === 'staged' && revision === base && (!accepted || frame.order > accepted.order);
      return Object.freeze({ frame, bands, sunRGB, sunColor,
        get status() { return status; }, canCommit,
        commit() {
          if (!canCommit()) return false;
          accepted = { ...frame, bands, sunRGB }; revision++; status = 'committed'; return true;
        },
        discard() { if (status === 'staged') status = 'discarded'; },
      });
    },
  });
}

/** Original eye SH order: Three's Y00, y, z, x. Alpha stays in ticket.bands. */
export function applyWorldEyeLighting(ticket, sun, sky) {
  const c = ticket.bands, sh = sky.sh.coefficients;
  [0, 8, 12, 4].forEach((offset, i) => sh[i].set(c[offset], c[offset + 1], c[offset + 2]));
  sun.position.set(...ticket.frame.sunDirection);
  sun.color.setRGB(...ticket.sunColor);
}
