#!/usr/bin/env python3
"""Verify release artifacts and the browser/target config-page contract."""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

from merge_webflasher import sanitize_part, sanitize_windows_paths

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "build_output" / "webflasher"
PARTS = [
    ("bootloader_@0x0000.bin", 0x000000),
    ("partitions_@0x8000.bin", 0x008000),
    ("boot_app0_@0xE000.bin", 0x00E000),
    ("firmware_@0x10000.bin", 0x010000),
    ("littlefs_@0x210000.bin", 0x210000),
]


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    for sample in (b"C:/Users/BuildUser/project", b"C:\\Users\\BuildUser\\project"):
        sanitized = sanitize_windows_paths(sample)
        assert len(sanitized) == len(sample), "path sanitizer changed the image layout"
        assert b"BuildUser" not in sanitized, "path sanitizer left a user name behind"
        assert sanitized.startswith(b"PUBLIC_BUILD_PATH"), "path sanitizer placeholder is missing"
    print("PASS Windows build-path sanitizer")

    app = OUT / "firmware_@0x10000.bin"
    merged_path = OUT / "WCH_WebLink_ALL_at_0x0.bin"
    if not app.exists() and not merged_path.exists():
        print("SKIP ESP32 application/merged image: not checked in; build locally")
    else:
        if not app.exists() or not merged_path.exists():
            raise SystemExit("incomplete local ESP32 package: application and merged image must both exist")
        merged = merged_path.read_bytes()
        assert len(merged) == 0x3F0000, f"merged size is {len(merged)}, expected {0x3F0000}"
        print(f"PASS merged size: {len(merged)} bytes")
        print(f"     merged sha256: {digest(merged)}")

        end = 0
        for name, offset in PARTS:
            data = (OUT / name).read_bytes()
            assert merged[offset : offset + len(data)] == sanitize_part(name, data), f"{name} differs from merged image"
            end = max(end, offset + len(data))
            print(f"PASS {name}: embedded at 0x{offset:06X}")
        assert merged[end:] == b"\xFF" * (len(merged) - end), "image tail is not erased fill"
        print(f"PASS fill from 0x{end:06X} to 0x{len(merged):06X}")

    target = ROOT / "ch32v003-firmware"
    firmware = (target / "build" / "ir_remote.bin").read_bytes()
    template = (target / "build" / "ir_remote_template.bin").read_bytes()
    web_template = (ROOT / "data" / "www" / "fw" / "ir_remote.bin").read_bytes()
    release_template = (OUT / "ir_remote_template.bin").read_bytes()
    assert len(firmware) <= 2048, f"target firmware is too large: {len(firmware)}"
    assert len(template) == 2112, f"target template size is {len(template)}"
    assert template.startswith(firmware), "template does not start with target firmware"
    assert template[len(firmware) :] == b"\xFF" * (len(template) - len(firmware)), "template tail is not fill"
    assert template == web_template == release_template, "target templates differ"
    print(f"PASS target firmware: {len(firmware)} bytes")
    print(f"PASS target template: {len(template)} bytes, sha256 {digest(template)}")

    subprocess.run(["node", str(target / "test_config_page.mjs")], cwd=target, check=True)
    print("ALL ARTIFACT CHECKS PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
