import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, basename, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { parseGodot3Scene, embeddedMeshes, reference, transformPoint, sourceActorMetadata } from '../src/world/import/godot3.js';
import { importedCell, voxelizeMeshes } from '../src/world/import/voxelize.js';
import { CRUELTY_MATERIALS, MATERIAL_LOSSES } from '../src/world/import/crueltyMaterials.js';
import { crueltyExcludeNode, crueltyMission, hiddenActorHelper, actorVisualAncestor } from '../src/world/import/crueltyMission.js';
import { CRUELTY_PROFILES, crueltyProfile } from '../src/world/import/crueltyProfiles.js';
import { crueltyInteractions, doorAncestor } from '../src/world/import/crueltyInteractions.js';
import { CELL_M } from '../src/scale.js';
import { E } from '../src/elements.js';
import { ELEMENTS, K } from '../src/elements.js';
import { AppearanceResources } from './appearance-resources.mjs';
import { AppearanceConversion, littleEndianWords } from './appearance-conversion.mjs';

// The far field draws its plain at the median height of the level's border
// (world/far.js beyondLevel), and it asks for that while the world is built —
// before a map's packed geometry has been fetched. Computing it here keeps that
// answer exact instead of invented, and lets the menu list a map without it.
function plainHeight(map, words) {
  const [wx, , wz] = map.size, hs = [];
  const column = (x, z) => {
    for (let y = map.size[1] - 1; y >= 0; y--) {
      const kind = ELEMENTS[importedCell(map, words, x, y, z)]?.kind;
      if (kind === K.SOLID || kind === K.POWDER || kind === K.LIQUID) return y + 1;
    }
    return 0;
  };
  for (let x = 0; x < wx; x++) hs.push(column(x, 0), column(x, wz - 1));
  for (let z = 1; z < wz - 1; z++) hs.push(column(0, z), column(wx - 1, z));
  hs.sort((a, b) => a - b);
  return hs[hs.length >> 1];
}

export function convertCrueltyMap(text, profile, { sourceRoot, gdre, magick } = {}) {
  if (!profile) throw new Error('Unknown source map profile');
  if (profile.blocked) throw new Error(`${profile.name} not imported: ${profile.blocked}`);
  const scene = parseGodot3Scene(text);
  const meshes = embeddedMeshes(scene, { excludeNode: crueltyExcludeNode });
  const resources = sourceRoot ? new AppearanceResources(sourceRoot, { gdre, magick }) : null;
  if (resources) {
    const info = JSON.parse(resources.read(`res://Levels/Level${profile.level}.json`).toString('utf8'));
    if (info.name !== profile.name) throw new Error(`Canonical Level${profile.level} name mismatch: ${info.name} != ${profile.name}`);
  }
  const appearance = resources ? new AppearanceConversion(resources, resources.context(scene, `res://Levels/Level${profile.level}.tscn`, text), meshes, CRUELTY_MATERIALS) : null;
  // Horizontal streaming advances in16-cell steps. Shared SAT hits drive
  // physical occupancy, door ownership and authored appearance together.
  const voxel = voxelizeMeshes(meshes, CRUELTY_MATERIALS, { cellMeters: CELL_M, alignment: [16, 8, 16],
    ownerForMesh: m => doorAncestor(m, scene), onTriangle: appearance?.onTriangle });
  const packedAppearance = appearance?.pack(voxel, { excludeNode: crueltyExcludeNode });
  const { words, ownedCells, ...manifest } = voxel;
  const elementNames = Object.fromEntries(Object.entries(E).map(([name, id]) => [id, name]));
  const usage = {};
  for (const mesh of meshes) for (const s of mesh.surfaces) {
    const element = elementNames[CRUELTY_MATERIALS[s.materialPath]];
    const entry = usage[s.materialPath] ??= { element, surfaces: 0, triangles: 0 };
    entry.surfaces++; entry.triangles += s.indices.length / 3;
  }
  const actorResource = (n) => n.instance ? scene.external.get(reference(n.instance).id)?.path : n.props.script ? scene.external.get(reference(n.props.script).id)?.path : null;
  const actors = [...scene.nodes.values()].filter((n) => actorResource(n)?.includes('/Enemies/') || actorResource(n) === 'res://Scripts/EnemyHandler.gd').map((n) => ({ path: n.path, sourcePath: n.path, ...sourceActorMetadata(n, scene), resource: actorResource(n), sourceAt: transformPoint(n.worldTransform, [0, 0, 0]), sourceFlags: Object.fromEntries(Object.entries(n.props).filter(([key]) => /hell|chaos|objective|disabled|visible/.test(key))) }));
  Object.assign(manifest, {
    id: profile.id, name: profile.name,
    plainHeight: plainHeight(voxel, words),
    mission: crueltyMission(scene, voxel, words, profile),
    interactions: crueltyInteractions(scene, meshes, voxel, ownedCells),
    preview: true,
    provenance: { sourceFile: `Levels/Level${profile.level}.tscn`, sha256: createHash('sha256').update(text).digest('hex'), originalFormat: 'Godot 3 text scene format=2', distribution: 'Local conversion only; game asset redistribution permission not established', coordinateRule: 'Godot Y-up, identity axes; meters / CELL_M, then integer bounds translation; Qodot scale already applied in .tscn' },
    materialMapping: Object.fromEntries(Object.entries(usage).sort(([a], [b]) => a.localeCompare(b)).map(([path, u]) => [path, u.element])),
    materialUsage: usage,
    materialLosses: Object.fromEntries([...new Set(Object.values(usage).map((u) => u.element))].sort().map((element) => [element, MATERIAL_LOSSES[element]])),
    sourceNodes: meshes.map((m) => ({ path: m.nodePath, triangles: m.surfaces.reduce((n, s) => n + s.indices.length / 3, 0) })),
    sourceActors: actors, actorInventory: actors,
    excludedActorVisualHelpers: [...scene.nodes.values()].filter((n) => hiddenActorHelper(n, scene)).map((n) => ({ path: n.path, visible: n.props.visible, mesh: n.props.mesh ?? null })),
    excludedActorVisuals: [...scene.nodes.values()].filter(n => n.props.mesh && actorVisualAncestor(n, scene)).map(n => ({ path: n.path, visible: n.props.visible ?? 'inherited', reason: 'Animated actor represented by destination NPC, not terrain' })),
    collision: { method: 'Conservative triangle/cell intersection; generated elements use existing voxel collision and destruction', originalShapes: [...scene.resources.values()].reduce((counts, r) => { if (/Shape$/.test(r.type)) counts[r.type] = (counts[r.type] ?? 0) + 1; return counts; }, {}) },
    unresolvedPackedScenes: [...scene.external.values()].filter((r) => r.type === 'PackedScene').map((r) => r.path).sort(),
    limitations: ['Embedded level geometry only: external PackedScene props, actors, and scripts are not executed or expanded.', 'Surface voxels preserve authored triangles within cell resolution; enclosed interiors are not flood-filled.', 'Ordinary and elevator doors use exclusive-cell voxel retraction, not animated swing/slide; elevator doors close after 5 seconds when safely resident. Special gates retain unsupported progression requirements. Elevator platforms and other scripted movers remain at rest; see interactions.inventory.', 'Actor source pivots are preserved in sourceAt; fixed X/Z feet require SOLID support and full ordinary body clearance within 3 meters below. Obstructed guards are explicit placementFailures; obstructed targets/spawn disable mission eligibility.', 'All authored normal exits are retained in extractions; exact bounds take precedence over inscribed cylinder compatibility fields.', 'NPC types/weapons are destination representations, not original AI parity; unsupported and hell/chaos actors remain in sourceActors inventory.', 'Source texture names translate to audited physical materials; original texture pixels and shader effects are not copied.'],
  });
  if (packedAppearance) {
    manifest.appearance = packedAppearance.metadata;
    manifest.limitations[manifest.limitations.length - 1] = 'Original appearance is retained in the separate versioned source-triangle payload; physical elements and their mechanics remain the audited translation.';
  }
  return { manifest, words, ...(packedAppearance ? { appearanceWords: packedAppearance.words } : {}) };
}
export async function writeConvertedMap({ manifest, words, appearanceWords }, output) {
  const prefix = resolve(output), path = relative(resolve('.'), prefix);
  // Published conversions live in public/local-maps: Vite copies that directory
  // into dist, so the host serves them as plain static files. Nothing else in
  // the tree may hold them.
  if (!/^public\/local-maps\/[^/]+$/.test(path)) throw new Error('Converted maps must be written to public/local-maps/<id>');
  const buffer = littleEndianWords(words);
  // Sparse bricks are mostly zero, so gzip takes the largest map from 29 MiB to
  // ~0.5 MiB: under Cloudflare Pages' 25 MiB per-file limit, and a small
  // download. The loader inflates it in the browser (importedMap.js).
  const packed = gzipSync(buffer, { level: 9 });
  manifest.dataFile = `${basename(prefix)}.binpack`;
  manifest.dataCompression = 'gzip';
  await mkdir(dirname(prefix), { recursive: true });
  await writeFile(`${prefix}.binpack`, packed);
  if (appearanceWords) {
    const raw = littleEndianWords(appearanceWords), data = gzipSync(raw, { level: 9 });
    Object.assign(manifest.appearance, { dataFile: `${basename(prefix)}.appearance.binpack`, dataCompression: 'gzip', bytes: raw.length, packedBytes: data.length, sha256: createHash('sha256').update(raw).digest('hex'), packedSha256: createHash('sha256').update(data).digest('hex') });
    await writeFile(`${prefix}.appearance.binpack`, data);
  }
  await writeFile(`${prefix}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ output: prefix, id: manifest.id, sha256: manifest.provenance.sha256, size: manifest.size, ...manifest.stats, packedBytes: packed.byteLength, targets: manifest.mission.targets.length, guards: manifest.mission.guards.length, authoredGuards: manifest.mission.authoredGuards.length, missionAvailable: manifest.mission.available, placementFailures: manifest.mission.placementFailures, exits: manifest.mission.extractions.length, materialGroups: Object.keys(manifest.materialLosses) }, null, 2));
}
async function main() {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--map', '--source', '--source-dir', '--source-root', '--gdre', '--out-dir'].includes(args[i]) || !args[i + 1] || Object.hasOwn(opts, args[i])) throw new Error('Usage: --map ID|all --source-root RECOVERED [--gdre GDRE_BIN] [--out-dir public/local-maps], or legacy --source FILE / --source-dir Levels');
    opts[args[i]] = args[i + 1];
  }
  const profiles = opts['--map'] === 'all' ? CRUELTY_PROFILES.filter((p) => !p.blocked) : [crueltyProfile(opts['--map'])];
  const roots = ['--source-root', '--source-dir', '--source'].filter(k => opts[k]);
  if (!profiles[0] || roots.length !== 1 || (profiles.length > 1 && opts['--source'])) throw new Error('Select a valid map and exactly one source root/file/directory');
  for (const profile of profiles) {
    const sourceRoot = opts['--source-root'];
    const source = sourceRoot ? resolve(sourceRoot, 'Levels', `Level${profile.level}.tscn`) : opts['--source'] ?? resolve(opts['--source-dir'], `Level${profile.level}.tscn`);
    await writeConvertedMap(convertCrueltyMap(await readFile(source, 'utf8'), profile, { sourceRoot, gdre: opts['--gdre'] }), resolve(opts['--out-dir'] ?? 'public/local-maps', profile.id));
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
