// Day and night: the sun crosses the sky as the simulation runs (it holds still
// while paused, so a paused scene still renders on demand), and a full moon
// opposite it lights the night. The renderer has one key light: whichever of
// the two is up, as a direction (uSun) and a colour scale on sunlight (uKeyLight).
import * as THREE from 'three';

export const DAY = {
  cycleSteps: 72000,    // simulation steps per day and night: 5 min at 4 steps per frame and 60 fps
  startPhase: 0.42,     // share of the day at load (0 midnight, 0.25 sunrise, 0.5 noon)
  latitude: 35,         // degrees; at the equinox the sun peaks at 90 - latitude
  noonAzimuth: 38,      // degrees: the direction the noon sun lies in, around the up axis
  keyElMin: 5,          // degrees: a light sits no lower, since grazing shadows smear across the whole box
  fadeEl: 4,            // degrees: a light fades in over this much elevation above the horizon
  // Moonlight is ~1/400000 of sunlight; a night-adapted eye sees it as dim and
  // blue (the Purkinje shift), which is what this stands in for.
  moonGain: 0.12,
  moonTint: [0.55, 0.7, 1.0],
};

const deg = THREE.MathUtils.degToRad;
const lat = deg(DAY.latitude), noonAz = deg(DAY.noonAzimuth);
// horizontal unit vectors: toward the noon sun, and east (where it rises)
const south = new THREE.Vector3(Math.cos(noonAz), 0, Math.sin(noonAz));
const east = new THREE.Vector3(Math.sin(noonAz), 0, -Math.cos(noonAz));
const sinKeyMin = Math.sin(deg(DAY.keyElMin));
const sunDir = new THREE.Vector3();

// Share of the day (0..1, 0.5 = noon) after `steps` simulation steps.
export const dayPhase = (steps) => (((steps / DAY.cycleSteps + DAY.startPhase) % 1) + 1) % 1;

/**
 * Key light for day phase `phase`: writes its unit direction into `dir`
 * (THREE.Vector3) and its colour scale into `light` (array of 3). `fixed`
 * ({ az, el } in degrees) pins the sun instead, for tools that need a set look.
 */
export function keyLight(phase, dir, light, fixed = null) {
  if (fixed) {
    const az = deg(fixed.az), el = deg(fixed.el);
    dir.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
    light.fill(1);
    return;
  }
  // the sun at the equinox: hour angle h from noon
  const h = 2 * Math.PI * (phase - 0.5);
  sunDir.copy(east).multiplyScalar(-Math.sin(h)).addScaledVector(south, Math.sin(lat) * Math.cos(h));
  sunDir.y = Math.cos(lat) * Math.cos(h);
  const moon = sunDir.y < 0;
  if (moon) sunDir.negate();
  const el = Math.asin(sunDir.y);
  const fade = THREE.MathUtils.smoothstep(el, 0, deg(DAY.fadeEl));
  for (let k = 0; k < 3; k++) light[k] = moon ? fade * DAY.moonGain * DAY.moonTint[k] : fade;
  // hold the light at keyElMin, keeping its azimuth
  const y = Math.max(sunDir.y, sinKeyMin);
  dir.set(sunDir.x, 0, sunDir.z).setLength(Math.sqrt(1 - y * y));
  dir.y = y;
}
