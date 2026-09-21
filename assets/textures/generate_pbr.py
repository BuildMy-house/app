#!/usr/bin/env python3
"""Derive PBR maps (normal / roughness / AO) from existing diffuse textures.

MAT-T2: bump-from-diffuse generation (path b of the ticket) — no external
assets, no licensing questions. The height proxy is the diffuse's luminance;
normal maps come from central-difference gradients (Sobel-equivalent), the
roughness map keeps the catalog's scalar as the base with per-pixel grain
variation, and AO darkens grain grooves.

Add an entry to PBR_SPECS to derive maps for another texture, then reference
the generated files in WALL_TEXTURES (src/core/home.ts).
"""
from PIL import Image, ImageFilter, ImageOps
import math
import os

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# id -> (normal strength, roughness base spread, ao_lo). Every catalog entry
# that lists PBR files in WALL_TEXTURES should have a matching spec here.
PBR_SPECS = {
    'carpet':        {'normal_strength': 10.0, 'rough_lo': 0.85, 'rough_hi': 1.0, 'ao_lo': 0.30},
    'concrete':      {'normal_strength': 12.0, 'rough_lo': 0.80, 'rough_hi': 1.0, 'ao_lo': 0.25},
    'plaster-white': {'normal_strength':  8.0, 'rough_lo': 0.80, 'rough_hi': 1.0, 'ao_lo': 0.15},
    'tile-floor':    {'normal_strength':  6.0, 'rough_lo': 0.20, 'rough_hi': 0.50, 'ao_lo': 0.10},
    'wood-oak':      {'normal_strength': 14.0, 'rough_lo': 0.70, 'rough_hi': 1.0, 'ao_lo': 0.25},
    'wood-pine':     {'normal_strength': 12.0, 'rough_lo': 0.60, 'rough_hi': 0.85, 'ao_lo': 0.20},
}


def height_field(diffuse: Image.Image) -> Image.Image:
    """Height proxy from diffuse luminance: fine grain (small blur) blended
    50/50 with broad sheet undulation (40px blur). The broad octave is what
    makes the relief perceptible at room-scale camera distances — grain-only
    height produces hairline normal detail that vanishes on screen."""
    lum = diffuse.convert('L')
    fine = ImageOps.autocontrast(lum.filter(ImageFilter.GaussianBlur(1)))
    broad = ImageOps.autocontrast(lum.filter(ImageFilter.GaussianBlur(40)))
    return Image.blend(fine, broad, 0.5)


def gen_normal(height: Image.Image, strength: float) -> Image.Image:
    """OpenGL-style tangent-space normal map (flat areas = RGB 128,128,255)."""
    w, h = height.size
    px = height.load()
    out = Image.new('RGB', (w, h), (128, 128, 255))
    opx = out.load()
    for y in range(h):
        for x in range(w):
            dh_du = (px[(x + 1) % w, y] - px[(x - 1) % w, y]) / 255.0
            # v axis points up, image rows down → dv flips row direction
            dh_dv = (px[x, (y - 1) % h] - px[x, (y + 1) % h]) / 255.0
            nx, ny = -dh_du * strength, -dh_dv * strength
            inv = 1.0 / math.sqrt(nx * nx + ny * ny + 1.0)
            opx[x, y] = (
                int((nx * inv * 0.5 + 0.5) * 255),
                int((ny * inv * 0.5 + 0.5) * 255),
                int((inv * 0.5 + 0.5) * 255),
            )
    return out


def gen_roughness(height: Image.Image, lo: float, hi: float) -> Image.Image:
    """Grayscale roughness in [lo, hi]: grain grooves (dark lum) rougher.

    Values stay near 1.0 because three.js multiplies roughnessMap by the
    material's scalar roughness — the catalog scalar carries the base.
    """
    w, h = height.size
    px = height.load()
    out = Image.new('L', (w, h))
    opx = out.load()
    for y in range(h):
        for x in range(w):
            lum = px[x, y] / 255.0
            rough = lo + (hi - lo) * (1.0 - lum)
            opx[x, y] = int(max(0.0, min(1.0, rough)) * 255)
    return out.filter(ImageFilter.GaussianBlur(0.5))


def gen_ao(height: Image.Image, ao_lo: float) -> Image.Image:
    """Grayscale AO: grain grooves occluded, flat wood ~1.0."""
    w, h = height.size
    smooth = height.filter(ImageFilter.GaussianBlur(2))
    px = smooth.load()
    out = Image.new('L', (w, h))
    opx = out.load()
    for y in range(h):
        for x in range(w):
            lum = px[x, y] / 255.0
            ao = ao_lo + (1.0 - ao_lo) * lum
            opx[x, y] = int(max(0.0, min(1.0, ao)) * 255)
    return out


if __name__ == '__main__':
    for name, spec in PBR_SPECS.items():
        diffuse = Image.open(os.path.join(OUT_DIR, f'{name}.png'))
        height = height_field(diffuse)
        normal = gen_normal(height, spec['normal_strength'])
        roughness = gen_roughness(height, spec['rough_lo'], spec['rough_hi'])
        ao = gen_ao(height, spec['ao_lo'])
        for suffix, img in (('normal', normal), ('roughness', roughness), ('ao', ao)):
            path = os.path.join(OUT_DIR, f'{name}_{suffix}.png')
            img.save(path, 'PNG')
            print(f'Generated {name}_{suffix}.png ({img.size[0]}x{img.size[1]})')
    print('Done.')
