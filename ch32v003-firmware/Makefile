CROSS   ?= riscv-none-elf-
CC      := $(CROSS)gcc
OBJCOPY := $(CROSS)objcopy
OBJDUMP := $(CROSS)objdump
SIZE    := $(CROSS)size

TARGET  := ir_remote
BUILD   := build
SRC     := src

ARCH    := -march=rv32ec -mabi=ilp32e
CFLAGS  := $(ARCH) -Os -g -ffreestanding -fno-builtin -fno-common \
           -fno-stack-protector -msmall-data-limit=0 -Wall -Wextra
LDFLAGS := $(ARCH) -nostdlib -nostartfiles -T $(SRC)/link.ld \
           -Wl,--gc-sections -Wl,--build-id=none -Wl,-Map=$(BUILD)/$(TARGET).map

OBJS    := $(BUILD)/start.o $(BUILD)/main.o

all: $(BUILD)/$(TARGET).bin $(BUILD)/$(TARGET).hex

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/start.o: $(SRC)/start.S | $(BUILD)
	$(CC) $(ARCH) -c $< -o $@

$(BUILD)/main.o: $(SRC)/main.c | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD)/$(TARGET).elf: $(OBJS) $(SRC)/link.ld
	$(CC) $(LDFLAGS) $(OBJS) -lgcc -o $@
	$(SIZE) $@

$(BUILD)/$(TARGET).bin: $(BUILD)/$(TARGET).elf
	$(OBJCOPY) -O binary $< $@

$(BUILD)/$(TARGET).hex: $(BUILD)/$(TARGET).elf
	$(OBJCOPY) -O ihex $< $@

clean:
	rm -rf $(BUILD)

.PHONY: all clean
