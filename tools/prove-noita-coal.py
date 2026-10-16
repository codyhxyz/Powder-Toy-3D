"""Audit one original save chunk against published terrain, without the compiler.

The image is a diagnostic foreground re-render using native material textures.
It is NOT a Noita game screenshot and does not reproduce its rendering engine.
"""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import gzip
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def sha(data):
    return hashlib.sha256(data).hexdigest()


decoder = load('proof_decoder', 'tools/noita-save-decode.py')
reader = load('proof_wak', 'tools/import-noita-map.py')
config = json.loads((ROOT / 'tools/noita-terrain-source.json').read_bytes())
route = json.loads((ROOT / 'public/local-maps/noita-terrain/route.json').read_bytes())
world = Path(config['world']).expanduser()
wak_data = Path(config['wak']).expanduser().read_bytes()
wak = reader.Wak(wak_data)
original = world / 'world_-1024_2048.png_petri'
origin, terrain, meta = decoder.decode_file(original)
source_record = next(c for c in route['source']['chunks'] if c['filename'] == original.name)
assert meta['sha256'] == source_record['sha256'], 'Archive differs from the imported snapshot'
assert sha(wak_data) == route['source']['wak_sha256'], 'Native game archive differs'

# Decode the published bands directly. Do not call Compiler or trust a preview.
palette_names = [p['name'] for p in route['palette']]
name_ids = {name: i for i, name in enumerate(palette_names)}
expected = np.array([name_ids[n] for n in terrain.names], dtype=np.uint16)[terrain.indices]
published = np.full((512, 512), 65535, dtype=np.uint16)
bands = []
for r in route['regions']:
    a, b = max(origin[1], r['core'][0]), min(origin[1]+512, r['core'][1])
    if a >= b:
        continue
    raw = gzip.decompress((ROOT / 'public/local-maps/noita-terrain' / r['file']).read_bytes())
    assert sha(raw) == r['sha256']
    cells = np.frombuffer(raw, np.uint8).reshape(r['sourceHeight'], config['fold']['sourceWidth'])
    x = origin[0]-config['fold']['sourceMinX']
    published[a-origin[1]:b-origin[1]] = cells[a-r['sourceTop']:b-r['sourceTop'], x:x+512]
    bands.append(dict(key=r['key'], file=r['file'], sha256=r['sha256'], core=r['core']))
assert not np.any(published == 65535), 'Uncovered original cells'
differences = int(np.count_nonzero(expected != published))
assert differences == 0, f'{differences} native material names differ'
anchor_name = terrain.names[int(terrain.indices[237, 434])]
assert anchor_name == 'moss', 'The original save does not match the live capture source lookup'

xml_bytes = wak.read('data/materials.xml')
materials = {e.attrib['name']: e for e in ET.fromstring(xml_bytes).iter()
             if e.tag in ('CellData', 'CellDataChild') and 'name' in e.attrib}
textures = {}
graphics_cache = {}


def graphics(name, seen=()):
    if name in graphics_cache:
        return graphics_cache[name]
    if name in seen or name not in materials:
        return {}
    e = materials[name]
    g = dict(graphics(e.attrib['_parent'], (*seen, name))) if '_parent' in e.attrib else {}
    child = e.find('Graphics')
    if child is not None:
        g.update(child.attrib)
    graphics_cache[name] = g
    return g


yy, xx = np.mgrid[origin[1]:origin[1]+512, origin[0]:origin[0]+512]
uncolored = []


def render(indices):
    image = np.zeros((512, 512, 3), dtype=np.uint8)
    for index in np.unique(indices):
        name = palette_names[int(index)]
        if name == 'air':
            continue
        g = graphics(name)
        mask = indices == index
        texture = g.get('texture_file')
        if texture:
            if texture not in textures:
                data = wak.read(texture)
                textures[texture] = (np.array(Image.open(io.BytesIO(data)).convert('RGB')), sha(data))
            pixels = textures[texture][0]
            image[mask] = pixels[yy[mask] % pixels.shape[0], xx[mask] % pixels.shape[1]]
        elif 'color' in g:
            value = int(g['color'], 16)
            image[mask] = [(value >> 16) & 255, (value >> 8) & 255, value & 255]
        else:
            image[mask] = [185, 64, 185]
            uncolored.append(name)
    return Image.fromarray(image)


output = ROOT / 'public/noita-evidence'
output.mkdir(parents=True, exist_ok=True)
render(expected).save(output / 'original-coal-chunk.png')
render(published).save(output / 'published-coal-chunk.png')
assert (output / 'original-coal-chunk.png').read_bytes() == (output / 'published-coal-chunk.png').read_bytes()
proof = dict(
    audited_build='2c5cb27ded2a9683245e71f249b1ccfcee7edd4a',
    source_archive='main-pre-inventory-restore-2026-05-21/world',
    original_file=original.name, original_sha256=meta['sha256'],
    decoded_sha256=meta['decoded_sha256'], origin=list(origin), shape=[512, 512],
    compared_cells=512*512, mismatched_native_material_names=differences,
    capture_source_anchor=dict(source=[-589.5, 2285, 0], local_cell=[434, 237],
                               original_material=anchor_name, published_material=palette_names[int(published[237, 434])],
                               scene='noitaTerrain04', world=[3747.0925494582016, 51, 2925.9808776740488],
                               limitation='Source coordinates and native material query were logged by the CPU sampler during the GPU capture, not a direct GPU voxel readback.'),
    published_bands=bands, native_material_counts=meta['material_counts'],
    native_game_archive_sha256=sha(wak_data), native_materials_xml_sha256=sha(xml_bytes),
    native_texture_sources=[dict(path=k, sha256=v[1]) for k, v in sorted(textures.items())],
    uncolored_native_materials=sorted(set(uncolored)),
    image_statement='Both images use the same diagnostic foreground renderer: native textures tiled at source coordinates; material Graphics color where no texture exists. Not Noita screenshots. Saved color overrides, edge art, backgrounds, bodies, entities and lighting are not reconstructed.',
    scope='This checks one 512x512 material grid from the original saved file against published native raster data. It does NOT establish a straight port of geometry, appearance, physics, gameplay, or the full map.',
)
(output / 'coal-proof.json').write_text(json.dumps(proof, indent=2) + '\n')
print(json.dumps({k: proof[k] for k in ['original_file', 'original_sha256', 'compared_cells', 'mismatched_native_material_names', 'uncolored_native_materials', 'scope']}, indent=2))
