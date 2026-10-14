// The browser half of tools/you-portrait.mjs: one frame of the loading screen's
// live player (src/ui/youViewer.js), a moment into his idle clip and turned a
// little to screen left, on a transparent background.
//   render({ width, height, yaw, time }) → a PNG data URL
import { createYou } from '../src/ui/youViewer.js';

export async function render({ width, height, yaw, time, character }) {
  const you = await createYou({ width, height, yaw, time, character, preserveDrawingBuffer: true });
  try {
    you.frame();
    return you.canvas.toDataURL('image/png');
  } finally {
    you.dispose();
  }
}
