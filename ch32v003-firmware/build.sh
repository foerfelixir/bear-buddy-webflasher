#!/bin/sh
# Builds the IR remote firmware and assembles the image the Bear-Buddy web UI
# programs: 2K of code padded with 0xFF, followed by the 64-byte blank config
# page that ir.js patches with each button's address, command and protocol
# before writing.
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
TOOL="${TOOLCHAIN_DIR:-$HERE/../tools/xpack-riscv-none-elf-gcc-15.2.0-1/bin}"
WEBFW="${WEBFW:-$HERE/../data/www/fw}"
PATH="$TOOL:$PATH"

if [ ! -x "$TOOL/riscv-none-elf-gcc" ]; then
  echo "RISC-V toolchain not found at: $TOOL" >&2
  echo "Set TOOLCHAIN_DIR to the xpack .../bin directory and retry." >&2
  exit 1
fi

CODE_SIZE=2048          # must match FLASH LENGTH in src/link.ld
CFG_SIZE=64             # one flash page, must match CFG_ADDR alignment

ARCH="-march=rv32ec -mabi=ilp32e"
CFLAGS="$ARCH -Os -g -ffreestanding -fno-builtin -fno-common \
        -fno-stack-protector -msmall-data-limit=0 -Wall -Wextra"
LDFLAGS="$ARCH -nostdlib -nostartfiles -T src/link.ld \
         -Wl,--gc-sections -Wl,--build-id=none -Wl,-Map=build/ir_remote.map"

cd "$HERE"
mkdir -p build

riscv-none-elf-gcc $ARCH -c src/start.S -o build/start.o
riscv-none-elf-gcc $CFLAGS -c src/main.c -o build/main.o
riscv-none-elf-gcc $LDFLAGS build/start.o build/main.o -lgcc -o build/ir_remote.elf
riscv-none-elf-objcopy -O binary build/ir_remote.elf build/ir_remote.bin
riscv-none-elf-objcopy -O ihex build/ir_remote.elf build/ir_remote.hex
riscv-none-elf-size build/ir_remote.elf

cp build/ir_remote.bin build/ir_remote_template.bin
head -c $((CODE_SIZE - $(stat -c%s build/ir_remote.bin))) /dev/zero | tr '\000' '\377' \
    >> build/ir_remote_template.bin
head -c "$CFG_SIZE" /dev/zero | tr '\000' '\377' >> build/ir_remote_template.bin

echo "template: $(stat -c%s build/ir_remote_template.bin) bytes (expect $((CODE_SIZE + CFG_SIZE)))"

mkdir -p "$WEBFW"
cp build/ir_remote_template.bin "$WEBFW/ir_remote.bin"
echo "installed: $WEBFW/ir_remote.bin"
