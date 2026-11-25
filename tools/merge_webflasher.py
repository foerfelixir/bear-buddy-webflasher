#!/usr/bin/env python3
"""Build the deterministic merged ESP32-C3 webflasher image."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "build_output" / "webflasher"
PARTS = [
    ("bootloader_@0x0000.bin", 0x000000),
    ("partitions_@0x8000.bin", 0x008000),
    ("boot_app0_@0xE000.bin", 0x00E000),
    ("firmware_@0x10000.bin", 0x010000),
    ("littlefs_@0x210000.bin", 0x210000),
]
REGION_END = 0x3F0000
OUTPUT = OUT / "WCH_WebLink_ALL_at_0x0.bin"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify the existing image without writing")
    args = parser.parse_args()

    blobs: list[tuple[str, int, bytes]] = []
    end = 0
    for name, offset in PARTS:
        path = OUT / name
        if not path.is_file():
            raise SystemExit(f"missing part: {path}")
        data = path.read_bytes()
        if not data:
            raise SystemExit(f"empty part: {path}")
        region_end = offset + len(data)
        if region_end > REGION_END:
            raise SystemExit(f"{name} exceeds the reserved image area: 0x{region_end:X}")
        if blobs and offset < end:
            raise SystemExit(f"overlapping part: {name}")
        blobs.append((name, offset, data))
        end = max(end, region_end)
        print(f"{name:32} offset=0x{offset:06X} size={len(data)}")

    image = bytearray(b"\xFF" * end)
    for name, offset, data in blobs:
        image[offset : offset + len(data)] = data
    image = bytes(image)

    digest = sha256(image)
    print(f"merged size: {len(image)} bytes")
    print(f"sha256: {digest}")

    if args.check:
        if not OUTPUT.is_file():
            raise SystemExit(f"missing merged image: {OUTPUT}")
        existing = OUTPUT.read_bytes()
        if existing != image:
            raise SystemExit("merged image does not match the current parts")
        print("CHECK PASS: merged image matches all parts")
    else:
        OUTPUT.write_bytes(image)
        print(f"wrote: {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
