# Bear-Buddy Web Flasher

Private ESP32-C3 / CH32V003 development repository for the TomatoCube **Box 10 Bear-Buddy** board.

**Repository status:** private. The documentation site in [`docs/index.html`](docs/index.html) is prepared but **GitHub Pages is not published**.

This project turns the Bear-Buddy into a browser-based CH32V003J4M6 programmer and IR remote configurator. The ESP32-C3 hosts the web UI, bit-bangs SWIO, receives NEC / extended-NEC / Samsung IR, and drives the onboard 5×5 NeoPixel matrix. The CH32V003 target firmware transmits a separately configurable NEC or Samsung code for each of its three buttons.

## Features

- Modern programmer dashboard and dedicated **IR Remote** page.
- Generate, randomize, download, and program per-button address / command / protocol values.
- NEC and Samsung transmission on the CH32V003, one protocol per button.
- NEC, extended-NEC, and Samsung reception on the Bear-Buddy.
- Received codes shown in the browser and as a one-pass `IR:...` matrix marquee.
- Detect chip, read protection status, program, firmware flash, and whole-chip erase.
- **Constant chip scan is opt-in and defaults off.** Detect and programming still access the target on demand.
- Local release-packaging tools, individual flash parts, and CH32V003 firmware/template included.

## Hardware at a glance

| Function | Pin |
|---|---:|
| SWIO / I²C SDA | IO5 |
| I²C SCL | IO6 |
| 5×5 NeoPixel matrix | IO7 |
| Button A / BOOT strap | IO9 |
| Button B | IO4 |
| Buzzer | IO10 |
| IR receiver | IO21 |
| Status LED | IO3 |

SWIO and I²C SDA share IO5; do not use both at once. See [hardware.md](docs/hardware.md).

## Quick start

1. Set `HOTSPOT_NAME` and `HOTSPOT_PASSWORD` in `src/SRLConfig.h`, build and flash the ESP32 image, then connect to the access point you configured.
2. Open `http://192.168.4.1/` for the programmer or `http://192.168.4.1/ir.html` for the IR configurator.
3. On the IR page, select each button, edit or randomize its code, choose NEC or Samsung, then program.
4. The target is asleep in standby. Press any button on the remote immediately before **Detect chip** or **Program codes**. Its SWIO window stays open for six seconds and is extended by SWIO activity.
5. Constant scanning is off by default. Turn on **Constant chip scan** only if you want the page to probe every two seconds and keep that window open.

## Included release images

| File | Purpose | Flash offset |
|---|---|---:|
| [`build_output/webflasher/littlefs_@0x210000.bin`](build_output/webflasher/littlefs_@0x210000.bin) | Web UI / LittleFS only | `0x210000` |
| [`build_output/webflasher/ir_remote_template.bin`](build_output/webflasher/ir_remote_template.bin) | CH32V003 firmware plus blank 64-byte config page | target `0x08000000` |
| [`ch32v003-firmware/build/ir_remote.bin`](ch32v003-firmware/build/ir_remote.bin) | CH32V003 firmware only | target `0x08000000` |

The ESP32 application and merged image are intentionally not checked in because compiled firmware embeds the Wi-Fi defaults. Build them locally after setting your access-point values. The generated merged image is 4,128,768 bytes and ends at `0x3F0000`; the final 64 KiB coredump region is left untouched.

## Build

Prerequisites: Python, PlatformIO Core, Node.js, and an xpack RISC-V GNU toolchain for the target build.

Set `HOTSPOT_NAME` and `HOTSPOT_PASSWORD` in `src/SRLConfig.h` before building. The checked-in values are generic placeholders; do not commit deployment credentials.

```sh
# CH32V003 target first, so its template is current in the web assets
cd ch32v003-firmware
TOOLCHAIN_DIR=/path/to/xpack-riscv-none-elf-gcc-15.2.0-1/bin sh build.sh
node test_config_page.mjs
cd ..

# ESP32-C3 bridge and web filesystem
python -m platformio run -e esp32-c3-devkitc-02
python -m platformio run -e esp32-c3-devkitc-02 -t buildfs
```

See [build-and-flash.md](docs/build-and-flash.md) for complete build, merge, verification, and flash commands.

For a no-install browser option, build the merged image locally and flash it at offset `0x0` with [Adafruit WebSerial ESPTool](https://adafruit.github.io/Adafruit_WebSerial_ESPTool/). This requires a Web Serial-capable browser and clears saved device configuration during a full erase/program.

## Documentation

- [Architecture](docs/architecture.md)
- [Hardware and wiring](docs/hardware.md)
- [Build, package, and flash](docs/build-and-flash.md)
- [IR protocols and config page](docs/ir-protocols.md)
- [Web UI and HTTP / WebSocket API](docs/web-api.md)
- [Troubleshooting and known limitations](docs/troubleshooting.md)
- [Release artifacts and verification](docs/release-artifacts.md)
- [Security and publication status](SECURITY.md)

A standalone documentation page is available at [docs/index.html](docs/index.html). It is intentionally not connected to GitHub Pages yet.

## Attribution and license

The bridge is based on [Subjective-Reality-Labs/WCH_WebLink](https://github.com/Subjective-Reality-Labs/WCH_WebLink), which in turn credits cnlohr's `ch32v003fun` minichlink and ESP32 programmer work. The original MIT license is retained in [LICENSE](LICENSE).

Bear-Buddy hardware and wiring references are credited to [TomatoCube's Box 10 Bear-Buddy documentation](https://github.com/TomatoCube18/Docs/tree/main/Box%2010%20-%20Bear-Buddy%20DIY%20Desk%20Companion).

## Private-release warning

Current source, documentation, and checked-in binaries contain no deployment Wi-Fi credentials. The source uses generic setup-AP placeholders, and credential-bearing ESP32 application/merged images are built locally. Replace the placeholders before deployment and review Git history before any public release. The device UI has no authentication and is intended for a trusted local network only.
