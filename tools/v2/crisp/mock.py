# v2 "crisp" look mock (NOT the renderer): a vectorized CPU voxel tracer that implements the
# pitch's shading model on today's box presets, so the look can be judged against today's shots.
#   per-cell palette jitter (element colour + var, stable hash), an 8x8 face pattern,
#   face AO by the 3-neighbour corner rule (0fps.net), sun shadow (here a DDA; v2 uses a shadow map),
#   Minecraft-style max-plus block light (coloured, per channel) and sky light on a 2-cell grid,
#   one sky for background, ambient, fog and reflections, coloured Beer-Lambert liquids, bloom, AgX.
# usage: python3 -I mock.py <dir> <preset> <view> <w> <h> <out.png>
import sys, json, math
import numpy as np
from PIL import Image

D, PRESET, VIEW = sys.argv[1], sys.argv[2], sys.argv[3]
W, H, OUT = int(sys.argv[4]), int(sys.argv[5]), sys.argv[6]
SS = 2
meta = json.load(open(f'{D}/meta.json'))
els = meta['els']
N = next(g['nx'] for g in meta['grids'] if g['name'] == PRESET)
ids = np.fromfile(f'{D}/{PRESET}.ids', np.uint8).reshape(N, N, N)       # [y, z, x]
BASE = PRESET.rstrip('0123456789')

# ---- material table: class, linear palette, jitter, emission, extinction
def lin(h):
    c = np.array([int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)])
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
NE = len(els)
CLS = np.zeros(256, np.uint8); ALB = np.zeros((256, 3)); VAR = np.zeros(256); EMIT = np.zeros((256, 3))
SIG = np.zeros((256, 3)); SPEC = np.zeros(256)
for i, e in enumerate(els):
    r = e['render']
    CLS[i] = 0 if e['kind'] == 0 else {0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 4}[r]
    ALB[i] = lin(e['color']); VAR[i] = e['var'] or 0.06
    if e['sigma']: SIG[i] = e['sigma']
KEY = {e['key']: i for i, e in enumerate(els)}
# a few art-directed palette entries (v2's palette rows); everything else is the table's colour
ALB[KEY['ROCK']] = lin('#675b53'); VAR[KEY['ROCK']] = 0.16
# stylised minimum optical depth for water (v2: one look parameter, not a 7 m fudge per droplet)
for k in ('WATER', 'SALTWATER'):
    SIG[KEY[k]] = np.array(els[KEY[k]]['sigma']) * 2.0
ALB[KEY['PLANT']] = lin('#4c9a2e'); VAR[KEY['PLANT']] = 0.22
ALB[KEY['WALL']] = lin('#6a707c')
ALB[KEY['LAVA']] = lin('#3a1a12'); VAR[KEY['LAVA']] = 0.3          # crust; cracks glow (EMIT below)
EMIT[KEY['LAVA']] = lin('#ff7a1e') * 7.0
SIG[KEY['GLASS']] = [0.03, 0.012, 0.02]; ALB[KEY['GLASS']] = lin('#cfe8ee')
SPEC[KEY['METAL']] = 0.6; SPEC[KEY['ICE']] = 0.2; SPEC[KEY['CLONE']] = 0.6
SCAT = np.where(CLS[:, None] == 2, ALB * 0.5, ALB * 0.05)
cls = CLS[ids]                                                     # [y, z, x]
opaque = cls == 1

# ---- sky, sun (the same sky everywhere: background, ambient, fog, reflections)
SUN = np.array([0.70, 0.71, -0.09]); SUN /= np.linalg.norm(SUN)
SUNC = np.array([1.0, 0.92, 0.80]) * 3.6
ZEN, HOR, GND = np.array([0.16, 0.32, 0.72]), np.array([0.62, 0.74, 0.92]), np.array([0.30, 0.28, 0.26])
def sky(d):
    y = d[:, 1:2]
    up = np.clip(y, 0, 1) ** 0.5
    c = np.where(y >= 0, HOR * (1 - up) + ZEN * up, HOR * np.clip(1 + y * 4, 0, 1) + GND * (1 - np.clip(1 + y * 4, 0, 1)))
    mu = np.clip(d @ SUN, -1, 1)
    c = c + SUNC * 8.0 * (mu > 0.9995)[:, None] + np.array([1.0, 0.85, 0.6]) * 0.25 * (np.clip(mu, 0, 1) ** 64)[:, None]
    return c
def sky_ambient(n):                     # irradiance of the same sky for a normal (cheap 2-term fit)
    y = n[:, 1:2]
    return (ZEN * 0.9 + HOR * 0.3) * (0.5 + 0.5 * y) + GND * 0.35 * (0.5 - 0.5 * y)

# ---- light grid (2-cell texels): Minecraft max-plus propagation, block light per channel, sky light
G = N // 2
def down2(a):
    return a.reshape(G, 2, G, 2, G, 2).sum(axis=(1, 3, 5))
blocked = down2(opaque.astype(np.int32)) >= 4
wet = down2((cls == 2).astype(np.int32)) >= 4
cost = np.where(wet, 2, 1)
def spread(L, src, iters=15):
    for _ in range(iters):
        m = L.copy()
        for ax in range(3):
            for s in (1, -1):
                sh = np.roll(L, s, axis=ax)
                idx = [slice(None)] * 3; idx[ax] = 0 if s == 1 else -1
                sh[tuple(idx)] = 0
                m = np.maximum(m, sh - cost)
        L = np.where(blocked, 0, np.maximum(src, m))
    return np.clip(L, 0, 15)
lava = down2((ids == KEY['LAVA']).astype(np.int32)) > 0
blk = [spread(np.zeros((G, G, G)), np.where(lava, lv, 0)) for lv in (15, 11, 6)]
# sky source: texels above the highest blocked texel of their column (y is axis 0)
hb = np.where(blocked.any(axis=0), G - 1 - np.argmax(blocked[::-1], axis=0), -1)
ys = np.arange(G)[:, None, None]
skysrc = np.where(ys > hb[None], 15, 0)
skyL = spread(np.zeros((G, G, G)), skysrc)
def mc(level):                           # Minecraft's light-level -> brightness curve, f/(4-3f)
    f = np.clip(level / 15.0, 0, 1)
    return f / (4 - 3 * f)
def tri(A, q):                           # trilinear sample of a [y,z,x] texel grid at cell coords q (x,y,z)
    t = q / 2.0 - 0.5
    t = np.clip(t, 0, G - 1.001)
    i = np.floor(t).astype(int); f = t - i
    out = 0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                out = out + w * A[np.minimum(i[:, 1] + dy, G - 1), np.minimum(i[:, 2] + dz, G - 1), np.minimum(i[:, 0] + dx, G - 1)]
    return out

# ---- DDA through the grid. mode 'primary' records the first transparent surface and the opaque/floor hit;
# mode 'shadow' returns transmittance only.
def march(o, d, shadow=False):
    n = len(o)
    inv = 1.0 / np.where(np.abs(d) < 1e-9, 1e-9, d)
    t1 = (0 - o) * inv; t2 = (N - o) * inv
    tn = np.minimum(t1, t2); tf = np.maximum(t1, t2)
    t0 = np.maximum(tn.max(1), 0); te = tf.min(1)
    inbox = te > t0
    res = dict(kind=np.zeros(n, np.int8), t=np.full(n, np.inf), nrm=np.zeros((n, 3)), cell=np.zeros((n, 3), int),
               od=np.zeros((n, 3)), tt=np.full(n, np.inf), tn=np.zeros((n, 3)), tid=np.zeros(n, int), ins=np.zeros((n, 3)))
    act = np.nonzero(inbox)[0]
    p = o[act] + d[act] * (t0[act] + 1e-5)[:, None]
    c = np.clip(np.floor(p).astype(int), 0, N - 1)
    st = np.where(d[act] > 0, 1, -1)
    tMax = (c + (st > 0) - o[act]) * inv[act]
    tD = np.abs(inv[act])
    tc = t0[act].copy()
    ax0 = np.argmax(tn[act], 1)
    nrm = np.zeros((len(act), 3)); nrm[np.arange(len(act)), ax0] = -st[np.arange(len(act)), ax0]
    od = np.zeros((len(act), 3)); first = np.zeros(len(act), bool); ins = np.zeros((len(act), 3))
    while len(act):
        out = (c < 0).any(1) | (c >= N).any(1)
        if out.any():
            r = act[out]
            res['od'][r] = od[out]; res['ins'][r] = ins[out]
            if not shadow:
                fl = (c[out, 1] < 0)
                res['kind'][r[fl]] = 2; res['t'][r[fl]] = tc[out][fl]
                res['nrm'][r[fl]] = [0, 1, 0]
                cc = c[out][fl].copy(); res['cell'][r[fl]] = cc
            keep = ~out
            act, c, st, tMax, tD, tc, nrm, od, first, ins = act[keep], c[keep], st[keep], tMax[keep], tD[keep], tc[keep], nrm[keep], od[keep], first[keep], ins[keep]
            if not len(act): break
        idv = ids[c[:, 1], c[:, 2], c[:, 0]]
        k = CLS[idv]
        hit = k == 1
        if hit.any():
            r = act[hit]
            res['od'][r] = od[hit]; res['ins'][r] = ins[hit]
            if shadow:
                res['od'][r] = 1e9
            else:
                res['kind'][r] = 1; res['t'][r] = tc[hit]; res['nrm'][r] = nrm[hit]; res['cell'][r] = c[hit]
            keep = ~hit
            act, c, st, tMax, tD, tc, nrm, od, first, idv, k, ins = act[keep], c[keep], st[keep], tMax[keep], tD[keep], tc[keep], nrm[keep], od[keep], first[keep], idv[keep], k[keep], ins[keep]
            if not len(act): break
        tr = (k == 2) | (k == 3)
        ax = np.argmin(tMax, 1)
        rows = np.arange(len(act))
        tnext = tMax[rows, ax]
        if tr.any():
            seg = SIG[idv[tr]] * (tnext[tr] - tc[tr])[:, None]
            ins[tr] += np.exp(-np.minimum(od[tr], 60)) * (1 - np.exp(-seg)) * SCAT[idv[tr]]
            od[tr] += seg
            if not shadow:
                nf = tr & ~first
                if nf.any():
                    r = act[nf]
                    res['tt'][r] = tc[nf]; res['tn'][r] = nrm[nf]; res['tid'][r] = idv[nf]
                    first |= nf
        tc = tnext
        c[rows, ax] += st[rows, ax]
        tMax[rows, ax] += tD[rows, ax]
        nrm = np.zeros((len(act), 3)); nrm[rows, ax] = -st[rows, ax]
    if not shadow:
        # rays that never entered the box may still hit the floor plane (y = 0) around it
        miss = (res['kind'] == 0) & (d[:, 1] < 0) & ~np.isfinite(res['t'])
        tfl = -o[:, 1] / np.where(d[:, 1] < 0, d[:, 1], -1)
        fp = o + d * tfl[:, None]
        onf = miss & (tfl < 4000)
        res['kind'][onf] = 2; res['t'][onf] = tfl[onf]; res['nrm'][onf] = [0, 1, 0]
        res['cell'][onf] = np.stack([np.floor(fp[onf, 0]), -np.ones(onf.sum()), np.floor(fp[onf, 2])], 1).astype(int)
    return res

def occ(x, y, z):
    ok = (x >= 0) & (y >= 0) & (z >= 0) & (x < N) & (y < N) & (z < N)
    v = np.zeros(len(x), bool)
    v[ok] = opaque[y[ok], z[ok], x[ok]]
    return v | (y < 0)

def hash3(c, salt=0):
    h = (c[:, 0] * 73856093) ^ (c[:, 1] * 19349663) ^ (c[:, 2] * 83492791) ^ (salt * 2654435761)
    h = (h ^ (h >> 13)) * 1274126177
    h = h ^ (h >> 16)
    return (h & 0xFFFF) / 65535.0

def shade(o, d):
    n = len(o)
    R = march(o, d)
    col = np.zeros((n, 3))
    k = R['kind']
    sk = k == 0
    col[sk] = sky(d[sk])
    hs = np.nonzero(k > 0)[0]
    if len(hs):
        t = R['t'][hs]; nr = R['nrm'][hs]; ce = R['cell'][hs]; dd = d[hs]
        p = o[hs] + dd * t[:, None]
        isfloor = k[hs] == 2
        idv = np.where(isfloor, 0, ids[np.clip(ce[:, 1], 0, N - 1), np.clip(ce[:, 2], 0, N - 1), np.clip(ce[:, 0], 0, N - 1)])
        # albedo: palette colour, per-cell stable jitter, 8x8 face pattern
        h = hash3(ce)
        tone = np.array([-1.0, -0.35, 0.35, 1.0])[np.minimum((h * 4).astype(int), 3)]
        alb = ALB[idv] * (1 + VAR[idv][:, None] * tone[:, None] * 1.4)
        ax = np.argmax(np.abs(nr), 1)
        u_ax = np.where(ax == 0, 2, 0); v_ax = np.where(ax == 1, 2, 1)
        rows = np.arange(len(hs))
        fu = p[rows, u_ax] - np.floor(p[rows, u_ax]); fv = p[rows, v_ax] - np.floor(p[rows, v_ax])
        tex = np.stack([ce[:, 0] * 8 + (fu * 8).astype(int), ce[:, 1] * 8 + (fv * 8).astype(int), ce[:, 2] * 8 + ax], 1)
        alb = alb * (1 + 0.07 * (hash3(tex, 7)[:, None] * 2 - 1))
        fl = isfloor
        if fl.any():
            gx = p[fl, 0]; gz = p[fl, 2]
            gs = N / 8
            line = ((np.abs(gx / gs - np.round(gx / gs)) * gs < 0.12) | (np.abs(gz / gs - np.round(gz / gs)) * gs < 0.12))
            base = lin('#45474a') * (1 + 0.05 * (h[fl] * 2 - 1))[:, None]
            alb[fl] = base * np.where(line, 1.35, 1.0)[:, None]
        alb = np.clip(alb, 0, 1)
        # face AO: corners of the cell layer in front of the face (side1, side2, corner)
        f = ce + nr.astype(int)
        U = np.zeros((len(hs), 3), int); V = np.zeros((len(hs), 3), int)
        U[rows, u_ax] = 1; V[rows, v_ax] = 1
        aoc = {}
        for i in (0, 1):
            for j in (0, 1):
                du = U * (2 * i - 1); dv = V * (2 * j - 1)
                s1 = occ(*(f + du).T); s2 = occ(*(f + dv).T); cc = occ(*(f + du + dv).T)
                lvl = np.where(s1 & s2, 0, 3 - (s1.astype(int) + s2 + cc))
                aoc[(i, j)] = np.array([0.42, 0.62, 0.81, 1.0])[lvl]
        ao = (aoc[(0, 0)] * (1 - fu) + aoc[(1, 0)] * fu) * (1 - fv) + (aoc[(0, 1)] * (1 - fu) + aoc[(1, 1)] * fu) * fv
        # convex-edge highlight: a thin bright rim where the face meets an exposed side face (voxel readability)
        rim = np.ones(len(hs))
        for sgn, fcoord in ((1, fu), (-1, 1 - fu)):
            open_ = ~occ(*(ce + U * sgn).T) & ~isfloor
            rim = np.where(open_ & (1 - fcoord < 0.07), 1.18, rim)
        for sgn, fcoord in ((1, fv), (-1, 1 - fv)):
            open_ = ~occ(*(ce + V * sgn).T) & ~isfloor
            rim = np.where(open_ & (1 - fcoord < 0.07), 1.18, rim)
        alb = np.clip(alb * rim[:, None], 0, 1)
        # sun with shadow (and coloured transmittance through liquids/glass)
        ndl = np.clip(nr @ SUN, 0, 1)
        sh_o = p + nr * 1e-3
        S = march(sh_o, np.tile(SUN, (len(hs), 1)), shadow=True)
        sunT = np.exp(-np.minimum(S['od'], 60))
        q = p + nr * 0.5
        skyb = mc(tri(skyL, q))
        blk_rgb = np.stack([mc(tri(B, q)) for B in blk], 1)
        amb = sky_ambient(nr) * skyb[:, None] * 0.8
        light = SUNC * (ndl[:, None] * sunT) + amb * ao[:, None] + blk_rgb * np.array([2.2, 1.6, 1.2]) * ao[:, None]
        c = alb * light
        # emission (lava cracks: brighter on cells the hash marks as cracks)
        em = EMIT[idv] * np.clip((h - 0.35) * 2.2, 0.05, 1.0)[:, None]
        c = c + em
        # specular from the one sky for metals/ice (cheap Fresnel)
        sp = SPEC[idv]
        if sp.any():
            rd = dd - 2 * (dd * nr).sum(1)[:, None] * nr
            c = c * (1 - sp[:, None] * 0.5) + sp[:, None] * sky(rd) * skyb[:, None] * 0.6 * alb
        # fog with the sky's horizon colour (aerial perspective), cells are 0.3 m
        dist = t * 0.3
        fog = 1 - np.exp(-dist * 0.0012)
        c = c * (1 - fog[:, None]) + HOR * fog[:, None]
        col[hs] = c
    # liquids and glass in front: coloured Beer-Lambert over what's behind, Fresnel reflection of the sky
    tw = np.nonzero(np.isfinite(R['tt']))[0]
    if len(tw):
        T = np.exp(-np.minimum(R['od'][tw], 60))
        nr = R['tn'][tw]; dd = d[tw]
        cosi = np.clip(-(dd * nr).sum(1), 0, 1)
        F = 0.02 + 0.98 * (1 - cosi) ** 5
        rd = dd - 2 * (dd * nr).sum(1)[:, None] * nr
        ps = o[tw] + dd * R['tt'][tw][:, None]
        skyb = mc(tri(skyL, ps + nr * 0.5))
        refl = sky(rd) * skyb[:, None]
        tid = R['tid'][tw]
        scat_lit = R['ins'][tw] * (sky_ambient(np.tile([[0.0, 1.0, 0.0]], (len(tw), 1))) * 0.8 + SUNC * 0.3) * skyb[:, None]
        behind = col[tw]
        col[tw] = F[:, None] * refl + (1 - F[:, None]) * (behind * T + scat_lit)
    return col

def camera():
    u = N / 10
    if VIEW == 'home':
        eye = np.array([(11 + 5) * u, 12 * u, (13 + 5) * u]); at = np.array([N / 2, 2.5 * u, N / 2])
    else:
        V = {('lab', 'tank'): ([36, 22, -14], [36, 16, 30]), ('volcano', 'flank'): ([64, 40, 4], [64, 26, 40]),
             ('volcano', 'summit'): ([50, 62, 40], [64, 46, 64]), ('lab', 'tower'): ([6, 30, 60], [27, 26, 87]),
             ('lab', 'lavaPlate'): ([70, 30, 64], [96, 10, 96])}[(BASE, VIEW)]
        eye, at = np.array(V[0], float) * N / 128, np.array(V[1], float) * N / 128
    return eye, at

eye, at = camera()
fwd = at - eye; fwd /= np.linalg.norm(fwd)
right = np.cross(fwd, [0, 1, 0]); right /= np.linalg.norm(right)
up = np.cross(right, fwd)
th = math.tan(math.radians(40) / 2)
WS, HS = W * SS, H * SS
jj, ii = np.meshgrid(np.arange(HS), np.arange(WS), indexing='ij')
sx = ((ii + 0.5) / WS * 2 - 1) * th * W / H
sy = (1 - (jj + 0.5) / HS * 2) * th
dirs = fwd[None] + sx.reshape(-1, 1) * right[None] + sy.reshape(-1, 1) * up[None]
dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
orig = np.tile(eye, (len(dirs), 1))
img = shade(orig, dirs).reshape(HS, WS, 3)
img = img.reshape(H, SS, W, SS, 3).mean(axis=(1, 3))          # 2x2 supersampling stands in for 4x MSAA

# bloom (energy-conserving mix of two blurs), then AgX
def blur(a, s):
    r = int(3 * s); x = np.arange(-r, r + 1); k = np.exp(-x * x / (2 * s * s)); k /= k.sum()
    a = np.apply_along_axis(lambda m: np.convolve(m, k, 'same'), 0, a)
    return np.apply_along_axis(lambda m: np.convolve(m, k, 'same'), 1, a)
b = np.stack([blur(img[..., ch], 2.5) * 0.5 + blur(img[..., ch], 8) * 0.5 for ch in range(3)], -1)
img = img * 0.94 + b * 0.06
M = np.array([[0.842479062253094, 0.0423282422610123, 0.0423756549057051],
              [0.0784335999999992, 0.878468636469772, 0.0784336],
              [0.0792237451477643, 0.0791661274605434, 0.879142973793104]]).T
Mi = np.array([[1.19687900512017, -0.0528968517574562, -0.0529716355144438],
               [-0.0980208811401368, 1.15190312990417, -0.0980434501171241],
               [-0.0990297440797205, -0.0989611768448433, 1.15107367264116]]).T
x = np.clip(img.reshape(-1, 3) * 0.8, 1e-10, None) @ M.T
lo, hi = -12.47393, 4.026069
x = (np.clip(np.log2(x), lo, hi) - lo) / (hi - lo)
x2 = x * x; x4 = x2 * x2
x = 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232
x = np.clip(x @ Mi.T, 0, 1)
Image.fromarray((x.reshape(H, W, 3) * 255 + 0.5).astype(np.uint8)).save(OUT)
print('wrote', OUT)
