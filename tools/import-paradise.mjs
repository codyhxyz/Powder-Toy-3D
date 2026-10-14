import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, basename, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseGodot3Scene, embeddedMeshes } from '../src/world/import/godot3.js';
import { voxelizeMeshes } from '../src/world/import/voxelize.js';
import { PARADISE_MATERIALS, paradiseExcludeNode, paradiseMission } from '../src/world/import/paradise.js';
import { CELL_M } from '../src/scale.js';
import { E } from '../src/elements.js';

export function convertParadise(text) {
  const scene = parseGodot3Scene(text);
  const meshes = embeddedMeshes(scene, { excludeNode: paradiseExcludeNode });
  const voxel = voxelizeMeshes(meshes, PARADISE_MATERIALS, { cellMeters: CELL_M });
  const { words, ...manifest } = voxel;
  const materials = [...new Set(meshes.flatMap((m) => m.surfaces.map((s) => s.materialPath)))].sort();
  const elementNames = Object.fromEntries(Object.entries(E).map(([name, id]) => [id, name]));
  Object.assign(manifest, {
    mission: paradiseMission(scene, voxel, words),
    provenance: { sourceFile: 'Levels/Level2.tscn', sha256: createHash('sha256').update(text).digest('hex'), originalFormat: 'Godot 3 text scene format=2', distribution: 'Local conversion only; game asset redistribution permission not established', coordinateRule: 'Godot Y-up, identity axes; meters / CELL_M, then integer bounds translation; Qodot scale already applied in .tscn' },
    materialMapping: Object.fromEntries(materials.map((path) => [path, elementNames[PARADISE_MATERIALS[path]]])),
    sourceNodes: meshes.map((m) => ({ path: m.nodePath, triangles: m.surfaces.reduce((n, s) => n + s.indices.length / 3, 0) })),
    collision: { method: 'Conservative triangle/cell intersection; generated elements use existing voxel collision and destruction', originalShapes: [...scene.resources.values()].reduce((counts, r) => { if (/Shape$/.test(r.type)) counts[r.type] = (counts[r.type] ?? 0) + 1; return counts; }, {}) },
    unresolvedPackedScenes: [...scene.external.values()].filter((r) => r.type === 'PackedScene').map((r) => r.path).sort(),
    limitations: ['Embedded level geometry only: external PackedScene props, actors, and scripts are not executed or expanded.', 'Surface voxels preserve authored triangles within cell resolution; enclosed interiors are not flood-filled.', 'Doors and elevators are imported at authored rest transforms, not animated.', 'Actor source pivots are preserved in sourceAt; feet use the nearest imported support within 3 meters below.', 'Extraction uses the authored convex bounds converted to an inscribed cylinder for the mission API.', 'Source texture names translate to physical materials; original texture pixels are not copied.'],
  });
  return { manifest, words };
}
async function main() {
  const args = process.argv.slice(2), value = (key) => { const i = args.indexOf(key); return i < 0 ? null : args[i + 1]; };
  const source = value('--source'), output = value('--out') ?? '.tmp-cruelty-import/paradise';
  if (!source || ![2, 4].includes(args.length)) throw new Error('Usage: node tools/import-paradise.mjs --source /path/to/Levels/Level2.tscn [--out .tmp-cruelty-import/paradise]');
  const prefix = resolve(output);
  const publicRelative = relative(resolve('public'), prefix);
  if (publicRelative === '' || (!publicRelative.startsWith('..') && !publicRelative.startsWith('/'))) throw new Error('Game-derived assets must stay outside public/ (production copies it)');
  const text = await readFile(source, 'utf8'), { manifest, words } = convertParadise(text);
  manifest.dataFile = `${basename(prefix)}.bin`;
  const buffer = Buffer.alloc(words.byteLength);
  words.forEach((word, i) => buffer.writeUInt32LE(word, i * 4));
  await mkdir(dirname(prefix), { recursive: true });
  await writeFile(`${prefix}.bin`, buffer);
  await writeFile(`${prefix}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ output: prefix, sha256: manifest.provenance.sha256, size: manifest.size, ...manifest.stats, targets: manifest.mission.targets.length, guards: manifest.mission.guards.length, limitations: manifest.limitations }, null, 2));
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
