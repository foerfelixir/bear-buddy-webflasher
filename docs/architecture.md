# Architecture

## System overview

```text
Browser
  |  HTTP :80                 WebSocket /wsflash       WebSocket /wsir
  v                           |                         |
ESP32-C3 Bear-Buddy ----------+-------------------------+
  | AsyncWebServer / LittleFS      bit-banged SWIO           IR receiver IO21
  | NeoPixel IO7                   IO5, interrupts masked   |
  | buttons IO9 / IO4              v                        v
  |                               CH32V003J4M6            NEC / ext-NEC /
  |                               remote target            Samsung decoder
  |                                 |
  +--- 5x5 matrix: received code ---+
```

The ESP32 is the programmer, web host, and IR receiver. The CH32V003 is only the three-button IR transmitter; it does not decode IR.

## ESP32-C3 bridge

- Platform: `espressif32@6.5.0`, Arduino framework, `esp32-c3-devkitc-02`.
- Web stack: ESPAsyncWebServer, AsyncWebSocket, SSE, ArduinoJson, PersWiFiManagerAsync.
- Filesystem: LittleFS mounted for the `/www/` UI.
- Configuration: `/config.json`.
- mDNS: `weblink.local` when mDNS works on the client network.
- SWIO: single-wire debug on IO5 using the onboard 10 kΩ I²C SDA pull-up; no external pull-up or board modification is required.
- IR receiver: interrupt timestamps edges on IO21; decoding runs in the main loop.
- Matrix: 5×5 serpentine WS2812 chain on IO7.

`no_serial.h` deliberately replaces the ESP32-C3 USB CDC `Serial` object with a null stream. USB CDC writes previously blocked while no terminal was attached, starving WiFi/web handling and causing re-enumeration. The optional target UART is separate and disabled by default because UART0 uses IO21, which belongs to the IR receiver.

## CH32V003 target

The target firmware is bare metal:

- No RTOS, USB serial, UART, or task watchdog.
- 24 MHz HSI divided by 16 to a 1.5 MHz core clock.
- Buttons: SW1 PC4, SW2 PC2, SW3 PC1; priority SW1 > SW2 > SW3.
- IR output: PA2 / TIM1_CH2N, active-low IR and indicator LEDs.
- SWIO: PD1.
- Carrier: timer hardware at approximately 38.46 kHz.
- Config page: 64 bytes at `0x08000800`.

The linker reserves only the first 2 KiB of the 16 KiB flash for code, keeping the config page at offset `0x800` isolated and independently programmable.

## Data flow

### Programming a target

1. Browser opens `/wsflash`.
2. Browser sends `#i;` on demand, or the bridge halts the core before a write.
3. Browser sends a text `#w;offset;size;` command followed by binary data.
4. The bridge masks interrupts while bit-banging SWIO and writes the target flash.
5. The bridge reboots the target; the browser reports completion.

Constant probing is optional. When disabled, the page sends no periodic `#i;` commands.

### Receiving IR

1. The IO21 interrupt records only edge deltas in a small ring buffer.
2. `bbPoll()` drains the ring when no SWIO operation is active.
3. The state machine recognizes NEC, extended NEC, Samsung, and repeats.
4. A decoded frame is announced through `/wsir`, stored as the last frame, and rendered on the matrix.
5. The browser can copy the received frame onto a target button, including its protocol.

## Power and scheduling constraints

WS2812 updates draw significant current. Continuous scrolling on top of WiFi transmit bursts caused USB brownouts on the test hardware. The current design uses brightness 32, amber pixels, a single marquee pass, and no restart for an identical code that is already scrolling.

Long interrupt-masked SWIO writes can also starve other ESP32 tasks. `/rest/ir` exposes `rst` and `up` so resets can be classified after the fact.
