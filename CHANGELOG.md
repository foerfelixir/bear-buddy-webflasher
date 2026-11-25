# Changelog

## Unreleased — private repository package

- Added a complete private-repository documentation set and standalone documentation page.
- Added the missing `no_ota.csv` partition definition.
- Made the CH32V003 build and config-page test scripts independent of the original workspace path.
- Added deterministic merged-image and artifact verification tools.
- Replaced real access-point defaults with generic placeholders and removed credential-bearing ESP32 application/merged images.
- Documented how to configure Wi-Fi and rebuild the omitted ESP32 binaries locally.
- Preserved the web UI, CH32V003 firmware, and non-credential release parts.
- Added TomatoCube credit for the Bear-Buddy hardware, detailed tutorials, and hardware documentation.
- Added Ishu1519's ESP32-S3 CH32V003 SWIO programmer as an original technical reference.
- Added a verified v1.0.0 complete ESP32-C3 release image with generic access-point defaults.
- Documented browser-based ESP32 flashing with Adafruit WebSerial ESPTool.
- Clarified that the onboard 10 kΩ I²C pull-ups support SWIO without hardware modification.

## Bear-Buddy feature set

- Added NEC / Samsung receive decoding, matrix marquee, `/rest/ir`, and `/wsir`.
- Added per-button NEC / Samsung target firmware and the `IRC2` configuration page.
- Added IR code generation, randomization, download, programming, detect, and recovery actions.
- Added optional constant chip scanning; default is off.
- Removed the blocking USB CDC console from normal operation.
- Added reset-reason diagnostics and one-pass matrix scrolling to reduce USB power resets.
