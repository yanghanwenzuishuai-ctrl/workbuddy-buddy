#!/usr/bin/env python3
"""Import a folder of pet packs into the buddy library.

Usage: python3 assets/import_pets.py <src-dir> [--default <id>]

<src-dir> contains one subfolder per pack (each with pet.json + spritesheet.png).
For each pack this validates dimensions/states, copies it into frontend/pets/<id>/,
generates a preview.png (idle frame, ~120x130), and rebuilds frontend/pets/index.json
(preserving the existing "default" unless --default is given).
"""
import json, os, sys, shutil
from PIL import Image

STATES = ["idle", "thinking", "working", "review", "waiting", "done", "failed"]
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEST = os.path.join(ROOT, "frontend", "pets")

def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    src = sys.argv[1]
    forced_default = None
    if "--default" in sys.argv:
        forced_default = sys.argv[sys.argv.index("--default") + 1]
    os.makedirs(DEST, exist_ok=True)

    imported = []
    for d in sorted(os.listdir(src)):
        p = os.path.join(src, d)
        if not os.path.isdir(p) or not os.path.exists(os.path.join(p, "pet.json")):
            continue
        m = json.load(open(os.path.join(p, "pet.json")))
        fr = m["frame"]; W, H, C = fr["width"], fr["height"], fr["columns"]
        sheet = Image.open(os.path.join(p, "spritesheet.png")).convert("RGBA")
        sw, sh = sheet.size
        missing = [s for s in STATES if s not in m.get("animations", {})]
        if missing or sw < C * W or sh < 7 * H:
            print(f"  SKIP {d}: missing={missing} size={sw}x{sh} (need >= {C*W}x{7*H})")
            continue
        dst = os.path.join(DEST, m["id"]); os.makedirs(dst, exist_ok=True)
        shutil.copy2(os.path.join(p, "pet.json"), os.path.join(dst, "pet.json"))
        shutil.copy2(os.path.join(p, "spritesheet.png"), os.path.join(dst, "spritesheet.png"))
        sheet.crop((0, 0, W, H)).resize((120, 130)).save(os.path.join(dst, "preview.png"))
        imported.append({"id": m["id"], "displayName": m.get("displayName", m["id"]),
                         "description": m.get("description", ""),
                         "author": m.get("author", ""), "license": m.get("license", "")})
        print(f"  OK   {m['id']}  '{m.get('displayName')}'")

    # merge into index.json (union by id, keep all existing packs on disk)
    idx_path = os.path.join(DEST, "index.json")
    existing = {}
    if os.path.exists(idx_path):
        old = json.load(open(idx_path))
        existing = {e["id"]: e for e in old.get("pets", [])}
        default = old.get("default")
    else:
        default = None
    for e in imported:
        existing[e["id"]] = e
    pets = sorted(existing.values(), key=lambda e: e["id"])
    default = forced_default or default or (pets[0]["id"] if pets else None)
    json.dump({"default": default, "pets": pets}, open(idx_path, "w"), ensure_ascii=False, indent=2)
    print(f"\n{len(imported)} imported; library now {len(pets)} buddies; default={default}")

if __name__ == "__main__":
    main()
