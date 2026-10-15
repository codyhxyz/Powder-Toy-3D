"""CPU self-checks for the native archive reader, palette and sparse packing."""
import importlib.util
from pathlib import Path
import struct
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location('noita_import', Path(__file__).with_name('import-noita-map.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def archive(path=b'data/test.png', payload=b'png'):
    end = 28 + len(path)
    return struct.pack('<4I', 0, 1, end, 0) + struct.pack('<3I', end, len(payload), len(path)) + path + payload


class ImportChecks(unittest.TestCase):
    def test_selective_archive_and_bounds(self):
        data = archive()
        self.assertEqual(module.Wak(data).read('data/test.png'), b'png')
        for bad in [data[:12], data[:-1], archive(b'data/../escape'), archive(b'/data/test')]:
            with self.assertRaises(ValueError):
                module.Wak(bad)
        bad = bytearray(data)
        struct.pack_into('<I', bad, 16, 0)
        with self.assertRaises(ValueError):
            module.Wak(bad)

    def test_material_translation_is_explicit(self):
        xml = '<Materials><!-- <CellData name="bad" wang_color="ff123456"> -->'
        xml += '<CellData name="water" wang_color="ff112233"><CellDataChild name="ice" wang_color="ffaabbcc"></Materials>'
        self.assertEqual(module.material_palette(xml), {0x112233: 'water', 0xaabbcc: 'ice'})
        self.assertEqual(module.element_for('acid'), 'ACID')
        self.assertEqual(module.element_for('templebrick_static'), 'BRICK')
        self.assertIsNone(module.element_for('unknown_material'))

    def test_sparse_brick_layout(self):
        grid = np.zeros((16, 8, 16), dtype=np.uint8)
        grid[2, 3, 4] = 173
        grid[15, 7, 15] = 255
        data, count = module.pack(grid)
        words = np.frombuffer(data, dtype='<u4')
        self.assertEqual(count, 2)
        for z in range(16):
            for y in range(8):
                for x in range(16):
                    at = int(words[x // 8 + 2 * (y // 8 + z // 8)])
                    j = x % 8 + 8 * (y % 8 + 8 * (z % 8))
                    value = (int(words[at + (j >> 2)]) >> (8 * (j & 3))) & 255 if at else 0
                    self.assertEqual(value, int(grid[z, y, x]))
        with self.assertRaises(ValueError):
            module.pack(np.zeros((8, 8, 16), dtype=np.uint8))


if __name__ == '__main__':
    unittest.main()
