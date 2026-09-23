#!/usr/bin/env python3
"""Generate default tileable textures for the rendering pipeline.

Every diffuse map carries real procedural surface variation (periodic
multi-octave value noise plus material-specific detail) so the PBR maps
derived in generate_pbr.py have actual relief to pick up. All noise is
lattice-periodic, so every texture tiles seamlessly. Fixed seeds keep
generation deterministic.
"""
from PIL import Image, ImageDraw, ImageFilter
import random
import os

SIZE = 512
OUT_DIR = os.path.dirname(os.path.abspath(__file__))


def _smooth(t):
    """Smoothstep fade for lattice interpolation."""
    return t * t * (3.0 - 2.0 * t)


def _noise_1d(freq, seed):
    """Periodic 1D value noise sampled at SIZE points, range [0, 1]."""
    rnd = random.Random(seed)
    lattice = [rnd.random() for _ in range(freq)]
    step = SIZE / freq
    out = [0.0] * SIZE
    for i in range(SIZE):
        f, t = divmod(i / step, 1.0)
        i0 = int(f)
        t = _smooth(t)
        out[i] = lattice[i0] * (1 - t) + lattice[(i0 + 1) % freq] * t
    return out


def _noise_2d(freq_x, freq_y, seed):
    """Tileable 2D value noise as a flat row-major list, range [0, 1].

    A non-square lattice stretches detail along one axis (e.g. wood streaks).
    """
    rnd = random.Random(seed)
    lattice = [[rnd.random() for _ in range(freq_x)] for _ in range(freq_y)]
    step_x = SIZE / freq_x
    step_y = SIZE / freq_y
    # Per-column lattice indices + fade, shared by every row.
    x0s = [0] * SIZE
    x1s = [0] * SIZE
    txs = [0.0] * SIZE
    for x in range(SIZE):
        f, t = divmod(x / step_x, 1.0)
        x0s[x] = int(f)
        x1s[x] = (x0s[x] + 1) % freq_x
        txs[x] = _smooth(t)
    out = [0.0] * (SIZE * SIZE)
    for y in range(SIZE):
        f, t = divmod(y / step_y, 1.0)
        y0 = int(f)
        y1 = (y0 + 1) % freq_y
        ty = _smooth(t)
        row0, row1 = lattice[y0], lattice[y1]
        base = y * SIZE
        for x in range(SIZE):
            tx = txs[x]
            x0 = x0s[x]
            x1 = x1s[x]
            v = (row0[x0] * (1 - tx) + row0[x1] * tx) * (1 - ty) + \
                (row1[x0] * (1 - tx) + row1[x1] * tx) * ty
            out[base + x] = v
    return out


def _fbm(freq=4, octaves=5, seed=0, persistence=0.5):
    """Multi-octave periodic value noise normalized to [0, 1]."""
    field = [0.0] * (SIZE * SIZE)
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        n = _noise_2d(freq << o, freq << o, seed + o * 101)
        for i, v in enumerate(n):
            field[i] += v * amp
        norm += amp
        amp *= persistence
    return [f / norm for f in field]


def _render(base, mods, blur=0.6):
    """Compose an RGB image: start at `base`, apply per-pixel luminance offsets.

    mods: iterable of (field, amplitude) where field is a flat [0, 1] list or
    an 'L' PIL image (speckle overlays). offset = (field - 0.5) * amplitude,
    scaled per channel by c/base_lum so hue stays put and dark channels
    don't clamp asymmetrically.
    """
    fields = []
    for field, amp in mods:
        if isinstance(field, Image.Image):
            field = [v / 255.0 for v in field.getdata()]
        fields.append((field, amp))
    br, bg, bb = base
    lum = (br + bg + bb) / 3.0
    img = Image.new('RGB', (SIZE, SIZE))
    px = img.load()
    for y in range(SIZE):
        row = y * SIZE
        for x in range(SIZE):
            i = row + x
            d = 0.0
            for field, amp in fields:
                d += (field[i] - 0.5) * amp
            px[x, y] = (
                max(0, min(255, int(br + d * br / lum))),
                max(0, min(255, int(bg + d * bg / lum))),
                max(0, min(255, int(bb + d * bb / lum))),
            )
    return img.filter(ImageFilter.GaussianBlur(blur))


def _speckle_overlay(seed, count, dark_values, light_values, max_r=3):
    """Sparse aggregate speckle as an 'L' image centered on mid-gray."""
    img = Image.new('L', (SIZE, SIZE), 128)
    d = ImageDraw.Draw(img)
    rnd = random.Random(seed)
    for _ in range(count):
        x, y = rnd.randrange(SIZE), rnd.randrange(SIZE)
        r = rnd.choice((1, 1, 1, 2, 2, max_r))
        v = rnd.choice(dark_values + light_values)
        d.ellipse([x - r, y - r, x + r, y + r], fill=v)
    return img


def gen_plaster_white():
    """Painted plaster: smooth tonal clouds from trowel passes + fine grain."""
    clouds = _fbm(freq=3, octaves=4, seed=11)
    fine = _noise_2d(64, 64, 111)
    return _render((240, 240, 240), [(clouds, 84), (fine, 36)], blur=0.5)


def gen_carpet():
    """Carpet: fiber pile noise + warp/weft weave + sparse dark flecks."""
    fiber = _noise_2d(96, 96, 55)
    warp = _noise_2d(48, 6, 56)
    weft = _noise_2d(6, 48, 57)
    pile = _fbm(freq=4, octaves=4, seed=58)
    flecks = _speckle_overlay(59, 220, (0,), (), max_r=1)
    return _render(
        (123, 139, 154),
        [(fiber, 52), (warp, 26), (weft, 26), (pile, 24), (flecks, 56)],
        blur=0.4,
    )


def gen_concrete():
    """Concrete: mottled cement + fine grain + aggregate speckle/pores."""
    mottle = _fbm(freq=3, octaves=4, seed=7)
    fine = _noise_2d(64, 64, 77)
    speckle = _speckle_overlay(8, 1600, (40, 70), (190, 210, 230))
    return _render((160, 160, 160), [(mottle, 72), (fine, 34), (speckle, 84)], blur=0.6)


def _wood(base, seeds, plank_amp, streak_amp, line_threshold, line_scale, knots, blur):
    """Shared wood generator: horizontal grain with wobble, plank drift, knots."""
    plank = _noise_1d(6, seeds[0])
    streak = _noise_2d(4, 64, seeds[1])
    wob = _noise_1d(8, seeds[2])
    grain = _noise_1d(24, seeds[3])
    fade = _fbm(freq=4, octaves=3, seed=seeds[4])
    br, bg, bb = base
    lum = (br + bg + bb) / 3.0
    img = Image.new('RGB', (SIZE, SIZE))
    px = img.load()
    for y in range(SIZE):
        p = (plank[y] - 0.5) * plank_amp
        row = y * SIZE
        for x in range(SIZE):
            i = row + x
            d = p + (streak[i] - 0.5) * streak_amp
            g = grain[(y + int((wob[x] - 0.5) * 12)) % SIZE]
            if g > line_threshold:
                d -= (g - line_threshold) * line_scale * fade[i]
            px[x, y] = (
                max(0, min(255, int(br + d * br / lum))),
                max(0, min(255, int(bg + d * bg / lum))),
                max(0, min(255, int(bb + d * bb / lum))),
            )
    draw = ImageDraw.Draw(img)
    for kx, ky, kr in knots:
        draw.ellipse([kx - kr, ky - kr, kx + kr, ky + kr],
                     fill=tuple(max(0, c - 38) for c in base))
        for ring in (1, 2):
            rr = kr + ring * 4
            draw.ellipse([kx - rr, ky - rr, kx + rr, ky + rr],
                         outline=tuple(max(0, c - 22) for c in base), width=2)
    return img.filter(ImageFilter.GaussianBlur(blur))


def gen_wood_oak():
    """Oak: warm brown, pronounced wobbly grain lines + knots."""
    rnd = random.Random(42)
    knots = [(rnd.randint(60, SIZE - 60), rnd.randint(60, SIZE - 60), rnd.randint(8, 14))
             for _ in range(3)]
    return _wood((139, 105, 20), (43, 44, 45, 46, 47),
                 plank_amp=22, streak_amp=14, line_threshold=0.60,
                 line_scale=240, knots=knots, blur=0.6)


def gen_wood_pine():
    """Pine: lighter, tighter, softer grain."""
    rnd = random.Random(99)
    knots = [(rnd.randint(60, SIZE - 60), rnd.randint(60, SIZE - 60), rnd.randint(6, 10))
             for _ in range(2)]
    return _wood((212, 165, 116), (100, 101, 102, 103, 104),
                 plank_amp=20, streak_amp=13, line_threshold=0.62,
                 line_scale=240, knots=knots, blur=0.5)


def gen_tile_floor():
    """Floor tile: cream tiles with per-tile tonal shade + gray grout grid."""
    tile, grout = 64, 3
    n_tiles = SIZE // tile
    rnd = random.Random(33)
    shades = {(tx, ty): rnd.randint(-9, 9) for tx in range(n_tiles) for ty in range(n_tiles)}
    noise = _noise_2d(48, 48, 34)
    img = Image.new('RGB', (SIZE, SIZE), (245, 240, 225))
    px = img.load()
    for y in range(SIZE):
        row = y * SIZE
        for x in range(SIZE):
            n = (noise[row + x] - 0.5) * 20 + shades[(x // tile, y // tile)]
            px[x, y] = tuple(max(0, min(255, c + int(n))) for c in px[x, y])
    draw = ImageDraw.Draw(img)
    for v in range(0, SIZE, tile):
        draw.line([(v, 0), (v, SIZE - 1)], fill=(180, 180, 180), width=grout)
        draw.line([(0, v), (SIZE - 1, v)], fill=(180, 180, 180), width=grout)
    return img


if __name__ == '__main__':
    textures = {
        'wood-oak': gen_wood_oak,
        'wood-pine': gen_wood_pine,
        'concrete': gen_concrete,
        'tile-floor': gen_tile_floor,
        'carpet': gen_carpet,
        'plaster-white': gen_plaster_white,
    }
    for name, gen_fn in textures.items():
        path = os.path.join(OUT_DIR, f'{name}.png')
        img = gen_fn()
        img.save(path, 'PNG')
        print(f'Generated {name}.png ({img.size[0]}x{img.size[1]})')
    print(f'Done: {len(textures)} textures in {OUT_DIR}')
