#!/usr/bin/env python3
"""Read-only decoder for version-24 assembled Noita png_petri save chunks.

Requires numpy (Pillow only for --preview). Never reads room assets or fills gaps.
See docs/noita-save-decoder.md for the observed format and limits.
"""
import argparse
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
import struct

import numpy as np

CHUNK = 512
MAX_DECODED = 64 * 1024 * 1024
MISSING = 65535
FILENAME = re.compile(r'world_(-?\d+)_(-?\d+)\.png_petri\Z')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fastlz2(data, expected):
    """FastLZ level 2, including overlapping and far-distance references."""
    if not data or (data[0] >> 5) + 1 != 2:
        raise ValueError('Expected FastLZ level 2')
    return _fastlz(data, expected, 2)


def _fastlz(data, expected, level):
    if level not in (1, 2):
        raise ValueError('Unsupported FastLZ level')
    if not 0 < expected <= MAX_DECODED:
        raise ValueError('Decoded size exceeds limit or is empty')
    out = bytearray()
    p = 1
    ctrl = data[0] & 31

    def byte():
        nonlocal p
        if p >= len(data):
            raise ValueError('Truncated FastLZ token')
        value = data[p]
        p += 1
        return value

    while True:
        if ctrl < 32:
            length = ctrl + 1
            if p + length > len(data) or len(out) + length > expected:
                raise ValueError('FastLZ literal exceeds bounds')
            out.extend(data[p:p + length])
            p += length
        else:
            length = (ctrl >> 5) - 1
            offset = (ctrl & 31) << 8
            if length == 6:
                while True:
                    extra = byte()
                    length += extra
                    if length + 3 > expected - len(out):
                        raise ValueError('FastLZ match exceeds output size')
                    if level == 1 or extra != 255:
                        break
            low = byte()
            distance = offset + low + 1
            if level == 2 and low == 255 and offset == 7936:
                distance = (byte() << 8) + byte() + 8192
            length += 3
            if distance > len(out) or length > expected - len(out):
                raise ValueError('FastLZ reference exceeds bounds')
            # Slicing alone would not implement overlapping references.
            block = bytes(out[-distance:])
            out.extend((block * ((length + distance - 1) // distance))[:length])
        if p == len(data):
            break
        ctrl = byte()
    if len(out) != expected:
        raise ValueError('FastLZ decoded size mismatch')
    return bytes(out)


def decode_plz(data):
    """Return exact [y,x,4] bytes from native PixelScene PLZ, plus provenance.

    This is NOT a saved terrain palette stream. Channels are retained verbatim.
    """
    if len(data) < 25:
        raise ValueError('Truncated PLZ header')
    version, width, height, channels, compressed, decoded = struct.unpack_from('<6I', data)
    if version != 1 or channels != 4 or not 1 <= width <= 512 or not 1 <= height <= 512:
        raise ValueError('Unsupported PLZ header')
    if compressed != len(data) - 24 or decoded != width * height * channels:
        raise ValueError('PLZ size mismatch')
    level = (data[24] >> 5) + 1
    payload = _fastlz(data[24:], decoded, level)
    pixels = np.frombuffer(payload, dtype=np.uint8).reshape(height, width, channels)
    return pixels, dict(source_sha256=sha(data), decoded_sha256=sha(payload),
                        source_bytes=len(data), decoded_bytes=decoded,
                        header=list(struct.unpack_from('<6I', data)), fastlz_level=level)


def material_raster_from_plz(data, materials_xml):
    """Return (native-name indices, names, RGBA bytes, metadata).

    IDs index sorted native names, NOT engine IDs. Unknown/ambiguous colors are
    MISSING (65535), never implicitly air. No scene coordinates are invented.
    """
    pixels, metadata = decode_plz(data)
    text = re.sub(r'<!--.*?-->', '', materials_xml.decode('utf-8'), flags=re.S)
    palette = {}
    for tag in re.findall(r'<CellData(?:Child)?\s+([^>]+)>', text):
        attrs = dict(re.findall(r'([\w_]+)\s*=\s*"([^"]*)"', tag))
        if 'name' in attrs and 'wang_color' in attrs:
            color = int(attrs['wang_color'], 16) & 0xffffff
            palette.setdefault(color, set()).add(attrs['name'])
    names = sorted({name for values in palette.values() for name in values})
    if len(names) >= MISSING:
        raise ValueError('Too many native material names')
    lookup = {name: i for i, name in enumerate(names)}
    rgb = pixels[:, :, :3].astype(np.uint32)
    colors = (rgb[:, :, 0] << 16) | (rgb[:, :, 1] << 8) | rgb[:, :, 2]
    raster = np.full(colors.shape, MISSING, dtype=np.uint16)
    unresolved = []
    for color, count in zip(*np.unique(colors, return_counts=True)):
        candidates = palette.get(int(color), set())
        if len(candidates) == 1:
            raster[colors == color] = lookup[next(iter(candidates))]
        else:
            unresolved.append(dict(rgb=f'{int(color):06x}', count=int(count),
                                   candidates=sorted(candidates)))
    metadata.update(materials_xml_sha256=sha(materials_xml), unresolved_colors=unresolved,
                    nonopaque_pixels=int(np.count_nonzero(pixels[:, :, 3] != 255)),
                    mapping='unique materials.xml wang_color RGB; unresolved retained as 65535')
    return raster, names, pixels, metadata


def unwrap(data):
    if len(data) < 9:
        raise ValueError('Truncated png_petri wrapper')
    compressed, decoded = struct.unpack_from('<II', data)
    if compressed != len(data) - 8:
        raise ValueError('Compressed size mismatch')
    return fastlz2(data[8:], decoded)


@dataclass
class Terrain:
    cells: np.ndarray
    names: list
    colors: np.ndarray
    tail: bytes
    color_offset: int
    tail_offset: int

    @property
    def indices(self):
        return self.cells & 127


def decode_inner(data):
    """Decode the terrain prefix; retain uninterpreted trailing physics data."""
    if len(data) < 12 or struct.unpack_from('>III', data) != (24, CHUNK, CHUNK):
        raise ValueError('Unsupported inner header (expected 24,512,512)')
    p = 12

    def take(size):
        nonlocal p
        if size < 0 or size > len(data) - p:
            raise ValueError('Truncated terrain record')
        value = data[p:p + size]
        p += size
        return value

    def u32():
        return struct.unpack('>I', take(4))[0]

    cells = np.frombuffer(take(CHUNK * CHUNK), dtype=np.uint8).reshape(CHUNK, CHUNK)
    count = u32()
    if not 1 <= count <= 128:
        raise ValueError('Unsupported material palette size')
    names = []
    for _ in range(count):
        size = u32()
        if not 1 <= size <= 1024:
            raise ValueError('Invalid material name length')
        try:
            name = take(size).decode('ascii')
        except UnicodeDecodeError as exc:
            raise ValueError('Non-ASCII material name') from exc
        if not re.fullmatch(r'[a-zA-Z0-9_]+', name) or name in names:
            raise ValueError('Invalid/duplicate material name')
        names.append(name)
    if int((cells & 127).max()) >= count:
        raise ValueError('Cell references absent palette entry')
    color_count = u32()
    if color_count != int(np.count_nonzero(cells & 128)):
        raise ValueError('Saved color count differs from high-bit cell count')
    color_offset = p
    colors = np.frombuffer(take(color_count * 4), dtype=np.uint8).reshape(-1, 4)
    # Trailing rigid bodies / other data are NOT interpreted as terrain.
    return Terrain(cells, names, colors, data[p:], color_offset, p)


def decode_file(path):
    match = FILENAME.fullmatch(path.name)
    if not match:
        raise ValueError('Expected world_<x>_<y>.png_petri')
    origin = tuple(map(int, match.groups()))
    if any(v % CHUNK for v in origin):
        raise ValueError('Chunk origin is not aligned to 512')
    raw = path.read_bytes()
    decoded = unwrap(raw)
    terrain = decode_inner(decoded)
    metadata = dict(origin=list(origin), filename=path.name, sha256=sha(raw),
                    decoded_sha256=sha(decoded), source_bytes=len(raw),
                    decoded_bytes=len(decoded), material_names=terrain.names,
                    color_count=len(terrain.colors), color_offset=terrain.color_offset,
                    opaque_tail_offset=terrain.tail_offset, opaque_tail_bytes=len(terrain.tail),
                    material_counts={name: int(np.count_nonzero(terrain.indices == i))
                                     for i, name in enumerate(terrain.names)})
    return origin, terrain, metadata


def export_region(world, output, bounds, preview=False):
    """Inclusive bounds are CHUNK ORIGINS, not pixel endpoints."""
    xmin, ymin, xmax, ymax = bounds
    if xmin > xmax or ymin > ymax or any(v % CHUNK for v in bounds):
        raise ValueError('Bounds must be ordered 512-aligned chunk origins')
    nx, ny = (xmax - xmin) // CHUNK + 1, (ymax - ymin) // CHUNK + 1
    if nx * ny > 512:
        raise ValueError('Region exceeds 512 chunks; export smaller rectangles')
    world = world.resolve(strict=True)
    output = output.resolve()
    # Never create decoder output inside a source save (including via symlinks).
    if output == world or world in output.parents or world.parent in output.parents:
        raise ValueError('Output must be outside the source save')
    if output.exists():
        raise ValueError('Output directory must not already exist (no overwrites)')
    records, names = [], set()
    for y in range(ymin, ymax + 1, CHUNK):
        for x in range(xmin, xmax + 1, CHUNK):
            path = world / f'world_{x}_{y}.png_petri'
            if path.exists():
                _, terrain, meta = decode_file(path)
                records.append(meta)
                names.update(terrain.names)
    if not records:
        raise ValueError('No saved chunks in requested rectangle')
    names = sorted(names)
    if len(names) >= MISSING:
        raise ValueError('Too many distinct materials')
    lookup = {name: i for i, name in enumerate(names)}
    raster = np.full((ny * CHUNK, nx * CHUNK), MISSING, dtype=np.uint16)
    missing = np.ones((ny, nx), dtype=np.bool_)
    output.mkdir(parents=True, exist_ok=False)
    chunks = output / 'chunks'
    chunks.mkdir(exist_ok=True)
    for meta in records:
        x, y = meta['origin']
        _, terrain, checked = decode_file(world / meta['filename'])
        if checked != meta:
            raise ValueError('Source changed between passes')
        ix, iy = (x - xmin) // CHUNK, (y - ymin) // CHUNK
        remap = np.array([lookup[n] for n in terrain.names], dtype=np.uint16)
        raster[iy * CHUNK:(iy + 1) * CHUNK, ix * CHUNK:(ix + 1) * CHUNK] = remap[terrain.indices]
        missing[iy, ix] = False
        relative = f'chunks/world_{x}_{y}.npz'
        np.savez_compressed(output / relative, origin=np.array([x, y], dtype=np.int64),
                            cell_bytes=terrain.cells, material_index=terrain.indices,
                            material_names=np.array(terrain.names), color_bytes=terrain.colors,
                            opaque_tail=np.frombuffer(terrain.tail, dtype=np.uint8))
        meta['output'] = relative
    np.savez_compressed(output / 'region.npz', material_id=raster, material_names=np.array(names),
                        missing_chunks=missing, origin=np.array([xmin, ymin], dtype=np.int64),
                        chunk_size=np.array(CHUNK), missing_id=np.array(MISSING, dtype=np.uint16))
    values, counts = np.unique(raster, return_counts=True)
    stats = {names[int(i)] if i != MISSING else '__MISSING__': int(c) for i, c in zip(values, counts)}
    manifest = dict(format='noita-save-terrain-v1', source_world=str(world),
                    bounds_chunk_origins=list(bounds), raster_shape=list(raster.shape),
                    array_order='[y,x], x fastest; world y increases down',
                    material_id_provenance='region IDs: sorted native names; chunk IDs: saved local palette',
                    missing_id=MISSING, missing_origins=[[int(xmin + ix * CHUNK), int(ymin + iy * CHUNK)]
                                                        for iy, ix in zip(*np.where(missing))],
                    statistics=stats, chunks=records,
                    limitations=['Gameplay-modified generated save; not pristine/unexplored terrain.',
                                 'Opaque trailing physics records retained, not rasterized.',
                                 'Global engine runtime numeric IDs are not inferred.'])
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    if preview:
        from PIL import Image
        # Diagnostic name-hash colors, NOT source colors or physical classification.
        palette = np.array([list(hashlib.sha256(n.encode()).digest()[:3]) for n in names], dtype=np.uint8)
        if 'air' in lookup:
            palette[lookup['air']] = 0
        image = np.empty((*raster.shape, 3), dtype=np.uint8)
        valid = raster != MISSING
        image[valid] = palette[raster[valid]]
        image[~valid] = [255, 0, 255]
        Image.fromarray(image).save(output / 'preview.png')
    return dict(chunks=len(records), missing_chunks=int(missing.sum()), pixels=int(raster.size),
                statistics=stats)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--world', type=Path, required=True, help='Read-only archived world/ directory')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--bounds', nargs=4, type=int, required=True, metavar=('XMIN', 'YMIN', 'XMAX', 'YMAX'))
    parser.add_argument('--preview', action='store_true', help='Diagnostic name-hash colors, air black, missing magenta')
    args = parser.parse_args()
    try:
        result = export_region(args.world, args.output, args.bounds, args.preview)
    except (ValueError, OSError) as exc:
        parser.exit(1, f'error: {exc}\n')
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
