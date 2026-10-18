#!/usr/bin/env python3
"""Compile immutable assembled Noita terrain, CPU-only. Never stamps rooms.

python3 tools/import-noita-terrain.py --decoder /path/to/noita-save-decode.py
Requires numpy/Pillow. Source world and WAK are read-only; only output assets
and the small runtime manifest are written. --inventory writes nothing.
"""
import argparse
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUTSIDE = 255
MISSING = 65535
# Existing physical roles that do not form body collision surfaces.
BODY_PASSABLE_ELEMENTS = {'EMPTY', 'WATER', 'OIL', 'ACID', 'LAVA', 'STEAM', 'SMOKE', 'FIRE',
                         'CLOUD', 'PLASMA', 'MERCURY', 'LIQUID_NITROGEN', 'SALTWATER', 'CO2',
                         'HYDROGEN', 'OXYGEN', 'CAUSTIC_GAS', 'PROPANE', 'BLOOD', 'TOXIC',
                         'SLIME', 'WHISKEY', 'TELEPORTATIUM', 'LEVITATIUM', 'HEALTHIUM',
                         'BERSERKIUM', 'POLYMORPHINE', 'PHEROMONE'}


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # dataclasses in the hyphenated decoder need this
    spec.loader.exec_module(module)
    return module


def sha(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()


def packed(data):
    compressed = bytearray(gzip.compress(data, compresslevel=9, mtime=0))
    compressed[9] = 255  # platform-independent gzip OS field
    # Only the DECOMPRESSED raster needs u32 alignment. Web DecompressionStream
    # rejects junk/padding after a gzip member, unlike Python gzip.decompress.
    return bytes(compressed)


def make_palette(names, mapping, elements):
    names = ['air'] + sorted(set(names) - {'air'})
    if len(names) > 255:
        raise ValueError('Native palette exceeds 255 entries')
    unknown = sorted(set(names) - mapping.keys())
    if unknown:
        raise ValueError('Unmapped native materials: ' + ', '.join(unknown))
    result = []
    for name in names:
        key = mapping[name]
        if key not in elements or (key == 'EMPTY') != (name == 'air'):
            raise ValueError(f'Invalid physical mapping {name}: {key}')
        result.append(dict(name=name, element=elements[key]))
    return result


def remap_native(indices, names, lookup):
    # No runtime/engine numeric IDs enter this global native-name raster.
    return np.array([lookup[n] for n in names], dtype=np.uint16)[indices]


def require_complete(raster, selected, origin):
    bad = selected & (raster == MISSING)
    if np.any(bad):
        y, x = np.argwhere(bad)[0]
        raise ValueError(f'Missing selected source pixels: {int(bad.sum())}; first at '
                         f'{int(x + origin[0])},{int(y + origin[1])}')


def resolve_fixed(indices, names, rgba, needed, lookup, black_proof):
    if np.any(needed & (rgba[:, :, 3] != 255)):
        raise ValueError('Unknown fixed-scene RGBA: nonopaque material pixels')
    result = np.full(indices.shape, MISSING, dtype=np.uint16)
    known = needed & (indices != MISSING)
    if np.any(known):
        for index in np.unique(indices[known]):
            result[known & (indices == index)] = lookup[names[int(index)]]
    black = needed & np.all(rgba == [0, 0, 0, 255], axis=2)
    if np.any(black):
        if black_proof['blackPixels'] < 100000 or black_proof['airFraction'] < .99:
            raise ValueError('Reserved fixed-arena black lacks saved-cell evidence')
        result[black] = lookup['air']
    unresolved = needed & (result == MISSING)
    if np.any(unresolved):
        colors, counts = np.unique(rgba[unresolved], axis=0, return_counts=True)
        raise ValueError('Unknown fixed-scene RGBA (never fallback to air): ' +
                         repr(list(zip(colors.tolist(), counts.tolist()))))
    return result


def regions_from(raster, origin_y, source_y, core_height, context):
    width = raster.shape[1]
    for top in range(source_y[0], source_y[1], core_height):
        source_top = top - context
        height = core_height + 2 * context
        region = np.full((height, width), OUTSIDE, dtype=np.uint8)
        lo, hi = max(source_top, origin_y), min(source_top + height, origin_y + len(raster))
        if hi > lo:
            region[lo - source_top:hi - source_top] = raster[lo - origin_y:hi - origin_y]
        yield top, min(top + core_height, source_y[1]), source_top, region


def physical_elements():
    # IDs follow the actual defs order that src/elements.js uses for E.
    text = (ROOT / 'src/elements.js').read_text()
    defs = text.split('const defs = [', 1)[1].split('\n];', 1)[0]
    keys = re.findall(r"\bkey:\s*'([A-Z_0-9]+)'", defs)
    if not keys or keys[0] != 'EMPTY' or len(set(keys)) != len(keys):
        raise ValueError('Cannot read actual elements.js defs')
    return {name: i for i, name in enumerate(keys)}


def element_kinds():
    # Matter kind per element key (K.EMPTY/SOLID/POWDER/LIQUID/GAS), from the same defs.
    defs = (ROOT / 'src/elements.js').read_text().split('const defs = [', 1)[1].split('\n];', 1)[0]
    kinds = dict(re.findall(r"\{[^{}]*?\bkey:\s*'([A-Z_0-9]+)'[^{}]*?\bkind:\s*K\.([A-Z]+)", defs))
    if set(kinds) != set(physical_elements()):
        raise ValueError('Cannot read a kind for every elements.js def')
    return kinds


# Third dimension, variant A ("air-only round inflation"): every open pixel (air,
# liquid, gas) gets a depth from the union of balls on its 2D medial discs, so a
# tunnel becomes a round tube and a chamber a dome. Solid and powder pixels stay
# themselves at every depth; behind an open pixel's envelope sits the biome's own
# rock (the backdrop). Depth 0 is exactly the native raster. Depth units are half
# cells so every quantity is an exact small integer.
OPEN_KINDS = {'EMPTY', 'LIQUID', 'GAS'}
INFLATE_STRIPE = 1024    # rows per pass; memory stays ~50 MB per working array
CLOSED_POWER = -(1 << 30)  # "no ball here" in the power envelope
BACKDROP_EXCLUDED_NAMES = ('box2d', 'prop', 'item', 'player')
# POV body half-width (src/pov/constants.js BODY_WIDTH / 2) plus the farthest a
# body voxel's centre sits from it radially once the fold turns X/Z (sqrt(2) * 1.3).
BODY_HALF_WIDTH = .8
BODY_RADIAL_REACH = 1.9


def vertical_distance(closed, cap, top_closed, bottom_closed):
    """Cells to the nearest closed pixel in the same column, capped at cap."""
    h, w = closed.shape
    out = np.empty((h, w), np.int16)
    prev = np.zeros(w, np.int16) if top_closed else np.full(w, cap, np.int16)
    for y in range(h):
        prev = np.where(closed[y], 0, np.minimum(prev + 1, cap)).astype(np.int16)
        out[y] = prev
    prev = np.zeros(w, np.int16) if bottom_closed else np.full(w, cap, np.int16)
    for y in range(h - 1, -1, -1):
        prev = np.where(closed[y], 0, np.minimum(prev + 1, cap)).astype(np.int16)
        np.minimum(out[y], prev, out=out[y])
    return out


def inflate_depth(open_, max_half_depth):
    """Half-depth (half cells, u8) of each open pixel's 3D envelope; 0 for closed pixels.

    Ball radius at an open pixel is its distance to the nearest closed pixel centre
    minus half a cell (the pixel boundary), capped at max_half_depth. The envelope's
    half-depth at p is sqrt(max_q (r_q^2 - |p - q|^2)): the union of those balls.
    Outside the raster counts as closed. Exact integers, bounded radius: any pixel's
    value depends only on pixels within 2 * (max_half_depth + 2) of it.
    """
    h, w = open_.shape
    r_cap = 2 * max_half_depth                  # radius cap, half cells
    cap = max_half_depth + 2                    # beyond this distance every ball is capped
    reach = max_half_depth                      # |offset| at which 4 * offset^2 >= r_cap^2
    halo = cap + reach + 1
    out = np.zeros((h, w), np.uint8)
    offsets = np.arange(-cap, cap + 1)
    for s in range(0, h, INFLATE_STRIPE):
        a, b = max(0, s - halo), min(h, s + INFLATE_STRIPE + halo)
        o = open_[a:b]
        g = vertical_distance(~o, cap, a == 0, b == h).astype(np.int32)
        g2 = np.pad(g * g, ((0, 0), (cap, cap)))            # columns beyond the raster: closed
        d2 = np.full(o.shape, cap * cap, np.int32)
        for dx in offsets:
            np.minimum(d2, g2[:, cap + dx:cap + dx + w] + dx * dx, out=d2)
        # r = floor(2 * sqrt(d2)) - 1 half cells = distance minus half a cell, capped.
        r = np.minimum(np.floor(np.sqrt(4.0 * d2)).astype(np.int32) - 1, r_cap)
        power = np.where(o, r * r, CLOSED_POWER).astype(np.int32)
        rows = np.full((power.shape[0] + 2 * reach, w), CLOSED_POWER, np.int32)
        rows[reach:reach + power.shape[0]] = power
        v = np.full(power.shape, CLOSED_POWER, np.int32)
        for dy in range(-reach, reach + 1):
            np.maximum(v, rows[reach + dy:reach + dy + power.shape[0]] - 4 * dy * dy, out=v)
        cols = np.pad(v, ((0, 0), (reach, reach)), constant_values=CLOSED_POWER)
        p = np.full(power.shape, CLOSED_POWER, np.int32)
        for dx in range(-reach, reach + 1):
            np.maximum(p, cols[:, reach + dx:reach + dx + w] - 4 * dx * dx, out=p)
        e = np.floor(np.sqrt(np.maximum(p, 0).astype(np.float64))).astype(np.int32)
        e = np.where(o, np.clip(e, 1, r_cap), 0).astype(np.uint8)
        out[s:min(s + INFLATE_STRIPE, h)] = e[s - a:s - a + min(INFLATE_STRIPE, h - s)]
    return out


def backdrop_blocks(raster, candidates, block, window):
    """Per block, the commonest backdrop-candidate material within window x window blocks.

    Blocks with none in reach take a neighbour's value, grown outward in a fixed
    order, so the result is deterministic. Returns u8 palette indices.
    """
    h, w = raster.shape
    if h % block or w % block:
        raise ValueError('Raster is not a whole number of backdrop blocks')
    bh, bw = h // block, w // block
    best = np.zeros((bh, bw), np.int32)
    choice = np.full((bh, bw), OUTSIDE, np.uint8)
    half = window // 2
    for index in sorted(candidates):
        counts = (raster == index).reshape(bh, block, bw, block).sum(axis=(1, 3), dtype=np.int32)
        if not counts.any():
            continue
        c = np.pad(counts, half).cumsum(0).cumsum(1)
        c = np.pad(c, ((1, 0), (1, 0)))
        box = c[window:, window:] - c[:-window, window:] - c[window:, :-window] + c[:-window, :-window]
        better = box > best   # ties keep the lower palette index
        best[better] = box[better]
        choice[better] = index
    if np.all(choice == OUTSIDE):
        raise ValueError('No backdrop material anywhere in the raster')
    while np.any(choice == OUTSIDE):
        for shifted in (np.pad(choice, ((1, 0), (0, 0)), constant_values=OUTSIDE)[:-1],
                        np.pad(choice, ((0, 1), (0, 0)), constant_values=OUTSIDE)[1:],
                        np.pad(choice, ((0, 0), (1, 0)), constant_values=OUTSIDE)[:, :-1],
                        np.pad(choice, ((0, 0), (0, 1)), constant_values=OUTSIDE)[:, 1:]):
            fill = (choice == OUTSIDE) & (shifted != OUTSIDE)
            choice[fill] = shifted[fill]
    return choice


def inflation_tables(palette, backdrop_elements):
    # Palette indices that inflate (air, liquids, gases) and that may form backdrop rock.
    kinds, ids = element_kinds(), physical_elements()
    keys = {v: k for k, v in ids.items()}
    unknown = sorted(set(backdrop_elements) - set(ids))
    if unknown or any(kinds[k] != 'SOLID' for k in backdrop_elements):
        raise ValueError(f'Backdrop elements must be existing solids: {unknown or backdrop_elements}')
    open_ids = [i for i, p in enumerate(palette) if kinds[keys[p['element']]] in OPEN_KINDS]
    # Rigid-body pieces and props (bones, crates, items) are never bulk rock.
    backdrop_ids = [i for i, p in enumerate(palette) if keys[p['element']] in backdrop_elements
                    and not any(tag in p['name'] for tag in BACKDROP_EXCLUDED_NAMES)]
    if not backdrop_ids:
        raise ValueError('No palette material can form backdrop rock')
    return open_ids, backdrop_ids


def check_inflation(fold, inflation):
    # The fold's slab must hold the deepest envelope plus a skin of backdrop rock.
    half, margin = inflation['maxHalfDepth'], inflation['backdropMargin']
    if not (isinstance(half, int) and 1 <= half <= 127 and isinstance(margin, int) and margin >= 1):
        raise ValueError('Inflation depth must be 1..127 cells with a backdrop margin')
    if fold['thickness'] != 2 * (half + margin):
        raise ValueError('Fold thickness must equal 2 * (maxHalfDepth + backdropMargin)')
    if inflation['backdropWindow'] % 2 != 1 or inflation['backdropBlock'] < 1:
        raise ValueError('Backdrop window must be odd and blocks at least one pixel')


def band_rows(array, origin_y, source_top, height, fill):
    # The same rows regions_from gives a band, for any per-pixel (or per-block) plane.
    out = np.full((height, array.shape[1]), fill, dtype=array.dtype)
    lo, hi = max(source_top, origin_y), min(source_top + height, origin_y + len(array))
    if hi > lo:
        out[lo - source_top:hi - source_top] = array[lo - origin_y:hi - origin_y]
    return out


class Compiler:
    def __init__(self, config_path, decoder, world=None, wak=None):
        self.config_path = config_path
        self.config_bytes = config_path.read_bytes()
        self.c = json.loads(self.config_bytes)
        self.decoder = decoder
        self.world = Path(world or self.c['world']).expanduser().resolve(strict=True)
        self.wak_path = Path(wak or self.c['wak']).expanduser().resolve(strict=True)
        # Reuse ONLY the selective WAK reader, never its geometry compiler.
        reader = load_module('noita_wak_reader', ROOT / 'tools/import-noita-map.py')
        wak_bytes = self.wak_path.read_bytes()
        self.wak_hash = sha(wak_bytes)
        self.wak = reader.Wak(wak_bytes)
        self.sources = {}
        self.chunks = {}
        self.chunk_records = []
        self.gaps = []

    def source(self, path):
        data = self.wak.read(path)
        self.sources[path] = dict(path=path, sha256=sha(data), bytes=len(data))
        return data

    def saved(self, x, y):
        key = (x, y)
        if key not in self.chunks:
            path = self.world / f'world_{x}_{y}.png_petri'
            if not path.exists():
                self.chunks[key] = None
            else:
                _, terrain, meta = self.decoder.decode_file(path)
                # Semantic material raster hash is independent of local IDs/colors.
                ordered = sorted(terrain.names)
                remap = np.array([ordered.index(n) for n in terrain.names], dtype='<u2')
                meta['material_raster_sha256'] = sha(remap[terrain.indices].tobytes())
                meta['material_raster_hash_palette'] = ordered
                self.chunks[key] = terrain
                self.chunk_records.append(meta)
        return self.chunks[key]

    def prepare(self):
        c = self.c
        if c['chunkSize'] != 512 or c['biomeMapOrigin'] != [35, 14]:
            raise ValueError('Unsupported source chart')
        biome = np.array(Image.open(io.BytesIO(self.source(c['biomeMap']))).convert('RGB'))
        self.cells = {(col, int(row)) for row, (lo, hi) in c['rowEnvelopes'].items()
                      for col in range(lo, hi + 1)}
        # Explicit connected crypt branch, proven with native biome map identity.
        for col, row in c['extraConnectedCells']:
            if not np.array_equal(biome[row, col], biome[row + 1, col]) or (col, row + 1) not in self.cells:
                raise ValueError('Extra crypt cell is not connected to selected crypt')
            self.cells.add((col, row))
        self.biome_cells = [dict(cell=[col, row], rgb=bytes(biome[row, col]).hex())
                            for col, row in sorted(self.cells, key=lambda p: (p[1], p[0]))]
        excluded = {tuple(g['origin']): g for g in c['explicitExcludedGaps']}
        self.minx, self.width = c['fold']['sourceMinX'], c['fold']['sourceWidth']
        self.miny, self.maxy = c['sourceY'][0] - c['context'], c['sourceY'][1]
        shape = (self.maxy - self.miny, self.width)
        self.selected = np.zeros(shape, dtype=bool)
        for col, row in sorted(self.cells, key=lambda p: (p[1], p[0])):
            x, y = (col - 35) * 512, (row - 14) * 512
            terrain = self.saved(x, y)
            if terrain is None and (x, y) in excluded:
                self.gaps.append(dict(excluded[(x, y)], disposition='OUTSIDE; not converted'))
                continue
            lo, hi = max(y, self.miny), min(y + 512, self.maxy)
            self.selected[lo - self.miny:hi - self.miny, x - self.minx:x - self.minx + 512] = True
            if terrain is None:
                raise ValueError(f'Missing main source chunk {(x, y)}')
        # Actual top neighbor context: only in the first selected row's columns.
        first = min(c['rowEnvelopes'], key=int)
        above = (int(first) - 14) * 512 - 512
        for col in range(c['rowEnvelopes'][first][0], c['rowEnvelopes'][first][1] + 1):
            x = (col - 35) * 512
            if self.saved(x, above) is None:
                # Sky never streamed above the crop: stays OUTSIDE, never inferred air.
                self.gaps.append(dict(origin=[x, above], reason='Top context chunk not streamed',
                                      disposition='OUTSIDE; not converted'))
                continue
            self.selected[:c['context'], x - self.minx:x - self.minx + 512] = True
        self.fixed = []
        xml = self.source(c['fixedScene'])
        origin, extent = c['fixedOrigin'], c['fixedShape']
        occupied = np.zeros((extent[1], extent[0]), dtype=bool)
        materials = self.source('data/materials.xml')
        for scene in ET.fromstring(xml).iter('PixelScene'):
            path = scene.attrib['material_filename']
            x, y = int(scene.attrib['pos_x']), int(scene.attrib['pos_y'])
            data = self.source(path)
            indices, names, rgba, metadata = self.decoder.material_raster_from_plz(data, materials)
            h, w = indices.shape
            ix, iy = x - origin[0], y - origin[1]
            if ix < 0 or iy < 0 or ix + w > extent[0] or iy + h > extent[1]:
                raise ValueError('Fixed scene violates authoritative bbox')
            if np.any(occupied[iy:iy + h, ix:ix + w]):
                raise ValueError('Overlapping fixed PLZ pieces')
            occupied[iy:iy + h, ix:ix + w] = True
            self.fixed.append(dict(origin=[x, y], indices=indices, names=names, rgba=rgba,
                                   metadata=dict(metadata, path=path, attributes=scene.attrib)))
        if not occupied.all():
            raise ValueError('Incomplete fixed arena bbox')
        fx, fy = origin
        self.selected[fy - self.miny:fy - self.miny + extent[1], fx - self.minx:fx - self.minx + extent[0]] = True
        # Saved material is primary, including all saved arena pieces and right strip.
        for y in range(fy // 512 * 512, (fy + extent[1] + 511) // 512 * 512, 512):
            for x in range(fx // 512 * 512, (fx + extent[0] + 511) // 512 * 512, 512):
                self.saved(x, y)
        return self

    def black_comparison(self):
        records = []
        for piece in self.fixed:
            x, y = piece['origin']
            t = self.saved(x, y)
            if t is None:
                continue
            h, w = piece['indices'].shape
            mask = np.all(piece['rgba'] == [0, 0, 0, 255], axis=2)
            names, counts = np.unique(np.array(t.names)[t.indices[:h, :w]][mask], return_counts=True)
            records.append(dict(origin=[x, y], path=piece['metadata']['path'],
                                blackPixels=int(mask.sum()), savedMaterialCounts=dict(zip(names.tolist(), counts.tolist()))))
        total = sum(r['blackPixels'] for r in records)
        air = sum(r['savedMaterialCounts'].get('air', 0) for r in records)
        return dict(scope='ONLY opaque reserved black in authoritative fixed-arena material PLZ',
                    blackPixels=total, savedAirPixels=air, airFraction=air / total,
                    interpretation='Reserved scene clearing/air; exceptions are saved gameplay material/debris, not overwritten.',
                    pieces=records)

    def assemble(self):
        proof = self.black_comparison()
        used = {'air'}
        # Include only materials actually used, not hundreds of unused XML names.
        for (x, y), terrain in self.chunks.items():
            if terrain is None:
                continue
            lo, hi = max(y, self.miny), min(y + 512, self.maxy)
            left, right = max(x, self.minx), min(x + 512, self.minx + self.width)
            if lo >= hi or left >= right:
                continue
            mask = self.selected[lo - self.miny:hi - self.miny, left - self.minx:right - self.minx]
            local = terrain.indices[lo - y:hi - y, left - x:right - x]
            used.update(terrain.names[int(i)] for i in np.unique(local[mask]))
        # Only absent chunks may receive native fixed-scene fallback.
        for piece in self.fixed:
            x, y = piece['origin']
            if self.saved(x, y) is None:
                used.update(piece['names'][int(i)] for i in np.unique(piece['indices']) if i != MISSING)
        names = ['air'] + sorted(used - {'air'})
        if len(names) > 255:
            raise ValueError(f'Native palette overflow: {len(names)}')
        lookup = {n: i for i, n in enumerate(names)}
        raster = np.full(self.selected.shape, MISSING, dtype=np.uint16)
        for (x, y), terrain in self.chunks.items():
            if terrain is None:
                continue
            lo, hi = max(y, self.miny), min(y + 512, self.maxy)
            left, right = max(x, self.minx), min(x + 512, self.minx + self.width)
            if lo >= hi or left >= right:
                continue
            target = raster[lo - self.miny:hi - self.miny, left - self.minx:right - self.minx]
            mask = self.selected[lo - self.miny:hi - self.miny, left - self.minx:right - self.minx]
            indices = terrain.indices[lo - y:hi - y, left - x:right - x]
            for i in np.unique(indices[mask]):
                target[mask & (indices == i)] = lookup[terrain.names[int(i)]]
        fixed_records = []
        for piece in self.fixed:
            x, y = piece['origin']
            h, w = piece['indices'].shape
            target = raster[y - self.miny:y - self.miny + h, x - self.minx:x - self.minx + w]
            needed = target == MISSING
            record = dict(piece['metadata'], origin=[x, y], shape=[w, h], suppliedPixels=int(needed.sum()))
            record['unresolvedColorsNotUsed'] = record.pop('unresolved_colors') if not np.any(needed) else []
            if np.any(needed):
                resolved = resolve_fixed(piece['indices'], piece['names'], piece['rgba'], needed, lookup, proof)
                target[needed] = resolved[needed]
                record['reservedBlackAirPixels'] = int(np.count_nonzero(needed & np.all(piece['rgba'] == [0, 0, 0, 255], axis=2)))
                record['supplied_material_sha256'] = sha(target[needed].astype(np.uint8).tobytes())
            fixed_records.append(record)
        require_complete(raster, self.selected, [self.minx, self.miny])
        raster[~self.selected] = OUTSIDE
        self.raster, self.names, self.lookup = raster.astype(np.uint8), names, lookup
        self.fixed_records, self.proof = fixed_records, proof
        return names

    def body(self, sx, sy, passable=None, depth=None):
        # POV body feet coordinate: width1.6,height5.5, y increases DOWN here.
        x0, x1 = int(np.floor(sx - BODY_HALF_WIDTH)) - self.minx, int(np.floor(sx + BODY_HALF_WIDTH)) - self.minx + 1
        y0, y1 = int(np.floor(sy - 5.5)) - self.miny, int(np.ceil(sy)) - self.miny
        if x0 < 0 or x1 > self.width or y0 < 0 or y1 > len(self.raster):
            return False
        cells = self.raster[y0:y1, x0:x1]
        clear = bool(np.all(cells == 0) if passable is None else np.all(np.isin(cells, passable)))
        if depth is None or not clear:
            return clear
        # In 3D the whole body, at this depth, must sit inside every body pixel's envelope.
        need = 2 * (abs(depth) + BODY_RADIAL_REACH)
        return bool(np.all(self.depth[y0:y1, x0:x1] > need))

    def spawn(self, lo, hi, allow_context=True, resident_top=None):
        # Search real air directly above real solid support; no carving/filling.
        resident_top = lo - self.c['context'] if resident_top is None else resident_top
        support_names = {n for n in self.names if self.mapping[n] in self.support_elements}
        support_ids = [self.lookup[n] for n in support_names]
        a, b = lo - self.miny, min(hi - self.miny, len(self.raster) - 1)
        supports = np.isin(self.raster[a:b], support_ids)
        candidates = np.argwhere(supports & (self.raster[a - 1:b - 1] == 0))
        # Prefer central native route, away from raster caps: the player's start
        # above the first Holy Mountain, its arrival column below.
        anchor = self.c['startSource'][0] if lo < (self.c['regularTempleRows'][0] - 14) * 512 else -677
        if len(candidates):
            score = np.abs(candidates[:, 1] + self.minx - anchor)
            ordered = np.argsort(score, kind='stable')
            # Debug starts/respawns prefer actual open rooms, not isolated
            # six-pixel pockets. Native arrivals and handoffs never use these.
            for open_view in [True, False]:
                for i in ordered:
                    dy, ix = candidates[i]
                    x, y = float(ix + self.minx) + .5, int(dy + lo)
                    row = y - self.miny
                    if open_view and (y < lo + 8 or y >= hi - 8 or y - 12 < resident_top or ix < 2 or ix + 21 > self.width or
                                      not np.all(self.raster[row - 12:row, ix - 2:ix + 21] == 0)):
                        continue
                    if y - 6 >= resident_top and self.body(x, y, depth=0) and np.all(np.isin(self.raster[row, ix - 1:ix + 2], support_ids)):
                        return [x, y, 0], dict(spawnPolicy='native-floor', spawnSupported=True, spawnOpenView=open_view)
        if allow_context and lo >= 13312:
            # Bottom guard bands need not invent an independent safe start.
            context_lo = max(self.c['sourceY'][0], lo - self.c['context'])
            context_hi = min(self.maxy, lo + self.c['coreHeight'] + self.c['context'])
            try:
                return self.spawn(context_lo, context_hi, allow_context=False, resident_top=resident_top)
            except ValueError:
                liquid_elements = {'WATER', 'OIL', 'ACID', 'LAVA', 'BLOOD', 'SLIME', 'TOXIC', 'TELEPORTATIUM'}
                passable = [0] + [i for i, n in enumerate(self.names) if self.mapping[n] in liquid_elements]
                for yy in range(max(context_lo, resident_top + 6, self.miny + 6), context_hi):
                    candidates = np.flatnonzero(np.isin(self.raster[yy - self.miny], passable))
                    for ix in candidates[::8]:
                        x = float(ix + self.minx) + .5
                        if self.body(x, yy, passable):
                            return [x, yy, 0], dict(spawnPolicy='hazardous-streaming-only', spawnSupported=False,
                                warning='Native lava band; entered by source-continuous streaming, not a safe starting scene')
        raise ValueError(f'No body-clear supported debug spawn in source core {lo}:{hi}; source unchanged')

    def portals(self):
        # Compare actual saved terrain liquids against native top templates.
        # Entity existence/activation is not decoded; evidence never claims it is.
        colors = {}
        xml = re.sub(r'<!--.*?-->', '', self.source('data/materials.xml').decode(), flags=re.S)
        for tag in re.findall(r'<CellData(?:Child)?\s+([^>]+)>', xml):
            attrs = dict(re.findall(r'([\w_]+)\s*=\s*"([^"]*)"', tag))
            if 'wang_color' in attrs and 'name' in attrs:
                colors.setdefault(int(attrs['wang_color'], 16) & 0xffffff, set()).add(attrs['name'])
        templates = []
        liquids = {'water', 'blood', 'oil', 'radioactive_liquid', 'lava', 'magic_liquid_teleportation', 'magic_liquid_unstable_teleportation'}
        for variant in ['', '_water', '_blood', '_oil', '_radioactive', '_lava']:
            path = f'data/biome_impl/temple/altar_top{variant}.png'
            image = np.array(Image.open(io.BytesIO(self.source(path))).convert('RGBA'))
            rgb = image[:, :, :3].astype(np.uint32)
            rgb = (rgb[:, :, 0] << 16) | (rgb[:, :, 1] << 8) | rgb[:, :, 2]
            samples = []
            for color, native in colors.items():
                if len(native) == 1 and next(iter(native)) in liquids:
                    yy, xx = np.where(rgb == color)
                    if len(yy):
                        samples.append((yy, xx, next(iter(native))))
            templates.append((variant or 'default', samples))
        portals = []
        for row in [*self.c['regularTempleRows'], 39]:
            base = (row - 14) * 512
            for col in range(self.c['rowEnvelopes'][str(row)][0], self.c['rowEnvelopes'][str(row)][1] + 1):
                if any(g['origin'] == [(col - 35) * 512, base] for g in self.gaps):
                    continue
                x = (col - 35) * 512
                scores = []
                if row != 39:
                    for variant, samples in templates:
                        total, match = 0, 0
                        for yy, xx, name in samples:
                            if name not in self.lookup:
                                total += len(yy)
                                continue
                            sy, sx = base - 40 + yy - self.miny, x + xx - self.minx
                            valid = (sy >= 0) & (sy < len(self.raster)) & (sx >= 0) & (sx < self.width)
                            total += len(yy)
                            match += int(np.count_nonzero(self.raster[sy[valid], sx[valid]] == self.lookup[name]))
                        scores.append(dict(variant=variant, matchingPixels=match, templateLiquidPixels=total,
                                           fraction=match / total if total else 0))
                    scores.sort(key=lambda s: (-s['fraction'], -s['matchingPixels']))
                    verified = scores[0]['fraction'] > .95 and scores[0]['fraction'] > scores[1]['fraction'] + .1
                    variant = scores[0]['variant'] if verified else 'default'
                    dx = 264 if variant == 'default' else 266
                else:
                    verified, variant, dx = True, 'ending-authored-marker', 266
                portals.append(dict(id=f'native-{row}-{col}', source=[x + dx, base + 46], halfSize=[15, 15],
                                    target=[1891 if row == 39 else -677, base + 326], enabled=True,
                                    evidence=dict(variant=variant, variantVerified=verified, liquidComparisons=scores,
                                                  entityState='Not decoded; source-authored portal graph, activation approximated.',
                                                  coordinateSource='altar_top_ending.png marker + spawn_endportal y-4' if row == 39 else 'altar_top template marker + spawn_portal y-4',
                                                  relativeY='Native component target.y=280 relative to portal center; engine default assumption',
                                                  targetBodyAir=self.body(1891 if row == 39 else -677, base + 326),
                                                  targetBodyCollisionFree=self.body(1891 if row == 39 else -677, base + 326,
                                                      [i for i, n in enumerate(self.names) if self.mapping[n] in BODY_PASSABLE_ELEMENTS], depth=0))))
        if not all(p['evidence']['targetBodyCollisionFree'] for p in portals):
            raise ValueError('Native portal destination body intersects source terrain; not modified')
        # Hash exact topology sources rather than claiming saved entities survived.
        for path in ['data/scripts/biomes/temple_altar_top_shared.lua', 'data/scripts/biomes/temple_wall_ending.lua',
                     'data/scripts/biome_scripts.lua', 'data/entities/buildings/teleport_liquid_powered.xml',
                     'data/entities/buildings/teleport_boss_arena.xml', 'data/entities/buildings/teleport_ending.xml',
                     'data/biome_impl/temple/altar_top_ending.png']:
            self.source(path)
        return portals

    def publish(self, materials_path, output, runtime):
        material_bytes = materials_path.read_bytes()
        material_config = json.loads(material_bytes)
        self.mapping = material_config['nativeToElement']
        self.support_elements = set(material_config['solidSupportElements'])
        palette = make_palette(self.names, self.mapping, physical_elements())
        inflation = self.c['inflation']
        open_ids, backdrop_ids = inflation_tables(palette, material_config['backdropElements'])
        check_inflation(self.c['fold'], inflation)
        block = inflation['backdropBlock']
        if self.miny % block or self.c['coreHeight'] % block or len(self.raster) % block:
            raise ValueError('Bands must start on whole backdrop blocks')
        self.depth = inflate_depth(np.isin(self.raster, open_ids), inflation['maxHalfDepth'])
        self.backdrop = backdrop_blocks(self.raster, backdrop_ids, block, inflation['backdropWindow'])
        start = self.c['startSource']
        if not self.body(*start[:2], depth=0):
            raise ValueError('Native first arrival lacks 3D air body clearance; terrain unchanged')
        # Report original landing column, including liquids, without moving arrival.
        ix, iy = int(start[0] - self.minx), int(start[1] - self.miny)
        below = self.raster[iy:, ix]
        first_nonair = np.flatnonzero(below != 0)
        solid_ids = [i for i, p in enumerate(palette) if self.mapping[p['name']] in self.support_elements]
        first_support = np.flatnonzero(np.isin(below, solid_ids))
        start_evidence = dict(source=start, bodyAir=True, bodyWidth=1.6, bodyHeight=5.5,
                              firstNonAirBelow=int(first_nonair[0]) if len(first_nonair) else None,
                              firstSolidBelow=int(first_support[0]) if len(first_support) else None,
                              note='Authoritative airborne native arrival retained. Landing may cross actual saved fluids; no platform or clearing.')
        regions, assets = [], {}
        for index, (lo, hi, source_top, data) in enumerate(regions_from(self.raster, self.miny, self.c['sourceY'], self.c['coreHeight'], self.c['context'])):
            section_index = next(i for i, s in enumerate(self.c['sections']) if s['sourceRange'][0] <= lo < s['sourceRange'][1])
            key = f'noitaTerrain{index:02d}'
            raw = data.tobytes()
            # v2 payload: native plane (unchanged bytes and hash), then the depth plane,
            # then the per-block backdrop plane. Beyond the raster: closed, outside rock.
            depth = band_rows(self.depth, self.miny, source_top, len(data), 0)
            # Rows past the raster are OUTSIDE (never sampled); they repeat the edge row.
            edge = len(data) // block
            backdrop = band_rows(np.pad(self.backdrop, ((edge, edge), (0, 0)), mode='edge'),
                                 self.miny // block - edge, source_top // block, edge, OUTSIDE)
            fields = depth.tobytes() + backdrop.tobytes()
            assets[f'{key}.binpack'] = packed(raw + fields)
            spawn, spawn_metadata = self.spawn(lo, hi)
            regions.append(dict(key=key, label=self.c['sections'][section_index]['label'], sourceTop=source_top,
                                sourceHeight=len(data), core=[lo, hi], sectionIndex=section_index, file=f'{key}.binpack',
                                sha256=sha(raw), fieldsSha256=sha(fields), spawnSource=spawn, **spawn_metadata))
        start_scene = next(r['key'] for r in regions if r['core'][0] <= start[1] < r['core'][1])
        portals = self.portals()
        manifest = dict(version=2, encoding='noita-folded-raster-u8-v2', fold=self.c['fold'], inflation=inflation,
                        palette=palette, regions=regions, sections=self.c['sections'], startScene=start_scene,
                        startSource=start, nativePortals=portals)
        manifest['source'] = dict(world=str(self.world), wak=str(self.wak_path), wak_sha256=self.wak_hash,
                                  compiler_sha256=sha(Path(__file__).read_bytes()), decoder_sha256=sha(Path(self.decoder.__file__).read_bytes()),
                                  configuration=[dict(path=self.config_path.name, sha256=sha(self.config_bytes)),
                                                 dict(path=materials_path.name, sha256=sha(material_bytes))],
                                  elements_sha256=sha((ROOT / 'src/elements.js').read_bytes()),
                                  rasterOrigin=[self.minx, self.miny], rasterShape=list(self.raster.shape),
                                  materialRasterSha256=sha(self.raster.tobytes()), selectedPixels=int(self.selected.sum()),
                                  outsidePixels=int(np.count_nonzero(~self.selected)), nativeBiomeCells=self.biome_cells,
                                  chunks=sorted(self.chunk_records, key=lambda r: (r['origin'][1], r['origin'][0])),
                                  fixedScene=dict(path=self.c['fixedScene'], origin=self.c['fixedOrigin'], shape=self.c['fixedShape'],
                                                  priority='Saved chunks first; fixed native PLZ only absent chunks at XML coordinates', pieces=self.fixed_records,
                                                  blackAirProof=self.proof),
                                  gaps=self.gaps, startValidation=start_evidence,
                                  wakEntries=sorted(self.sources.values(), key=lambda r: r['path']),
                                  limitations=['Fresh day-0 vanilla world, streamed by a camera fly-through; the player never left the start.',
                                               'Opaque physics/rigid bodies and saved entities are not terrain; not rasterized.',
                                               'Sky chunks above the crop that were never streamed are OUTSIDE top context, not inferred air.',
                                               'Portal variants inferred only when liquid template matches uniquely; unverified entries use labeled native default candidates.',
                                               'Portal entity survival, liquid-enabled state, relative-Y default not independently decoded.',
                                               'Bottom domain stops at the arena; guard context beyond is OUTSIDE. Top context is actual saved sky where it was streamed.'])
        # Prepare everything first: incomplete/unknown inputs never publish partial maps.
        output.mkdir(parents=True, exist_ok=True)
        for name, data in assets.items():
            (output / name).write_bytes(data)
        (output / 'route.json').write_bytes(json_bytes(manifest))
        (output / 'black-air-regression.json').write_bytes(json_bytes(self.proof))
        # Same runtime interface, minus bulky provenance and per-template comparisons.
        small = {k: v for k, v in manifest.items() if k != 'source'}
        small['nativePortals'] = [dict(p, evidence={k: v for k, v in p['evidence'].items() if k != 'liquidComparisons'}) for p in portals]
        runtime.parent.mkdir(parents=True, exist_ok=True)
        runtime.write_bytes(json_bytes(small))
        return dict(regions=len(regions), nativeMaterials=len(palette), chunks=len(self.chunk_records),
                    selectedPixels=int(self.selected.sum()), fixedPixels=sum(p['suppliedPixels'] for p in self.fixed_records),
                    sourceHash=manifest['source']['materialRasterSha256'], startScene=start_scene, gaps=self.gaps,
                    startValidation=start_evidence, nativePortals=len(portals))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=ROOT / 'tools/noita-terrain-source.json')
    parser.add_argument('--materials', type=Path, default=ROOT / 'tools/noita-terrain-materials.json')
    parser.add_argument('--decoder', type=Path, default=ROOT / 'tools/noita-save-decode.py')
    parser.add_argument('--world')
    parser.add_argument('--wak')
    parser.add_argument('--output', type=Path, default=ROOT / 'public/local-maps/noita-terrain')
    parser.add_argument('--runtime', type=Path, default=ROOT / 'src/world/scenes/descent/terrainRoute.json')
    parser.add_argument('--inventory', action='store_true', help='Decode and report used native names; publish nothing')
    args = parser.parse_args()
    try:
        decoder = load_module('noita_save_decode', args.decoder)
        compiler = Compiler(args.config, decoder, args.world, args.wak).prepare()
        names = compiler.assemble()
        if args.inventory:
            print(json.dumps(dict(nativeMaterials=names, gaps=compiler.gaps, blackAirProof=compiler.proof), indent=2))
        else:
            for target in [args.output, args.runtime]:
                target = target.resolve()
                if target == compiler.world or compiler.world in target.parents or compiler.world.parent in target.parents:
                    raise ValueError('Output must not be inside source save')
            print(json.dumps(compiler.publish(args.materials, args.output, args.runtime), indent=2))
    except (ValueError, OSError) as exc:
        parser.exit(1, f'error: {exc}\n')


if __name__ == '__main__':
    main()
