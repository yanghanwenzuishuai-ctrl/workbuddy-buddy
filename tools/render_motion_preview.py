#!/usr/bin/env python3
"""Render all WorkBuddy pet states into a compact visual-QA video."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


STATES = [
    "idle",
    "thinking",
    "working",
    "review",
    "waiting",
    "done",
    "failed",
    "slacking",
    "slacking_salted",
    "slacking_costume",
    "slacking_shared_fish",
]


def checkerboard(width: int, height: int, square: int = 16) -> Image.Image:
    image = Image.new("RGB", (width, height), "#edf0f4")
    draw = ImageDraw.Draw(image)
    for y in range(0, height, square):
        for x in range(0, width, square):
            if (x // square + y // square) % 2:
                draw.rectangle((x, y, x + square - 1, y + square - 1), fill="#dfe4ea")
    return image


def load_font(size: int) -> ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/SFNS.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--seconds-per-state", type=float, default=1.6)
    parser.add_argument("--grid-columns", type=int, default=5)
    args = parser.parse_args()

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg is required")

    pets = []
    for manifest_path in sorted(args.root.glob("*/pet.json")):
        manifest = json.loads(manifest_path.read_text())
        sheet = Image.open(manifest_path.parent / manifest["spritesheetPath"]).convert("RGBA")
        pets.append((manifest, sheet))
    if not pets:
        raise SystemExit(f"no pet packs found below {args.root}")

    frame_width = max(pet[0]["frame"]["width"] for pet in pets)
    frame_height = max(pet[0]["frame"]["height"] for pet in pets)
    label_height = 22
    header_height = 36
    grid_rows = (len(pets) + args.grid_columns - 1) // args.grid_columns
    canvas_width = frame_width * args.grid_columns
    canvas_height = header_height + (frame_height + label_height) * grid_rows
    background = checkerboard(canvas_width, canvas_height)
    header_font = load_font(20)
    label_font = load_font(12)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgb24",
        "-video_size",
        f"{canvas_width}x{canvas_height}",
        "-framerate",
        str(args.fps),
        "-i",
        "-",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "18",
        str(args.output),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    assert process.stdin is not None

    frames_per_state = round(args.seconds_per_state * args.fps)
    try:
        for state in STATES:
            for output_index in range(frames_per_state):
                local_time = output_index / args.fps
                canvas = background.copy()
                draw = ImageDraw.Draw(canvas)
                draw.rectangle((0, 0, canvas_width, header_height - 1), fill="#111827")
                title = f"Motion alignment QA — {state}"
                draw.text((12, 7), title, font=header_font, fill="#ffffff")

                for pet_index, (manifest, sheet) in enumerate(pets):
                    grid_x = pet_index % args.grid_columns
                    grid_y = pet_index // args.grid_columns
                    left = grid_x * frame_width
                    top = header_height + grid_y * (frame_height + label_height)
                    animation = manifest["animations"][state]
                    sequence = animation["frames"]
                    sequence_index = int(local_time * animation.get("fps", 6)) % len(sequence)
                    column = sequence[sequence_index]
                    row = animation["row"]
                    source = sheet.crop(
                        (
                            column * manifest["frame"]["width"],
                            row * manifest["frame"]["height"],
                            (column + 1) * manifest["frame"]["width"],
                            (row + 1) * manifest["frame"]["height"],
                        )
                    )
                    canvas.paste(source, (left, top), source)
                    draw.rectangle(
                        (left, top + frame_height, left + frame_width - 1, top + frame_height + label_height - 1),
                        fill="#111827",
                    )
                    draw.text(
                        (left + 6, top + frame_height + 4),
                        manifest["id"],
                        font=label_font,
                        fill="#ffffff",
                    )
                process.stdin.write(canvas.tobytes())
    finally:
        process.stdin.close()

    return_code = process.wait()
    if return_code:
        raise SystemExit(f"ffmpeg exited with status {return_code}")
    print(f"wrote {args.output} ({canvas_width}x{canvas_height})")


if __name__ == "__main__":
    main()
