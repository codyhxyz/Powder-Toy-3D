#!/usr/bin/env python3
"""Deterministic native-mask → folded 3D Descent compiler. No game execution.

Offline dependencies: Pillow, numpy. Runtime uses the existing sparse-brick ABI.
See docs/noita-source-import.md for deliberately authored 2D → 3D losses.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import struct

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SIZE = (512, 256, 512)
DEFAULT_ARCHIVE = str(Path.home() / 'Games/Noita-native/data/data.wak')
ROUTE = [
    ('noitaHolyMountain', 'Holy Mountain', 'temple_altar', []),
    ('noitaCoal', 'Coal Pits', 'excavationsite', ['machine_1', 'machine_2', 'machine_4', 'oiltank_1']),
    ('noitaSnow', 'Snowy Depths', 'snowcave', ['camp', 'icebridge', 'horizontalobservatory', 'snowcastle']),
    ('noitaHiisi', 'Hiisi Base', 'snowcastle', ['bar', 'bedroom', 'cargobay', 'bridge']),
    ('noitaJungle', 'Underground Jungle', 'rainforest', ['hut01', 'hut02', 'base', 'oiltank_01']),
    ('noitaVault', 'Vault', 'vault', ['brain_room', 'lab', 'acidtank', 'electric_tunnel_room']),
    ('noitaTemple', 'Temple of the Art', 'crypt', ['cathedral', 'stairs_right', 'room_gate_drop', 'mining']),
    ('noitaKolmi', 'Kolmi Arena', 'boss_arena', []),
]
FILL = dict(excavationsite='coal_static', snowcave='snowrock_static', snowcastle='snowrock_static',
            rainforest='soil_lush', vault='rock_vault', crypt='templebrickdark_static')


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


def sha(data):
    return hashlib.sha256(data).hexdigest()


def attrs(text):
    return dict(re.findall(r'([\w_]+)\s*=\s*"([^"]*)"', text))


def material_palette(xml):
    xml = re.sub(r'<!--.*?-->', '', xml, flags=re.S)
    # Native XML has duplicate attributes in some releases; read only material tags.
    return {int(a['wang_color'], 16) & 0xffffff: a['name']
            for a in (attrs(t) for t in re.findall(r'<CellData(?:Child)?\s+([^>]+)>', xml))
            if 'wang_color' in a and 'name' in a}


def element_for(name):
    """Explicit physical approximations. No catch-all rock for unknown names."""
    if name == 'air': return 'EMPTY'
    if name.startswith('templebrick'): return 'BRICK'
    if name.startswith(('rock', 'concrete')): return 'ROCK'
    if name.startswith(('steel', 'metal', 'aluminium')): return 'METAL'
    if name.startswith('wood'): return 'WOOD'
    if name.startswith(('snow', 'ice')): return 'ICE'
    if name.startswith(('soil', 'sand', 'mud')): return 'SANDSTONE'
    if name.startswith('coal'): return 'COAL'
    if name.startswith('glass'): return 'GLASS'
    if name.startswith(('glowstone', 'neon_tube')): return 'LAMP'
    if name.startswith(('grass', 'plant', 'moss')): return 'MOSS'
    if name.startswith(('fung', 'mushroom')): return 'FUNGUS'
    if name.startswith(('meat', 'rotten_meat')): return 'FUNGUS'
    if name.startswith('gunpowder'): return 'TNT'
    if name.startswith('gold'): return 'GOLD'
    if name == 'diamond': return 'DIAMOND'
    return {'water': 'WATER', 'oil': 'OIL', 'acid': 'ACID', 'lava': 'LAVA',
            'radioactive_liquid': 'TOXIC', 'blood': 'BLOOD', 'alcohol': 'WHISKEY'}.get(name)


def pack(grid):
    """X fastest in directory and bricks, little-endian u32, 8³ cells/brick."""
    nz, ny, nx = grid.shape
    if nx % 16 or nz % 16 or ny % 8:
        raise ValueError('WorldWindow alignment requires X/Z multiples of 16, Y of 8')
    bricks = grid.reshape(nz // 8, 8, ny // 8, 8, nx // 8, 8).transpose(0, 2, 4, 1, 3, 5).reshape(-1, 512)
    active = np.flatnonzero(np.any(bricks, axis=1))
    head = np.zeros((len(bricks) + 3) // 4 * 4, dtype='<u4')
    head[active] = len(head) + np.arange(len(active), dtype=np.uint32) * 128
    return head.tobytes() + bricks[active].tobytes(), len(active)


class Compiler:
    def __init__(self, archive, elements):
        self.wak, self.e = archive, elements
        self.palette = material_palette(archive.read('data/materials.xml').decode())
        self.used = {}

    def source(self, path):
        data = self.wak.read(path)
        self.used[path] = {'path': path, 'sha256': sha(data), 'bytes': len(data)}
        return data

    def mask(self, path, biome, script, width):
        data = self.source(path)
        im = Image.open(io.BytesIO(data)).convert('RGBA')
        if im.width > 4096 or im.height > 4096:
            raise ValueError('Not a selective native scene')
        rgb = np.array(im)
        colors = (rgb[:, :, 0].astype(np.uint32) << 16) | (rgb[:, :, 1].astype(np.uint32) << 8) | rgb[:, :, 2]
        ids = np.zeros(colors.shape, dtype=np.uint8)
        inventory = []
        for color, count in zip(*np.unique(colors, return_counts=True)):
            color = int(color)
            material = self.palette.get(color)
            loss = None
            if color == 0:
                material, element = 'mask-clear', 'EMPTY'
            elif color == 0xffffff:
                material = FILL.get(biome, 'rock_hard')
                element, loss = element_for(material), 'biome fill selected from biome XML (not native noise synthesis)'
            elif biome == 'vault' and color in (0xf0bbee, 0xa4dbd5):
                material, element, loss = 'acid', 'ACID', 'deterministic choice from Lua lab_liquids'
            else:
                element = element_for(material) if material else None
            marker = re.search(r'RegisterSpawnFunction\(\s*0x[0-9a-fA-F]{2}' + f'{color:06x}' + r'\s*,\s*"([^"]+)"', script, re.I)
            if not element:
                element = 'EMPTY'
                loss = 'script entity omitted: ' + marker[1] if marker else 'unresolved color omitted; NOT rock'
            inventory.append({'rgb': f'{color:06x}', 'pixels': int(count), 'material': material,
                              'element': element, **({'loss': loss} if loss else {})})
            ids[(colors == color) & (rgb[:, :, 3] != 0)] = self.e[element]
        height = max(1, round(im.height * width / im.width))
        small = np.array(Image.fromarray(ids).resize((width, height), Image.Resampling.NEAREST))[::-1].copy()
        return small, {'path': path, 'nativeSize': list(im.size), 'compiledSize': [width, height], 'palette': inventory}

    def place(self, path, biome, script, center, width, depth, quarter=0, crop=None):
        mask, audit = self.mask(path, biome, script, width)
        if crop:
            x0, y0, x1, y1 = crop
            mask = mask[y0:y1, x0:x1]
        h, w = mask.shape
        cx, bottom, cz = center
        before = int(np.count_nonzero(self.grid))
        for u in range(w):
            half = max(5, depth // 2 - abs(u - w // 2) // 8)
            for v in range(h):
                id_ = int(mask[v, u])
                if not id_: continue
                radius = max(4, half - ((v // 12 + u // 23) % 3) * 2)
                a = u - w // 2
                y = bottom + v
                if y < 0: continue  # sanctuary is deliberately cropped at world bedrock
                if y >= SIZE[1]: raise ValueError('Source placement height out of bounds')
                if quarter % 2 == 0:
                    x = cx + (a if quarter == 0 else -a)
                    if not (0 <= x < SIZE[0] and 0 <= cz-radius and cz+radius < SIZE[2]): raise ValueError('Source placement bounds')
                    self.grid[cz-radius:cz+radius+1, y, x] = id_
                else:
                    z = cz + (a if quarter == 1 else -a)
                    if not (0 <= z < SIZE[2] and 0 <= cx-radius and cx+radius < SIZE[0]): raise ValueError('Source placement bounds')
                    self.grid[z, y, cx-radius:cx+radius+1] = id_
        audit.update(center=list(center), quarterTurn=quarter, maxDepth=depth, crop=crop,
                     thickness='taper by abs(u-width/2)/8; ledges by (v/12+u/23)%3',
                     addedCells=int(np.count_nonzero(self.grid))-before)
        self.placements.append(audit)

    def box(self, lo, hi, id_):
        x, y, z = lo; xx, yy, zz = hi
        self.grid[z:zz, y:yy, x:xx] = id_

    def bridge(self, points, label, material='ROCK', radius=5):
        """Authored stairs/bridges: <=1 cell rise, 11-wide, ten-cell headroom."""
        self.edges.append({'label': label, 'points': points, 'radius': radius, 'material': material})
        samples = []
        for a, b in zip(points, points[1:]):
            n = max(abs(b[0]-a[0]), abs(b[2]-a[2]))
            if n < abs(b[1]-a[1]) or not n: raise ValueError('Unsafe connector slope')
            for i in range(n + 1):
                p = [round(a[k] + (b[k]-a[k])*i/n) for k in range(3)]
                if not samples or p != samples[-1]: samples.append(p)
        for x, y, z in samples:
            self.box((x-radius, y, z-radius), (x+radius+1, y+11, z+radius+1), 0)
        for x, y, z in samples:
            self.box((x-3, y-2, z-3), (x+4, y, z+4), self.e[material])
        self.paths.extend(samples)
        return samples

    def sanctuary(self, script):
        self.place('data/biome_impl/temple/altar.png', 'temple_altar', script, (256, -42, 256), 184, 54)
        self.box((185, 14, 245), (332, 31, 268), 0)
        self.box((185, 11, 245), (332, 14, 268), self.e['BRICK'])
        self.box((220, 10, 248), (236, 14, 264), self.e['WATER'])
        self.box((219, 9, 247), (237, 10, 265), self.e['BRICK'])
        self.bridge([[310, 14, 256], [324, 6, 256]], 'Holy Mountain exit stair', 'BRICK', 4)
        return dict(box=[186, 14, 246, 318, 31, 267], pool=[220, 10, 248, 236, 14, 264],
                    altars=[[290, 14, 250], [298, 14, 250], [306, 14, 250]],
                    shop=[[246+i*8, 14, 256] for i in range(5)], refresher=[266, 14, 263],
                    exit=[320, 4, 250, 330, 10, 263])

    def contain_fluids(self):
        """Keep native basin silhouettes, cap deep columns; sealed against initial spills."""
        fluids = [self.e[k] for k in ['WATER', 'OIL', 'ACID', 'LAVA', 'TOXIC', 'BLOOD', 'WHISKEY']]
        liquid = np.isin(self.grid, fluids)
        original = int(liquid.sum())
        for z, x in np.argwhere(np.any(liquid, axis=1)):
            ys = np.flatnonzero(liquid[z, :, x])
            for run in np.split(ys, np.where(np.diff(ys) != 1)[0]+1):
                if len(run) > 4: self.grid[z, run[:-4], x] = self.e['BASALT' if self.grid[z, run[-1], x] == self.e['LAVA'] else 'GLASS']
        liquid = np.isin(self.grid, fluids)
        shell = np.zeros_like(liquid)
        for axis in range(3):
            for sign in [-1, 1]: shell |= np.roll(liquid, sign, axis=axis)
        shell &= self.grid == 0
        self.grid[shell] = self.e['GLASS']
        return {'sourceLiquidCells': original, 'retainedLiquidCells': int(liquid.sum()),
                'glassSealCells': int(shell.sum()), 'loss': 'four-cell sealed reservoirs; deep fluid replaced by glass/basalt'}

    def clear_body(self, p):
        x, y, z = p
        return (1 <= x < 511 and 1 <= z < 511 and 1 <= y < 250 and
                not np.any(self.grid[z-1:z+2, y:y+6, x-1:x+2]) and
                np.any(np.isin(self.grid[z-1:z+2, y-1, x-1:x+2], self.solid)))

    def feet(self, x, z, around, radius=14):
        for y in sorted(range(max(1, around-radius), min(249, around+radius+1)), key=lambda y: abs(y-around)):
            if self.clear_body([x, y, z]): return [x, y, z]
        raise ValueError(f'No supported body at {x},{around},{z}')

    def compile(self, index):
        key, name, biome, rooms = ROUTE[index]
        self.used = {}
        self.grid = np.zeros((SIZE[2], SIZE[1], SIZE[0]), dtype=np.uint8)
        self.placements, self.edges, self.paths = [], [], []
        self.solid = [self.e[k] for k in ['BRICK', 'ROCK', 'COAL', 'ICE', 'METAL', 'WOOD', 'SANDSTONE',
                                               'GLASS', 'MOSS', 'FUNGUS', 'TNT', 'GOLD', 'LAMP', 'BASALT']]
        self.source('data/materials.xml')
        self.source('data/biome/_pixel_scenes.xml')
        script = self.source(f'data/scripts/biomes/{biome}.lua').decode()
        self.source(f'data/biome/{biome}.xml')
        self.source('data/scripts/biome_scripts.lua')
        altar_script = self.source('data/scripts/biomes/temple_altar.lua').decode()
        tier = max(1, index)
        if index == 7:
            arena = 'data/biome_impl/spliced/boss_arena.png'
            self.source('data/biome_impl/spliced/boss_arena.xml')
            self.place(arena, biome, script, (256, 5, 256), 390, 104)
            self.place(arena, biome, script, (155, 5, 150), 390, 40, 1, [0, 80, 150, 160])
            # Native spawn_items marker (2010,721), Sampo spawned 80 pixels below.
            goal = [256 - 195 + round(2010*390/2600), 122, 256]
            spawn = [140, 187, 115]
            self.bridge([spawn, [210, 163, 115], [210, 143, 205], [goal[0], 122, 205], goal], 'Arena approach to native Sampo platform', 'BRICK')
            self.bridge([[210, 143, 205], [155, 143, 205], [155, 143, 150]], 'Perpendicular entrance overlook', 'BRICK')
            temple = {'exit': [goal[0]-3, goal[1], goal[2]-3, goal[0]+4, goal[1]+7, goal[2]+4]}
        else:
            temple = self.sanctuary(altar_script)
            goal = [324, 6, 256]
            if index == 0:
                spawn = [240, 14, 256]
                self.bridge([spawn, [310, 14, 256]], 'Sanctuary gallery', 'BRICK')
            else:
                positions = [(135, 162, 110), (355, 120, 135), (355, 80, 355), (135, 40, 350)]
                for i, (room, center) in enumerate(zip(rooms, positions)):
                    path = f'data/biome_impl/{biome}/{room}.png'
                    if path not in script: raise ValueError(f'Scene not referenced by biome Lua: {path}')
                    native = Image.open(io.BytesIO(self.wak.read(path)))
                    width = min(156 if i != 3 else 132, round(100*native.width/native.height))
                    self.place(path, biome, script, center, width, 50+i*12, i)
                spawn = [95, 190, 110]
                self.bridge([spawn, [190, 180, 110], [285, 161, 110], [355, 150, 135],
                             [355, 130, 230], [355, 110, 355], [255, 94, 355], [135, 70, 350],
                             [135, 45, 256], [195, 14, 256]], 'Main folded descent', 'METAL' if index in (3, 5) else 'ROCK')
                self.bridge([[190, 180, 110], [190, 160, 200], [270, 143, 230], [355, 130, 230]], 'Upper cross-link', 'WOOD' if index == 1 else 'ROCK')
                self.bridge([[355, 130, 230], [290, 112, 280], [255, 94, 355]], 'Drop gallery cross-link')
                self.bridge([[355, 150, 135], [392, 150, 135], [392, 142, 180]], 'East room branch')
                self.bridge([[135, 70, 350], [95, 70, 350], [95, 64, 390]], 'Lower room branch')
        fluids = self.contain_fluids()
        saved_edges = self.edges[:]
        self.edges, self.paths = [], []
        for edge in saved_edges:
            self.bridge(edge['points'], edge['label'], edge['material'], edge['radius'])
        if index < 7:
            # The sanctuary pool is open water, not one of the sealed source tanks.
            self.box((220, 14, 248), (236, 15, 264), 0)
        spawn = self.feet(spawn[0], spawn[2], spawn[1])
        goal = self.feet(goal[0], goal[2], goal[1])
        torches = []
        for x, y, z in self.paths[::32]:
            self.grid[z+5, y+5, x] = self.e['LAMP']
            torches.append([x, y+5, z+5])
        candidates, seen = [], set()
        for x, y, z in self.paths:
            if index not in (0, 7) and y < 35: continue
            try: p = self.feet(x, z, y, 3)
            except ValueError: continue
            if min((sum((p[k]-q[k])**2 for k in (0, 2)) for q in candidates), default=1000) < 16: continue
            if tuple(p) not in seen:
                candidates.append(p); seen.add(tuple(p))
        count = 45
        if len(candidates) < count:
            for z in range(248, 266, 4):
                for x in range(240, 310, 4):
                    if self.clear_body([x, 14, z]) and (x, 14, z) not in seen:
                        candidates.append([x, 14, z]); seen.add((x, 14, z))
        if len(candidates) < count: raise ValueError(f'{key}: not enough valid sites')
        selected = [candidates[round(i*(len(candidates)-1)/(count-1))] for i in range(count)]
        loot = [dict(zip(('x','y','z'), p), kind=('wand' if i < 5 else 'spell' if i < 11 else 'gold'), tier=tier)
                for i, p in enumerate(selected[:36])]
        chests = [dict(zip(('x','y','z'), p), tier=tier) for p in selected[36:39]]
        potions = [dict(zip(('x','y','z'), p), tier=tier) for p in selected[39:45]]
        # Shops supply sanctuary items; the Sampo approach is not another loot biome.
        if index in (0, 7):
            loot, chests, potions = [], [], []
        level = dict(key=key, name=name, tier=tier, spawn=spawn, spawnYaw=-1.5707963267948966,
                     role='sanctuary' if index == 0 else 'arena' if index == 7 else 'biome',
                     temple=temple, loot=loot, chests=chests, potions=potions)
        if index == 7:
            level.update(completion={'title': 'Sampo platform reached', 'subtitle': 'Map route complete · Kolmi combat is not implemented'})
        packed, bricks = pack(self.grid)
        compressed = gzip.compress(packed, compresslevel=9, mtime=0)
        manifest = dict(version=1, id=key, name=name, encoding='sparse-brick-u8-v1', cellMeters=0.3,
                        size=list(SIZE), brickDims=[n//8 for n in SIZE], plainHeight=0,
                        dataFile=key+'.binpack', dataCompression='gzip', spawn=spawn, descent=level,
                        airT=-12 if index in (2, 3) else 18,
                        ambient=[0.025, 0.03, 0.04], torches=torches,
                        geometrySha256=sha(packed), packedSha256=sha(compressed),
                        provenance={'archive': 'Noita-native/data/data.wak', 'archiveSha256': sha(self.wak.data),
                                    'sources': sorted(self.used.values(), key=lambda s:s['path']),
                                    'biome': biome, 'placements': self.placements, 'connectors': self.edges,
                                    'fluids': fluids, 'losses': ['Authored 3D composition, not native seeded Wang generation',
                                        'Nearest-neighbour downsampling; stepped variable-depth extrusion and quarter turns',
                                        'Frozen snow/soil/sand/tissue kept structural; material approximations listed in palette',
                                        'Native entities, visual/background layers, scripts, boss AI and ending not imported']},
                        stats={'cells': int(np.count_nonzero(self.grid)), 'sourcePlacementCells': sum(p['addedCells'] for p in self.placements),
                               'bricks': bricks, 'bytes': len(packed), 'gzipBytes': len(compressed)},
                        route={'goal': goal, 'body': {'width': 1.6, 'height': 5.5},
                               'validation': 'scripts/check-noita-source.mjs: packed occupancy body walk',
                               'mainWaypoints': self.edges[-1]['points'] if index == 0 else next(e['points'] for e in self.edges if e['label'].startswith(('Main', 'Arena')))})
        return level, manifest, compressed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', default=DEFAULT_ARCHIVE)
    args = parser.parse_args()
    import subprocess
    elements = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
        "import {E} from './src/elements.js';console.log(JSON.stringify(E))"], cwd=ROOT))
    compiler = Compiler(Wak(Path(args.archive).read_bytes()), elements)
    output = ROOT/'public/local-maps'
    output.mkdir(parents=True, exist_ok=True)
    manifests = []
    for i in range(len(ROUTE)):
        level, manifest, data = compiler.compile(i)
        manifests.append(manifest)
        (output/(level['key']+'.binpack')).write_bytes(data)
        (output/(level['key']+'.json')).write_text(json.dumps(manifest, indent=2)+'\n')
        print(level['key'], json.dumps(manifest['stats']), flush=True)
    generated = ROOT/'src/world/scenes/descent/sourceRoute.json'
    generated.write_text(json.dumps([{k:v for k,v in m.items() if k not in ('provenance', 'stats', 'route')}
                                     for m in manifests], indent=2)+'\n')


if __name__ == '__main__':
    main()
