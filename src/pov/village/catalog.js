// Stable save IDs; footprint dimensions are placement cells, not icon sizes.
const items = {};
function add(id, family, theme, name, w, d, h, color, rest = {}) {
  items[id] = Object.freeze({ family, theme, name, w, d, h, color, ...rest });
}
add('bed', 'bed', 'classic', 'Patchwork bed', 4, 6, 2.85, '#7ba995', { lyingHeight: 1.75 });
add('chair', 'chair', 'classic', 'Oak chair', 2, 2, 3.4, '#cf9c62', { seatHeight: 1.75 });
add('table', 'table', 'classic', 'Round table', 4, 4, 3.05, '#d4ac77');
add('sofa', 'sofa', 'classic', 'Sage sofa', 6, 3, 3.1, '#81a994', { seatHeight: 1.75 });
add('lamp', 'lamp', 'classic', 'Sunflower lamp', 2, 2, 4.2, '#e5bd66');
add('plant', 'plant', 'classic', 'Leafy plant', 2, 2, 3.5, '#568c61');
add('dresser', 'dresser', 'classic', 'Oak dresser', 4, 3, 3.65, '#c99562');
const sizes = {
  chair: [2, 2, 3.4], bed: [4, 6, 3.6], sofa: [6, 3, 3.1],
  table: [4, 4, 2.8], lamp: [2, 2, 4.2], plant: [2, 2, 3.5],
  shelf: [4, 2, 5], desk: [4, 2, 3.4],
};
for (const [theme, color] of [['cottage', '#bc8957'], ['botanical', '#79a46e'], ['workshop', '#67838a']]) {
  for (const [family, size] of Object.entries(sizes)) {
    const title = family[0].toUpperCase() + family.slice(1);
    add(theme + title, family, theme, `${theme[0].toUpperCase() + theme.slice(1)} ${family}`,
      ...size, color, family === 'bed' ? { lyingHeight: 1.75 } :
        ['chair', 'sofa'].includes(family) ? { seatHeight: 1.75 } : {});
  }
}
add('rockingChair', 'rocker', 'cottage', 'Spindle rocking chair', 3, 4, 3.8, '#b78151', { seatHeight: 1.75 });
add('bunkBed', 'bunk', 'workshop', 'Loft bunk bed', 4, 6, 6, '#67838a', { lyingHeight: 1.75 });
add('roundStool', 'stool', 'botanical', 'Mushroom stool', 2, 2, 1.75, '#d7a078', { seatHeight: 1.75 });
add('grandfatherClock', 'clock', 'cottage', 'Pendulum clock', 2, 2, 6, '#93643f');
add('aquariumStand', 'aquarium', 'workshop', 'Aquarium stand', 4, 2, 4.5, '#658f9b');
add('writingBureau', 'bureau', 'cottage', 'Rolltop writing bureau', 4, 3, 4.5, '#a8774d');
export const ITEMS = Object.freeze(items);
