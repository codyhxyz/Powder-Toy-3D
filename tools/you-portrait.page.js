// The browser half of tools/you-portrait.mjs: one frame of the loading screen's
// live player (src/ui/youViewer.js), a moment into his idle clip and turned a
// little to screen left, on a transparent background.
//   render({ width, height, yaw, time }) → a PNG data URL
import { createYou } from '../src/ui/youViewer.js';

export async function render({ width, height, yaw = 0.42, time = 0.6 }) {
  const you = await createYou({ width, height, yaw, time, preserveDrawingBuffer: true });
  you.frame();
  const url = you.canvas.toDataURL('image/png');
  you.dispose();
  return url;
}
