#!/usr/bin/env python3
"""Generate a SELF-MADE placeholder spritesheet + pet.json for workbuddy-buddy.

Fully procedural (no third-party art) so the provenance is clean and the sheet
is reproducible. Layout follows the Codex pet.json convention: a grid of
WIDTH x HEIGHT cells, one animation row per pet state, COLS frames per row.
Output: frontend/pet/spritesheet.png + frontend/pet/pet.json
"""
import json, math, os
from PIL import Image, ImageDraw

W, H = 192, 208          # cell size (Codex convention)
COLS = 8                 # frames per state
OUT = os.path.join(os.path.dirname(__file__), "..", "frontend", "pet")
os.makedirs(OUT, exist_ok=True)

# state -> (row, body color, belly color, face style)
STATES = [
    ("idle",    (126, 200, 227), (198, 230, 243), "calm"),
    ("working", (245, 166,  35), (252, 214, 153), "focus"),
    ("waiting", (181, 126, 220), (223, 200, 240), "look"),
    ("done",    (111, 207, 119), (198, 236, 202), "happy"),
    ("failed",  (235,  87,  87), (247, 190, 190), "sad"),
]
ROWS = len(STATES)

sheet = Image.new("RGBA", (W * COLS, H * ROWS), (0, 0, 0, 0))

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def draw_cell(body, belly, style, frame):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    bob = int(6 * math.sin(2 * math.pi * frame / COLS))          # vertical bob
    cx, cy = W // 2, H // 2 + bob
    bw, bh = 120, 130                                            # body size
    # shadow
    d.ellipse([cx - 55, cy + 58, cx + 55, cy + 74], fill=(0, 0, 0, 40))
    # body
    d.ellipse([cx - bw//2, cy - bh//2, cx + bw//2, cy + bh//2],
              fill=body + (255,), outline=lerp(body, (0, 0, 0), 0.35) + (255,), width=4)
    # belly
    d.ellipse([cx - 34, cy - 6, cx + 34, cy + 52], fill=belly + (255,))
    # feet (little wiggle on working)
    fo = 6 if style == "focus" and frame % 2 else 0
    d.ellipse([cx - 34, cy + 48 - fo, cx - 10, cy + 70 - fo], fill=lerp(body,(0,0,0),0.2)+(255,))
    d.ellipse([cx + 10, cy + 48 + fo, cx + 34, cy + 70 + fo], fill=lerp(body,(0,0,0),0.2)+(255,))

    blink = frame % COLS in (3,) and style in ("calm", "look", "happy")
    eye_y = cy - 18
    lx, rx = cx - 22, cx + 22
    white = (255, 255, 255, 255)
    dark = (40, 40, 55, 255)
    if style == "sad":  # X eyes
        for ex in (lx, rx):
            d.line([ex-9, eye_y-9, ex+9, eye_y+9], fill=dark, width=4)
            d.line([ex-9, eye_y+9, ex+9, eye_y-9], fill=dark, width=4)
        d.arc([cx-22, cy+18, cx+22, cy+40], 200, 340, fill=dark, width=4)  # frown
    elif blink:
        for ex in (lx, rx):
            d.line([ex-10, eye_y, ex+10, eye_y], fill=dark, width=4)
        d.arc([cx-16, cy+6, cx+16, cy+26], 20, 160, fill=dark, width=4)
    else:
        look = 5 if style == "look" else 0        # waiting: glance up
        for ex in (lx, rx):
            d.ellipse([ex-12, eye_y-12, ex+12, eye_y+12], fill=white)
            d.ellipse([ex-5, eye_y-6-look, ex+5, eye_y+4-look], fill=dark)
        if style == "happy":
            d.arc([cx-20, cy+8, cx+20, cy+34], 10, 170, fill=dark, width=5)  # big smile
        elif style == "focus":
            d.line([cx-10, cy+22, cx+10, cy+22], fill=dark, width=4)         # focused
        else:
            d.arc([cx-14, cy+10, cx+14, cy+28], 20, 160, fill=dark, width=4) # small smile
    # accessories
    if style == "look":     # "?" bubble for waiting
        d.ellipse([cx+30, cy-78, cx+66, cy-42], fill=(255,255,255,235))
        d.text((cx+44, cy-70), "?", fill=(120, 60, 170, 255))
    if style == "happy" and frame % COLS in (1, 5):  # sparkle
        d.line([cx+40, cy-40, cx+40, cy-24], fill=(255,240,120,255), width=3)
        d.line([cx+32, cy-32, cx+48, cy-32], fill=(255,240,120,255), width=3)
    return img

meta_anims = {}
for row, (name, body, belly, style) in enumerate(STATES):
    fps = {"idle":6,"working":12,"waiting":5,"done":8,"failed":4}[name]
    for f in range(COLS):
        sheet.paste(draw_cell(body, belly, style, f), (f * W, row * H))
    meta_anims[name] = {"row": row, "frames": list(range(COLS)), "fps": fps, "loop": True}

sheet.save(os.path.join(OUT, "spritesheet.png"))
pet = {
    "id": "wb-buddy-placeholder",
    "displayName": "WorkBuddy Buddy (placeholder)",
    "description": "Self-made procedural placeholder pet for workbuddy-buddy v0.",
    "spritesheetPath": "spritesheet.png",
    "frame": {"width": W, "height": H, "columns": COLS, "rows": ROWS},
    "animations": meta_anims,
}
with open(os.path.join(OUT, "pet.json"), "w") as f:
    json.dump(pet, f, indent=2)
print("wrote spritesheet.png", sheet.size, "and pet.json with states:", list(meta_anims))
