# Troubleshooting and known limitations

## Detect or program says link init failed

The CH32V003 is in standby and its SWIO pin is unavailable.

1. Press any button on the remote.
2. Immediately click **Detect chip** or **Program codes**.
3. Keep constant scanning off unless you specifically want the page to hold the window open.

SWIO activity extends the six-second window. Pressing a remote button again closes it immediately.

## Why constant scanning is optional

Chip probing halts and resumes the core and keeps the debug window open. That is useful for an always-open configurator, but it is unnecessary for normal Detect/Program workflows and creates constant SWIO traffic. The toggle defaults off for that reason.

## Read back is not trustworthy

The bit-banged SWIO read path has repeatedly returned inconsistent data on this hardware, including shifted bits and corrupted bytes. Writes have been reliable enough to program the target, but read-back is not proof.

- Do not diagnose a failed write solely from SWIO read-back.
- Verify transmitted IR with the Bear-Buddy receiver or another known-good decoder.
- Use a dedicated hardware programmer if independent flash verification is required.
- The UI rejects all-`0xFF` and obviously invalid config pages rather than overwriting the current codes.

## Target falls back to factory NEC codes

Possible causes:

- Config page is blank or corrupt.
- Magic is not `IRC2`.
- Checksum is wrong.
- A protocol byte is greater than `1`.
- The target is running old firmware that does not understand the protocol byte.

Flash the complete target firmware image with **Flash firmware**, then program the config page again.

## IR receiver sees nothing

- Check IO21 wiring and receiver power.
- Confirm the remote uses NEC or Samsung; other protocols are not decoded.
- Confirm the optional UART terminal is disabled because it takes IO21.
- Inspect `/rest/ir`: `edges:0` suggests no receiver activity; a rising histogram with no valid frame suggests noise or unsupported timing.
- Keep SWIO operations short; decoding is paused while the bridge is busy.

## Matrix causes USB resets

The 25-pixel matrix plus WiFi can exceed a weak USB supply. The current mitigation is brightness 32 and one-pass scrolling. Use a stable power source and avoid continuous high-brightness animation.

## Board reboots during long programming

`/rest/ir` exposes reset reason and uptime:

- `rst:6` — task watchdog.
- `rst:9` — brownout.
- `rst:4` — panic.
- `rst:0` — power-on reset, including the reset after flashing.

Long interrupt-masked SWIO writes can starve the FreeRTOS idle task. There is no explicit task-watchdog feed between 64-byte write blocks yet; treat this as an open robustness item.

## No USB serial output

This is intentional. The ESP32-C3 USB CDC console was replaced with a null stream because blocking writes with no terminal attached starved the web server and caused re-enumeration. Do not expect COM11 debug output.

## Browser cannot reach 192.168.4.1

Some system proxy configurations intercept the board access point. Use `curl --noproxy '*'` for diagnostics or configure the browser to bypass the proxy for `192.168.4.1`.

## Stale files in the upstream repository

The original upstream README describes an older UI and says reads/chip-info are unimplemented. This repository's README and `docs/` describe the current Bear-Buddy work. The `index.html` S3 label is also historical; the actual target is ESP32-C3.
