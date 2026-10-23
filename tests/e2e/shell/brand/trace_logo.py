"""Trace logo.png (workspace root) into the Atrium mark with true circular arcs.

potrace is not installed on the build host, so this does the trace directly:
1. threshold at 50% luminance and split the ink into the two bands and the doorway (flood fill),
2. marching squares gives each band's sub-pixel outline,
3. the outline is split at its sharp corners and each run is fitted greedily with straight lines
   and circular arcs (max deviation TOL px at the 1254px source size),
4. collinear lines are merged, the baseline is snapped flat, and the doorway is rebuilt exactly as
   two verticals and a semicircle.
Writes src/features/shell/brand-paths.ts. Run from app/: python3 -I tests/e2e/shell/brand/trace_logo.py
Needs Pillow and numpy only.
"""
import json, sys, os
import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
LOGO = os.path.join(APP, "..", "logo.png")
TOL = 0.7
OX, OY = 112.5, 279.5  # crop offset: the mark's box in logo.png
BASE = 970.25          # baseline in logo.png pixels

im = Image.open(LOGO).convert("RGBA")
a = np.array(im).astype(float)
alpha = a[..., 3] / 255
lum = (0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]) * alpha + 255 * (1 - alpha)
ink = lum < 128
lab_img = Image.fromarray(np.where(ink, 255, 0).astype(np.uint8), "L").copy()
for seed, val in [((200, 900), 50), ((1000, 900), 100), ((627, 900), 150)]:
    ImageDraw.floodfill(lab_img, seed, val)
L = np.array(lab_img)

def component_field(c):
    m = L == c
    d = m.copy()
    for _ in range(3):
        d = d | np.roll(d, 1, 0) | np.roll(d, -1, 0) | np.roll(d, 1, 1) | np.roll(d, -1, 1)
    f = np.where(d, lum, 255.0)
    other = (L != c) & (L != 0) & (lum < 128)
    return np.where(other & ~m, 255.0, f)

def marching(f, iso=128.0):
    inside = f < iso
    edge = (inside[:-1, :-1] != inside[1:, :-1]) | (inside[:-1, :-1] != inside[:-1, 1:]) | (inside[1:, 1:] != inside[1:, :-1]) | (inside[1:, 1:] != inside[:-1, 1:])
    segs = []
    for y, x in zip(*np.nonzero(edge)):
        v = [f[y, x], f[y, x + 1], f[y + 1, x + 1], f[y + 1, x]]
        pts = [(x, y), (x + 1, y), (x + 1, y + 1), (x, y + 1)]
        es = []
        for e in range(4):
            p, q = e, (e + 1) % 4
            if (v[p] < iso) != (v[q] < iso):
                t = (iso - v[p]) / (v[q] - v[p])
                es.append((pts[p][0] + t * (pts[q][0] - pts[p][0]), pts[p][1] + t * (pts[q][1] - pts[p][1])))
        if len(es) == 2:
            segs.append((es[0], es[1]))
        elif len(es) == 4:
            segs += [(es[0], es[1]), (es[2], es[3])]
    return segs

def link(segs):
    key = lambda p: (round(p[0], 4), round(p[1], 4))
    adj = {}
    for p, q in segs:
        adj.setdefault(key(p), []).append(key(q))
        adj.setdefault(key(q), []).append(key(p))
    seen, loops = set(), []
    for s in list(adj):
        if s in seen:
            continue
        loop, prev, cur = [s], None, s
        seen.add(s)
        while True:
            nxt = [n for n in adj[cur] if n != prev and n not in seen]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            seen.add(cur)
            loop.append(cur)
        loops.append(loop)
    return max(loops, key=len)

def fit_circle(p):
    x, y = p[:, 0], p[:, 1]
    A = np.c_[2 * x, 2 * y, np.ones(len(x))]
    (cx, cy, c), *_ = np.linalg.lstsq(A, x * x + y * y, rcond=None)
    r = np.sqrt(max(c + cx * cx + cy * cy, 1e-9))
    return (cx, cy, r), np.abs(np.hypot(x - cx, y - cy) - r).max()

def line_err(p):
    a, b = p[0], p[-1]
    d = b - a
    n = np.array([-d[1], d[0]]) / max(np.hypot(*d), 1e-9)
    return np.abs((p - a) @ n).max()

def corners(p, win=8, thr=30):
    n = len(p)
    ang = np.zeros(n)
    for i in range(n):
        u = p[i] - p[(i - win) % n]
        v = p[(i + win) % n] - p[i]
        ang[i] = np.degrees(np.arccos(np.clip(u @ v / np.hypot(*u) / np.hypot(*v), -1, 1)))
    out = []
    for i in range(n):
        if ang[i] > thr and ang[i] == max(ang[(i + k) % n] for k in range(-win, win + 1)):
            if not out or i - out[-1] > win:
                out.append(i)
    return out

def segment(chain):
    segs, i, n = [], 0, len(chain)
    while i < n - 1:
        last = None
        for j in range(i + 2, n):
            q = chain[i : j + 1]
            if line_err(q) <= TOL:
                last = ("L", j, None)
                continue
            c, ec = fit_circle(q)
            if ec <= TOL and c[2] < 5000:
                last = ("A", j, c)
                continue
            break
        if last is None:
            last = ("L", min(i + 2, n - 1), None)
        kind, j, c = last
        if kind == "A":
            c, _ = fit_circle(chain[i : j + 1])
        segs.append((kind, chain[i].tolist(), chain[j].tolist(), None if c is None else list(c)))
        i = j
    return segs

def snap(p):
    return [p[0], BASE if abs(p[1] - 970) < 1.0 else p[1]]

def cleanup(segs):
    out = []
    for k, a_, b, c in segs:
        a_, b = snap(a_), snap(b)
        if np.hypot(b[0] - a_[0], b[1] - a_[1]) < 1.0:
            continue
        if k == "A" and c[2] > 3000:
            k, c = "L", None
        if out and k == "L" and out[-1][0] == "L":
            pa, pb, mid = np.array(out[-1][1]), np.array(b), np.array(out[-1][2])
            d = pb - pa
            n = np.array([-d[1], d[0]]) / np.hypot(*d)
            if abs((mid - pa) @ n) < 1.2:
                out[-1] = ("L", out[-1][1], b, None)
                continue
        if out:
            a_ = out[-1][2]
        out.append((k, a_, b, c))
    return out

def fmt(v):
    return ("%.1f" % v).rstrip("0").rstrip(".")

def to_path(segs):
    s = "M%s %s" % (fmt(segs[0][1][0] - OX), fmt(segs[0][1][1] - OY))
    for k, a_, b, c in segs:
        if k == "L":
            s += "L%s %s" % (fmt(b[0] - OX), fmt(b[1] - OY))
        else:
            cx, cy, r = c
            da = (np.arctan2(b[1] - cy, b[0] - cx) - np.arctan2(a_[1] - cy, a_[0] - cx) + np.pi) % (2 * np.pi) - np.pi
            s += "A%s %s 0 0 %d %s %s" % (fmt(r), fmt(r), 1 if da > 0 else 0, fmt(b[0] - OX), fmt(b[1] - OY))
    return s + "Z"

paths, report = {}, {}
for name, c in [("L", 50), ("R", 100)]:
    p = np.array(link(marching(component_field(c))))
    keep = [0]
    for k in range(1, len(p)):
        if np.hypot(*(p[k] - p[keep[-1]])) > 0.5:
            keep.append(k)
    p = p[keep]
    cs = corners(p)
    p = np.roll(p, -cs[0], axis=0)
    cs = [(x - cs[0]) % len(p) for x in cs] + [len(p)]
    segs = []
    for s0, s1 in zip(cs[:-1], cs[1:]):
        segs += segment(np.vstack([p[s0:s1], p[s1 % len(p)][None]]))
    segs = cleanup(segs)
    paths[name] = to_path(segs)
    report[name] = [(k, None if c_ is None else round(c_[2], 1)) for k, _, _, c_ in segs]

dp = np.array(link(marching(component_field(150))))
side = dp[(dp[:, 1] > 800) & (dp[:, 1] < 960)]
left, right = side[side[:, 0] < 627][:, 0].mean(), side[side[:, 0] > 627][:, 0].mean()
top = dp[:, 1].min()
r = (right - left) / 2
cy = top + r
paths["D"] = "M%s %sV%sA%s %s 0 0 1 %s %sV%sZ" % (fmt(left - OX), fmt(BASE - OY), fmt(cy - OY), fmt(r), fmt(r), fmt(right - OX), fmt(cy - OY), fmt(BASE - OY))

src = f'''// The Atrium mark, traced from logo.png (workspace root) with true circular arcs.
// Coordinates: viewBox 0 0 1020 691 (logo.png pixels offset by {OX}, {OY}). Generated by
// tests/e2e/shell/brand/trace_logo.py; public/brand/*.svg use the same paths.
export const MARK_VIEWBOX = "0 0 1020 691";
export const MARK_WIDTH = 1020;
export const MARK_HEIGHT = 691;
/** Left band: sweeps up and over the top. */
export const MARK_LEFT_BAND = "{paths['L']}";
/** Right band: folds in beneath the left band, separated by the thin gap. */
export const MARK_RIGHT_BAND = "{paths['R']}";
/** The arched doorway on the baseline (the only part the lit variant colours). */
export const MARK_DOORWAY = "{paths['D']}";
'''
open(os.path.join(APP, "src/features/shell/brand-paths.ts"), "w").write(src)
json.dump(paths, open(os.path.join(HERE, "mark-paths.json"), "w"), indent=1)
print(json.dumps({"segments": report, "door": {"left": left, "right": right, "top": top, "r": r}}, indent=1))
