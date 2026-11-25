# Security and deployment status

This is a public source repository. Its static documentation is published at [foerfelixir.github.io/bear-buddy-webflasher](https://foerfelixir.github.io/bear-buddy-webflasher/).

## Device credentials

No deployment Wi-Fi credentials are stored in the current source, documentation, or checked-in binaries. `src/SRLConfig.h` contains generic setup-AP placeholders only. The ESP32 application and merged image are intentionally omitted because compiled firmware embeds those defaults.

Before deployment:

1. Replace `HOTSPOT_NAME` and `HOTSPOT_PASSWORD` in `src/SRLConfig.h` with your own values.
2. Build the ESP32 application locally; do not commit images containing private credentials.
3. Scan generated binaries for unwanted credential strings.
4. Audit any modified source and generated artifacts for local paths, logs, and other private data.

## Device exposure

The Bear-Buddy web server does not implement authentication or HTTPS. It is designed for a trusted local network. Do not expose port 80, `/wsflash`, `/wsir`, `/reset`, `/unbrick`, or `/reboot` directly to the internet.

Programming and erase endpoints can modify attached hardware. Physical and network access should be treated as equivalent to access to the device.

## Documentation site

`docs/index.html` is published through GitHub Pages as static documentation. The site does not expose or proxy the device web server; keep the Bear-Buddy itself on a trusted local network.
