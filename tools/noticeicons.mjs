// The notices' icons (src/ui/noticeIcons.js), baked from game-icons.net by
// tools/game-icons.mjs. They stand in for Garry's Mod's notice materials
// (vgui/notices/generic, error, undo, hint and cleanup), which are Facepunch's;
// like them each is one flat shape, which src/ui/notices.js draws in its
// kind's colour. Rerun after changing ICONS.
// usage: node tools/noticeicons.mjs
import { bakeIcons } from './game-icons.mjs';

// a notice kind (GMod's NOTIFY_*), or an icon a notice asks for by name → '<author>/<name>' in the repo
const ICONS = {
  generic: 'delapouite/info',
  error: 'lorc/hazard-sign',
  undo: 'delapouite/anticlockwise-rotation',
  hint: 'lorc/light-bulb',
  cleanup: 'delapouite/broom',
  camera: 'delapouite/photo-camera',   // "Screenshot saved"
};

await bakeIcons({ icons: ICONS, out: 'src/ui/noticeIcons.js', prefix: 'NOTICEICON', what: 'Notice icons', script: 'tools/noticeicons.mjs' });
