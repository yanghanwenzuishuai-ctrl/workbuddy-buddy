#!/usr/bin/env python3
"""Repack an RGBA sprite atlas so each frame has deterministic safe spacing.

The input and output use the WorkBuddy 8 x 7 grid. Connected alpha components
are assigned to the frame containing their centroid before the frame is scaled.
That prevents neighboring ears, tails, and detached status symbols from leaking
into the wrong runtime crop.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image


FRAME_WIDTH = 192
FRAME_HEIGHT = 208
COLUMNS = 8
ROWS = 7


@dataclass(frozen=True)
class Run:
    y: int
    start: int
    end: int
    label: int


class UnionFind:
    def __init__(self) -> None:
        self.parent: list[int] = []
        self.rank: list[int] = []

    def add(self) -> int:
        label = len(self.parent)
        self.parent.append(label)
        self.rank.append(0)
        return label

    def find(self, value: int) -> int:
        while self.parent[value] != value:
            self.parent[value] = self.parent[self.parent[value]]
            value = self.parent[value]
        return value

    def union(self, left: int, right: int) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root == right_root:
            return
        if self.rank[left_root] < self.rank[right_root]:
            left_root, right_root = right_root, left_root
        self.parent[right_root] = left_root
        if self.rank[left_root] == self.rank[right_root]:
            self.rank[left_root] += 1


def row_runs(mask_row: np.ndarray, y: int, union_find: UnionFind) -> list[Run]:
    padded = np.pad(mask_row.astype(np.int8), (1, 1))
    changes = np.diff(padded)
    starts = np.flatnonzero(changes == 1)
    ends = np.flatnonzero(changes == -1) - 1
    return [Run(y, int(start), int(end), union_find.add()) for start, end in zip(starts, ends)]


def connected_runs(mask: np.ndarray) -> tuple[list[Run], UnionFind]:
    union_find = UnionFind()
    all_runs: list[Run] = []
    previous: list[Run] = []

    for y in range(mask.shape[0]):
        current = row_runs(mask[y], y, union_find)
        previous_index = 0
        for run in current:
            while previous_index < len(previous) and previous[previous_index].end < run.start - 1:
                previous_index += 1
            candidate = previous_index
            while candidate < len(previous) and previous[candidate].start <= run.end + 1:
                union_find.union(run.label, previous[candidate].label)
                candidate += 1
        all_runs.extend(current)
        previous = current

    for label in range(len(union_find.parent)):
        union_find.find(label)
    return all_runs, union_find


def detect_boundaries(mask: np.ndarray, count: int, axis: int) -> list[int]:
    """Find the transparent valleys between AI-generated atlas cells."""
    projection = mask.sum(axis=axis).astype(np.float64)
    kernel = np.ones(11, dtype=np.float64) / 11
    smoothed = np.convolve(projection, kernel, mode="same")
    length = mask.shape[1] if axis == 0 else mask.shape[0]
    nominal = length / count
    radius = round(nominal * 0.32)
    boundaries = [0]
    for index in range(1, count):
        expected = round(index * nominal)
        low = max(boundaries[-1] + round(nominal * 0.55), expected - radius)
        high = min(length - 1, expected + radius)
        boundary = low + int(np.argmin(smoothed[low : high + 1]))
        boundaries.append(boundary)
    boundaries.append(length)
    return boundaries


def frame_for_point(center_x: float, center_y: float, x_boundaries: list[int], y_boundaries: list[int]) -> tuple[int, int]:
    column = int(np.searchsorted(x_boundaries, center_x, side="right") - 1)
    row = int(np.searchsorted(y_boundaries, center_y, side="right") - 1)
    return min(ROWS - 1, max(0, row)), min(COLUMNS - 1, max(0, column))


def component_assignments(
    runs: list[Run],
    union_find: UnionFind,
    minimum_area: int,
    x_boundaries: list[int],
    y_boundaries: list[int],
) -> tuple[dict[int, tuple[int, int]], dict[tuple[int, int], list[Run]]]:
    area: dict[int, int] = defaultdict(int)
    x_sum: dict[int, int] = defaultdict(int)
    y_sum: dict[int, int] = defaultdict(int)

    for run in runs:
        root = union_find.find(run.label)
        length = run.end - run.start + 1
        area[root] += length
        x_sum[root] += (run.start + run.end) * length // 2
        y_sum[root] += run.y * length

    assignments: dict[int, tuple[int, int]] = {}
    for root, component_area in area.items():
        if component_area < minimum_area:
            continue
        center_x = x_sum[root] / component_area
        center_y = y_sum[root] / component_area
        assignments[root] = frame_for_point(center_x, center_y, x_boundaries, y_boundaries)

    grouped: dict[tuple[int, int], list[Run]] = defaultdict(list)
    for run in runs:
        root = union_find.find(run.label)
        frame = assignments.get(root)
        if frame is not None:
            grouped[frame].append(run)
    return assignments, grouped


def resize_premultiplied(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    return image.convert("RGBa").resize(size, Image.Resampling.LANCZOS).convert("RGBA")


def repack(
    source: np.ndarray,
    grouped_runs: dict[tuple[int, int], list[Run]],
    x_boundaries: list[int],
    y_boundaries: list[int],
    scale: float,
    extension: int,
) -> Image.Image:
    output = Image.new("RGBA", (FRAME_WIDTH * COLUMNS, FRAME_HEIGHT * ROWS))

    for row in range(ROWS):
        for column in range(COLUMNS):
            cell_left = x_boundaries[column]
            cell_top = y_boundaries[row]
            source_width = x_boundaries[column + 1] - cell_left
            source_height = y_boundaries[row + 1] - cell_top
            fit_scale = min(FRAME_WIDTH / source_width, FRAME_HEIGHT / source_height)
            source_extension_x = max(1, round(extension / fit_scale))
            source_extension_y = max(1, round(extension / fit_scale))
            tile_width = source_width + source_extension_x * 2
            tile_height = source_height + source_extension_y * 2
            tile = np.zeros((tile_height, tile_width, 4), dtype=np.uint8)
            origin_x = cell_left - source_extension_x
            origin_y = cell_top - source_extension_y

            for run in grouped_runs.get((row, column), []):
                target_y = run.y - origin_y
                if not 0 <= target_y < tile_height:
                    continue
                source_start = max(run.start, origin_x)
                source_end = min(run.end, origin_x + tile_width - 1)
                if source_start > source_end:
                    continue
                target_start = source_start - origin_x
                target_end = source_end - origin_x + 1
                tile[target_y, target_start:target_end] = source[run.y, source_start : source_end + 1]

            fitted_width = round(tile_width * fit_scale)
            fitted_height = round(tile_height * fit_scale)
            fitted = resize_premultiplied(Image.fromarray(tile, "RGBA"), (fitted_width, fitted_height))
            normalized = Image.new("RGBA", (FRAME_WIDTH + extension * 2, FRAME_HEIGHT + extension * 2))
            normalized.alpha_composite(
                fitted,
                ((normalized.width - fitted.width) // 2, (normalized.height - fitted.height) // 2),
            )
            resized_width = round(normalized.width * scale)
            resized_height = round(normalized.height * scale)
            resized = resize_premultiplied(normalized, (resized_width, resized_height))
            left = (resized_width - FRAME_WIDTH) // 2
            top = (resized_height - FRAME_HEIGHT) // 2
            frame = resized.crop((left, top, left + FRAME_WIDTH, top + FRAME_HEIGHT))
            output.alpha_composite(frame, (column * FRAME_WIDTH, row * FRAME_HEIGHT))

    return output


def frame_margins(image: Image.Image) -> list[tuple[int, int, int, int]]:
    alpha = np.asarray(image.getchannel("A"))
    margins: list[tuple[int, int, int, int]] = []
    for row in range(ROWS):
        for column in range(COLUMNS):
            cell = alpha[
                row * FRAME_HEIGHT : (row + 1) * FRAME_HEIGHT,
                column * FRAME_WIDTH : (column + 1) * FRAME_WIDTH,
            ]
            ys, xs = np.nonzero(cell)
            if not len(xs):
                raise ValueError(f"frame ({row}, {column}) is empty after repacking")
            margins.append(
                (
                    int(xs.min()),
                    int(ys.min()),
                    FRAME_WIDTH - 1 - int(xs.max()),
                    FRAME_HEIGHT - 1 - int(ys.max()),
                )
            )
    return margins


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--scale", type=float, default=0.70)
    parser.add_argument("--extension", type=int, default=64)
    parser.add_argument("--minimum-component-area", type=int, default=3)
    parser.add_argument("--alpha-threshold", type=int, default=8)
    args = parser.parse_args()

    if not 0 < args.scale < 1:
        parser.error("--scale must be between 0 and 1")

    image = Image.open(args.input).convert("RGBA")
    if image.width < COLUMNS * 32 or image.height < ROWS * 32:
        raise ValueError(f"input atlas is too small for an {COLUMNS} x {ROWS} grid: {image.size}")

    source = np.asarray(image)
    mask = source[:, :, 3] > args.alpha_threshold
    x_boundaries = detect_boundaries(mask, COLUMNS, axis=0)
    y_boundaries = detect_boundaries(mask, ROWS, axis=1)
    runs, union_find = connected_runs(mask)
    assignments, grouped_runs = component_assignments(
        runs,
        union_find,
        args.minimum_component_area,
        x_boundaries,
        y_boundaries,
    )
    missing = [(row, column) for row in range(ROWS) for column in range(COLUMNS) if (row, column) not in grouped_runs]
    if missing:
        raise ValueError(f"no components assigned to frames: {missing}")

    output = repack(source, grouped_runs, x_boundaries, y_boundaries, args.scale, args.extension)
    margins = frame_margins(output)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    output.save(args.output, optimize=True)

    minimum_margins = tuple(min(values) for values in zip(*margins))
    print(
        f"{args.input} -> {args.output}: components={len(assignments)}, "
        f"scale={args.scale:.2f}, min margins L/T/R/B={minimum_margins}, "
        f"x-boundaries={x_boundaries}, y-boundaries={y_boundaries}"
    )


if __name__ == "__main__":
    main()
