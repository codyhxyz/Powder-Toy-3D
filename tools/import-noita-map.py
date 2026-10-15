#!/usr/bin/env python3
"""Compatibility entry point for the assembled-terrain importer.

The rejected room-stamping compiler has been removed. Keep only its selective
WAK reader; the source importer uses it to read native metadata and fixed scenes.
"""
from pathlib import Path
import runpy
import struct


class Wak:
    """Bounds-checked selective reader; never extracts the archive to disk."""
    def __init__(self, data):
        self.data, self.entries = data, {}
        if len(data) < 16:
            raise ValueError('Truncated WAK header')
        _, count, table_end, _ = struct.unpack_from('<4I', data)
        if not 16 <= table_end <= len(data) or count > (table_end - 16) // 13:
            raise ValueError('Invalid WAK table bounds')
        p = 16
        for _ in range(count):
            if p + 12 > table_end:
                raise ValueError('Truncated WAK entry')
            offset, size, length = struct.unpack_from('<3I', data, p)
            p += 12
            if not length or p + length > table_end:
                raise ValueError('Invalid WAK path bounds')
            path = data[p:p + length].decode('utf-8')
            p += length
            if path in self.entries or not path.startswith('data/') or '..' in path.split('/') or '\\' in path:
                raise ValueError('Invalid/duplicate WAK path')
            if offset < table_end or offset + size > len(data):
                raise ValueError('Invalid WAK payload bounds')
            self.entries[path] = (offset, size)
        if p != table_end:
            raise ValueError('WAK table size mismatch')

    def read(self, path):
        offset, size = self.entries[path]
        return self.data[offset:offset + size]


if __name__ == '__main__':
    runpy.run_path(str(Path(__file__).with_name('import-noita-terrain.py')), run_name='__main__')
