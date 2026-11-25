# Web UI and HTTP / WebSocket API

## Pages

- `/` — programmer dashboard.
- `/ir.html` — IR Remote Configurator.
- `/wsflash` — target programming WebSocket.
- `/wsir` — received IR frame WebSocket.
- `/terminal` — optional target terminal WebSocket.
- `/events` — Server-Sent Events for flasher and terminal state.

Static assets are served from LittleFS under `/www/`.

## IR Remote page

Each button has an address, command, and protocol selector. Controls can generate, randomize, download, and program the target image.

**Constant chip scan** defaults off. With it off:

- No periodic `#i;` probe is sent.
- Detect and programming still send their own commands.
- The user must wake the remote with a button press within the six-second window.
- The status chip shows `scan off` rather than claiming the target is awake or asleep.

With it on, the page sends `#i;` every two seconds. Probing is paused during an operation, and the switch is locked until the operation ends.

## HTTP routes

| Method | Route | Purpose |
|---:|---|---|
| GET / POST | `/rest/settings` | Read/update device settings |
| GET | `/rest/ir` | Last IR frame, receiver health, uptime, reset reason |
| GET | `/heap` | Free heap diagnostics |
| GET | `/reset` | Reset the CH32V003 target |
| GET | `/unbrick` | Whole-chip erase / clear read protection |
| POST | `/upload` | Legacy stub; not useful for current uploads |
| POST | `/flash` | Multipart legacy flash upload |
| GET | `/status` | Legacy flasher status |
| GET | `/reboot` | Reboot the ESP32-C3 |
| GET | `/events` | SSE event stream |

The current UI primarily uses `/wsflash`, not the legacy multipart `/flash` route.

`/rest/ir` response fields:

```json
{
  "armed": true,
  "edges": 0,
  "state": 0,
  "queued": 0,
  "valid": false,
  "addr": 0,
  "cmd": 0,
  "raw": "00000000",
  "proto": 0,
  "ext": false,
  "up": 0,
  "rst": 0,
  "hist": [0, 0, 0, 0, 0, 0, 0, 0]
}
```

`up` is seconds since boot. Common `rst` values include `4` panic, `6` task watchdog, and `9` brownout.

## `/wsir`

The server pushes decoded frames as JSON:

```json
{
  "t": 12345,
  "addr": 7,
  "cmd": 2,
  "raw": "FD020707",
  "proto": 2,
  "ext": false,
  "rep": 0
}
```

A newly connected client receives the cached last frame with `last:true`.

## `/wsflash`

Commands use `#command;argument;...`. All numeric arguments are **decimal**.

Examples:

```text
#i;
#b;
#E;
#r;134219776;64;
#w;134219776;64;
#w;134217728;2112;
```

A write uses two messages: a text command followed by a binary payload.

Reply codes:

| Code | Meaning |
|---:|---|
| `0` | Success |
| `1` | Bridge busy |
| `2` | SWIO link init failed |
| `3` | Bad or missing argument |
| `4` | Operation failed |
| `8` | Not implemented |
| `9` | Unknown command |

`#i;` halts and resumes the core to read chip information. On a sleeping target it returns `#2;Failed to init link`; press a remote button and retry.

## `/terminal`

Optional. Incoming messages begin with `#`; replies are binary beginning with `#`. UART mode is hardcoded to 115200 baud. On this board it conflicts with the IO21 IR receiver and is disabled by default.

## Connection limit

The original bridge allows two clients per WebSocket endpoint; a newer client can close the oldest one. A `/wsflash` command also closes `/terminal` clients.
