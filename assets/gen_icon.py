#!/usr/bin/env python3
"""Generate the app icon set from a pet's idle frame (default: sora-shiba).

Produces src-tauri/icons/{32x32,64x64,128x128,128x128@2x,256x256,icon}.png,
icon.ico, and a macOS icon.icns — a warm rounded-square plate with the pet
centered, so it reads as a real Mac app icon.

Usage: python3 assets/gen_icon.py [pet-id]
"""
import os, sys, math, subprocess, tempfile
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PET = sys.argv[1] if len(sys.argv) > 1 else "sora-shiba"
ICONS = os.path.join(ROOT, "src-tauri", "icons")
os.makedirs(ICONS, exist_ok=True)

def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m

def vgrad(size, top, bot):
    g = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / (size - 1)
        g.putpixel((0, y), tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    return g.resize((size, size))

def build_master(S=1024):
    # crop the pet's idle frame (cell 0,0), trim transparent margin
    m = __import__("json").load(open(os.path.join(ROOT, "frontend", "pets", PET, "pet.json")))
    W, H = m["frame"]["width"], m["frame"]["height"]
    sheet = Image.open(os.path.join(ROOT, "frontend", "pets", PET, "spritesheet.png")).convert("RGBA")
    idle = sheet.crop((0, 0, W, H))
    idle = idle.crop(idle.getbbox())

    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # rounded-square warm plate
    plate = vgrad(S, (255, 250, 243), (255, 227, 198)).convert("RGBA")
    icon.paste(plate, (0, 0), rounded_mask(S, int(S * 0.225)))

    # pet: fit into ~66% box, centered a touch high
    box = int(S * 0.66)
    scale = min(box / idle.width, box / idle.height)
    pw, ph = round(idle.width * scale), round(idle.height * scale)
    pet_img = idle.resize((pw, ph), Image.LANCZOS)
    px, py = (S - pw) // 2, int(S * 0.46) - ph // 2 + int(S * 0.02)

    # soft drop shadow
    sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sh.paste(Image.new("RGBA", (pw, ph), (40, 30, 20, 90)), (px, py + int(S * 0.02)), pet_img)
    sh = sh.filter(ImageFilter.GaussianBlur(int(S * 0.02)))
    icon = Image.alpha_composite(icon, sh)
    icon.alpha_composite(pet_img, (px, py))
    # re-clip to the rounded plate so nothing bleeds past the corners
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(icon, (0, 0), rounded_mask(S, int(S * 0.225)))
    return out

master = build_master(1024)
master.save(os.path.join(ICONS, "master-1024.png"))

# Tauri PNG set
sizes = {"32x32.png": 32, "64x64.png": 64, "128x128.png": 128, "128x128@2x.png": 256,
         "256x256.png": 256, "icon.png": 512}
for name, s in sizes.items():
    master.resize((s, s), Image.LANCZOS).save(os.path.join(ICONS, name))
# Windows .ico (multi-size)
master.resize((256, 256), Image.LANCZOS).save(os.path.join(ICONS, "icon.ico"),
    sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

# macOS .icns via iconutil
with tempfile.TemporaryDirectory() as td:
    iconset = os.path.join(td, "icon.iconset"); os.makedirs(iconset)
    for base in [16, 32, 128, 256, 512]:
        master.resize((base, base), Image.LANCZOS).save(os.path.join(iconset, f"icon_{base}x{base}.png"))
        master.resize((base * 2, base * 2), Image.LANCZOS).save(os.path.join(iconset, f"icon_{base}x{base}@2x.png"))
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(ICONS, "icon.icns")], check=True)

print("icon set written to", ICONS, "from pet:", PET)
print("files:", sorted(os.listdir(ICONS)))
