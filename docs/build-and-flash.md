# Build, package, and flash

## Prerequisites

- Python 3
- PlatformIO Core (`python -m platformio`)
- Node.js 18 or newer for the config-page test and merge tooling
- Git Bash on Windows, or a POSIX shell on Linux/macOS
- xpack RISC-V GNU toolchain, for example `xpack-riscv-none-elf-gcc-15.2.0-1`

The repository does not include the large RISC-V toolchain archive.

## Configure Wi-Fi before building

Set `HOTSPOT_NAME` and `HOTSPOT_PASSWORD` in `src/SRLConfig.h`. The checked-in values are generic setup placeholders, not deployment credentials. Do not commit real access-point values.

The ESP32 application and merged image are intentionally not checked in because compiled firmware embeds these defaults. Build them locally after configuring Wi-Fi.

## Build the CH32V003 target

Build the target first so its current template is installed into the web assets before LittleFS is generated:

```sh
cd ch32v003-firmware
TOOLCHAIN_DIR=/path/to/xpack-riscv-none-elf-gcc-15.2.0-1/bin sh build.sh
node test_config_page.mjs
cd ..
```

`build.sh` creates:

- `build/ir_remote.bin` — firmware only, currently 1360 bytes.
- `build/ir_remote.hex` — Intel HEX output.
- `build/ir_remote_template.bin` — 2112 bytes: 2048-byte code area plus a blank 64-byte config page.

It also installs the template at `../data/www/fw/ir_remote.bin` so the web UI can download the current target image. Override `WEBFW` if a different destination is required.

The config-page test compares constants and byte layout between `src/main.c` and `data/www/js/ir.js`, executes the browser codec, rejects invalid pages, and verifies the deployed template.

## Build the ESP32-C3 bridge

From the repository root:

```sh
python -m platformio run -e esp32-c3-devkitc-02
python -m platformio run -e esp32-c3-devkitc-02 -t buildfs
```

Outputs are written under `.pio/build/esp32-c3-devkitc-02/`.

The partition table is defined by [`no_ota.csv`](../no_ota.csv) and has no OTA slot:

| Region | Offset | Size |
|---|---:|---:|
| Bootloader | `0x000000` | — |
| Partition table | `0x008000` | `0x1000` |
| NVS | `0x009000` | `0x5000` |
| OTA metadata | `0x00E000` | `0x2000` |
| Application | `0x010000` | `0x200000` |
| LittleFS | `0x210000` | `0x1E0000` |
| Coredump | `0x3F0000` | `0x10000` |

## Verify and merge the ESP32 image

After building the bridge and filesystem, stage the PlatformIO outputs and create the merged image:

```sh
mkdir -p build_output/webflasher
cp .pio/build/esp32-c3-devkitc-02/bootloader.bin build_output/webflasher/bootloader_@0x0000.bin
cp .pio/build/esp32-c3-devkitc-02/partitions.bin build_output/webflasher/partitions_@0x8000.bin
cp .pio/build/esp32-c3-devkitc-02/firmware.bin build_output/webflasher/firmware_@0x10000.bin
cp .pio/build/esp32-c3-devkitc-02/littlefs.bin build_output/webflasher/littlefs_@0x210000.bin

python tools/merge_webflasher.py
python tools/verify_artifacts.py
```

The merge tool reads these files from `build_output/webflasher/`:

- `bootloader_@0x0000.bin`
- `partitions_@0x8000.bin`
- `boot_app0_@0xE000.bin`
- `firmware_@0x10000.bin`
- `littlefs_@0x210000.bin`

It fills gaps with `0xFF`, checks region sizes, and writes `WCH_WebLink_ALL_at_0x0.bin`. Use `--check` to verify the existing merged image without rewriting it. The generated ESP32 application and merged image are ignored by Git so local Wi-Fi values are not accidentally committed.

## Flash the ESP32-C3

### Browser flash with Adafruit WebSerial ESPTool

Use this method when Python or `esptool` is not installed. Build `build_output/webflasher/WCH_WebLink_ALL_at_0x0.bin` locally first; it is intentionally not checked in.

1. Open [Adafruit WebSerial ESPTool](https://adafruit.github.io/Adafruit_WebSerial_ESPTool/) in a Web Serial-capable browser. The tool currently lists Chrome 89+ or Firefox 151+.
2. Connect the Bear-Buddy by USB and close any serial monitor, PlatformIO monitor, or IDE serial session using the port.
3. Click **Connect** and select the ESP32-C3 serial port. Use `921600` baud if the tool exposes a baud control.
4. Set the offset to `0x0`, choose `WCH_WebLink_ALL_at_0x0.bin`, and start the erase/program operation.
5. Wait for the write and verification to finish, reset the board if needed, then connect to the access point configured in `src/SRLConfig.h`.

A full erase/program clears saved device configuration. If the board does not enter download mode automatically, hold **BOOT** (Button A), tap **RESET**, release **BOOT**, and retry the connection.

### Command-line complete image

Replace `COM11` with the actual serial port.

```sh
python -m esptool --chip esp32c3 --port COM11 --baud 921600 \
  --before usb_reset --after hard_reset \
  write_flash 0x0 build_output/webflasher/WCH_WebLink_ALL_at_0x0.bin
```

### Web UI only

Use this when the ESP32 application is already correct and only the web files changed:

```sh
python -m esptool --chip esp32c3 --port COM11 --baud 921600 \
  --before usb_reset --after hard_reset \
  write_flash 0x210000 build_output/webflasher/littlefs_@0x210000.bin
```

### Application only

```sh
python -m esptool --chip esp32c3 --port COM11 --baud 921600 \
  --before usb_reset --after hard_reset \
  write_flash 0x10000 build_output/webflasher/firmware_@0x10000.bin
```

## Program the CH32V003

The supported path is the Bear-Buddy IR page:

1. Connect the target SWIO line to IO5 with the pull-up.
2. Press a remote button to open the six-second debug window.
3. Click **Program codes** for only the 64-byte config page, or **Flash firmware** for the complete 2112-byte image.

For automation over `/wsflash`, numeric arguments are decimal:

```text
#w;134219776;64;       # config page at 0x08000800
#w;134217728;2112;     # complete target image at 0x08000000
```

Do not trust SWIO read-back as proof of a successful write on this hardware. Use the on-air IR output or an independent programmer for verification.
