#!/usr/bin/env python3
"""Build the deterministic merged ESP32-C3 webflasher image."""

from __future__ import annotations

import argparse
import hashlib
import re
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
WINDOWS_USER_PATH = re.compile(rb"[A-Za-z]:[\\/]+Users[\\/]+[^\\/\x00\r\n]+")


def sanitize_windows_paths(data: bytes) -> bytes:
    def replace(match: re.Match[bytes]) -> bytes:
        original = match.group(0)
        placeholder = b"PUBLIC_BUILD_PATH"
        if len(original) < len(placeholder):
            return b"P" * len(original)
        return placeholder + b"_" * (len(original) - len(placeholder))

    # Preserve ESP32 image offsets while removing build-user paths.
    return WINDOWS_USER_PATH.sub(replace, data)


def sanitize_esp32_image(data: bytes) -> bytes:
    image = bytearray(sanitize_windows_paths(data))
    if not image or image[0] != 0xE9 or image[23] not in (0, 1):
        raise ValueError("invalid ESP32 application image header")

    position = 24
    checksum = 0xEF
    for _ in range(image[1]):
        if position + 8 > len(image):
            raise ValueError("truncated ESP32 segment header")
        size = int.from_bytes(image[position + 4 : position + 8], "little")
        position += 8
        if position + size > len(image):
            raise ValueError("truncated ESP32 segment data")
        for value in image[position : position + size]:
            checksum ^= value
        position += size

    checksum_offset = (position // 16 + 1) * 16 - 1
    if checksum_offset >= len(image):
        raise ValueError("missing ESP32 checksum")
    image[checksum_offset] = checksum
    end = checksum_offset + 1
    if image[23]:
        if end + 32 > len(image):
            raise ValueError("missing ESP32 validation digest")
        image[end : end + 32] = hashlib.sha256(image[:end]).digest()
    return bytes(image)


def sanitize_part(name: str, data: bytes) -> bytes:
    if name == "firmware_@0x10000.bin":
        return sanitize_esp32_image(data)
    return sanitize_windows_paths(data)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify the existing image without writing")
    args = parser.parse_args()

    blobs: list[tuple[str, int, bytes]] = []
    end = 0
    replacements = 0
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
        replacements += len(WINDOWS_USER_PATH.findall(data))
        blobs.append((name, offset, sanitize_part(name, data)))
        end = max(end, region_end)
        print(f"{name:32} offset=0x{offset:06X} size={len(data)}")

    image = bytearray(b"\xFF" * end)
    for name, offset, data in blobs:
        image[offset : offset + len(data)] = data
    image = bytes(image)

    digest = sha256(image)
    print(f"merged size: {len(image)} bytes")
    print(f"sanitized Windows build paths: {replacements}")
    print(f"sha256: {digest}")

    if args.check:
        if not OUTPUT.is_file():
            raise SystemExit(f"missing merged image: {OUTPUT}")
        existing = OUTPUT.read_bytes()
        if existing != image:
            raise SystemExit("merged image does not match the current parts")
        print("CHECK PASS: merged image matches all parts")
    else:
        temporary = OUTPUT.with_name(OUTPUT.name + ".tmp")
        temporary.write_bytes(image)
        temporary.replace(OUTPUT)
        print(f"wrote: {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
