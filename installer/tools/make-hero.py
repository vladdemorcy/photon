"""Builds installer/assets/photon-hero.png: the logo's glowing mark with a crisp "Photon"
wordmark in the app's gradient, so the name reads clearly on the installer's welcome page."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops
import os
here = os.path.join(os.path.dirname(__file__), '..', 'assets')
src = Image.open(os.path.join(here, 'photon-logo.jpg')).convert('RGB')
W, H, top = 1100, 314, 52
base = src.crop((0, top, W, top + H))

bg = Image.new('RGB', (W, H), (4, 6, 18))
haze = Image.new('RGB', (W, H), (0, 0, 0))
hd = ImageDraw.Draw(haze)
hd.ellipse((520, -60, 1180, 380), fill=(20, 40, 120))
hd.ellipse((850, 40, 1250, 360), fill=(70, 30, 130))
bg = Image.blend(bg, haze.filter(ImageFilter.GaussianBlur(90)), 0.55)

# Keep the mark, fade to the dark backdrop before the logo's own (dim) lettering starts.
mask = Image.new('L', (W, H), 0)
md = ImageDraw.Draw(mask)
x0, x1 = 300, 395
for x in range(W):
    t = min(1, max(0, (x - x0) / (x1 - x0)))
    md.line([(x, 0), (x, H)], fill=int(255 * t * t * (3 - 2 * t)))
img = Image.composite(bg, base, mask)

font = ImageFont.truetype(os.path.join(here, 'fonts', 'sora-600.ttf'), 170)
text = 'Photon'
bbox = ImageDraw.Draw(img).textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
tx, ty = 395 - bbox[0], (H - th) // 2 - bbox[1] - 6
tmask = Image.new('L', (W, H), 0)
ImageDraw.Draw(tmask).text((tx, ty), text, font=font, fill=255)

# Same gradient as the app's wordmark: #2f6bff -> #38d9ff (55%) -> #a44dff
lerp = lambda a, b, t: tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
c1, c2, c3 = (0x2f, 0x6b, 0xff), (0x38, 0xd9, 0xff), (0xa4, 0x4d, 0xff)
grad = Image.new('RGB', (W, H))
gd = ImageDraw.Draw(grad)
left, right = tx + bbox[0], tx + bbox[0] + tw
for x in range(W):
    t = min(1, max(0, (x - left) / max(1, right - left)))
    gd.line([(x, 0), (x, H)], fill=lerp(c1, c2, t / .55) if t < .55 else lerp(c2, c3, (t - .55) / .45))

glow = Image.composite(grad, Image.new('RGB', (W, H)), tmask).filter(ImageFilter.GaussianBlur(22))
img = ImageChops.add(img, ImageChops.multiply(glow, Image.new('RGB', (W, H), (150, 150, 150))))
img = Image.composite(grad, img, tmask)
img.save(os.path.join(here, 'photon-hero.png'), optimize=True)
