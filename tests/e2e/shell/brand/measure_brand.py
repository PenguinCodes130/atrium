"""Measure trace fidelity and wordmark proportions from render_brand.cjs evidence.
Run from app/: python3 -I tests/e2e/shell/brand/measure_brand.py"""
import json, os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
EV = os.path.join(APP, "evidence/app-shell/r1/logo")
a = np.array(Image.open(os.path.join(APP, "../logo.png")).convert("RGBA")).astype(float)
alpha = a[..., 3] / 255
lum = (0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]) * alpha + 255 * (1 - alpha)
ink = int((lum < 128).sum())
d = np.array(Image.open(os.path.join(EV, "mark-difference.png")).convert("L")).astype(int)
m = d < 128
core = m & np.roll(m, 1, 0) & np.roll(m, -1, 0) & np.roll(m, 1, 1) & np.roll(m, -1, 1)
res = {
    "reference_ink_px": ink,
    "mismatch_px": int(m.sum()),
    "mismatch_pct_of_ink": round(100 * m.sum() / ink, 3),
    "mismatch_px_thicker_than_1px": int(core.sum()),
    "note": "difference blend: agreement is grey (logo ink is #232323), a mismatch is darker than 128",
}
w = np.array(Image.open(os.path.join(EV, "wordmark-and-marks-light.png")).convert("L"))
region = w[30:260, :]
cols = np.where((region < 128).any(0))[0]
gap_i = np.where(np.diff(cols) > 20)[0][0]
mark_end, text_start = cols[gap_i], cols[gap_i + 1]
mr = np.where((region[:, : mark_end + 1] < 128).any(1))[0]
mark_h = mr.max() - mr.min() + 1
A = region[:, text_start : text_start + int(mark_h * 0.6)]
ar = np.where((A < 128).any(1))[0]
cap_h = ar.max() - ar.min() + 1
res["wordmark"] = {"mark_height_px": int(mark_h), "cap_height_px": int(cap_h), "cap_ratio": round(cap_h / mark_h, 3), "gap_px": int(text_start - mark_end - 1), "gap_ratio": round((text_start - mark_end - 1) / mark_h, 3)}
json.dump(res, open(os.path.join(EV, "measurements.json"), "w"), indent=1)
print(json.dumps(res, indent=1))
