"""Write public/brand/*.svg from mark-paths.json (trace_logo.py) and design v2 section 5.

The wordmark text is outlined from Inter 600 (Google Fonts static TTF, fetched to a temp folder for
this build step only; the app itself self-hosts Inter through next/font). Glyph positions come from
wordmark-positions.json, measured in Chromium with the app's own Inter so kerning and the -0.02em
tracking match the inline <Wordmark>.
Run from app/: python3 -I tests/e2e/shell/brand/make_brand.py <path-to-inter600.ttf>
"""
import json, os, subprocess, sys, math

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
OUT = os.path.join(APP, "public", "brand")
P = json.load(open(os.path.join(HERE, "mark-paths.json")))
W, H = 1020, 691

def oklch_to_hex(L, C, h):
    a, b = C * math.cos(math.radians(h)), C * math.sin(math.radians(h))
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s]
    def enc(x):
        x = min(1, max(0, x))
        return 12.92 * x if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055
    return "#" + "".join("%02X" % round(enc(c) * 255) for c in rgb)

FG_LIGHT = oklch_to_hex(0.21, 0.01, 70)
FG_DARK = "#F4F1EC"  # design v2 section 5 names this value exactly
ACCENT_LIGHT = oklch_to_hex(0.80, 0.135, 80)
ACCENT_DARK = oklch_to_hex(0.82, 0.13, 82)
DAY = (oklch_to_hex(0.97, 0.02, 85), oklch_to_hex(0.93, 0.03, 230))
DUSK = (oklch_to_hex(0.30, 0.05, 40), oklch_to_hex(0.18, 0.03, 280))
print("colours", FG_LIGHT, FG_DARK, ACCENT_LIGHT, ACCENT_DARK, DAY, DUSK)

def scheme_style(extra=""):
    return (
        "<style>.b{fill:%s}.d{fill:%s}%s@media (prefers-color-scheme:dark){.b{fill:%s}.d{fill:%s}}</style>"
        % (FG_LIGHT, "%s", extra, FG_DARK, "%s")
    )

def bands(cls="b"):
    return f'<path class="{cls}" d="{P["L"]}"/><path class="{cls}" d="{P["R"]}"/>'

def write(name, svg):
    open(os.path.join(OUT, name), "w").write(svg + "\n")
    print("wrote", name, len(svg), "bytes")

os.makedirs(OUT, exist_ok=True)
head = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">'
# One colour: --fg light, #F4F1EC on dark.
write("mark.svg", head + "<title>Atrium</title>" + (scheme_style() % (FG_LIGHT, FG_DARK)) + bands() + f'<path class="d" d="{P["D"]}"/></svg>')
# Lit: only the doorway changes, to --accent.
write("mark-lit.svg", head + "<title>Atrium</title>" + (scheme_style() % (ACCENT_LIGHT, ACCENT_DARK)) + bands() + f'<path class="d" d="{P["D"]}"/></svg>')

# Wordmark: gap half the mark height, cap height 45% of the mark height.
pos = json.load(open(os.path.join(HERE, "wordmark-positions.json")))
ttf = sys.argv[1]
fs = pos["fs"]
# Shift so the gap is half the mark height measured to the ink of "A" (left side bearing 50/2048 em).
shift = -(50 / 2048) * fs
pos["out"] = [[a + shift, b + shift] for a, b in pos["out"]]
pos["x"] = pos["x"] + shift
glyphs = ""
for ch, (x0, _x1) in zip("Atrium", pos["out"]):
    r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "ttf_outline.py"), ttf, ch, str(fs), str(x0), str(H), "0"], capture_output=True, text=True, check=True)
    glyphs += json.loads(r.stdout)["d"]
cap = json.loads(subprocess.run([sys.executable, "-I", os.path.join(HERE, "ttf_outline.py"), ttf, "A", str(fs), "0", str(H), "0"], capture_output=True, text=True, check=True).stdout)["capPx"]
total = math.ceil(pos["out"][-1][1] + 4)
write(
    "wordmark.svg",
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total} {H}" width="{total}" height="{H}"><title>Atrium</title>'
    + (scheme_style() % (FG_LIGHT, FG_DARK))
    + bands()
    + f'<path class="d" d="{P["D"]}"/><path class="b" d="{glyphs}"/></svg>',
)
print("wordmark cap height", round(cap, 1), "=", round(cap / H * 100, 1), "% of mark height; ink gap", round(pos["x"] - shift * 0 - W + (50 / 2048) * fs, 1))

# Favicon (16 and 32px): the band gap is closed (a stroke in the band colour fills it), doorway kept.
S = 1100
fav_head = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{-(S - W) / 2} {-(S - H) / 2} {S} {S}" width="32" height="32">'
gap_fill = ".g{fill:%s;stroke:%s;stroke-width:22;stroke-linejoin:round}@media (prefers-color-scheme:dark){.g{fill:%s;stroke:%s}}" % (FG_LIGHT, FG_LIGHT, FG_DARK, FG_DARK)
write("favicon.svg", fav_head + "<title>Atrium</title>" + (scheme_style(gap_fill) % (ACCENT_LIGHT, ACCENT_DARK)) + bands("g") + f'<path class="d" d="{P["D"]}"/></svg>')

# App icon sources (rendered to PNG by render_brand.cjs). Lit variant on the Daylight gradient, and
# the lit variant in #F4F1EC on the Dusk gradient. Mark at 62% of the icon width, centred.
def icon(bg, fg, accent):
    size = 512
    mw = size * 0.62
    sc = mw / W
    tx, ty = (size - mw) / 2, (size - H * sc) / 2 + size * 0.02
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">'
        f'<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{bg[0]}"/><stop offset="1" stop-color="{bg[1]}"/></linearGradient></defs>'
        f'<rect width="{size}" height="{size}" fill="url(#g)"/>'
        f'<g transform="translate({tx:.2f} {ty:.2f}) scale({sc:.5f})"><path fill="{fg}" d="{P["L"]}"/><path fill="{fg}" d="{P["R"]}"/><path fill="{accent}" d="{P["D"]}"/></g></svg>'
    )
write("icon-source-light.svg", icon(DAY, FG_LIGHT, ACCENT_LIGHT))
write("icon-source-dark.svg", icon(DUSK, "#F4F1EC", ACCENT_DARK))
