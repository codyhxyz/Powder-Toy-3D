// The user's arcade-racer sprint: peripheral streaks, never a blurred aiming point.
export const SPRINT_BLUR = { taps: 8, length: 0.075, inner: 0.16, outer: 0.72, mix: 0.9 };

export function sprintBlurStep(current, rush, dt) {
  const target = Math.max(0, Math.min(1, Number.isFinite(rush) ? rush : 0)) ** 2;
  const from = Math.max(0, Math.min(1, Number.isFinite(current) ? current : 0));
  const seconds = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
  const next = target + (from - target) * Math.exp(-seconds / (target > from ? 0.16 : 0.08));
  return next < 0.0001 ? 0 : next;
}

// Integrated into the existing composite: no new target/pass, and no taps when disabled.
export const sprintBlurWGSL = () => /* wgsl */ `
fn sprintBlur(uv: vec2f, original: vec4f) -> vec4f {
  if (P.sprintBlur <= 0.0) { return original; }
  let q = (uv - 0.5) * P.size / min(P.size.x, P.size.y);
  let edge = smoothstep(${SPRINT_BLUR.inner}, ${SPRINT_BLUR.outer}, length(q));
  if (edge <= 0.0) { return original; }
  let reach = (uv - 0.5) * (${SPRINT_BLUR.length} * P.sprintBlur * edge);
  var sum = original;
  for (var i = 1u; i < ${SPRINT_BLUR.taps}u; i++) {
    let at = uv - reach * (f32(i) / ${SPRINT_BLUR.taps - 1}.0);
    sum += sanitize(tapRadiance(tColor, smp, at, P.packed));
  }
  let blend = edge * ${SPRINT_BLUR.mix} * smoothstep(0.0, 0.12, P.sprintBlur);
  return mix(original, sum / ${SPRINT_BLUR.taps}.0, blend);
}
`;
