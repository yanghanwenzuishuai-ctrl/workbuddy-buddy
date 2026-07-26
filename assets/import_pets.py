#!/usr/bin/env python3
"""Import a folder of pet packs into the buddy library.

Usage: python3 assets/import_pets.py <src-dir> [--default <id>]

<src-dir> contains one subfolder per pack (each with pet.json + spritesheet.png).
For each pack this validates dimensions/states, copies it into frontend/pets/<id>/,
generates a preview.png (idle frame, ~120x130), and rebuilds frontend/pets/index.json
(preserving the existing "default" unless --default is given).

Legacy seven-state packs remain valid. Packs that declare
extensions.workbuddy.slacking must provide the four standard eight-frame
slacking animations in rows 7-10.
"""

import hashlib
import json
import os
import shutil
import sys

from PIL import Image


STATES = ["idle", "thinking", "working", "review", "waiting", "done", "failed"]
SLACKING_STAGES = [
    {"id": "fresh_fish", "minIdleSeconds": 900, "animation": "slacking"},
    {"id": "salted_fish", "minIdleSeconds": 1500, "animation": "slacking_salted"},
    {"id": "fish_costume", "minIdleSeconds": 2100, "animation": "slacking_costume"},
    {
        "id": "shared_salted_fish",
        "minIdleSeconds": 3600,
        "animation": "slacking_shared_fish",
    },
]
SLACKING_ROWS = {
    "slacking": 7,
    "slacking_salted": 8,
    "slacking_costume": 9,
    "slacking_shared_fish": 10,
}
SLACKING_FRAMES = list(range(8))

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEST = os.path.join(ROOT, "frontend", "pets")


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _is_positive_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


def _declared_rows(frame, animations):
    """Return the physical row count, preserving legacy manifests without rows."""
    if "rows" in frame:
        return frame["rows"]
    animation_rows = [
        animation.get("row")
        for animation in animations.values()
        if isinstance(animation, dict) and _is_int(animation.get("row"))
    ]
    return max([len(STATES), *(row + 1 for row in animation_rows)])


def validate_pack(manifest, sheet_size):
    """Return (errors, rows, has_slacking) for one decoded manifest and sheet."""
    errors = []
    frame = manifest.get("frame")
    animations = manifest.get("animations")
    if not isinstance(frame, dict):
        return ["frame must be an object"], None, False
    if not isinstance(animations, dict):
        return ["animations must be an object"], None, False

    dimensions = {}
    for key in ("width", "height", "columns"):
        value = frame.get(key)
        if not _is_int(value) or value <= 0:
            errors.append(f"frame.{key} must be a positive integer")
        else:
            dimensions[key] = value

    rows = _declared_rows(frame, animations)
    if not _is_int(rows) or rows <= 0:
        errors.append("frame.rows must be a positive integer when present")
        rows = None

    missing = [state for state in STATES if state not in animations]
    if missing:
        errors.append(f"missing required animations: {missing}")

    if rows is not None and "columns" in dimensions:
        columns = dimensions["columns"]
        for state in STATES:
            animation = animations.get(state)
            if animation is None:
                continue
            if not isinstance(animation, dict):
                errors.append(f"animations.{state} must be an object")
                continue
            row = animation.get("row")
            frames = animation.get("frames")
            if not _is_int(row) or not 0 <= row < rows:
                errors.append(f"animations.{state}.row must be within 0..{rows - 1}")
            if (
                not isinstance(frames, list)
                or not frames
                or any(not _is_int(index) or not 0 <= index < columns for index in frames)
            ):
                errors.append(
                    f"animations.{state}.frames must contain indices within 0..{columns - 1}"
                )

    if rows is not None and len(dimensions) == 3:
        width = dimensions["width"] * dimensions["columns"]
        height = dimensions["height"] * rows
        sheet_width, sheet_height = sheet_size
        if sheet_width < width or sheet_height < height:
            errors.append(
                f"spritesheet is {sheet_width}x{sheet_height}; need at least {width}x{height} "
                f"for frame.rows={rows}"
            )

    extensions = manifest.get("extensions", {})
    if not isinstance(extensions, dict):
        errors.append("extensions must be an object when present")
        return errors, rows, False

    workbuddy = extensions.get("workbuddy")
    if workbuddy is None:
        return errors, rows, False
    if not isinstance(workbuddy, dict):
        errors.append("extensions.workbuddy must be an object")
        return errors, rows, False

    has_slacking = "slacking" in workbuddy
    if not has_slacking:
        return errors, rows, False

    slacking = workbuddy["slacking"]
    if not isinstance(slacking, dict):
        errors.append("extensions.workbuddy.slacking must be an object")
        return errors, rows, True

    if slacking.get("version") != 1:
        errors.append("extensions.workbuddy.slacking.version must be 1")
    if slacking.get("clock") != "workbuddyInactivity":
        errors.append(
            "extensions.workbuddy.slacking.clock must be workbuddyInactivity"
        )
    if slacking.get("resetOnActivity") is not True:
        errors.append("extensions.workbuddy.slacking.resetOnActivity must be true")
    if slacking.get("replacesStates") != ["idle", "done"]:
        errors.append(
            "extensions.workbuddy.slacking.replacesStates must be ['idle', 'done']"
        )
    if slacking.get("stages") != SLACKING_STAGES:
        errors.append(
            "extensions.workbuddy.slacking.stages must exactly define the "
            "900/1500/2100/3600 second stages"
        )
    if slacking.get("sharedFinal") is not True:
        errors.append("extensions.workbuddy.slacking.sharedFinal must be true")
    if frame.get("rows") is None:
        errors.append(
            "frame.rows is required when extensions.workbuddy.slacking is declared"
        )
    if rows is not None and rows < 11:
        errors.append("frame.rows must be at least 11 for slacking rows 7-10")
    if dimensions.get("columns") != 8:
        errors.append(
            "frame.columns must be 8 when extensions.workbuddy.slacking is declared"
        )

    for name, expected_row in SLACKING_ROWS.items():
        animation = animations.get(name)
        if not isinstance(animation, dict):
            errors.append(f"animations.{name} is required and must be an object")
            continue
        if animation.get("row") != expected_row:
            errors.append(f"animations.{name}.row must be {expected_row}")
        frames = animation.get("frames")
        if (
            frames != SLACKING_FRAMES
            or any(not _is_int(index) for index in frames)
        ):
            errors.append(f"animations.{name}.frames must be exactly {SLACKING_FRAMES}")
        if not _is_positive_number(animation.get("fps")):
            errors.append(f"animations.{name}.fps must be a positive number")
        if animation.get("loop") is not True:
            errors.append(f"animations.{name}.loop must be true")

    return errors, rows, True


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    src = sys.argv[1]
    forced_default = None
    if "--default" in sys.argv:
        forced_default = sys.argv[sys.argv.index("--default") + 1]
    os.makedirs(DEST, exist_ok=True)

    imported = []
    shared_final_digest = None
    shared_final_source = None
    for d in sorted(os.listdir(src)):
        p = os.path.join(src, d)
        manifest_path = os.path.join(p, "pet.json")
        sheet_path = os.path.join(p, "spritesheet.png")
        if not os.path.isdir(p) or not os.path.exists(manifest_path):
            continue
        try:
            with open(manifest_path, encoding="utf-8") as manifest_file:
                manifest = json.load(manifest_file)
            with Image.open(sheet_path) as source_sheet:
                sheet = source_sheet.convert("RGBA")
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(f"  SKIP {d}: {exc}")
            continue

        errors, rows, has_slacking = validate_pack(manifest, sheet.size)
        if has_slacking and not errors:
            frame = manifest["frame"]
            row_top = SLACKING_ROWS["slacking_shared_fish"] * frame["height"]
            final_row = sheet.crop(
                (0, row_top, frame["columns"] * frame["width"], row_top + frame["height"])
            )
            digest = hashlib.sha256(final_row.tobytes()).hexdigest()
            if shared_final_digest is None:
                shared_final_digest = digest
                shared_final_source = d
            elif digest != shared_final_digest:
                errors.append(
                    "slacking_shared_fish pixels differ from the shared row in "
                    f"{shared_final_source}"
                )

        if errors:
            print(f"  SKIP {d}: " + "; ".join(errors))
            continue

        dst = os.path.join(DEST, manifest["id"])
        os.makedirs(dst, exist_ok=True)
        shutil.copy2(manifest_path, os.path.join(dst, "pet.json"))
        shutil.copy2(sheet_path, os.path.join(dst, "spritesheet.png"))
        width, height = manifest["frame"]["width"], manifest["frame"]["height"]
        sheet.crop((0, 0, width, height)).resize((120, 130)).save(
            os.path.join(dst, "preview.png")
        )
        imported.append(
            {
                "id": manifest["id"],
                "displayName": manifest.get("displayName", manifest["id"]),
                "description": manifest.get("description", ""),
                "author": manifest.get("author", ""),
                "license": manifest.get("license", ""),
            }
        )
        mode = " + slacking" if has_slacking else ""
        print(f"  OK   {manifest['id']}  '{manifest.get('displayName')}' rows={rows}{mode}")

    # merge into index.json (union by id, keep all existing packs on disk)
    idx_path = os.path.join(DEST, "index.json")
    existing = {}
    if os.path.exists(idx_path):
        with open(idx_path, encoding="utf-8") as index_file:
            old = json.load(index_file)
        existing = {entry["id"]: entry for entry in old.get("pets", [])}
        default = old.get("default")
    else:
        default = None
    for entry in imported:
        existing[entry["id"]] = entry
    pets = sorted(existing.values(), key=lambda entry: entry["id"])
    default = forced_default or default or (pets[0]["id"] if pets else None)
    with open(idx_path, "w", encoding="utf-8") as index_file:
        json.dump(
            {"default": default, "pets": pets},
            index_file,
            ensure_ascii=False,
            indent=2,
        )
    print(f"\n{len(imported)} imported; library now {len(pets)} buddies; default={default}")


if __name__ == "__main__":
    main()
