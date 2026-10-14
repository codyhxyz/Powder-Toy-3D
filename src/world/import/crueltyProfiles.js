// Lightweight authored-node profiles shared by the CLI and DEV registry.
// Scene names/normal objectives confirmed against the corresponding wiki pages
// and exact Levels/LevelN.tscn nodes. No coordinates or geometry live here.
export const CRUELTY_PROFILES = [
  { id: 'pharmakokinetiks', name: 'Pharmakokinetiks', level: 1, spawn: 'QodotMap/entity_1_Player', targets: ['QodotMap/entity_45_Obj_Executive1', 'QodotMap/entity_47_Obj_Pinky'], exits: ['QodotMap/entity_46_Exit'] },
  { id: 'paradise', name: 'Paradise', level: 2, spawn: 'QodotMap/entity_9_Player', targets: ['Nerd_1', 'Nerd_2', 'Nerd_3'], exits: ['QodotMap/entity_225_Exit'] },
  { id: 'sinSpaceEngineering', name: 'Sin Space Engineering', level: 3, blocked: 'Full source bounds require 2840x2464x2936 cells and a 40-million-entry brick directory; existing import/storage budget exceeded. No geometry cropped or scaled.', spawn: 'QodotMap/entity_38_Player', targets: ['CEO'], exits: ['QodotMap/entity_6_Exit', 'QodotMap/entity_167_Exit'] },
  { id: 'androgenAssault', name: 'Androgen Assault', level: 4, spawn: 'QodotMap/entity_1_Player', targets: ['Chief', 'Cop_Narc'], exits: ['QodotMap/entity_239_Exit', 'QodotMap/entity_240_Exit'] },
  { id: 'apartmentAtrocity', name: 'Apartment Atrocity', level: 6, spawn: 'QodotMap/entity_1_Player', targets: ['Cult_Leader'], exits: ['QodotMap/entity_143_Exit', 'QodotMap/entity_144_Exit', 'QodotMap/entity_186_Exit'] },
];
export const crueltyProfile = (id) => CRUELTY_PROFILES.find((p) => p.id === id || String(p.level) === String(id));
