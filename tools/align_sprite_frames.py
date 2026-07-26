#!/usr/bin/env python3
"""Stabilize character anchors across frames in WorkBuddy pet atlases.

The largest connected alpha component in each cell is treated as the pet.  For
each animation row, every complete cell (pet plus detached status effects) is
translated by an integer number of pixels so the pet's bounding-box bottom
center matches the row median.  Pixel values are copied without resampling.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path
from statistics import median
from typing import Any

import numpy as np
from PIL import Image

from repack_sprites import connected_runs, resize_premultiplied


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
class FrameMetrics:
    subject: Bounds
    artwork: Bounds
    subject_area: int


def bounds_for_mask(mask: np.ndarray) -> Bounds:
    ys, xs = np.nonzero(mask)
    if not len(xs):
        raise ValueError("frame contains no visible pixels")
    return Bounds(int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))


def largest_component(mask: np.ndarray) -> tuple[Bounds, int]:
    runs, union_find = connected_runs(mask)
    if not runs:
        raise ValueError("frame contains no subject pixels above the alpha threshold")

    stats: dict[int, list[int]] = {}
    for run in runs:
        root = union_find.find(run.label)
        values = stats.setdefault(root, [0, mask.shape[1], mask.shape[0], -1, -1])
        length = run.end - run.start + 1
        values[0] += length
        values[1] = min(values[1], run.start)
        values[2] = min(values[2], run.y)
        values[3] = max(values[3], run.end)
        values[4] = max(values[4], run.y)

    area, left, top, right, bottom = max(stats.values(), key=lambda value: value[0])
    return Bounds(left, top, right, bottom), area


def measure_frame(frame: np.ndarray, alpha_threshold: int) -> FrameMetrics:
    alpha = frame[:, :, 3]
    subject, subject_area = largest_component(alpha >= alpha_threshold)
    artwork = bounds_for_mask(alpha > 0)
    return FrameMetrics(subject=subject, artwork=artwork, subject_area=subject_area)


def translate_frame(frame: np.ndarray, dx: int, dy: int) -> np.ndarray:
    height, width = frame.shape[:2]
    output = np.zeros_like(frame)

    source_left = max(0, -dx)
    source_top = max(0, -dy)
    source_right = min(width, width - dx)
    source_bottom = min(height, height - dy)
    if source_left >= source_right or source_top >= source_bottom:
        raise ValueError(f"translation ({dx}, {dy}) moves the entire frame out of bounds")

    target_left = source_left + dx
    target_top = source_top + dy
    target_right = source_right + dx
    target_bottom = source_bottom + dy
    output[target_top:target_bottom, target_left:target_right] = frame[
        source_top:source_bottom, source_left:source_right
    ]
    return output


def place_on_canvas(image: np.ndarray, width: int, height: int, left: int, top: int) -> np.ndarray:
    output = np.zeros((height, width, 4), dtype=np.uint8)
    image_height, image_width = image.shape[:2]
    source_left = max(0, -left)
    source_top = max(0, -top)
    source_right = min(image_width, width - left)
    source_bottom = min(image_height, height - top)
    if source_left >= source_right or source_top >= source_bottom:
        raise ValueError("scaled frame falls entirely outside its cell")
    output[
        source_top + top : source_bottom + top,
        source_left + left : source_right + left,
    ] = image[source_top:source_bottom, source_left:source_right]
    return output


def scale_about_anchor(frame: np.ndarray, scale: float, anchor_x: float, anchor_y: float) -> np.ndarray:
    if math.isclose(scale, 1.0):
        return frame
    height, width = frame.shape[:2]
    resized_width = round(width * scale)
    resized_height = round(height * scale)
    resized = np.asarray(
        resize_premultiplied(Image.fromarray(frame, "RGBA"), (resized_width, resized_height))
    )
    left = round(anchor_x - anchor_x * scale)
    top = round(anchor_y - anchor_y * scale)
    return place_on_canvas(resized, width, height, left, top)


def frame_margins(bounds: Bounds, width: int, height: int) -> dict[str, int]:
    return {
        "left": bounds.left,
        "top": bounds.top,
        "right": width - 1 - bounds.right,
        "bottom": height - 1 - bounds.bottom,
    }


def rounded_delta(target: float, current: float) -> int:
    delta = target - current
    return int(np.floor(delta + 0.5)) if delta >= 0 else int(np.ceil(delta - 0.5))


def row_report(
    atlas: np.ndarray,
    row: int,
    state: str,
    frame_width: int,
    frame_height: int,
    columns: int,
    alpha_threshold: int,
) -> tuple[list[np.ndarray], dict[str, Any]]:
    frames: list[np.ndarray] = []
    before: list[FrameMetrics] = []
    for column in range(columns):
        frame = atlas[
            row * frame_height : (row + 1) * frame_height,
            column * frame_width : (column + 1) * frame_width,
        ].copy()
        frames.append(frame)
        before.append(measure_frame(frame, alpha_threshold))

    target_center_x = median(metrics.subject.center_x for metrics in before)
    target_bottom = median(metrics.subject.bottom for metrics in before)
    median_width = median(metrics.subject.width for metrics in before)
    median_height = median(metrics.subject.height for metrics in before)

    aligned: list[np.ndarray] = []
    details: list[dict[str, Any]] = []
    for column, (frame, metrics) in enumerate(zip(frames, before)):
        width_delta = metrics.subject.width - median_width
        height_delta = metrics.subject.height - median_height
        is_scale_outlier = (
            width_delta <= -10
            and height_delta <= -10
            and (width_delta <= -18 or height_delta <= -18)
        )
        scale = 1.0
        if is_scale_outlier:
            scale = min(
                1.35,
                math.sqrt(
                    (median_width * median_height)
                    / (metrics.subject.width * metrics.subject.height)
                ),
            )
        normalized = scale_about_anchor(
            frame,
            scale,
            metrics.subject.center_x,
            metrics.subject.bottom,
        )
        normalized_metrics = measure_frame(normalized, alpha_threshold)
        dx = rounded_delta(target_center_x, normalized_metrics.subject.center_x)
        dy = rounded_delta(target_bottom, normalized_metrics.subject.bottom)
        moved = translate_frame(normalized, dx, dy)
        after = measure_frame(moved, alpha_threshold)
        aligned.append(moved)
        details.append(
            {
                "frame": column,
                "shift": {"x": dx, "y": dy},
                "scale": round(scale, 6),
                "before": {
                    "subject": asdict(metrics.subject),
                    "artwork": asdict(metrics.artwork),
                    "subjectArea": metrics.subject_area,
                },
                "after": {
                    "subject": asdict(after.subject),
                    "artwork": asdict(after.artwork),
                    "subjectArea": after.subject_area,
                    "margins": frame_margins(after.artwork, frame_width, frame_height),
                },
                "sizeDeltaFromMedian": {
                    "width": width_delta,
                    "height": height_delta,
                },
            }
        )

    return aligned, {
        "state": state,
        "row": row,
        "targetAnchor": {"centerX": target_center_x, "bottom": target_bottom},
        "medianSubjectSize": {"width": median_width, "height": median_height},
        "frames": details,
    }


def align_pack(
    pack_dir: Path,
    alpha_threshold: int,
    minimum_margin: int,
) -> tuple[Image.Image, dict[str, Any]]:
    manifest_path = pack_dir / "pet.json"
    manifest = json.loads(manifest_path.read_text())
    frame = manifest["frame"]
    frame_width = int(frame["width"])
    frame_height = int(frame["height"])
    columns = int(frame["columns"])
    rows = int(frame.get("rows", 0))
    animations = manifest["animations"]
    if not rows:
        rows = max(int(animation["row"]) for animation in animations.values()) + 1

    row_names: dict[int, str] = {}
    for state, animation in animations.items():
        row = int(animation["row"])
        if row in row_names:
            raise ValueError(f"{pack_dir.name}: multiple states point to row {row}")
        row_names[row] = state
    missing_rows = sorted(set(range(rows)) - set(row_names))
    if missing_rows:
        raise ValueError(f"{pack_dir.name}: rows without animation states: {missing_rows}")

    sheet_path = pack_dir / manifest["spritesheetPath"]
    sheet = Image.open(sheet_path).convert("RGBA")
    expected_size = (frame_width * columns, frame_height * rows)
    if sheet.size != expected_size:
        raise ValueError(f"{pack_dir.name}: expected atlas {expected_size}, found {sheet.size}")
    atlas = np.asarray(sheet)
    output = np.zeros_like(atlas)
    states: list[dict[str, Any]] = []

    for row in range(rows):
        aligned, report = row_report(
            atlas,
            row,
            row_names[row],
            frame_width,
            frame_height,
            columns,
            alpha_threshold,
        )
        for column, cell in enumerate(aligned):
            output[
                row * frame_height : (row + 1) * frame_height,
                column * frame_width : (column + 1) * frame_width,
            ] = cell
        states.append(report)

    all_frames = [frame_data for state in states for frame_data in state["frames"]]
    smallest_margin = min(
        margin
        for frame_data in all_frames
        for margin in frame_data["after"]["margins"].values()
    )
    if smallest_margin < minimum_margin:
        raise ValueError(
            f"{pack_dir.name}: alignment leaves only {smallest_margin}px margin; "
            f"minimum is {minimum_margin}px"
        )

    shifted_frames = sum(
        frame_data["shift"] != {"x": 0, "y": 0} for frame_data in all_frames
    )
    significant_frames = sum(
        abs(frame_data["shift"]["x"]) >= 12 or abs(frame_data["shift"]["y"]) >= 10
        for frame_data in all_frames
    )
    scaled_frames = sum(not math.isclose(frame_data["scale"], 1.0) for frame_data in all_frames)
    report = {
        "id": manifest["id"],
        "atlas": {
            "width": expected_size[0],
            "height": expected_size[1],
            "frameWidth": frame_width,
            "frameHeight": frame_height,
            "columns": columns,
            "rows": rows,
        },
        "shiftedFrames": shifted_frames,
        "significantFrames": significant_frames,
        "scaledFrames": scaled_frames,
        "minimumMarginAfter": smallest_margin,
        "states": states,
    }
    return Image.fromarray(output, "RGBA"), report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path, help="directory containing one pet-pack directory per pet")
    parser.add_argument("--apply", action="store_true", help="overwrite spritesheets after every pack validates")
    parser.add_argument("--report", type=Path, help="optional JSON audit report path")
    parser.add_argument("--alpha-threshold", type=int, default=16)
    parser.add_argument("--minimum-margin", type=int, default=16)
    args = parser.parse_args()

    pack_dirs = sorted(path.parent for path in args.root.glob("*/pet.json"))
    if not pack_dirs:
        parser.error(f"no pet packs found below {args.root}")

    pending: list[tuple[Path, Image.Image]] = []
    reports: list[dict[str, Any]] = []
    for pack_dir in pack_dirs:
        image, report = align_pack(pack_dir, args.alpha_threshold, args.minimum_margin)
        manifest = json.loads((pack_dir / "pet.json").read_text())
        pending.append((pack_dir / manifest["spritesheetPath"], image))
        reports.append(report)

    if args.apply:
        temporary_files: list[tuple[Path, Path]] = []
        try:
            for destination, image in pending:
                temporary = destination.with_name(f".{destination.name}.motion-aligned.tmp")
                image.save(temporary, format="PNG", optimize=True)
                temporary_files.append((temporary, destination))
            for temporary, destination in temporary_files:
                temporary.replace(destination)
        finally:
            for temporary, _ in temporary_files:
                temporary.unlink(missing_ok=True)

    summary = {
        "mode": "applied" if args.apply else "dry-run",
        "method": (
            "high-confidence undersized-frame normalization followed by integer translation "
            "to the per-state median subject bbox bottom-center"
        ),
        "alphaThreshold": args.alpha_threshold,
        "minimumMargin": args.minimum_margin,
        "packs": reports,
    }
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(summary, indent=2) + "\n")

    total_frames = sum(pack["atlas"]["columns"] * pack["atlas"]["rows"] for pack in reports)
    shifted_frames = sum(pack["shiftedFrames"] for pack in reports)
    significant_frames = sum(pack["significantFrames"] for pack in reports)
    scaled_frames = sum(pack["scaledFrames"] for pack in reports)
    minimum_margin = min(pack["minimumMarginAfter"] for pack in reports)
    print(
        f"{summary['mode']}: packs={len(reports)}, frames={total_frames}, "
        f"shifted={shifted_frames}, significant={significant_frames}, scaled={scaled_frames}, "
        f"minimum margin={minimum_margin}px"
    )


if __name__ == "__main__":
    main()
