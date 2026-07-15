#!/usr/bin/env python3
"""Generate a SELF-MADE placeholder spritesheet + pet.json for workbuddy-buddy.

Fully procedural (no third-party art) so the provenance is clean and the sheet
is reproducible. This is also the reference implementation of the pet format
documented in docs/PET_SPEC.md: a grid of WIDTH x HEIGHT cells, one animation
row per pet state, COLS frames per row, transparent PNG.
Output: frontend/pet/spritesheet.png + frontend/pet/pet.json
"""
import json, math, os
from PIL import Image, ImageDraw

W, H = 192, 208          # cell size
COLS = 8                 # frames per state
OUT = os.path.join(os.path.dirname(__file__), "..", "frontend", "pet")
os.makedirs(OUT, exist_ok=True)

# state -> (body, belly, face-style, fps)   (row order MUST match core::State)
STATES = [
    ("idle",     (126, 200, 227), (198, 230, 243), "calm",   6),
    ("thinking", (124, 140, 224), (200, 208, 244), "think", 10),
    ("working",  (245, 166,  35), (252, 214, 153), "focus", 12),
    ("review",   ( 72, 194, 180), (192, 235, 230), "scan",  10),
    ("waiting",  (181, 126, 220), (223, 200, 240), "look",   5),
    ("done",     (111, 207, 119), (198, 236, 202), "happy",  8),
    ("failed",   (235,  87,  87), (247, 190, 190), "sad",    4),
]
ROWS = len(STATES)
sheet = Image.new("RGBA", (W * COLS, H * ROWS), (0, 0, 0, 0))

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def draw_cell(body, belly, style, frame):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    bob = int(6 * math.sin(2 * math.pi * frame / COLS))
    cx, cy = W // 2, H // 2 + bob
    bw, bh = 120, 130
    dark = (40, 40, 55, 255); white = (255, 255, 255, 255)
    d.ellipse([cx - 55, cy + 58, cx + 55, cy + 74], fill=(0, 0, 0, 40))          # shadow
    d.ellipse([cx - bw//2, cy - bh//2, cx + bw//2, cy + bh//2],
              fill=body + (255,), outline=lerp(body, (0, 0, 0), 0.35) + (255,), width=4)
    d.ellipse([cx - 34, cy - 6, cx + 34, cy + 52], fill=belly + (255,))          # belly
    # feet (wiggle for active styles)
    fo = 6 if style in ("focus", "scan") and frame % 2 else 0
    d.ellipse([cx - 34, cy + 48 - fo, cx - 10, cy + 70 - fo], fill=lerp(body,(0,0,0),0.2)+(255,))
    d.ellipse([cx + 10, cy + 48 + fo, cx + 34, cy + 70 + fo], fill=lerp(body,(0,0,0),0.2)+(255,))

    eye_y = cy - 18; lx, rx = cx - 22, cx + 22
    blink = frame % COLS == 3 and style in ("calm", "look", "happy", "think")

    def eyes(dx=0, dy=0):
        for ex in (lx, rx):
            d.ellipse([ex-12, eye_y-12, ex+12, eye_y+12], fill=white)
            d.ellipse([ex-5+dx, eye_y-6+dy, ex+5+dx, eye_y+4+dy], fill=dark)

    if style == "sad":                                   # failed: X eyes + frown
        for ex in (lx, rx):
            d.line([ex-9, eye_y-9, ex+9, eye_y+9], fill=dark, width=4)
            d.line([ex-9, eye_y+9, ex+9, eye_y-9], fill=dark, width=4)
        d.arc([cx-22, cy+18, cx+22, cy+40], 200, 340, fill=dark, width=4)
    elif blink:
        for ex in (lx, rx):
            d.line([ex-10, eye_y, ex+10, eye_y], fill=dark, width=4)
        d.arc([cx-16, cy+6, cx+16, cy+26], 20, 160, fill=dark, width=4)
    elif style == "look":                                # waiting: look up + "?"
        eyes(0, -5)
        d.arc([cx-14, cy+10, cx+14, cy+28], 20, 160, fill=dark, width=4)
        d.ellipse([cx+30, cy-78, cx+66, cy-42], fill=(255,255,255,235))
        d.text((cx+44, cy-70), "?", fill=(120, 60, 170, 255))
    elif style == "scan":                                # review: eyes sweep L/R
        dx = 5 if frame % COLS < COLS//2 else -5
        eyes(dx, 0)
        d.arc([cx-14, cy+10, cx+14, cy+26], 20, 160, fill=dark, width=4)
    elif style == "think":                               # thinking: look up + "..."
        eyes(0, -4)
        d.line([cx-8, cy+20, cx+8, cy+20], fill=dark, width=4)
        n = (frame % 3) + 1
        for i in range(n):
            d.ellipse([cx+34+i*12, cy-52, cx+42+i*12, cy-44], fill=(90,100,190,255))
    elif style == "focus":                               # working: focused, motion lines
        eyes()
        d.line([cx-10, cy+22, cx+10, cy+22], fill=dark, width=4)
        if frame % 2:
            for yy in (cy-30, cy-10):
                d.line([cx-72, yy, cx-58, yy], fill=lerp(body,(0,0,0),0.15)+(255,), width=3)
    elif style == "happy":                               # done: big smile + sparkle
        eyes()
        d.arc([cx-20, cy+8, cx+20, cy+34], 10, 170, fill=dark, width=5)
        if frame % COLS in (1, 5):
            d.line([cx+40, cy-40, cx+40, cy-24], fill=(255,240,120,255), width=3)
            d.line([cx+32, cy-32, cx+48, cy-32], fill=(255,240,120,255), width=3)
    else:                                                # idle: calm smile
        eyes()
        d.arc([cx-14, cy+10, cx+14, cy+28], 20, 160, fill=dark, width=4)
    return img

meta = {}
for row, (name, body, belly, style, fps) in enumerate(STATES):
    for f in range(COLS):
        sheet.paste(draw_cell(body, belly, style, f), (f * W, row * H))
    meta[name] = {"row": row, "frames": list(range(COLS)), "fps": fps, "loop": True}

sheet.save(os.path.join(OUT, "spritesheet.png"))
pet = {
    "id": "workbuddy-buddy-default",
    "displayName": "workbuddy-buddy default pet",
    "description": "Self-made procedural reference pet for workbuddy-buddy.",
    "author": "workbuddy-buddy",
    "license": "MIT",
    "spritesheetPath": "spritesheet.png",
    "frame": {"width": W, "height": H, "columns": COLS, "rows": ROWS},
    "animations": meta,
}
with open(os.path.join(OUT, "pet.json"), "w") as f:
    json.dump(pet, f, indent=2)
print("wrote spritesheet.png", sheet.size, "| states:", list(meta))
