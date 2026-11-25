# IR protocols and configuration

## Target transmit protocols

Each button can independently use NEC or Samsung.

| Property | NEC | Samsung |
|---|---:|---:|
| Header mark | 9000 µs | 4500 µs |
| Header space | 4500 µs | 4500 µs |
| Bit mark | 560 µs | 560 µs |
| Zero space | 560 µs | 560 µs |
| One space | 1690 µs | 1690 µs |
| Byte 0 | address | address |
| Byte 1 | `~address` | address |
| Byte 2 | command | command |
| Byte 3 | `~command` | `~command` |
| Bit order | LSB first | LSB first |

Held buttons repeat every 200 ms. The target sends a whole frame again for both protocols; the Bear-Buddy receiver also recognizes NEC-style repeat frames.

Target protocol values are:

- `0` = NEC
- `1` = Samsung

## Configuration page

The 64-byte page lives at `0x08000800`:

| Offset | Size | Meaning |
|---:|---:|---|
| `0x00` | 4 | Magic `IRC2`, little-endian `0x32435249` |
| `0x04` | 4 | SW1: address, command, protocol, `0xFF` |
| `0x08` | 4 | SW2: address, command, protocol, `0xFF` |
| `0x0C` | 4 | SW3: address, command, protocol, `0xFF` |
| `0x10` | 4 | Little-endian sum of bytes `0x00..0x0F` |
| `0x14` | 44 | Unused, `0xFF` |

`IRC1` pages are rejected because the checksum/protocol layout changed. Invalid protocol values also trigger factory fallback.

Factory fallback:

| Button | Address | Command | Protocol |
|---|---:|---:|---|
| SW1 | `0x00` | 152 / `0x98` | NEC |
| SW2 | `0x00` | 31 / `0x1F` | NEC |
| SW3 | `0x00` | 62 / `0x3E` | NEC |

## Bear-Buddy receive protocols

Receiver protocol values are different from target protocol values:

- `0` = standard NEC
- `1` = extended NEC
- `2` = Samsung
- `3` = unknown / ambiguous

The receiver uses interrupt-timestamped edge deltas and accepts:

- NEC header mark: 7500–10500 µs
- Samsung or ambiguous header: 3800–5200 µs
- Repeat space: 1800–2900 µs
- Bit mark: 380–800 µs
- Zero space: 380–900 µs
- One space: 1300–2000 µs

Identical frames received within 600 ms are counted as repeats. Extended-NEC addresses are 16-bit and cannot be represented by the target's 8-bit address field; the UI warns and truncates when assigning one.

## Matrix and browser output

A valid frame is rendered as `IR:ADDR-CMD` or `IR:ADDR16-CMD`, scrolls once, then clears. `/wsir` pushes JSON to connected pages, and `/rest/ir` returns the last frame plus receiver diagnostics.

## Verification

`node ch32v003-firmware/test_config_page.mjs` checks the browser and target implementations against each other. Hardware verification should use the Bear-Buddy receiver or another known-good IR decoder; SWIO read-back is not reliable on this setup.
