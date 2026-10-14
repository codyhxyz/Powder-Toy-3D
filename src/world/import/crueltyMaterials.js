import { E } from '../../elements.js';

// Exact resource-path -> physical substrate, NOT a texture/color catalog.
// Audit and losses: docs/cruelty-source-comparison.md. Unknown paths fail closed.
// Painted/grotesque/mossy structural patterns do not establish edible matter,
// plant growth, electronics or any other mechanic merely from their appearance.
const base = {
  ROCK: ['plain_wall_dark_cracked.png', '1.png', 'BlackWall.png', 'Granite1.png', 'Granite2.png', 'GreyWall.png', 'RedWall.png', 'OliveWall.png', 'WhiteWall.png', 'Stone1.png', 'Stone2.png', 'Stone2face.png', 'Stone2green.png', 'Stone3.png', 'Stone4.png', 'Stone5.png', 'Stone6.png', 'Stone_Tile.png', 'Stone_Tile_dark.png', 'Stone_Wall_1.png', 'Stone_wall_2.png', 'TealWall.png', 'Wall_Crusty.png', 'Wall_Crusty_face.png', 'alien_1.png', 'alien_2.png', 'arches.png', 'blue_yellow.png', 'catacomb.png', 'cobble1.png', 'cobble2.png', 'cyber_1.png', 'cyber_2.png', 'flower.png', 'frog1.png', 'greenwall.png', 'joe2.png', 'maario.png', 'pizzahouse.png', 'plain_wall.png', 'plain_wall2.png', 'plain_wall_dark.png', 'plain_wall_greenred.png', 'bl_red_cyan.png', 'bluewall.png', 'building_1.png', 'building_2.png', 'building_3.png', 'building_3_no_logo.png', 'greyface.png', 'greyfacedstrct.png', 'moss.png', 'moss2.png', 'moss2dstrct.png', 'flesh.tres', 'flesh_tile.png', 'flesh2.png', 'noise.tres'],
  LIMESTONE: ['Marble1.tres', 'Marble1red.tres', 'Marble1green.tres', 'MarbleFace1.png', 'blackmarble.png'],
  CERAMIC: ['Red_Tile.png', 'Diamond_Tile_blue.png', 'Diamond_Tile_green.png', 'Diamond_Tile.png', 'Teal_Tile.png', 'Teal_Tile2.png', 'Tile_Wall.png', 'bathroom.png', 'freak_tile.png', 'mosaic_1.png', 'non_slip_tile.png', 'psycho_tile.png', 'star_tile.png', 'chessboard.png'],
  WOOD: ['Wood3.png', 'Wood1.png', 'Wood2.tres', 'Wood_Door2.png', 'greenplank.png', 'rug1.png', 'wood_door.tres', 'woodbottomwall.png'],
  METAL: ['Elevator1.png', 'chainlink.tres', 'grate.png', 'metal_door.png', 'divinedoor.png', 'airduct.png', 'helldoor.png', 'profanedoor.png'],
  GLASS: ['glass1.tres', 'glass_green.tres'],
  WATER: ['water.tres', 'red_water.png'],
  PLANT: ['grass.png'],
  // Self-glow, not electrical LAMP: no source circuit/energization is provided.
  CRYSTAL: ['light1.tres', 'light_effect.tres'],
};
export const CRUELTY_MATERIALS = Object.fromEntries(Object.entries(base).flatMap(([element, names]) => names.map((name) => [`res://Maps/textures/base/${name}`, E[element]])));
const extra = {
  WALL: ['__default__'], // Only genuinely material-less collision/clip surfaces.
  WOOD: ['res://Imported_Mesh/Snirby.material', 'res://Maps/textures/swamp/swamptree.png'],
  EMPTY: ['res://Maps/textures/special/exit.tres'],
  ROCK: ['res://Maps/textures/suburb/funko.png', 'res://Maps/textures/suburb/suburb_wall_1.png', 'res://Maps/textures/suburb/suburb_wall_2.png', 'res://Maps/textures/suburb/suburb_wall_3.png', 'res://Maps/textures/office/2.png', 'res://Maps/textures/office/3.png', 'res://Maps/textures/office/4.png', 'res://Maps/textures/pyramid/dirt1.png', 'res://Maps/textures/pyramid/heliport.png', 'res://Maps/textures/pyramid/Bluered.png', 'res://Maps/textures/pyramid/bluered2.png', 'res://Maps/textures/pyramid/skull1.png', 'res://Maps/textures/pyramid/skull2.png', 'res://Maps/textures/schizo/Schizo_Blue_Yellow.tres'],
  BRICK: ['res://Maps/textures/suburb/suburb_brick_1.png', 'res://Maps/textures/suburb/suburb_brick_2.png', 'res://Maps/textures/suburb/suburb_roof_1.png', 'res://Maps/textures/suburb/suburb_roof_2.png'],
  PLANT: ['res://Maps/textures/suburb/suburb_grass.png', 'res://Maps/textures/suburb/suburb_grass_red.png'],
  WATER: ['res://Maps/textures/swamp/swampwater1.tres'],
  METAL: ['res://Maps/textures/pyramid/container_end.png', 'res://Maps/textures/pyramid/container_side.png', 'res://Maps/textures/pyramid/pipes.png', 'res://Maps/textures/mall/hatch.png', 'res://Maps/textures/PD/locker.png', 'res://Maps/textures/PD/manhole.png'],
  GLASS: ['res://Maps/textures/pyramid/screen.tres', 'res://Maps/textures/pyramid/screen2.tres'],
  MEAT: ['res://Materials/E_Assassin.tres', 'res://Materials/E_Civ_Cultist_Mat.tres'],
};
Object.assign(extra, {
  ROCK: [...extra.ROCK, 'res://Maps/textures/apartment/ceiling.png', 'res://Maps/textures/apartment/crungewallpaper.png', 'res://Maps/textures/apartment/grandma.png', 'res://Maps/textures/apartment/grandma2.png', 'res://Maps/textures/apartment/grandma3.png', 'res://Maps/textures/sewer/sewerwall.png', 'res://Maps/textures/sewer/sewerwalldark.png', 'res://Maps/textures/sewer/sewerwallneon.png', 'res://Maps/textures/sewer/slimecarpet.png', 'res://Maps/textures/sewer/orb.png', 'res://Maps/textures/mall/store_strength.png'],
  WOOD: [...extra.WOOD, 'res://Maps/textures/apartment/whitedoor.png', 'res://Maps/textures/apartment/cupboard.png'],
  METAL: [...extra.METAL, 'res://Maps/textures/apartment/oven.png', 'res://Maps/textures/sewer/sewerpipe.png'],
  CERAMIC: ['res://Maps/textures/apartment/bluetilekitchen.png', 'res://Maps/textures/mall/reddish_tile.png', 'res://Maps/textures/mall/pale_green_tile.png'],
});
for (const [element, paths] of Object.entries(extra)) for (const path of paths) CRUELTY_MATERIALS[path] = E[element];
export const MATERIAL_LOSSES = {
  MEAT: 'Visible inline actor body triangles only, not structural flesh patterns. Existing falling/cooking flesh chunks do not reproduce a living animated actor.',
  ROCK: 'Structural substrate; painted facades, grotesque/mossy graphics and animated pattern shaders are not reproduced. No edible/growing mechanic is inferred from a surface picture.',
  LIMESTONE: 'Closest existing carbonate behavior for marble; not a separate marble palette. Acid/heat/break behavior is ours, not source script parity.',
  CERAMIC: 'Existing brittle, acid-proof fired tile; source patterns/glazes omitted. Different toughness/melting from original game geometry.',
  METAL: 'Conductive/breakable metal; no source door motion, container contents, grate holes below cell resolution or screen circuitry is invented.',
  WOOD: 'Burnable/breakable organic substrate; rug fiber and painted doors use existing wood rather than a new cosmetic element.',
  GLASS: 'Transparent brittle panel; colored panes and display graphics omitted. Screens are not programmable/electrical devices.',
  WATER: 'Existing liquid; colored/swamp water is not classified as blood/toxic without source mechanic evidence. Surface-only voxel liquid can drain.',
  PLANT: 'Existing rooted, flammable plant for turf; our water-driven growth differs from static source grass. Grass soil backing is not invented.',
  BRICK: 'Existing building brick; patterned roofs share its break/acid/heat behavior rather than a new roof texture element.',
  CRYSTAL: 'Existing self-glowing brittle material; not exact lamp color, volumetric light shader or an electrical circuit. LAMP would require an unsupported power feed.',
  WALL: 'Untextured collision substrate only; original purpose of material-less faces is ambiguous. Not a fallback for unknown materials.',
  EMPTY: 'Explicit extraction trigger material, never solid terrain.',
};
