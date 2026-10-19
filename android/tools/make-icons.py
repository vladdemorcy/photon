#!/usr/bin/env python3
"""Makes the Android launcher and notification icons from the Mac app icon.

Run from the repo root:  python3 android/tools/make-icons.py
Needs Pillow. The results are committed, so this only needs running if the logo changes.
"""
import math
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RES = os.path.join(ROOT, 'android', 'res')
ICNS = os.path.join(ROOT, 'installer', 'mac', 'support', 'photon.icns')

# The app needs Android 8 or later, so launchers always use the adaptive icon. One set of
# large images is enough; Android scales them down for smaller screens.
DENSITIES = {'xxxhdpi': 4}


def save(img, folder, name):
    d = os.path.join(RES, folder)
    os.makedirs(d, exist_ok=True)
    img.save(os.path.join(d, name), optimize=True)


def artwork():
    im = Image.open(ICNS)
    im.size = (1024, 1024)
    im.load()
    im = im.convert('RGBA')
    # The Mac icon has a margin around the rounded square. Keep just the square.
    box = im.getchannel('A').point(lambda a: 255 if a > 200 else 0).getbbox()
    return im.crop(box)


def launcher(art):
    # Adaptive icon (res/mipmap-anydpi-v26/ic_launcher.xml). The layer is 108dp and launchers
    # show the middle 72dp or so, so the artwork fills about 84dp and the dark background
    # covers its rounded corners.
    for dens, k in DENSITIES.items():
        layer = round(108 * k)
        inner = round(84 * k)
        fg = Image.new('RGBA', (layer, layer), (0, 0, 0, 0))
        off = (layer - inner) // 2
        fg.alpha_composite(art.resize((inner, inner), Image.LANCZOS), (off, off))
        save(fg, f'mipmap-{dens}', 'ic_launcher_fg.png')


def notification():
    # Status bar icons must be plain white on transparent. A small version of the logo:
    # an orbit with three lights and a glow in the middle.
    S = 384
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = S / 2
    rx, ry, tilt = S * 0.40, S * 0.30, math.radians(-25)

    def pt(t):
        x, y = rx * math.cos(t), ry * math.sin(t)
        return (c + x * math.cos(tilt) - y * math.sin(tilt), c + x * math.sin(tilt) + y * math.cos(tilt))

    pts = [pt(i / 180 * math.pi) for i in range(361)]
    d.line(pts, fill=(255, 255, 255, 255), width=round(S * 0.055), joint='curve')
    for t in (math.radians(200), math.radians(320), math.radians(85)):
        x, y = pt(t)
        r = S * 0.075
        d.ellipse((x - r, y - r, x + r, y + r), fill=(255, 255, 255, 255))
    r = S * 0.12
    d.ellipse((c - r, c - r, c + r, c + r), fill=(255, 255, 255, 255))
    for dens, k in DENSITIES.items():
        px = round(24 * k)
        save(img.resize((px, px), Image.LANCZOS), f'drawable-{dens}', 'ic_stat_photon.png')


def logo(art):
    # The picture at the top of the app's main screen.
    save(art.resize((288, 288), Image.LANCZOS), 'drawable-nodpi', 'photon_logo.png')


if __name__ == '__main__':
    art = artwork()
    launcher(art)
    notification()
    logo(art)
    print('Icons written to', RES)
