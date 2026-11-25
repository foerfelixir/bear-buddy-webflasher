# Security and publication status

This repository and the associated GitHub repository are **private**. No GitHub Pages site has been published.

## Device credentials

No deployment Wi-Fi credentials are stored in the current source, documentation, or checked-in binaries. `src/SRLConfig.h` contains generic setup-AP placeholders only. The ESP32 application and merged image are intentionally omitted because compiled firmware embeds those defaults.

Before deployment or any public release:

1. Replace `HOTSPOT_NAME` and `HOTSPOT_PASSWORD` in `src/SRLConfig.h` with your own values.
2. Build the ESP32 application locally; do not commit images containing private credentials.
3. Scan generated binaries for unwanted credential strings.
4. Review Git history if the repository previously contained real credentials.
5. Audit the repository for local paths, logs, and other private data.

## Device exposure

The Bear-Buddy web server does not implement authentication or HTTPS. It is designed for a trusted local network. Do not expose port 80, `/wsflash`, `/wsir`, `/reset`, `/unbrick`, or `/reboot` directly to the internet.

Programming and erase endpoints can modify attached hardware. Physical and network access should be treated as equivalent to access to the device.

## GitHub Pages

`docs/index.html` is ready to be served as a static documentation page, but Pages remains disabled. A private GitHub Pages site may require a paid GitHub plan and can have different access semantics. Review that explicitly before enabling it.
