#!/usr/bin/env python3
"""Validate the 15-pet progressive-slacking asset release."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image


FRAME_WIDTH = 192
FRAME_HEIGHT = 208
COLUMNS = 8
BASE_ROWS = 7
FINAL_ROWS = 11
MIN_MARGIN = 24
MAX_CENTER_X_SPAN = 6
MAX_BASELINE_SPAN = 6
MAX_SIZE_SPAN = 10
FRAMES = list(range(COLUMNS))

ANIMATIONS = {
    "slacking": {"row": 7, "frames": FRAMES, "fps": 6, "loop": True},
    "slacking_salted": {"row": 8, "frames": FRAMES, "fps": 5, "loop": True},
    "slacking_costume": {"row": 9, "frames": FRAMES, "fps": 5, "loop": True},
    "slacking_shared_fish": {"row": 10, "frames": FRAMES, "fps": 4, "loop": True},
}

EXTENSION = {
    "version": 1,
    "clock": "workbuddyInactivity",
    "resetOnActivity": True,
    "replacesStates": ["idle", "done"],
    "sharedFinal": True,
    "stages": [
        {"id": "fresh_fish", "minIdleSeconds": 900, "animation": "slacking"},
        {
            "id": "salted_fish",
            "minIdleSeconds": 1500,
            "animation": "slacking_salted",
        },
        {
            "id": "fish_costume",
            "minIdleSeconds": 2100,
            "animation": "slacking_costume",
        },
        {
            "id": "shared_salted_fish",
            "minIdleSeconds": 3600,
            "animation": "slacking_shared_fish",
        },
    ],
}


def alpha_bounds(frame: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(frame[:, :, 3] > 0)
    if not len(xs):
        raise ValueError("empty frame")
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def cell(atlas: np.ndarray, row: int, column: int) -> np.ndarray:
    return atlas[
        row * FRAME_HEIGHT : (row + 1) * FRAME_HEIGHT,
        column * FRAME_WIDTH : (column + 1) * FRAME_WIDTH,
    ]


def pack_paths(root: Path) -> dict[str, Path]:
    return {path.parent.name: path for path in sorted(root.glob("*/pet.json"))}


def validate(final_root: Path, base_root: Path) -> tuple[list[str], dict]:
    errors: list[str] = []
    report: dict[str, dict] = {}
    final_packs = pack_paths(final_root)
    base_packs = pack_paths(base_root)
    if set(final_packs) != set(base_packs):
        errors.append(
            "pack set differs: "
            f"missing={sorted(set(base_packs) - set(final_packs))}, "
            f"extra={sorted(set(final_packs) - set(base_packs))}"
        )

    shared_digest: str | None = None
    shared_source: str | None = None
    for pet_id in sorted(set(final_packs) & set(base_packs)):
        manifest = json.loads(final_packs[pet_id].read_text())
        base_manifest = json.loads(base_packs[pet_id].read_text())
        if manifest.get("id") != pet_id:
            errors.append(f"{pet_id}: manifest id is {manifest.get('id')!r}")
        frame = manifest.get("frame", {})
        expected_frame = {
            "width": FRAME_WIDTH,
            "height": FRAME_HEIGHT,
            "columns": COLUMNS,
            "rows": FINAL_ROWS,
        }
        if frame != expected_frame:
            errors.append(f"{pet_id}: frame must be {expected_frame}, found {frame}")
        for name, expected in ANIMATIONS.items():
            actual = manifest.get("animations", {}).get(name)
            if actual != expected:
                errors.append(f"{pet_id}: animations.{name} differs: {actual}")
        actual_extension = (
            manifest.get("extensions", {}).get("workbuddy", {}).get("slacking")
        )
        if actual_extension != EXTENSION:
            errors.append(f"{pet_id}: extensions.workbuddy.slacking differs")

        final_sheet_path = final_packs[pet_id].parent / manifest.get(
            "spritesheetPath", "spritesheet.png"
        )
        base_sheet_path = base_packs[pet_id].parent / base_manifest.get(
            "spritesheetPath", "spritesheet.png"
        )
        final_image = Image.open(final_sheet_path).convert("RGBA")
        base_image = Image.open(base_sheet_path).convert("RGBA")
        if final_image.size != (FRAME_WIDTH * COLUMNS, FRAME_HEIGHT * FINAL_ROWS):
            errors.append(f"{pet_id}: final sheet size is {final_image.size}")
            continue
        final_atlas = np.asarray(final_image)
        base_atlas = np.asarray(base_image)
        base_height = FRAME_HEIGHT * BASE_ROWS
        if base_atlas.shape[0] < base_height or base_atlas.shape[1] != final_atlas.shape[1]:
            errors.append(f"{pet_id}: invalid comparison base size {base_image.size}")
            continue
        old_rows_identical = np.array_equal(
            final_atlas[:base_height], base_atlas[:base_height]
        )
        if not old_rows_identical:
            errors.append(f"{pet_id}: rows 0-6 changed")

        row_metrics: dict[str, dict] = {}
        for name, animation in ANIMATIONS.items():
            metrics = []
            for column in FRAMES:
                try:
                    left, top, right, bottom = alpha_bounds(
                        cell(final_atlas, animation["row"], column)
                    )
                except ValueError:
                    errors.append(f"{pet_id}: {name} frame {column} is empty")
                    continue
                margins = [
                    left,
                    top,
                    FRAME_WIDTH - 1 - right,
                    FRAME_HEIGHT - 1 - bottom,
                ]
                if min(margins) < MIN_MARGIN:
                    errors.append(
                        f"{pet_id}: {name} frame {column} margin {min(margins)} < {MIN_MARGIN}"
                    )
                metrics.append(
                    {
                        "frame": column,
                        "bounds": [left, top, right, bottom],
                        "margins": margins,
                        "centerX": (left + right) / 2,
                        "baseline": bottom,
                        "width": right - left + 1,
                        "height": bottom - top + 1,
                    }
                )
            if metrics:
                row_metrics[name] = {
                    "minimumMargin": min(min(item["margins"]) for item in metrics),
                    "centerXSpan": max(item["centerX"] for item in metrics)
                    - min(item["centerX"] for item in metrics),
                    "baselineSpan": max(item["baseline"] for item in metrics)
                    - min(item["baseline"] for item in metrics),
                    "widthSpan": max(item["width"] for item in metrics)
                    - min(item["width"] for item in metrics),
                    "heightSpan": max(item["height"] for item in metrics)
                    - min(item["height"] for item in metrics),
                    "frames": metrics,
                }

                summary = row_metrics[name]
                if summary["centerXSpan"] > MAX_CENTER_X_SPAN:
                    errors.append(
                        f"{pet_id}: {name} center-x span {summary['centerXSpan']}px "
                        f"> {MAX_CENTER_X_SPAN}px"
                    )
                if summary["baselineSpan"] > MAX_BASELINE_SPAN:
                    errors.append(
                        f"{pet_id}: {name} baseline span {summary['baselineSpan']}px "
                        f"> {MAX_BASELINE_SPAN}px"
                    )
                if (
                    summary["widthSpan"] > MAX_SIZE_SPAN
                    or summary["heightSpan"] > MAX_SIZE_SPAN
                ):
                    errors.append(
                        f"{pet_id}: {name} bbox size span exceeds {MAX_SIZE_SPAN}px"
                    )

        costume = row_metrics.get("slacking_costume")
        if costume and (
            costume["centerXSpan"] > 0
            or costume["widthSpan"] > 0
            or costume["heightSpan"] > 0
            or costume["baselineSpan"] > 2
        ):
            errors.append(f"{pet_id}: costume master drifts across frames")

        shared_row = final_atlas[
            10 * FRAME_HEIGHT : 11 * FRAME_HEIGHT,
            : FRAME_WIDTH * COLUMNS,
        ]
        digest = hashlib.sha256(shared_row.tobytes()).hexdigest()
        if shared_digest is None:
            shared_digest = digest
            shared_source = pet_id
        elif digest != shared_digest:
            errors.append(
                f"{pet_id}: shared fish row differs from {shared_source}"
            )
        report[pet_id] = {
            "oldRowsPixelIdentical": old_rows_identical,
            "sharedFishSha256": digest,
            "rows": row_metrics,
        }

    report["summary"] = {
        "packCount": len(final_packs),
        "checkedPackCount": len(report),
        "newFrameCount": len(final_packs) * len(ANIMATIONS) * COLUMNS,
        "sharedFishSha256": shared_digest,
        "minimumRequiredMargin": MIN_MARGIN,
        "maximumAllowedCenterXSpan": MAX_CENTER_X_SPAN,
        "maximumAllowedBaselineSpan": MAX_BASELINE_SPAN,
        "maximumAllowedSizeSpan": MAX_SIZE_SPAN,
        "errorCount": len(errors),
    }
    return errors, report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path, nargs="?", default=Path("pet-packs"))
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument(
        "--report", type=Path, default=Path("reports/slacking-validation-report.json")
    )
    args = parser.parse_args()
    errors, report = validate(args.root, args.base)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    if errors:
        for error in errors:
            print(f"ERROR {error}")
        raise SystemExit(f"validation failed with {len(errors)} error(s)")
    summary = report["summary"]
    print(
        f"validated {summary['packCount']} packs / {summary['newFrameCount']} new frames; "
        f"minimum margin {summary['minimumRequiredMargin']}px; rows 0-6 unchanged"
    )
    print(f"wrote {args.report}")


if __name__ == "__main__":
    main()
