"""CPU unit and published-asset regression checks. No game/GPU/save writes.

python3 tools/import-noita-terrain-test.py
NOITA_DECODER_PATH=/path/to/noita-save-decode.py enables archive comparison.
"""
import copy
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
import zlib

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('terrain_compiler', ROOT / 'tools/import-noita-terrain.py')
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)
ASSETS = ROOT / 'public/local-maps/noita-terrain'


class UnitChecks(unittest.TestCase):
    def test_missing_selected_source_fails_never_air(self):
        a = np.array([[0, m.MISSING]], dtype=np.uint16)
        with self.assertRaisesRegex(ValueError, 'Missing selected source pixels'):
            m.require_complete(a, np.ones(a.shape, dtype=bool), [-512, 1024])
        m.require_complete(a, np.array([[True, False]]), [-512, 1024])

    def test_unknown_native_material_fails_and_nonair_cannot_empty(self):
        with self.assertRaisesRegex(ValueError, 'Unmapped native materials'):
            m.make_palette(['air', 'new_native_material'], {'air': 'EMPTY'}, {'EMPTY': 0})
        with self.assertRaisesRegex(ValueError, 'Invalid physical mapping'):
            m.make_palette(['air', 'rock'], {'air': 'EMPTY', 'rock': 'EMPTY'}, {'EMPTY': 0})

    def test_palette_overflow_fails(self):
        with self.assertRaisesRegex(ValueError, 'exceeds 255'):
            m.make_palette([f'native_{i}' for i in range(255)], {}, {})

    def test_native_palette_preserved_even_when_physical_elements_merge(self):
        palette = m.make_palette(['oil', 'blood', 'air'], {'air': 'EMPTY', 'oil': 'WATER', 'blood': 'WATER'}, {'EMPTY': 0, 'WATER': 7})
        self.assertEqual([p['name'] for p in palette], ['air', 'blood', 'oil'])
        ids = m.remap_native(np.array([[1, 0, 2]], dtype=np.uint8), ['oil', 'blood', 'air'], {p['name']: i for i, p in enumerate(palette)})
        self.assertEqual(ids.tolist(), [[1, 2, 0]])
        self.assertNotEqual(int(ids[0, 0]), int(ids[0, 1]))

    def test_fixed_unknown_rgba_fails_even_with_valid_black_proof(self):
        unresolved = np.array([[m.MISSING]], dtype=np.uint16)
        proof = dict(blackPixels=455966, airFraction=453229 / 455966)
        with self.assertRaisesRegex(ValueError, 'Unknown fixed-scene RGBA'):
            m.resolve_fixed(unresolved, [], np.array([[[1, 2, 3, 255]]]), np.array([[True]]), {'air': 0}, proof)
        with self.assertRaisesRegex(ValueError, 'lacks saved-cell evidence'):
            m.resolve_fixed(unresolved, [], np.array([[[0, 0, 0, 255]]]), np.array([[True]]), {'air': 0}, dict(blackPixels=0, airFraction=0))
        resolved = m.resolve_fixed(unresolved, [], np.array([[[0, 0, 0, 255]]]), np.array([[True]]), {'air': 0}, proof)
        self.assertEqual(resolved.tolist(), [[0]])
        with self.assertRaisesRegex(ValueError, 'Unknown fixed-scene RGBA'):
            m.resolve_fixed(unresolved, [], np.array([[[0, 0, 0, 0]]]), np.array([[True]]), {'air': 0}, proof)

    def test_context_overlap_and_actual_crop(self):
        original = (np.arange(600 * 5).reshape(600, 5) % 170).astype(np.uint8)
        bands = list(m.regions_from(original, 992, [1024, 1592], 256, 32))
        for left, right in zip(bands, bands[1:]):
            self.assertTrue(np.array_equal(left[3][-64:], right[3][:64]))
        self.assertTrue(np.array_equal(bands[0][3], original[:320]))
        self.assertEqual(bands[-1][1], 1592)
        self.assertTrue(np.all(bands[-1][3][88:] == 255))

    def test_hash_determinism_and_fold_independence(self):
        raster = np.arange(320 * 16, dtype=np.uint8).reshape(320, 16)
        raw = raster.tobytes()
        a, b = m.packed(raw), m.packed(raw)
        self.assertEqual(a, b)
        self.assertEqual(a[4:8], bytes(4))
        self.assertEqual(a[9], 255)
        stream = zlib.decompressobj(16 + zlib.MAX_WBITS)
        self.assertEqual(stream.decompress(a), raw)
        self.assertEqual(stream.unused_data, b'', 'Web gzip decoding rejects trailing padding')
        self.assertEqual(gzip.decompress(a), raw)
        c = json.loads((ROOT / 'tools/noita-terrain-source.json').read_text())
        changed = copy.deepcopy(c)
        changed['fold']['angleSpan'] = 3.14
        # Region generation has no fold argument: editing fold cannot alter bytes.
        def hashes(config):
            return [m.sha(data.tobytes()) for _, _, _, data in m.regions_from(raster, 992, [1024, 1280], config['coreHeight'], config['context'])]
        self.assertEqual(hashes(c), hashes(changed))

    def test_physical_ids_agree_with_existing_dictionary(self):
        e = m.physical_elements()
        self.assertEqual(e['EMPTY'], 0)
        self.assertEqual(e['WATER'], 7)
        self.assertEqual(e['BRICK'], 41)
        self.assertEqual(e['TELEPORTATIUM'], 79)


@unittest.skipUnless((ASSETS / 'route.json').exists(), 'Published terrain assets not installed')
class PublishedChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.route = json.loads((ASSETS / 'route.json').read_text())
        cls.arrays = []
        width = cls.route['fold']['sourceWidth']
        for r in cls.route['regions']:
            data = gzip.decompress((ASSETS / r['file']).read_bytes())
            cls.arrays.append(np.frombuffer(data, dtype=np.uint8).reshape(r['sourceHeight'], width))

    def test_all_hashes_shapes_palette_and_adjacent_context(self):
        route = self.route
        self.assertEqual(len(route['regions']), 51)
        self.assertEqual(route['palette'][0], dict(name='air', element=0))
        self.assertLessEqual(len(route['palette']), 255)
        for i, (r, a) in enumerate(zip(route['regions'], self.arrays)):
            self.assertEqual(a.shape, (320, 9216))
            self.assertEqual(m.sha(a.tobytes()), r['sha256'])
            self.assertEqual(r['sourceTop'], r['core'][0] - 32)
            self.assertEqual(r['core'][0], 1024 + i * 256)
            self.assertTrue(np.all((a < len(route['palette'])) | (a == 255)))
            if i:
                self.assertTrue(np.array_equal(self.arrays[i - 1][-64:], a[:64]))
        self.assertEqual(route['regions'][-1]['core'], [13824, 13888])
        self.assertTrue(np.all(self.arrays[-1][96:] == 255))

    def test_start_portals_and_debug_spawn_diagnostics(self):
        self.assertEqual(self.route['startScene'], 'noitaTerrain01')
        self.assertEqual(self.route['startSource'], [-677, 1350, 0])
        self.assertTrue(self.route['source']['startValidation']['bodyAir'])
        self.assertEqual(len(self.route['nativePortals']), 60)
        for p in self.route['nativePortals']:
            self.assertEqual(p['halfSize'], [15, 15])
            self.assertIsInstance(p['enabled'], bool)
            self.assertEqual(p['target'][1] - p['source'][1], 280)
            self.assertTrue(p['evidence']['targetBodyCollisionFree'])
            self.assertNotEqual(p['id'], 'native-39-32')
        for r in self.route['regions']:
            self.assertTrue(r['sourceTop'] + 6 <= r['spawnSource'][1] < r['sourceTop'] + 320)
            a = self.arrays[self.route['regions'].index(r)]
            x, y, _ = r['spawnSource']
            body = a[int(np.floor(y - 5.5)) - r['sourceTop']:int(np.ceil(y)) - r['sourceTop'],
                     int(np.floor(x - .8)) + 4608:int(np.floor(x + .8)) + 4609]
            self.assertGreater(body.size, 0)
            self.assertNotIn(255, body)
            if r['spawnSupported']:
                self.assertTrue(np.all(body == 0))
            else:
                self.assertTrue(all(self.route['palette'][int(i)]['element'] in {0, 7, 8, 9, 10, 73, 74, 75, 79} for i in np.unique(body)))
            if not r['spawnSupported']:
                self.assertEqual(r['spawnPolicy'], 'hazardous-streaming-only')
                self.assertIn('Native lava band', r['warning'])

    def test_black_air_regression_exact_counts_and_debris_exceptions(self):
        proof = json.loads((ASSETS / 'black-air-regression.json').read_text())
        self.assertEqual(proof, self.route['source']['fixedScene']['blackAirProof'])
        self.assertEqual(proof['blackPixels'], 455966)
        self.assertEqual(proof['savedAirPixels'], 453229)
        pieces = {tuple(r['origin']): r for r in proof['pieces']}
        self.assertEqual(pieces[3072, 13312]['savedMaterialCounts'], {'air': 6656})
        self.assertEqual(pieces[2048, 12800]['savedMaterialCounts']['bone'], 2204)
        self.assertEqual(sum(sum(r['savedMaterialCounts'].values()) for r in proof['pieces']), 455966)

    def test_runtime_manifest_same_interface_without_provenance(self):
        small = json.loads((ROOT / 'src/world/scenes/descent/terrainRoute.json').read_text())
        for key in ['fold', 'palette', 'regions', 'sections', 'startScene', 'startSource']:
            self.assertEqual(self.route[key], small[key])
        for p, q in zip(self.route['nativePortals'], small['nativePortals']):
            self.assertEqual({k: v for k, v in p.items() if k != 'evidence'}, {k: v for k, v in q.items() if k != 'evidence'})
        self.assertNotIn('source', small)

    def test_configuration_and_chunk_hash_provenance(self):
        for config in self.route['source']['configuration']:
            self.assertEqual(m.sha((ROOT / 'tools' / config['path']).read_bytes()), config['sha256'])
        for entry in self.route['source']['chunks']:
            self.assertEqual(len(entry['sha256']), 64)
            self.assertEqual(len(entry['material_raster_sha256']), 64)
        self.assertEqual(self.route['source']['gaps'][0]['origin'], [-1536, 12800])

    def test_fixed_gap_pixels_agree_with_authoritative_xml_and_original_plz(self):
        path = os.environ.get('NOITA_DECODER_PATH', str(ROOT / 'tools/noita-save-decode.py'))
        wak_path = Path(self.route['source']['wak'])
        if not Path(path).exists() or not wak_path.exists():
            self.skipTest('Original WAK and decoder required for fixed-source comparison')
        decoder = m.load_module('fixed_comparison_decoder', Path(path))
        reader = m.load_module('fixed_wak_reader', ROOT / 'tools/import-noita-map.py')
        wak_bytes = wak_path.read_bytes()
        self.assertEqual(m.sha(wak_bytes), self.route['source']['wak_sha256'])
        wak = reader.Wak(wak_bytes)
        import xml.etree.ElementTree as ET
        scenes = {s.attrib['material_filename']: s.attrib for s in ET.fromstring(wak.read('data/biome_impl/spliced/boss_arena.xml')).iter('PixelScene')}
        lookup = {p['name']: i for i, p in enumerate(self.route['palette'])}
        total = 0
        for piece in self.route['source']['fixedScene']['pieces']:
            if not piece['suppliedPixels']:
                continue
            scene = scenes[piece['path']]
            x, y = piece['origin']
            self.assertEqual([int(scene['pos_x']), int(scene['pos_y'])], [x, y])
            self.assertEqual(m.sha(wak.read(piece['path'])), piece['source_sha256'])
            ids, names, rgba, _ = decoder.material_raster_from_plz(wak.read(piece['path']), wak.read('data/materials.xml'))
            h, w = ids.shape
            # Every fallback piece is in a wholly absent saved chunk.
            self.assertFalse((Path(self.route['source']['world']) / f'world_{x}_{y}.png_petri').exists())
            self.assertEqual(piece['suppliedPixels'], h * w)
            black = np.all(rgba == [0, 0, 0, 255], axis=2)
            self.assertTrue(np.all((ids != m.MISSING) | black))
            for r, raster in zip(self.route['regions'], self.arrays):
                lo, hi = max(y, r['sourceTop']), min(y + h, r['sourceTop'] + 320, 13888)
                if hi <= lo:
                    continue
                published = raster[lo - r['sourceTop']:hi - r['sourceTop'], x + 4608:x + 4608 + w]
                local, reserved = ids[lo - y:hi - y], black[lo - y:hi - y]
                self.assertTrue(np.all(published[reserved] == 0))
                for index in np.unique(local[~reserved]):
                    self.assertTrue(np.all(published[(local == index) & ~reserved] == lookup[names[int(index)]]))
                total += published.size
        self.assertGreater(total, 1000000)
        print(f'Fixed-source comparison: {total:,} published fallback cells (including overlap) match native XML/PLZ; only proved reserved black becomes air.')

    def test_every_published_primary_pixel_agrees_with_original_archive(self):
        path = os.environ.get('NOITA_DECODER_PATH', str(ROOT / 'tools/noita-save-decode.py'))
        world = Path(self.route['source']['world'])
        if not Path(path).exists() or not world.exists():
            self.skipTest('Set NOITA_DECODER_PATH and install original source archive for full comparison')
        decoder = m.load_module('archive_comparison_decoder', Path(path))
        palette = {p['name']: i for i, p in enumerate(self.route['palette'])}
        total = 0
        for record in self.route['source']['chunks']:
            file = world / record['filename']
            self.assertEqual(m.sha(file.read_bytes()), record['sha256'])
            (x, y), terrain, _ = decoder.decode_file(file)
            sorted_names = sorted(terrain.names)
            native_hash = np.array([sorted_names.index(n) for n in terrain.names], dtype='<u2')[terrain.indices]
            self.assertEqual(m.sha(native_hash.tobytes()), record['material_raster_sha256'])
            for r, raster in zip(self.route['regions'], self.arrays):
                lo = max(y, r['sourceTop'])
                hi = min(y + 512, r['sourceTop'] + 320, 13888)
                left, right = max(x, -4608), min(x + 512, 4608)
                if hi <= lo or right <= left:
                    continue
                published = raster[lo - r['sourceTop']:hi - r['sourceTop'], left + 4608:right + 4608]
                mask = published != 255
                ids = terrain.indices[lo - y:hi - y, left - x:right - x]
                for index in np.unique(ids[mask]):
                    self.assertTrue(np.all(published[mask & (ids == index)] == palette[terrain.names[int(index)]]),
                                    f'Primary source disagreement {record["filename"]} region {r["key"]}')
                total += int(mask.sum())
        self.assertGreater(total, 60000000)
        print(f'Archive comparison: {total:,} published primary cells (including overlapping context) exactly match native names.')


if __name__ == '__main__':
    unittest.main()
