#!/usr/bin/env python3
"""CPU-only design studies from actual Mines material cells. Not game geometry."""
import argparse
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import sys
import time
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
WORLD = Path.home() / (
    "Library/Application Support/Noita-backups/before-mina4mac-20261014-231758/"
    "Nolla_Games_Noita/worlds/_archive/main-pre-inventory-restore-2026-05-21/world"
)


def decoder():
    spec = importlib.util.spec_from_file_location("saved_noita", ROOT / "tools/noita-save-decode.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def palette(names):
    route = json.loads((ROOT / "public/local-maps/noita-terrain/route.json").read_text())
    known = {p["name"]: p for p in route["palette"]}
    # The original material picture uses display colors, not a native-game screenshot.
    colors = {
        "air": "#10151a", "rock_static_intro": "#585247",
        "rock_static_intro_02": "#61594c", "soil": "#6d5946",
        "soil_dark": "#574a3d", "wood_static": "#997245",
        "wood_static_vertical": "#89623c", "gold": "#e4bd4b",
        "coal_static": "#373a38", "rock_static_grey": "#73786f",
        "sand": "#a58c5d", "water": "#43899b", "grass": "#95ad46",
        "moss": "#889345", "rock_static": "#777768",
    }
    # Published palette has material IDs, so use actual element display colors.
    import re
    elements = (ROOT / "src/elements.js").read_text()
    defs = re.findall(r"\{\s*key:\s*'([^']+)'(.*?)(?=\n\s*\{\s*key:|\n\];)", elements, re.S)
    by_key = {}
    for key, body in defs:
        match = re.search(r"color:\s*'(#[0-9a-fA-F]{6})'", body)
        if match:
            by_key[key] = match.group(1)
    result = []
    for name in names:
        entry = known.get(name, {})
        color = colors.get(name, by_key.get(entry.get("elementKey"), "#82796a"))
        result.append(tuple(bytes.fromhex(color[1:])))
    return np.array(result, dtype=np.uint8)


def contact():
    dec = decoder()
    sheet = Image.new("RGB", (1024, 1068), "#e9e5dc")
    draw = ImageDraw.Draw(sheet)
    for i, (x, y) in enumerate([(-512, 0), (0, 0), (-512, 512), (0, 512)]):
        origin, terrain, meta = dec.decode_file(WORLD / f"world_{x}_{y}.png_petri")
        colors = palette(terrain.names)
        image = Image.fromarray(colors[terrain.indices])
        dx, dy = (i % 2) * 512, (i // 2) * 534
        sheet.paste(image, (dx, dy + 22))
        draw.text((dx + 8, dy + 5), f"Mines {origin}: {len(terrain.names)} native materials", fill="#20251e")
    sheet.save("/tmp/noita-mines-contact.png")
    print("/tmp/noita-mines-contact.png")


def distance_inside(solid):
    """Chamfer distance for a preview depth profile, not native material physics."""
    h, w = solid.shape
    d = np.where(solid, 1000., 0.)
    d[[0, -1], :] = np.minimum(d[[0, -1], :], 1.)
    d[:, [0, -1]] = np.minimum(d[:, [0, -1]], 1.)
    for y in range(h):
        for x in range(w):
            if y:
                d[y, x] = min(d[y, x], d[y-1, x] + 1)
            if x:
                d[y, x] = min(d[y, x], d[y, x-1] + 1)
    for y in range(h-1, -1, -1):
        for x in range(w-1, -1, -1):
            if y < h-1:
                d[y, x] = min(d[y, x], d[y+1, x] + 1)
            if x < w-1:
                d[y, x] = min(d[y, x], d[y, x+1] + 1)
    return d


def frame(kind):
    spans = [64., 128., 64.]
    angles = [math.radians(-55), 0., math.radians(80)] if kind == "fold" else [0., 0., 0.]
    segments, point, source = [], np.array([0., 0.]), 0.
    for length, angle in zip(spans, angles):
        tangent = np.array([math.cos(angle), math.sin(angle)])
        segments.append((point.copy(), tangent, length, source))
        point += tangent * length
        source += length
    pts = np.array([s[0] for s in segments] + [point])
    shift = 58 - pts.min(axis=0)
    size = np.ceil(pts.max(axis=0) - pts.min(axis=0) + 116).astype(int)
    return segments, shift, size


def forward(kind, source_x, source_y, depth=0.):
    segments, shift, _ = frame(kind)
    for point, tangent, length, start in segments:
        if source_x <= start + length:
            p = point + tangent * (source_x-start) + np.array([-tangent[1], tangent[0]]) * depth + shift
            return np.array([p[0], 256-source_y, p[1]]), np.array([tangent[0], 0., tangent[1]])
    raise ValueError("Source outside model")


def volume(kind, ids, solid, distance, cut=False):
    segments, shift, size = frame(kind)
    width, depth = size
    xx, zz = np.meshgrid(np.arange(width) + .5, np.arange(depth) + .5)
    xx -= shift[0]
    zz -= shift[1]
    closest = np.full(xx.shape, np.inf)
    source = np.zeros(xx.shape)
    signed = np.zeros(xx.shape)
    for point, tangent, length, start in segments:
        tx = (xx-point[0])*tangent[0] + (zz-point[1])*tangent[1]
        clamped = np.clip(tx, 0, length)
        dx = xx-point[0]-tangent[0]*clamped
        dz = zz-point[1]-tangent[1]*clamped
        r2 = dx*dx + dz*dz
        better = r2 < closest
        closest[better] = r2[better]
        source[better] = start + clamped[better]
        signed[better] = (xx[better]-point[0])*(-tangent[1]) + (zz[better]-point[1])*tangent[0]
    # Crop endpoints stay open rather than acquiring an invented enclosing wall.
    valid = (source > .01) & (source < 255.99)
    sx = np.clip(source.astype(int), 0, 255)
    field = np.zeros((256, depth, width), dtype=np.uint8)
    for y in range(256):
        sy = 255-y
        half = 13. if kind == "reference" else np.minimum(48., 5. + distance[sy, sx]*2.6)
        occupied = valid & (np.abs(signed) <= half) & solid[sy, sx]
        if cut:
            occupied &= signed <= 0
        field[y] = np.where(occupied, ids[sy, sx], 0)
    return field


def unit(v):
    v = np.asarray(v, dtype=float)
    return v / np.linalg.norm(v)


def camera(field, kind, pov):
    h, d, w = field.shape
    if pov:
        eye, tangent = forward(kind, 90., 85.)
        normal = np.array([-tangent[2], 0., tangent[0]])
        target = eye + tangent * 70 + normal * 24 + np.array([0., -8., 0.])
        fov = .72
    else:
        target = np.array([w/2, h*.49, d/2])
        # Positive Z keeps source +X pointing right in the recognition view.
        eye = target + unit([.72, .40, 1.]) * 620
        fov = .30
    front = unit(target-eye)
    right = unit(np.cross(front, [0., 1., 0.]))
    up = np.cross(right, front)
    return eye, front, right, up, fov


def render(field, colors, kind, pov=False):
    """Vectorized voxel DDA. CPU only; no browser or game renderer."""
    width, height = (720, 480) if not pov else (640, 400)
    eye, front, right, up, fov = camera(field, kind, pov)
    aspect = width / height
    px, py = np.meshgrid(np.arange(width)+.5, np.arange(height)+.5)
    u = (2*px/width-1)*fov*aspect
    v = (1-2*py/height)*fov
    direction = front + u[..., None]*right + v[..., None]*up
    direction /= np.linalg.norm(direction, axis=2)[..., None]
    direction = direction.reshape(-1, 3)
    count = len(direction)
    h, d, w = field.shape
    dims = np.array([w, h, d])
    with np.errstate(divide="ignore", invalid="ignore"):
        low = -eye/direction
        high = (dims-eye)/direction
        near = np.minimum(low, high)
        far = np.maximum(low, high)
        entry = np.maximum(near.max(axis=1), 0)
        exit_ = far.min(axis=1)
        at = np.floor(eye + direction*(entry[:, None]+1e-5)).astype(int)
        step = np.sign(direction).astype(int)
        delta = np.abs(1/direction)
        nxt = (at + (step > 0) - eye)/direction
    active = np.flatnonzero(exit_ > entry)
    normals = np.zeros((count, 3))
    axes = near.argmax(axis=1)
    normals[np.arange(count), axes] = -step[np.arange(count), axes]
    hit_id = np.zeros(count, dtype=np.uint8)
    hit_at = np.zeros((count, 3), dtype=int)
    dist = entry.copy()
    for _ in range(int(dims.sum())+3):
        if not len(active):
            break
        positions = at[active]
        valid = ((positions >= 0) & (positions < dims)).all(axis=1)
        active = active[valid]
        if not len(active):
            break
        positions = at[active]
        values = field[positions[:, 1], positions[:, 2], positions[:, 0]]
        hits = values != 0
        hit = active[hits]
        hit_id[hit] = values[hits]
        hit_at[hit] = at[hit]
        active = active[~hits]
        if not len(active):
            break
        axis = nxt[active].argmin(axis=1)
        dist[active] = nxt[active, axis]
        at[active, axis] += step[active, axis]
        nxt[active, axis] += delta[active, axis]
        normals[active] = 0
        normals[active, axis] = -step[active, axis]
    mask = hit_id != 0
    background = np.array([17., 24., 29.])
    image = np.tile(background, (count, 1))
    sun = unit([-.4, .85, .65])
    diffuse = np.maximum(0, np.sum(normals*sun, axis=1))
    facing = np.maximum(0, -np.sum(normals*direction, axis=1))
    light = .48 + .45*diffuse + .20*facing
    if pov:
        light = .37 + .38*diffuse + .5*facing/(1+(dist/170)**2)
    coordinates = hit_at.astype(np.int64)
    hashed = (coordinates[:, 0]*73856093) ^ (coordinates[:, 1]*19349663) ^ (coordinates[:, 2]*83492791)
    hashed ^= hashed >> 13
    grain = ((hashed & 255)/255. - .5) * .12
    shade = np.clip(light + grain, .25, 1.2)
    rgb = colors[hit_id].astype(float)*shade[:, None]
    fog = np.clip((dist - (15 if pov else 510)) / (620 if pov else 1200), 0, .35)
    rgb = rgb*(1-fog[:, None]) + background*fog[:, None]
    image[mask] = rgb[mask]
    image = np.clip(image.reshape(height, width, 3), 0, 255).astype(np.uint8)
    markers = {}
    landmarks = {"A": [334/2, 45/2], "B": [177/2, 186/2], "C": [247/2, 275/2], "D": [40/2, 443/2]}
    for label, point in landmarks.items():
        world, _ = forward(kind, *point)
        relative = world-eye
        z = float(relative @ front)
        x = float(relative @ right)
        y = float(relative @ up)
        markers[label] = [round((.5+x/z/(2*fov*aspect))*100, 2), round((.5-y/z/(2*fov))*100, 2)]
    return Image.fromarray(image), markers


def build():
    started = time.monotonic()
    out = ROOT / "public/noita-directions"
    out.mkdir(exist_ok=True)
    source_file = WORLD / "world_-512_512.png_petri"
    spec = importlib.util.spec_from_file_location("mockup_wak", ROOT / "tools/import-noita-map.py")
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    wak = reader.Wak((Path.home() / "Games/Noita-native/data/data.wak").read_bytes())
    biome_map = Image.open(io.BytesIO(wak.read("data/biome_impl/biome_map.png"))).convert("RGB")
    rgb = biome_map.getpixel((34, 15))
    color = "ff" + bytes(rgb).hex()
    native_biomes = ET.fromstring(wak.read("data/biome/_biomes_all.xml"))
    native_file = next(node.attrib["biome_filename"] for node in native_biomes.iter()
                       if node.attrib.get("color", "").lower() == color)
    assert native_file == "data/biome/coalmine.xml", "The selected source must be the Mines, not Coal Pits"
    origin, terrain, metadata = decoder().decode_file(source_file)
    colors = palette(terrain.names)
    original = colors[terrain.indices]
    Image.fromarray(original).save(out / "mines-source.png")
    ids = terrain.indices[::2, ::2].astype(np.uint8)+1
    hidden = [i+1 for i, name in enumerate(terrain.names) if name == "air" or "smoke" in name or name in ("steam", "fire")]
    solid = ~np.isin(ids, hidden)
    ids = np.where(solid, ids, 0).astype(np.uint8)
    dist = distance_inside(solid)
    render_colors = np.vstack(([17, 24, 29], colors)).astype(np.uint8)
    source = {
        "biome": "Mines (first main biome)",
        "native_biome_file": native_file,
        "biome_map_cell": [34, 15],
        "file": source_file.name,
        "sha256": hashlib.sha256(source_file.read_bytes()).hexdigest(),
        "origin": list(origin),
        "shape": [512, 512],
        "names": terrain.names,
        "preview_source_step": 2,
        "source_cells": 512*512,
        "scope": "Actual saved materials. Display palette, not a native game screenshot. Rigid bodies/entities are not reconstructed.",
        "models": {},
        "eye_view_source": {"local": [180, 170], "native_world": [-332, 682], "normal_depth": 0},
        "landmarks": {"A": [334, 45, "Timber post"], "B": [177, 186, "Broken beam"],
                      "C": [247, 275, "Rock platform"], "D": [40, 443, "Water pocket"]},
    }
    # Camera must start in actual air, not inside an attractive but impossible wall.
    assert terrain.names[int(terrain.indices[170, 180])] == "air"
    for kind in ("reference", "shaped", "fold"):
        field = volume(kind, ids, solid, dist)
        point, _ = forward(kind, 90, 85)
        x, y, z = np.floor(point).astype(int)
        assert field[y, z, x] == 0, (kind, "camera is inside material")
        image, markers = render(field, render_colors, kind)
        image.save(out / f"{kind}-overview.webp", quality=92)
        image, _ = render(field, render_colors, kind, True)
        image.save(out / f"{kind}-eye.webp", quality=92)
        source["models"][kind] = {
            "overviewMarkers": markers,
            "size": [field.shape[2], field.shape[0], field.shape[1]],
            "overview_camera": [v.tolist() if isinstance(v, np.ndarray) else v for v in camera(field, kind, False)],
            "eye_camera": [v.tolist() if isinstance(v, np.ndarray) else v for v in camera(field, kind, True)],
        }
        # Height-collapsed footprint. This is not a conversion of source Y into depth.
        seen = (field != 0).any(axis=0)
        top_y = 255 - (field[::-1] != 0).argmax(axis=0)
        pz, px = np.indices(seen.shape)
        plan = render_colors[field[top_y, pz, px]]
        plan[~seen] = [17, 24, 29]
        Image.fromarray(plan[::-1]).resize((field.shape[2]*2, field.shape[1]*2), Image.Resampling.NEAREST).save(out / f"{kind}-plan.png")
        section = volume(kind, ids, solid, dist, cut=True)
        image, _ = render(section, render_colors, kind)
        image.save(out / f"{kind}-section.webp", quality=92)
        print(kind, source["models"][kind]["size"], "CPU renders complete", flush=True)
    (out / "source.json").write_text(json.dumps(source, indent=2)+"\n")
    print(f"Completed in {time.monotonic()-started:.2f}s CPU; no GPU used.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contact", action="store_true")
    args = parser.parse_args()
    if args.contact:
        contact()
    else:
        build()
