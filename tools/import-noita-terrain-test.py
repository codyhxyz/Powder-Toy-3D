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
CONFIG = json.loads((ROOT / 'tools/noita-terrain-source.json').read_text())


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

    def test_inflation_tube_is_round_and_depth_zero_is_native(self):
        open_ = np.zeros((60, 200), bool)
        open_[20:29, 10:190] = True                       # a tunnel 9 cells tall
        depth = m.inflate_depth(open_, 64)
        # Half-depth in half cells: 4.5 cells at the axis, a circle's chord off it.
        self.assertEqual(depth[20:29, 100].tolist(), [4, 6, 8, 8, 9, 8, 8, 6, 4])
        self.assertTrue(np.all(depth[~open_] == 0), 'closed pixels never inflate')
        self.assertTrue(np.all(depth[open_] >= 1), 'every open pixel is open at depth 0')

    def test_inflation_caps_and_fillets_big_rooms(self):
        open_ = np.ones((600, 600), bool)
        open_[0] = open_[-1] = False
        depth = m.inflate_depth(open_, 64)
        self.assertEqual(int(depth[300, 300]), 128)
        # Quarter-round fillet of radius 64 cells where the back wall meets a floor.
        self.assertEqual(depth[1:6, 300].tolist(), [15, 27, 35, 41, 46])

    def test_inflation_is_local_so_bands_have_no_seams(self):
        rng = np.random.default_rng(7)
        caves = rng.random((700, 500)) < .5
        for _ in range(6):
            p = np.pad(caves, 1)
            caves = (p[2:, 1:-1].astype(int) + p[:-2, 1:-1] + p[1:-1, 2:] + p[1:-1, :-2] + caves) >= 3
        full = m.inflate_depth(caves, 64)
        halo = 2 * (64 + 2) + 2
        window = m.inflate_depth(caves[100:600], 64)
        self.assertTrue(np.array_equal(window[halo:500 - halo], full[100 + halo:600 - halo]))

    def test_backdrop_majority_ties_and_fill(self):
        raster = np.zeros((32, 32), np.uint8)
        raster[:8, :8] = 3
        raster[:8, 8:12] = 2
        raster[:8, 12:16] = 4          # 2 and 4 tie in block (0, 1): the lower index wins
        blocks = m.backdrop_blocks(raster, [2, 3, 4], 8, 1)
        self.assertEqual(blocks[0, :2].tolist(), [3, 2])
        self.assertTrue(np.all(blocks != m.OUTSIDE), 'empty blocks take a neighbour, never OUTSIDE')
        with self.assertRaisesRegex(ValueError, 'No backdrop'):
            m.backdrop_blocks(np.zeros((8, 8), np.uint8), [5], 8, 1)

    def test_fold_must_hold_the_inflation(self):
        inflation = dict(maxHalfDepth=64, backdropMargin=4, backdropBlock=8, backdropWindow=9)
        m.check_inflation(dict(thickness=136), inflation)
        with self.assertRaisesRegex(ValueError, 'thickness'):
            m.check_inflation(dict(thickness=48), inflation)

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
        cls.arrays, cls.depths, cls.backdrops, cls.payloads = [], [], [], []
        width = cls.route['fold']['sourceWidth']
        block = cls.route['inflation']['backdropBlock']
        n, nb = width * 320, (width // block) * (320 // block)
        for r in cls.route['regions']:
            data = gzip.decompress((ASSETS / r['file']).read_bytes())
            cls.payloads.append(data)
            cls.arrays.append(np.frombuffer(data[:n], dtype=np.uint8).reshape(r['sourceHeight'], width))
            cls.depths.append(np.frombuffer(data[n:2 * n], dtype=np.uint8).reshape(320, width))
            cls.backdrops.append(np.frombuffer(data[2 * n:2 * n + nb], dtype=np.uint8).reshape(320 // block, width // block))

    def stitched(self, planes, scale=1):
        # One global plane from band cores (first band keeps its top context rows).
        top = self.route['regions'][0]['sourceTop']
        rows = [planes[0][:(self.route['regions'][0]['core'][1] - top) // scale]]
        for r, plane in zip(self.route['regions'][1:], planes[1:]):
            rows.append(plane[(r['core'][0] - r['sourceTop']) // scale:(r['core'][1] - r['sourceTop']) // scale])
        return np.concatenate(rows)

    def test_all_hashes_shapes_palette_and_adjacent_context(self):
        route = self.route
        top, bottom = CONFIG['sourceY']
        self.assertEqual(len(route['regions']), -(-(bottom - top) // 256))
        self.assertEqual(route['palette'][0], dict(name='air', element=0))
        self.assertLessEqual(len(route['palette']), 255)
        for i, (r, a) in enumerate(zip(route['regions'], self.arrays)):
            self.assertEqual(a.shape, (320, 9216))
            self.assertEqual(len(self.payloads[i]), 2 * a.size + self.backdrops[i].size)
            self.assertEqual(m.sha(a.tobytes()), r['sha256'])
            self.assertEqual(m.sha(self.payloads[i][a.size:]), r['fieldsSha256'])
            self.assertEqual(r['sourceTop'], r['core'][0] - 32)
            self.assertEqual(r['core'][0], top + i * 256)
            self.assertTrue(np.all((a < len(route['palette'])) | (a == 255)))
            if i:
                self.assertTrue(np.array_equal(self.arrays[i - 1][-64:], a[:64]))
                self.assertTrue(np.array_equal(self.depths[i - 1][-64:], self.depths[i][:64]), 'no depth seams')
                self.assertTrue(np.array_equal(self.backdrops[i - 1][-8:], self.backdrops[i][:8]), 'no backdrop seams')
        last = route['regions'][-1]['core']
        self.assertEqual(last[1], bottom)
        self.assertTrue(np.all(self.arrays[-1][32 + last[1] - last[0]:] == 255))

    def test_start_portals_and_debug_spawn_diagnostics(self):
        start = CONFIG['startSource']
        self.assertEqual(self.route['startSource'], start)
        scene = next(r for r in self.route['regions'] if r['core'][0] <= start[1] < r['core'][1])
        self.assertEqual(self.route['startScene'], scene['key'])
        self.assertTrue(self.route['source']['startValidation']['bodyAir'])
        excluded = [g['origin'] for g in CONFIG['explicitExcludedGaps']]
        rows = [*CONFIG['regularTempleRows'], 39]
        cells = [((col - 35) * 512, (row - 14) * 512) for row in rows
                 for col in range(CONFIG['rowEnvelopes'][str(row)][0], CONFIG['rowEnvelopes'][str(row)][1] + 1)]
        self.assertEqual(len(self.route['nativePortals']), len([c for c in cells if list(c) not in excluded]))
        for p in self.route['nativePortals']:
            self.assertEqual(p['halfSize'], [15, 15])
            self.assertIsInstance(p['enabled'], bool)
            self.assertEqual(p['target'][1] - p['source'][1], 280)
            self.assertTrue(p['evidence']['targetBodyCollisionFree'])
            if [-1536, 12800] in excluded:
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
                depth = self.depths[self.route['regions'].index(r)][int(np.floor(y - 5.5)) - r['sourceTop']:int(np.ceil(y)) - r['sourceTop'],
                                                                     int(np.floor(x - .8)) + 4608:int(np.floor(x + .8)) + 4609]
                self.assertTrue(np.all(depth > 2 * m.BODY_RADIAL_REACH), 'debug starts are body-clear in 3D, not just in the native slice')
            if r.get('spawnOpenView'):
                ix, iy = int(np.floor(x)) + 4608, int(y) - r['sourceTop']
                view = a[iy - 12:iy, ix - 2:ix + 21]
                self.assertEqual(view.shape, (12, 23))
                self.assertTrue(np.all(view == 0), 'debug camera uses an actual open room, never carved space')
            else:
                self.assertTrue(all(self.route['palette'][int(i)]['element'] in {0, 7, 8, 9, 10, 73, 74, 75, 79} for i in np.unique(body)))
            if not r['spawnSupported']:
                self.assertEqual(r['spawnPolicy'], 'hazardous-streaming-only')
                self.assertIn('Native lava band', r['warning'])

    def test_inflation_planes_recompute_exactly_from_native_pixels(self):
        palette = self.route['palette']
        open_ids, backdrop_ids = m.inflation_tables(palette, json.loads((ROOT / 'tools/noita-terrain-materials.json').read_text())['backdropElements'])
        raster = self.stitched(self.arrays)
        depth = self.stitched(self.depths)
        is_open = np.isin(raster, open_ids)
        self.assertTrue(np.array_equal(depth > 0, is_open), 'exactly the open pixels inflate')
        self.assertLessEqual(int(depth.max()), 2 * self.route['inflation']['maxHalfDepth'])
        # Values depend only on pixels within the halo, so windows recompute exactly.
        half = self.route['inflation']['maxHalfDepth']
        halo, miny = 2 * (half + 2) + 2, self.route['regions'][0]['sourceTop']
        for sx, sy in [self.route['startSource'][:2], (0, 3800), (2000, 13000)]:
            x0, y0 = int(sx) + 4608 - 256, int(sy) - miny - 256
            y0, x0 = max(0, y0), max(0, min(x0, 9216 - 512))
            a, b = max(0, y0 - halo), min(len(raster), y0 + 512 + halo)
            got = m.inflate_depth(is_open[a:b], half)
            self.assertTrue(np.array_equal(got[y0 - a:y0 - a + 512, x0:x0 + 512], depth[y0:y0 + 512, x0:x0 + 512]), (sx, sy))
        block = self.route['inflation']['backdropBlock']
        blocks = m.backdrop_blocks(raster, backdrop_ids, block, self.route['inflation']['backdropWindow'])
        self.assertTrue(np.array_equal(blocks, self.stitched(self.backdrops, block)[:len(blocks)]))
        self.assertTrue(set(np.unique(blocks).tolist()) <= set(backdrop_ids), 'backdrop is bulk rock, never props or air')

    def test_black_air_regression_exact_counts_and_debris_exceptions(self):
        proof = json.loads((ASSETS / 'black-air-regression.json').read_text())
        self.assertEqual(proof, self.route['source']['fixedScene']['blackAirProof'])
        # Exact counts for the clean day-0 source (descent-clean-2026-10-17).
        self.assertEqual(proof['blackPixels'], 612469)
        self.assertEqual(proof['savedAirPixels'], 611991)
        pieces = {tuple(r['origin']): r for r in proof['pieces']}
        self.assertEqual(pieces[3072, 13312]['savedMaterialCounts'], {'air': 6656})
        self.assertEqual(sum(sum(r['savedMaterialCounts'].values()) for r in proof['pieces']), 612469)

    def test_runtime_manifest_same_interface_without_provenance(self):
        small = json.loads((ROOT / 'src/world/scenes/descent/terrainRoute.json').read_text())
        for key in ['fold', 'inflation', 'palette', 'regions', 'sections', 'startScene', 'startSource']:
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
        excluded = [g['origin'] for g in CONFIG['explicitExcludedGaps']]
        above = (int(min(CONFIG['rowEnvelopes'], key=int)) - 14) * 512 - 512
        for gap in self.route['source']['gaps']:
            self.assertTrue(gap['origin'] in excluded or gap['origin'][1] == above, gap)
            self.assertIn('OUTSIDE', gap['disposition'])

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
        if any(p['suppliedPixels'] for p in self.route['source']['fixedScene']['pieces']):
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
