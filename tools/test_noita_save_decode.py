"""CPU-only decoder tests; synthetic format fixtures, no game/save mutations."""
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest

import numpy as np

SPEC = importlib.util.spec_from_file_location('noita_save_decode', Path(__file__).with_name('noita-save-decode.py'))
decoder = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = decoder
SPEC.loader.exec_module(decoder)


def literal_wrapper(data):
    encoded = bytearray()
    for p in range(0, len(data), 32):
        block = data[p:p + 32]
        encoded.append((len(block) - 1) | (32 if p == 0 else 0))
        encoded.extend(block)
    return struct.pack('<II', len(encoded), len(data)) + encoded


def inner(cells=None, names=('air', 'water', 'rock_static'), colors=b'', tail=b'opaque'):
    if cells is None:
        cells = np.zeros((512, 512), dtype=np.uint8)
    result = struct.pack('>III', 24, 512, 512) + cells.tobytes() + struct.pack('>I', len(names))
    for name in names:
        name = name.encode()
        result += struct.pack('>I', len(name)) + name
    return result + struct.pack('>I', len(colors) // 4) + colors + tail


class Compression(unittest.TestCase):
    def test_literal_and_overlap(self):
        data = b'example' * 50
        self.assertEqual(decoder.unwrap(literal_wrapper(data)), data)
        self.assertEqual(decoder.fastlz2(b'\x20a\x20\x00', 4), b'aaaa')
        self.assertEqual(decoder.fastlz2(b'\x20a\xe0\xff\x00\x00', 265), b'a' * 265)

    def test_far_reference(self):
        data = bytes(range(256)) * 32
        payload = literal_wrapper(data)[8:] + b'\x3f\xff\x00\x00'
        self.assertEqual(decoder.fastlz2(payload, 8195), data + data[:3])

    def test_reject_corrupt(self):
        for payload, size in [(b'', 1), (b'\x00a', 1), (b'\x21a', 2),
                              (b'\x20a\x20\x01', 4), (b'\x20a', 2),
                              (b'\x20a\xe0\xff', 500), (b'\x20a', decoder.MAX_DECODED + 1)]:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                decoder.fastlz2(payload, size)
        wrapped = literal_wrapper(b'hello')
        for damaged in (wrapped[:5], wrapped[:-1], wrapped + b'x'):
            with self.assertRaises(ValueError):
                decoder.unwrap(damaged)


class PixelScene(unittest.TestCase):
    def test_plz_levels_and_material_palette(self):
        pixels = bytes([0, 51, 68, 255, 0, 0, 0, 255])
        xml = b'<CellData name="rock_hard" wang_color="ff003344" >'
        for level in (1, 2):
            encoded = bytes([(len(pixels) - 1) | ((level - 1) << 5)]) + pixels
            data = struct.pack('<6I', 1, 2, 1, 4, len(encoded), len(pixels)) + encoded
            raster, names, rgba, meta = decoder.material_raster_from_plz(data, xml)
            self.assertEqual(names, ['rock_hard'])
            self.assertEqual(raster.tolist(), [[0, 65535]])
            self.assertEqual(rgba.tobytes(), pixels)
            self.assertEqual(meta['fastlz_level'], level)
            self.assertEqual(meta['unresolved_colors'], [{'rgb': '000000', 'count': 1, 'candidates': []}])
            ambiguous = xml + b'<CellData name="other" wang_color="ff003344" >'
            self.assertTrue(np.all(decoder.material_raster_from_plz(data, ambiguous)[0] == 65535))
            for corrupt in (data[:24], data[:-1], data + b'x'):
                with self.assertRaises(ValueError):
                    decoder.decode_plz(corrupt)


class Terrain(unittest.TestCase):
    def test_materials_flags_color_and_opaque_tail(self):
        cells = np.zeros((512, 512), dtype=np.uint8)
        cells[12, 34] = 129  # saved local water ID + color flag
        cells[50, 60] = 2
        result = decoder.decode_inner(inner(cells, colors=b'\xff\x11\x22\x33'))
        self.assertEqual(result.names[1], 'water')
        self.assertEqual(result.indices[12, 34], 1)
        self.assertEqual(result.indices[50, 60], 2)
        self.assertEqual(result.colors.tobytes(), b'\xff\x11\x22\x33')
        self.assertEqual(result.tail, b'opaque')

    def test_bad_inner(self):
        data = inner()
        for damaged in (data[:10], b'\0' + data[1:3] + b'\x19' + data[4:],
                        data[:262158], inner(names=()), inner(names=('air', 'air')),
                        inner(names=('bad name',)), inner(colors=b'1234')):
            with self.subTest(length=len(damaged)), self.assertRaises(ValueError):
                decoder.decode_inner(damaged)
        cells = np.full((512, 512), 3, dtype=np.uint8)
        with self.assertRaises(ValueError):
            decoder.decode_inner(inner(cells))

    def test_region_coordinates_missingness_local_palettes_and_seam(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            world = root / 'save' / 'world'
            world.mkdir(parents=True)
            # Adjacent chunks use DIFFERENT local numeric IDs for rock/water.
            left = np.full((512, 512), 2, dtype=np.uint8)
            right = np.full((512, 512), 1, dtype=np.uint8)
            left[:100] = 0
            right[:100] = 0
            left[300:] = 1
            right[300:] = 2
            for x, cells, names in [(-512, left, ('air', 'water', 'rock_static')),
                                    (0, right, ('air', 'rock_static', 'water'))]:
                (world / f'world_{x}_1024.png_petri').write_bytes(literal_wrapper(inner(cells, names)))
            output = root / 'decoded'
            stats = decoder.export_region(world, output, (-512, 1024, 512, 1024))
            self.assertEqual(stats['missing_chunks'], 1)
            with np.load(output / 'region.npz', allow_pickle=False) as region:
                self.assertEqual(region['origin'].tolist(), [-512, 1024])
                self.assertEqual(region['missing_chunks'].tolist(), [[False, False, True]])
                raster = region['material_id']
                np.testing.assert_array_equal(raster[:, 511], raster[:, 512])
                self.assertTrue(np.all(raster[:, 1024:] == decoder.MISSING))
                names = region['material_names'].tolist()
                self.assertEqual(names[int(raster[50, 0])], 'air')
                self.assertEqual(names[int(raster[200, 0])], 'rock_static')
                self.assertEqual(names[int(raster[400, 0])], 'water')
            manifest = json.loads((output / 'manifest.json').read_text())
            self.assertEqual(manifest['missing_origins'], [[512, 1024]])
            for record in manifest['chunks']:
                self.assertEqual(record['sha256'], decoder.sha((world / record['filename']).read_bytes()))
            with self.assertRaises(ValueError):
                decoder.export_region(world, world / 'oops', (-512, 1024, 0, 1024))
            with self.assertRaises(ValueError):
                decoder.export_region(world, output, (-1, 1024, 0, 1024))


@unittest.skipUnless(os.environ.get('NOITA_SAVED_WORLD'), 'Set NOITA_SAVED_WORLD to read-only archive world/')
class ArchivedTerrain(unittest.TestCase):
    def test_actual_air_solid_fluid_and_source_hash(self):
        world = Path(os.environ['NOITA_SAVED_WORLD'])
        _, air, _ = decoder.decode_file(world / 'world_-1024_-1536.png_petri')
        self.assertEqual(int(np.count_nonzero(air.indices == air.names.index('air'))), 262136)
        _, terrain, meta = decoder.decode_file(world / 'world_0_2048.png_petri')
        self.assertEqual(meta['sha256'], '2371c4c8c8faa4659ec2f28bdf9ee3b47938721fffdc487b1353a2ed00a42dc3')
        self.assertEqual(meta['decoded_sha256'], '0e9747215086a50a7b8949935acabd7776b27c723bb71700f1b4163cd3449543')
        self.assertEqual(meta['material_counts']['air'], 174940)
        self.assertEqual(meta['material_counts']['coal_static'], 42404)
        self.assertEqual(meta['material_counts']['rock_static_grey'], 28413)
        self.assertEqual(meta['material_counts']['water'], 748)
        self.assertEqual(len(terrain.colors), 49803)

    def test_actual_horizontal_seam_supports_row_major(self):
        world = Path(os.environ['NOITA_SAVED_WORLD'])
        _, left, _ = decoder.decode_file(world / 'world_-512_2048.png_petri')
        _, right, _ = decoder.decode_file(world / 'world_0_2048.png_petri')
        a = np.array(left.names)[left.indices]
        b = np.array(right.names)[right.indices]
        self.assertGreater(float(np.mean(a[:, -1] == b[:, 0])), .8)
        self.assertGreater(float(np.mean(a[:, -1] == b[:, 0])),
                           float(np.mean(a[-1, :] == b[0, :])))


if __name__ == '__main__':
    unittest.main()
