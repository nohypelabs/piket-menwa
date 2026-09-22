#!/usr/bin/env python3
"""Generate semua ikon brand dari 1 file logo master.

E2E brand flow:
  1. Taruh logo asli Menwa di  public/brand/logo-menwa.png  (PNG, transparan OK,
     makin besar makin baik, misal 1024x1024).
  2. Jalankan:  python3 scripts/gen-icons.py
     (tanpa argumen = pakai master di atas; atau sebut path lain sebagai argumen)
  3. Rebuild PWA. Selesai — welcome, home-screen/TWA, splash, favicon ikut baru.

Output:
  public/icons/icon-192.png, icon-512.png      (launcher standar)
  public/icons/maskable-512.png                (adaptive, safe-zone 80% + bg)
  public/apple-touch-icon.png                  (iOS, 180px + bg)
  public/favicon.png                           (tab browser, 64px)
"""
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / 'public'
BG = (15, 20, 19, 255)  # samakan theme_color #0f1413


def load_master() -> Image.Image:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else PUB / 'brand' / 'logo-menwa.png'
    img = Image.open(src).convert('RGBA')
    print('master:', src, img.size)
    return img


def fit(img: Image.Image, size: int, bg: tuple | None = None, ratio: float = 1.0) -> Image.Image:
    """Perkecil logo ke ratio×size, tempel tengah kanvas size×size."""
    side = int(size * ratio)
    img = img.copy()
    img.thumbnail((side, side), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), bg or (0, 0, 0, 0))
    canvas.alpha_composite(img, ((size - img.width) // 2, (size - img.height) // 2))
    return canvas.convert('RGB') if bg else canvas


def main() -> None:
    master = load_master()
    (PUB / 'icons').mkdir(exist_ok=True)
    (PUB / 'brand').mkdir(exist_ok=True)
    out = {
        PUB / 'icons' / 'icon-192.png': fit(master, 192),
        PUB / 'icons' / 'icon-512.png': fit(master, 512),
        PUB / 'icons' / 'maskable-512.png': fit(master, 512, BG, 0.8),
        PUB / 'apple-touch-icon.png': fit(master, 180, BG),
        PUB / 'favicon.png': fit(master, 64),
    }
    for dest, img in out.items():
        img.save(dest)
        print('tulis:', dest.relative_to(ROOT), img.size)


if __name__ == '__main__':
    main()
