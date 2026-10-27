#!/usr/bin/env python3
"""Scores pictures against a reference with NVIDIA FLIP (Andersson et al. 2020, "FLIP: A Difference
Evaluator for Alternating Images"; NVlabs/flip, BSD-3): the perceived difference a viewer sees flipping
between the two at this screen's size, 0 (same) to 1. The look's outside judge (research/detail-loss):
the reference is tools/profile.mjs --truth --shot, the candidates the same poses' --shot frames.

  python3 -I tools/look-score.py TRUTH.png CANDIDATE.png [CANDIDATE.png ...] [--map OUT_DIR]

Prints each candidate's mean FLIP, its 90th/99th percentile, and the mean of the top and bottom halves
of the frame (on these poses the top half is mostly the distance, the bottom the near ground). --map
writes each candidate's error map (magma, FLIP's own colouring) beside its name.
Needs: pip install flip-evaluator numpy pillow (CPU only, no browser).
"""
import os
import sys

import flip_evaluator as flip
import numpy as np
from PIL import Image

# FLIP's viewing conditions: its defaults (0.7 m from a 0.7 m wide, 3840 px monitor: 67 px per degree)
# are a desktop screen; the M5 laptop is ~0.3 m wide at 3024 px seen from ~0.5 m: ~88 px per degree.
# FLIP takes them as pixels per degree (its "ppd" parameter).
MONITOR_DISTANCE_M = 0.5
MONITOR_WIDTH_M = 0.30
MONITOR_WIDTH_PX = 3024
PPD = MONITOR_DISTANCE_M * MONITOR_WIDTH_PX / MONITOR_WIDTH_M * np.pi / 180
PERCENTILES = (90, 99)


def load_rgb(path):
    return np.asarray(Image.open(path).convert('RGB'), dtype=np.float32) / 255.0


def main(argv):
    out = None
    if '--map' in argv:
        i = argv.index('--map')
        out = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    if len(argv) < 2:
        sys.exit(__doc__)
    params = {'ppd': float(PPD)}
    ref = load_rgb(argv[0])
    for path in argv[1:]:
        test = load_rgb(path)
        if test.shape != ref.shape:
            print(f'{path}: size {test.shape[1]}x{test.shape[0]} differs from the reference {ref.shape[1]}x{ref.shape[0]}')
            continue
        err, mean, _ = flip.evaluate(ref, test, 'LDR', inputsRGB=True, applyMagma=False, computeMeanError=True, parameters=params)
        err = np.asarray(err).squeeze()
        h = err.shape[0] // 2
        pct = ' '.join(f'p{p} {np.percentile(err, p):.4f}' for p in PERCENTILES)
        print(f'{os.path.basename(path)}: FLIP mean {mean:.4f} · {pct} · top half {err[:h].mean():.4f} · bottom half {err[h:].mean():.4f}')
        if out:
            os.makedirs(out, exist_ok=True)
            magma, _, _ = flip.evaluate(ref, test, 'LDR', inputsRGB=True, applyMagma=True, computeMeanError=False, parameters=params)
            img = (np.clip(np.asarray(magma).squeeze(), 0, 1) * 255).astype(np.uint8)
            Image.fromarray(img).save(os.path.join(out, 'flip-' + os.path.basename(path)))


if __name__ == '__main__':
    main(sys.argv[1:])
