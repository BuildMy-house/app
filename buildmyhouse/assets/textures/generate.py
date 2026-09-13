#!/usr/bin/env python3
"""Generate default tileable textures for the rendering pipeline."""
from PIL import Image, ImageDraw, ImageFilter
import random
import os

SIZE = 512
OUT_DIR = os.path.dirname(os.path.abspath(__file__))

def gen_wood_oak():
    """Oak wood grain: warm brown with horizontal grain lines."""
    img = Image.new('RGB', (SIZE, SIZE), (139, 105, 20))
    draw = ImageDraw.Draw(img)
    random.seed(42)
    for y in range(SIZE):
        offset = int(random.gauss(0, 3))
        shade = random.randint(-15, 15)
        r = max(0, min(255, 139 + shade))
        g = max(0, min(255, 105 + shade))
        b = max(0, min(255, 20 + shade))
        draw.line([(0, y), (SIZE-1, y)], fill=(r, g, b))
    # Add knot
    for _ in range(3):
        kx, ky = random.randint(50, SIZE-50), random.randint(50, SIZE-50)
        kr = random.randint(8, 15)
        draw.ellipse([kx-kr, ky-kr, kx+kr, ky+kr], fill=(101, 67, 33))
    img = img.filter(ImageFilter.GaussianBlur(1))
    return img

def gen_wood_pine():
    """Pine wood: lighter, tighter grain."""
    img = Image.new('RGB', (SIZE, SIZE), (212, 165, 116))
    draw = ImageDraw.Draw(img)
    random.seed(99)
    for y in range(SIZE):
        offset = int(random.gauss(0, 2))
        shade = random.randint(-10, 10)
        r = max(0, min(255, 212 + shade))
        g = max(0, min(255, 165 + shade))
        b = max(0, min(255, 116 + shade))
        draw.line([(0, y), (SIZE-1, y)], fill=(r, g, b))
    for _ in range(2):
        kx, ky = random.randint(50, SIZE-50), random.randint(50, SIZE-50)
        kr = random.randint(5, 10)
        draw.ellipse([kx-kr, ky-kr, kx+kr, ky+kr], fill=(193, 154, 107))
    img = img.filter(ImageFilter.GaussianBlur(0.5))
    return img

def gen_concrete():
    """Concrete: gray with subtle noise."""
    img = Image.new('RGB', (SIZE, SIZE), (160, 160, 160))
    draw = ImageDraw.Draw(img)
    random.seed(7)
    for x in range(SIZE):
        for y in range(SIZE):
            if random.random() < 0.3:
                shade = random.randint(-20, 20)
                c = max(0, min(255, 160 + shade))
                img.putpixel((x, y), (c, c, c))
    img = img.filter(ImageFilter.GaussianBlur(2))
    return img

def gen_tile_floor():
    """Floor tile: cream with gray grout grid."""
    img = Image.new('RGB', (SIZE, SIZE), (245, 240, 225))
    draw = ImageDraw.Draw(img)
    tile_size = 64
    grout = 3
    for x in range(0, SIZE, tile_size):
        draw.line([(x, 0), (x, SIZE-1)], fill=(180, 180, 180), width=grout)
    for y in range(0, SIZE, tile_size):
        draw.line([(0, y), (SIZE-1, y)], fill=(180, 180, 180), width=grout)
    # Add subtle noise to tiles
    random.seed(33)
    for x in range(SIZE):
        for y in range(SIZE):
            px = img.getpixel((x, y))
            if px != (180, 180, 180):
                shade = random.randint(-5, 5)
                img.putpixel((x, y), tuple(max(0, min(255, c+shade)) for c in px))
    return img

def gen_carpet():
    """Carpet: solid muted blue-gray with fiber noise."""
    img = Image.new('RGB', (SIZE, SIZE), (123, 139, 154))
    random.seed(55)
    for x in range(SIZE):
        for y in range(SIZE):
            shade = random.randint(-8, 8)
            r = max(0, min(255, 123 + shade))
            g = max(0, min(255, 139 + shade))
            b = max(0, min(255, 154 + shade))
            img.putpixel((x, y), (r, g, b))
    img = img.filter(ImageFilter.GaussianBlur(0.5))
    return img

def gen_plaster_white():
    """White plaster: near-white with subtle texture."""
    img = Image.new('RGB', (SIZE, SIZE), (240, 240, 240))
    random.seed(11)
    for x in range(SIZE):
        for y in range(SIZE):
            if random.random() < 0.1:
                shade = random.randint(-5, 5)
                c = max(0, min(255, 240 + shade))
                img.putpixel((x, y), (c, c, c))
    img = img.filter(ImageFilter.GaussianBlur(1))
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