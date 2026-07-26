#!/usr/bin/env python3
"""Build four deterministic slacking rows for every WorkBuddy pet pack.

The first two stages composite a shared animated fish prop over one canonical
pet frame.  The third stage animates one identity-preserving costume master per
pet.  The final row is a byte-identical shared salted-fish animation.  Existing
rows are copied without resampling.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path
from statistics import median

import numpy as np
from PIL import Image

from repack_sprites import connected_runs, resize_premultiplied


FRAME_WIDTH = 192
FRAME_HEIGHT = 208
COLUMNS = 8
BASE_ROWS = 7
FINAL_ROWS = 11
ALPHA_THRESHOLD = 16
NEW_ROW_MIN_MARGIN = 24
BOB_Y = (0, 0, -1, -1, 0, 0, 1, 0)
SAFE_BASELINE = FRAME_HEIGHT - 1 - NEW_ROW_MIN_MARGIN - max(BOB_Y)

NEW_ANIMATIONS = {
    "slacking": {"row": 7, "frames": list(range(8)), "fps": 6, "loop": True},
    "slacking_salted": {"row": 8, "frames": list(range(8)), "fps": 5, "loop": True},
    "slacking_costume": {"row": 9, "frames": list(range(8)), "fps": 5, "loop": True},
    "slacking_shared_fish": {"row": 10, "frames": list(range(8)), "fps": 4, "loop": True},
}

SLACKING_EXTENSION = {
    "version": 1,
    "clock": "workbuddyInactivity",
    "resetOnActivity": True,
    "replacesStates": ["idle", "done"],
    "sharedFinal": True,
    "stages": [
        {"id": "fresh_fish", "minIdleSeconds": 900, "animation": "slacking"},
        {"id": "salted_fish", "minIdleSeconds": 1500, "animation": "slacking_salted"},
        {"id": "fish_costume", "minIdleSeconds": 2100, "animation": "slacking_costume"},
        {
            "id": "shared_salted_fish",
            "minIdleSeconds": 3600,
            "animation": "slacking_shared_fish",
        },
    ],
}


@dataclass(frozen=True)
class Bounds:
    left: int
    top: int
    right: int
    bottom: int

    @property
    def width(self) -> int:
        return self.right - self.left + 1

    @property
    def height(self) -> int:
        return self.bottom - self.top + 1

    @property
    def center_x(self) -> float:
        return (self.left + self.right) / 2


@dataclass(frozen=True)
class Component:
    bounds: Bounds
    area: int


@dataclass(frozen=True)
class CanonicalPet:
    frame: np.ndarray
    anchor_x: float
    baseline: int
    width: float
    height: float
    source_column: int


def alpha_bounds(image: np.ndarray) -> Bounds:
    ys, xs = np.nonzero(image[:, :, 3] > 0)
    if not len(xs):
        raise ValueError("image contains no visible pixels")
    return Bounds(int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))


def largest_component(image: np.ndarray) -> Component:
    mask = image[:, :, 3] >= ALPHA_THRESHOLD
    runs, union_find = connected_runs(mask)
    if not runs:
        raise ValueError("image contains no component above the alpha threshold")
    stats: dict[int, list[int]] = {}
    for run in runs:
        root = union_find.find(run.label)
        values = stats.setdefault(root, [0, image.shape[1], image.shape[0], -1, -1])
        length = run.end - run.start + 1
        values[0] += length
        values[1] = min(values[1], run.start)
        values[2] = min(values[2], run.y)
        values[3] = max(values[3], run.end)
        values[4] = max(values[4], run.y)
    area, left, top, right, bottom = max(stats.values(), key=lambda value: value[0])
    return Component(Bounds(left, top, right, bottom), area)


def crop_cell(atlas: np.ndarray, row: int, column: int) -> np.ndarray:
    return atlas[
        row * FRAME_HEIGHT : (row + 1) * FRAME_HEIGHT,
        column * FRAME_WIDTH : (column + 1) * FRAME_WIDTH,
    ].copy()


def canonical_pet(atlas: np.ndarray) -> CanonicalPet:
    cells = [crop_cell(atlas, 0, column) for column in range(COLUMNS)]
    subjects = [largest_component(cell).bounds for cell in cells]
    target_x = median(subject.center_x for subject in subjects)
    target_bottom = round(median(subject.bottom for subject in subjects))
    target_width = median(subject.width for subject in subjects)
    target_height = median(subject.height for subject in subjects)

    def score(index: int) -> float:
        subject = subjects[index]
        return (
            abs(subject.center_x - target_x) / 2
            + abs(subject.bottom - target_bottom)
            + abs(subject.width - target_width) / 4
            + abs(subject.height - target_height) / 4
        )

    source_column = min(range(COLUMNS), key=score)
    frame = translate(
        cells[source_column],
        round(target_x - subjects[source_column].center_x),
        target_bottom - subjects[source_column].bottom,
    )
    return CanonicalPet(frame, target_x, target_bottom, target_width, target_height, source_column)


def safe_slacking_canonical(canonical: CanonicalPet) -> CanonicalPet:
    """Normalize one locked identity master into the stricter new-row safe area."""
    baseline = min(canonical.baseline, SAFE_BASELINE)
    frame = normalize_layer(
        canonical.frame,
        target_anchor_x=canonical.anchor_x,
        target_bottom=baseline,
        target_height=canonical.height,
    )
    subject = largest_component(frame).bounds
    return CanonicalPet(
        frame=frame,
        anchor_x=canonical.anchor_x,
        baseline=baseline,
        width=subject.width,
        height=subject.height,
        source_column=canonical.source_column,
    )


def translate(image: np.ndarray, dx: int, dy: int) -> np.ndarray:
    height, width = image.shape[:2]
    output = np.zeros_like(image)
    source_left = max(0, -dx)
    source_top = max(0, -dy)
    source_right = min(width, width - dx)
    source_bottom = min(height, height - dy)
    if source_left >= source_right or source_top >= source_bottom:
        raise ValueError(f"translation ({dx}, {dy}) moves the image out of bounds")
    output[
        source_top + dy : source_bottom + dy,
        source_left + dx : source_right + dx,
    ] = image[source_top:source_bottom, source_left:source_right]
    return output


def trim(image: np.ndarray, padding: int = 4) -> np.ndarray:
    bounds = alpha_bounds(image)
    left = max(0, bounds.left - padding)
    top = max(0, bounds.top - padding)
    right = min(image.shape[1], bounds.right + padding + 1)
    bottom = min(image.shape[0], bounds.bottom + padding + 1)
    return image[top:bottom, left:right].copy()


def place(image: np.ndarray, width: int, height: int, left: int, top: int) -> np.ndarray:
    output = np.zeros((height, width, 4), dtype=np.uint8)
    image_height, image_width = image.shape[:2]
    source_left = max(0, -left)
    source_top = max(0, -top)
    source_right = min(image_width, width - left)
    source_bottom = min(image_height, height - top)
    if source_left >= source_right or source_top >= source_bottom:
        raise ValueError("layer is entirely outside its target cell")
    output[
        source_top + top : source_bottom + top,
        source_left + left : source_right + left,
    ] = image[source_top:source_bottom, source_left:source_right]
    return output


def resize_rgba(image: np.ndarray, scale: float) -> np.ndarray:
    width = max(1, round(image.shape[1] * scale))
    height = max(1, round(image.shape[0] * scale))
    resized = resize_premultiplied(Image.fromarray(image, "RGBA"), (width, height))
    return np.asarray(resized)


def normalize_layer(
    image: np.ndarray,
    *,
    target_anchor_x: float,
    target_bottom: int,
    target_width: float | None = None,
    target_height: float | None = None,
    minimum_margin: int = NEW_ROW_MIN_MARGIN,
) -> np.ndarray:
    source = trim(image)
    subject = largest_component(source).bounds
    if target_width is not None:
        scale = target_width / subject.width
    elif target_height is not None:
        scale = target_height / subject.height
    else:
        raise ValueError("target_width or target_height is required")

    for _ in range(16):
        resized = resize_rgba(source, scale)
        resized_subject = largest_component(resized).bounds
        left = round(target_anchor_x - resized_subject.center_x)
        top = target_bottom - resized_subject.bottom
        output = place(resized, FRAME_WIDTH, FRAME_HEIGHT, left, top)
        margins = frame_margins(output)
        if min(margins) >= minimum_margin:
            return output
        scale *= 0.95
    raise ValueError(f"cannot retain {minimum_margin}px margins after normalization")


def alpha_composite(bottom: np.ndarray, top: np.ndarray) -> np.ndarray:
    result = Image.fromarray(bottom, "RGBA")
    result.alpha_composite(Image.fromarray(top, "RGBA"))
    return np.asarray(result)


def frame_margins(image: np.ndarray) -> tuple[int, int, int, int]:
    bounds = alpha_bounds(image)
    return (
        bounds.left,
        bounds.top,
        image.shape[1] - 1 - bounds.right,
        image.shape[0] - 1 - bounds.bottom,
    )


def split_equal_grid(image: np.ndarray, columns: int, rows: int) -> list[np.ndarray]:
    cells: list[np.ndarray] = []
    for row in range(rows):
        top = round(row * image.shape[0] / rows)
        bottom = round((row + 1) * image.shape[0] / rows)
        for column in range(columns):
            left = round(column * image.shape[1] / columns)
            right = round((column + 1) * image.shape[1] / columns)
            cell = image[top:bottom, left:right].copy()
            if not np.any(cell[:, :, 3] > 0):
                raise ValueError(f"source grid cell ({row}, {column}) is empty")
            cells.append(cell)
    return cells


def normalize_fish_row(source_path: Path, target_width: int, target_bottom: int = 165) -> Image.Image:
    source = np.asarray(Image.open(source_path).convert("RGBA"))
    cells = split_equal_grid(source, 4, 2)
    output = Image.new("RGBA", (FRAME_WIDTH * COLUMNS, FRAME_HEIGHT))
    for column, cell in enumerate(cells):
        normalized = normalize_layer(
            cell,
            target_anchor_x=FRAME_WIDTH / 2,
            target_bottom=target_bottom,
            target_width=target_width,
        )
        output.alpha_composite(Image.fromarray(normalized, "RGBA"), (column * FRAME_WIDTH, 0))
    return output


def save_reference(canonical: CanonicalPet, destination: Path) -> None:
    scale = 4
    source = Image.fromarray(canonical.frame, "RGBA").resize(
        (FRAME_WIDTH * scale, FRAME_HEIGHT * scale), Image.Resampling.NEAREST
    )
    background = Image.new("RGBA", source.size, "#FF00FF")
    background.alpha_composite(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    background.convert("RGB").save(destination)


def prepare_refs(packs: Path, output: Path) -> None:
    metadata: dict[str, dict[str, float | int]] = {}
    for manifest_path in sorted(packs.glob("*/pet.json")):
        manifest = json.loads(manifest_path.read_text())
        atlas = np.asarray(Image.open(manifest_path.parent / manifest["spritesheetPath"]).convert("RGBA"))
        canonical = canonical_pet(atlas)
        save_reference(canonical, output / f"{manifest['id']}.png")
        metadata[manifest["id"]] = {
            "sourceColumn": canonical.source_column,
            "anchorX": canonical.anchor_x,
            "baseline": canonical.baseline,
            "width": canonical.width,
            "height": canonical.height,
        }
    (output / "canonical.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"prepared {len(metadata)} identity references in {output}")


def row_cells(row: Image.Image) -> list[np.ndarray]:
    atlas = np.asarray(row.convert("RGBA"))
    return [atlas[:, column * FRAME_WIDTH : (column + 1) * FRAME_WIDTH].copy() for column in range(COLUMNS)]


def scale_prop(cell: np.ndarray, target_width: float, center_x: float, bottom: int) -> np.ndarray:
    return normalize_layer(
        cell,
        target_anchor_x=center_x,
        target_bottom=bottom,
        target_width=target_width,
        minimum_margin=0,
    )


def composite_prop_row(canonical: CanonicalPet, prop_row: Image.Image, salted: bool) -> Image.Image:
    output = Image.new("RGBA", (FRAME_WIDTH * COLUMNS, FRAME_HEIGHT))
    desired_width = min(84.0, max(58.0, canonical.width * (0.72 if salted else 0.68)))
    prop_bottom = canonical.baseline - max(8, round(canonical.height * 0.08))
    for column, prop in enumerate(row_cells(prop_row)):
        pet = translate(canonical.frame, 0, BOB_Y[column])
        fish = scale_prop(
            prop,
            desired_width,
            canonical.anchor_x,
            prop_bottom + BOB_Y[column],
        )
        frame = alpha_composite(pet, fish)
        output.alpha_composite(Image.fromarray(frame, "RGBA"), (column * FRAME_WIDTH, 0))
    return output


def costume_row(canonical: CanonicalPet, costume_path: Path) -> Image.Image:
    source = np.asarray(Image.open(costume_path).convert("RGBA"))
    master = normalize_layer(
        source,
        target_anchor_x=canonical.anchor_x,
        target_bottom=canonical.baseline,
        target_height=canonical.height,
    )
    output = Image.new("RGBA", (FRAME_WIDTH * COLUMNS, FRAME_HEIGHT))
    for column, dy in enumerate(BOB_Y):
        frame = translate(master, 0, dy)
        output.alpha_composite(Image.fromarray(frame, "RGBA"), (column * FRAME_WIDTH, 0))
    return output


def updated_manifest(manifest: dict) -> dict:
    result = json.loads(json.dumps(manifest))
    result["frame"]["rows"] = FINAL_ROWS
    result["animations"].update(NEW_ANIMATIONS)
    result.setdefault("extensions", {}).setdefault("workbuddy", {})["slacking"] = SLACKING_EXTENSION
    return result


def build(
    packs: Path,
    output: Path,
    costumes: Path,
    fresh_source: Path,
    salted_source: Path,
) -> None:
    fresh_row = normalize_fish_row(fresh_source, target_width=100)
    salted_prop_row = normalize_fish_row(salted_source, target_width=100)
    shared_fish_row = normalize_fish_row(salted_source, target_width=122)
    output.mkdir(parents=True, exist_ok=True)
    shared_bytes = np.asarray(shared_fish_row).tobytes()
    report: dict[str, dict] = {}

    for manifest_path in sorted(packs.glob("*/pet.json")):
        manifest = json.loads(manifest_path.read_text())
        pet_id = manifest["id"]
        base_image = Image.open(manifest_path.parent / manifest["spritesheetPath"]).convert("RGBA")
        expected = (FRAME_WIDTH * COLUMNS, FRAME_HEIGHT * BASE_ROWS)
        if base_image.width != expected[0] or base_image.height < expected[1]:
            raise ValueError(f"{pet_id}: expected at least {expected}, found {base_image.size}")
        base_image = base_image.crop((0, 0, expected[0], expected[1]))
        source_canonical = canonical_pet(np.asarray(base_image))
        canonical = safe_slacking_canonical(source_canonical)
        costume_path = costumes / f"{pet_id}-alpha.png"
        if not costume_path.exists():
            raise ValueError(f"{pet_id}: missing costume master {costume_path}")

        rows = [
            composite_prop_row(canonical, fresh_row, salted=False),
            composite_prop_row(canonical, salted_prop_row, salted=True),
            costume_row(canonical, costume_path),
            shared_fish_row,
        ]
        atlas_pixels = np.zeros(
            (FRAME_HEIGHT * FINAL_ROWS, FRAME_WIDTH * COLUMNS, 4), dtype=np.uint8
        )
        atlas_pixels[: FRAME_HEIGHT * BASE_ROWS] = np.asarray(base_image)
        for index, row in enumerate(rows, start=BASE_ROWS):
            atlas_pixels[
                index * FRAME_HEIGHT : (index + 1) * FRAME_HEIGHT
            ] = np.asarray(row)
        atlas = Image.fromarray(atlas_pixels, "RGBA")

        pack_output = output / pet_id
        pack_output.mkdir(parents=True, exist_ok=True)
        atlas.save(pack_output / "spritesheet.png", optimize=True)
        (pack_output / "pet.json").write_text(
            json.dumps(updated_manifest(manifest), ensure_ascii=False, indent=2) + "\n"
        )

        new_margins = []
        for row in range(BASE_ROWS, FINAL_ROWS):
            for column in range(COLUMNS):
                new_margins.append(frame_margins(crop_cell(atlas_pixels, row, column)))
        report[pet_id] = {
            "canonicalSourceColumn": canonical.source_column,
            "sourceCanonicalAnchor": [source_canonical.anchor_x, source_canonical.baseline],
            "sourceCanonicalSize": [source_canonical.width, source_canonical.height],
            "canonicalAnchor": [canonical.anchor_x, canonical.baseline],
            "canonicalSize": [canonical.width, canonical.height],
            "minimumNewRowMargin": min(min(values) for values in new_margins),
            "sharedFishSha256InputBytes": __import__("hashlib").sha256(shared_bytes).hexdigest(),
        }

    (output / "slacking-build-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"built {len(report)} packs in {output}")


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    refs = subparsers.add_parser("prepare-refs")
    refs.add_argument("--packs", type=Path, default=Path("pet-packs"))
    refs.add_argument("--output", type=Path, default=Path("tmp/imagegen/slacking/refs"))

    builder = subparsers.add_parser("build")
    builder.add_argument("--packs", type=Path, default=Path("pet-packs"))
    builder.add_argument("--output", type=Path, default=Path("tmp/slacking-built-packs"))
    builder.add_argument("--costumes", type=Path, default=Path("tmp/imagegen/slacking/costumes"))
    builder.add_argument(
        "--fresh-source", type=Path, default=Path("tmp/imagegen/slacking/fresh-fish-alpha.png")
    )
    builder.add_argument(
        "--salted-source", type=Path, default=Path("tmp/imagegen/slacking/shared-fish-alpha.png")
    )

    args = parser.parse_args()
    if args.command == "prepare-refs":
        prepare_refs(args.packs, args.output)
    else:
        build(args.packs, args.output, args.costumes, args.fresh_source, args.salted_source)


if __name__ == "__main__":
    main()
