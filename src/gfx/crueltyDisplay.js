// Original Cruelty Squad normal fullscreen treatment; authorized recovered sources:
// res://Shaders/PaletteLimiter.shader (normal else branch and final get_noise)
// SHA-256 dfe86d7d5f5a395568052a995687ff07c125796771f18612bd2721cd783b0949
// res://Materials/screenmat.tres (all effects false, gamma=1, u_amount=0.002)
// SHA-256 f4fc5c94a980dd48205e0e09ff7da94fba77b811a2b367b20bed294b446dab5a
// Recovered under Library/Caches/tpt-cruelty-source/recovered on the source Mac.
// No water/drugs/scope/holy/nightmare/health effects are ported here.
export const crueltyDisplayWGSL = () => /* wgsl */ `
fn crueltyDisplay(rgb: vec3f, uv: vec2f, time: f32) -> vec3f {
  let palette = floor(rgb * 255.0 / 16.0) * 16.0 / 255.0;
  let noise = fract(sin(dot(uv + vec2f(time * 5.0, 0.0), vec2f(5.0, 0.0))) * 43758.5453);
  return palette + vec3f((2.0 * noise - 1.0) * 0.002);
}
`;

// Frame-local overrides only: never change the user's saved cinematic controls.
// Original normal display uses linear tone mapping, not a cinematic exposure/look.
export function crueltyFrameSettings(s) {
  return s.cruelty ? { ...s, bloom: 0, sharpen: 0, adapt: false, exposure: 0, raw: false, night: 0 } : s;
}

// CPU reference for the source's display-value math (not GPU sin precision).
export function crueltyDisplayRGB(rgb, uv, time) {
  const hash = Math.sin((uv[0] + time * 5) * 5) * 43758.5453;
  const noise = (2 * (hash - Math.floor(hash)) - 1) * 0.002;
  return rgb.map((c) => Math.floor(c * 255 / 16) * 16 / 255 + noise);
}
