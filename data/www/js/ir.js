/*
 * IR Remote Configurator.
 *
 * Talks to the WCH WebLink bridge on /wsflash. The three codes live in a
 * dedicated 64-byte flash page on the CH32V003, so "Program" writes only that
 * page, at 0x08000800, and cannot touch the firmware. Each button carries an
 * address, a command and a protocol byte: NEC sends addr, ~addr, cmd, ~cmd
 * behind a 9 ms mark, Samsung repeats the address byte behind a 4.5 ms mark.
 * Every bit timing is shared, which is why one firmware can drive both.
 * Putting the config-aware firmware on a board in the first place is a
 * separate, explicit action. The bridge erases each 64-byte page as it
 * programs it and reboots the target afterwards, so new codes take effect
 * immediately.
 *
 * Offsets and sizes go on the wire in decimal: the firmware parses them with
 * atoi(), which would read "0x08000000" as 0.
 */

"use strict";

const FLASH_BASE   = 0x08000000;   // 134217728
const CODE_SIZE    = 2048;         // FLASH LENGTH in link.ld
const CFG_OFFSET   = 2048;         // config page offset inside the image
const CFG_ADDR     = 0x08000800;   // 134219776
const CFG_SIZE     = 64;           // one flash page
const CFG_MAGIC    = 0x32435249;   // "IRC2", little endian
const CFG_STRIDE   = 4;            // addr, cmd, proto, 0xFF per button
const CFG_SUM_LEN  = 16;           // bytes the checksum covers
const CFG_SUM_OFF  = 16;           // where that little-endian checksum sits
const TEMPLATE_URL = "fw/ir_remote.bin";

/* Protocol values exactly as the target firmware stores them. The bridge's own
   receiver numbers its protocols differently (IR_PROTO_* below), so
   useReceived() maps between the two rather than sharing one enum. */
const TG_NEC     = 0;
const TG_SAMSUNG = 1;
const TG_PROTO   = ["NEC", "Samsung"];
const TG_HDR_MARK = [9000, 4500];  // us of 38 kHz carrier that opens a frame

const NEC = {
  hdrSpace: 4500,
  bitMark: 560, zeroSpace: 560, oneSpace: 1690,
};

const BUTTONS = [
  { name: "SW1", pin: "PC4", addr: 0x00, cmd: 152, proto: TG_NEC },
  { name: "SW2", pin: "PC2", addr: 0x00, cmd: 31, proto: TG_NEC },
  { name: "SW3", pin: "PC1", addr: 0x00, cmd: 62, proto: TG_NEC },
];

const FACTORY = BUTTONS.map(({ addr, cmd, proto }) => ({ addr, cmd, proto }));

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/wsflash`;

const state = {
  ws: null,
  open: false,
  pending: null,
  chunks: [],
  expected: 0,
  codes: FACTORY.map((c) => ({ ...c })),
  stored: null,        // what was last read from / written to the chip
  selected: 0,
  template: null,
  poll: null,
  scan: false,         // constant chip scan; off unless the page's switch says so
  awake: null,
  protected: null,     // RDPR says flash reads and writes are blocked
  irWs: null,
  irOpen: false,
  irLast: null,        // most recent frame the bridge's own receiver decoded
  irHistory: [],
};

const $ = (sel) => document.querySelector(sel);
const el = {
  linkStatus: $("#link-status"),
  targetStatus: $("#target-status"),
  targetChip: $("#target-chip"),
  remote: $("#remote"),
  remoteLens: $("#remote-lens"),
  codePanel: $("#code-panel"),
  wave: $("#wave"),
  frameTitle: $("#frame-title"),
  frameStats: $("#frame-stats"),
  wakeBox: $("#wake-box"),
  scanToggle: $("#scan-toggle"),
  deviceInfo: $("#device-info"),
  progress: $("#progress"),
  progressBar: $("#progress-bar"),
  progressMeta: $("#progress-meta"),
  console: $("#console"),
  toasts: $("#toasts"),
};

/* ------------------------------------------------------------------ bridge */

function connect() {
  if (state.ws && state.ws.readyState <= WebSocket.OPEN) return;
  state.ws = new WebSocket(WS_URL);
  state.ws.binaryType = "arraybuffer";
  state.ws.onopen = () => {
    state.open = true;
    setChip("link-status", "ok", "bridge online");
    log("connected to /wsflash", "ok");
    /* A fresh link knows nothing about the target yet, so with the scan off the
       chip has to say that instead of keeping the offline error it showed. */
    if (state.scan) startPolling(); else setScanIdle();
  };
  state.ws.onclose = () => {
    state.open = false;
    settlePending(new Error("bridge connection closed"));
    setChip("link-status", "err", "bridge offline");
    stopPolling();
    // With the scan off the page never claimed to know the target, so the chip
    // goes neutral rather than reporting a failure it is not in a position to
    // diagnose; the link chip already says the bridge is gone.
    if (state.scan) setChip("target-status", "err", "target unknown");
    else setScanIdle();
    log("bridge connection closed", "err");
    setTimeout(connect, 2000);
  };
  state.ws.onerror = () => log("bridge socket error", "err");
  state.ws.onmessage = onMessage;
}

function onMessage(event) {
  if (event.data instanceof ArrayBuffer) {
    const bytes = new Uint8Array(event.data);
    state.chunks.push(bytes);
    const got = state.chunks.reduce((n, c) => n + c.length, 0);
    if (state.pending && state.pending.kind === "read" && state.expected) {
      setProgress(got, state.expected, `reading ${got} / ${state.expected} bytes`);
    }
    return;
  }
  onText(String(event.data));
}

function onText(text) {
  if (!text.startsWith("#")) {
    log(`<< ${text}`, "tx");
    if (state.pending && state.pending.kind === "info") settlePending(null, text);
    return;
  }
  const semi = text.indexOf(";");
  const code = Number.parseInt(text.slice(1, semi < 0 ? text.length : semi), 10);
  const msg = semi < 0 ? "" : text.slice(semi + 1);
  log(`<< #${code} ${msg}`, code === 0 ? "tx" : "err");

  const p = state.pending;
  if (!p) return;
  if (code !== 0) { settlePending(new Error(describe(code, msg))); return; }
  // Chip info is the one reply the firmware sends without a "#code;" prefix.
  if (p.kind === "info") return;
  // Multi-stage operations emit several "#0;" messages; only the completion counts.
  if (p.until && !p.until.test(msg)) return;
  settlePending(null, p.kind === "read" ? concatenate() : msg);
}

function describe(code, msg) {
  const known = {
    1: "bridge is busy with another operation",
    2: "SWIO link init failed - is the remote in standby? Press one of its buttons",
    3: "malformed command or argument out of range",
    4: "flash operation failed on the target",
    8: "not implemented by this firmware",
    9: "unknown command",
  };
  return `${msg || "error"} (#${code}: ${known[code] || "bridge reported a failure"})`;
}

function concatenate() {
  const total = state.chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of state.chunks) { out.set(c, at); at += c.length; }
  return out;
}

function settlePending(error, value) {
  const p = state.pending;
  if (!p) return;
  state.pending = null;
  clearTimeout(p.timer);
  if (error) p.reject(error); else p.resolve(value);
}

// until: optional pattern the "#0;" message must match before the operation
// counts as finished. Omit it for single-reply commands.
function beginOp(kind, timeoutMs, until) {
  if (!state.open) return Promise.reject(new Error("not connected to the bridge"));
  if (state.pending) return Promise.reject(new Error("another operation is already running"));
  state.chunks = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settlePending(new Error(`${kind} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    state.pending = { kind, resolve, reject, timer, until };
  });
}

function waitFor(kind, timeoutMs, until = null) { return beginOp(kind, timeoutMs, until); }

function request(kind, command, timeoutMs, until = null) {
  // Arm the listener before sending. When it cannot be armed - no link, or
  // another operation already holds the bridge - the command must not go out,
  // or the bridge is left waiting for a reply and an upload nobody sends.
  if (!state.open) return Promise.reject(new Error("not connected to the bridge"));
  if (state.pending) return Promise.reject(new Error("another operation is already running"));
  const promise = beginOp(kind, timeoutMs, until);
  log(`>> ${command}`, "tx");
  state.ws.send(command);
  return promise;
}

/* ------------------------------------------------------------- config page */

function buildConfig(codes) {
  const page = new Uint8Array(CFG_SIZE).fill(0xff);
  page[0] = CFG_MAGIC & 0xff;
  page[1] = (CFG_MAGIC >> 8) & 0xff;
  page[2] = (CFG_MAGIC >> 16) & 0xff;
  page[3] = (CFG_MAGIC >> 24) & 0xff;
  codes.forEach((c, i) => {
    page[4 + i * CFG_STRIDE] = c.addr;
    page[5 + i * CFG_STRIDE] = c.cmd;
    page[6 + i * CFG_STRIDE] = c.proto;
  });
  let sum = 0;
  for (let i = 0; i < CFG_SUM_LEN; i++) sum += page[i];
  page[CFG_SUM_OFF] = sum & 0xff;
  page[CFG_SUM_OFF + 1] = (sum >> 8) & 0xff;
  page[CFG_SUM_OFF + 2] = (sum >> 16) & 0xff;
  page[CFG_SUM_OFF + 3] = (sum >> 24) & 0xff;
  return page;
}

/* Returns the codes stored on the chip, or null when the page is blank, the
   checksum does not match, or a protocol byte is one this firmware does not
   implement - in which case the firmware uses its compiled factory defaults. */
function parseConfig(page) {
  if (!page || page.length < CFG_SUM_OFF + 4) return null;
  const le32 = (o) => page[o] | (page[o + 1] << 8) | (page[o + 2] << 16) | (page[o + 3] << 24);
  if ((le32(0) >>> 0) !== CFG_MAGIC) return null;
  let sum = 0;
  for (let i = 0; i < CFG_SUM_LEN; i++) sum += page[i];
  if ((le32(CFG_SUM_OFF) >>> 0) !== (sum >>> 0)) return null;
  const codes = [0, 1, 2].map((i) => ({
    addr: page[4 + i * CFG_STRIDE],
    cmd: page[5 + i * CFG_STRIDE],
    proto: page[6 + i * CFG_STRIDE],
  }));
  if (codes.some((c) => c.proto > TG_SAMSUNG)) return null;
  return codes;
}

async function fetchTemplate() {
  if (state.template) return state.template;
  log(`>> GET ${TEMPLATE_URL}`, "tx");
  const res = await fetch(TEMPLATE_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`could not fetch ${TEMPLATE_URL} (HTTP ${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length !== CODE_SIZE + CFG_SIZE) {
    throw new Error(`template is ${buf.length} bytes, expected ${CODE_SIZE + CFG_SIZE}`);
  }
  state.template = buf;
  log(`<< firmware template ${buf.length} bytes`, "tx");
  return buf;
}

/* ------------------------------------------------------------ generated image */

/* The full flashable target image: the firmware template with the generated
   config page spliced in at its fixed offset. Shared by the downloads and by
   Flash firmware, so what you can inspect is byte-for-byte what gets written. */
async function buildImage() {
  const template = await fetchTemplate();
  const image = template.slice();
  image.set(buildConfig(state.codes), CFG_OFFSET);
  if (!parseConfig(image.subarray(CFG_OFFSET, CFG_OFFSET + CFG_SIZE))) {
    throw new Error("internal error: built config page failed its own checksum");
  }
  return image;
}

function hexDump(bytes) {
  const rows = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const slice = [...bytes.subarray(off, off + 16)];
    rows.push(`${off.toString(16).padStart(4, "0")}  ${slice.map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
  }
  return rows.join("\n");
}

/* Intel HEX, which is what the WCH ISP tools ask for. The image is 2112 bytes
   based at 0x08000000, so its low 16 bits never wrap and no extended address
   record is needed. */
function toIntelHex(bytes, base) {
  const two = (n) => (n & 0xff).toString(16).padStart(2, "0").toUpperCase();
  const lines = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const slice = bytes.subarray(off, off + 16);
    const addr = (base + off) & 0xffff;
    const body = [slice.length, (addr >> 8) & 0xff, addr & 0xff, 0, ...slice];
    const sum = body.reduce((n, b) => n + b, 0);
    lines.push(`:${body.map(two).join("")}${two(~sum + 1)}`);
  }
  return `${lines.join("\r\n")}\r\n:00000001FF\r\n`;
}

function codesTag() {
  return state.codes
    .map((c) => `${hex(c.addr).slice(2)}-${hex(c.cmd).slice(2)}${c.proto === TG_SAMSUNG ? "S" : ""}`)
    .join("_");
}

function save(data, filename) {
  const url = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* Keeps the Generate card a truthful picture of what a download would contain,
   including the checksum the firmware validates on every wake. */
function renderGenerate() {
  const page = buildConfig(state.codes);
  const sum = page.subarray(0, CFG_SUM_LEN).reduce((n, b) => n + b, 0);

  $("#gen-badge").textContent = `${CODE_SIZE + CFG_SIZE} B image`;
  $("#gen-summary").replaceChildren(
    kv("Codes (proto/addr/cmd)", state.codes.map((c) => `${TG_PROTO[c.proto]} ${hex(c.addr)}/${hex(c.cmd)}`).join("   ")),
    kv("Magic", `IRC2 = ${page.subarray(0, 4).join(" ")}`),
    kv("Checksum", `0x${sum.toString(16).toUpperCase().padStart(8, "0")} over bytes 0x00..0x0F`),
    kv("Config page", `${hexAddr(CFG_ADDR)}, ${CFG_SIZE} B`),
    kv("Full image", `${hexAddr(FLASH_BASE)}, ${CODE_SIZE + CFG_SIZE} B`),
  );
  $("#gen-page").textContent = hexDump(page);
}

/* The step that does not depend on this link working: hand the generated
   image to a programmer that can deal with read protection on its own terms,
   and confirm the remote actually responds before writing anything. */
async function doDownload(kind) {
  try {
    const image = await buildImage();
    const name = `ir_remote_${codesTag()}.${kind === "hex" ? "hex" : "bin"}`;
    save(kind === "hex" ? toIntelHex(image, FLASH_BASE) : image, name);
    log(`downloaded ${name} - ${image.length} bytes of flash image at ${hexAddr(FLASH_BASE)}`, "ok");
    toast(`Saved ${name}`, "ok");
  } catch (err) {
    log(err.message, "err");
    toast(err.message, "err");
  }
}

function doDownloadPage() {
  const page = buildConfig(state.codes);
  const name = `ir_config_${codesTag()}.bin`;
  save(page, name);
  log(`downloaded ${name} - ${page.length} bytes for ${hexAddr(CFG_ADDR)} only`, "ok");
  toast(`Saved ${name}`, "ok");
}

/* --------------------------------------------------------------- waveform */

/* The four bytes on the wire. Samsung repeats the address instead of
   complementing it; everything after the header mark is identical. */
function frameBytes(addr, cmd, proto) {
  const second = proto === TG_SAMSUNG ? addr : ~addr & 0xff;
  return [addr, second, cmd, ~cmd & 0xff];
}

function frameSegments(addr, cmd, proto) {
  const segs = [
    { us: TG_HDR_MARK[proto], cls: "mark hdr" },
    { us: NEC.hdrSpace, cls: "space" },
  ];
  for (const byte of frameBytes(addr, cmd, proto)) {
    for (let i = 0; i < 8; i++) {
      segs.push({ us: NEC.bitMark, cls: "mark" });
      segs.push({ us: (byte >> i) & 1 ? NEC.oneSpace : NEC.zeroSpace, cls: "space" });
    }
  }
  segs.push({ us: NEC.bitMark, cls: "mark" });
  return segs;
}

function renderWave(addr, cmd, proto) {
  const segs = frameSegments(addr, cmd, proto);
  const frag = document.createDocumentFragment();
  for (const s of segs) {
    const bar = document.createElement("i");
    bar.className = s.cls;
    bar.style.flexGrow = String(s.us);
    bar.style.flexBasis = "0";
    frag.appendChild(bar);
  }
  el.wave.replaceChildren(frag);

  const total = segs.reduce((n, s) => n + s.us, 0);
  const ones = segs.filter((s) => s.cls === "space" && s.us === NEC.oneSpace).length;
  const bits = frameBytes(addr, cmd, proto)
    .flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >> i) & 1))
    .join("");
  el.frameStats.replaceChildren(
    kv("Protocol", `${TG_PROTO[proto]} · ${TG_HDR_MARK[proto] / 1000} ms header mark`),
    kv("32-bit word", hex32(addr, cmd, proto)),
    kv("LSB-first bits", bits),
    kv("Frame length", `${(total / 1000).toFixed(2)} ms`),
    kv("Ones / zeros", `${ones} / ${32 - ones}`),
    kv("Carrier", "38.46 kHz, 25.6 % duty"),
  );
}

function hex32(addr, cmd, proto) {
  const b = frameBytes(addr, cmd, proto || TG_NEC);
  const word = ((b[0] << 0) | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  return `0x${word.toString(16).padStart(8, "0").toUpperCase()}`;
}

function kv(key, value) {
  const wrap = document.createElement("div");
  const k = document.createElement("dt");
  k.textContent = key;
  const v = document.createElement("dd");
  v.textContent = value;
  wrap.append(k, v);
  return wrap;
}

/* ------------------------------------------------------------------- views */

function buildRemote() {
  BUTTONS.forEach((b, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "remote-btn";
    btn.dataset.index = String(i);
    btn.setAttribute("aria-pressed", String(i === state.selected));

    const key = document.createElement("span");
    key.className = "remote-key";
    key.dataset.sw = String(i);
    key.textContent = String(i + 1);

    const meta = document.createElement("span");
    meta.className = "remote-meta";
    const name = document.createElement("span");
    name.className = "remote-name";
    name.textContent = b.name;
    const code = document.createElement("span");
    code.className = "remote-code";
    code.dataset.code = String(i);
    const pin = document.createElement("span");
    pin.className = "remote-pin";
    pin.textContent = `${b.pin} · EXTI${i === 0 ? 4 : i === 1 ? 2 : 1} falling edge`;
    meta.append(name, code, pin);

    const fire = document.createElement("span");
    fire.className = "badge";
    fire.dataset.fire = String(i);
    fire.textContent = "idle";

    btn.append(key, meta, fire);
    btn.addEventListener("click", () => select(i));
    el.remote.appendChild(btn);
  });
}

function buildCodeCards() {
  BUTTONS.forEach((b, i) => {
    const card = document.createElement("article");
    card.className = "card code-card";
    card.dataset.index = String(i);
    card.innerHTML = `
      <div class="card-head">
        <h2><span class="swatch" data-sw="${i}">${i + 1}</span> ${b.name}</h2>
        <span class="badge">${b.pin}</span>
        <button class="card-toggle" type="button" data-collapse aria-expanded="true" aria-label="Collapse">&minus;</button>
      </div>
      <div class="card-body">
        <div class="form-grid">
          <label class="fld span2">
            <span>Protocol</span>
            <select class="proto-in" data-field="proto" aria-label="Protocol">
              <option value="0">NEC &mdash; 9 ms header mark, address then ~address</option>
              <option value="1">Samsung &mdash; 4.5 ms header mark, address sent twice</option>
            </select>
          </label>
          <label class="fld">
            <span>Address</span>
            <div class="fld-row">
              <input type="number" min="0" max="255" step="1" data-field="addr" inputmode="numeric" />
              <input type="text" class="mono hex-in" data-field="addrHex" maxlength="4" spellcheck="false" aria-label="Address in hex" />
            </div>
            <input type="range" min="0" max="255" step="1" data-field="addrRange" aria-label="Address slider" />
          </label>
          <label class="fld">
            <span>Command</span>
            <div class="fld-row">
              <input type="number" min="0" max="255" step="1" data-field="cmd" inputmode="numeric" />
              <input type="text" class="mono hex-in" data-field="cmdHex" maxlength="4" spellcheck="false" aria-label="Command in hex" />
            </div>
            <input type="range" min="0" max="255" step="1" data-field="cmdRange" aria-label="Command slider" />
          </label>
        </div>
        <div class="code-actions">
          <button class="btn" type="button" data-act="random">Randomize</button>
          <button class="btn" type="button" data-act="unique">Unique command</button>
          <button class="btn" type="button" data-act="factory">Factory code</button>
          <button class="btn" type="button" data-act="preview">Preview frame</button>
        </div>
        <div class="code-summary">
          <span class="bytes" data-summary></span>
          <span data-flag></span>
        </div>
      </div>`;

    card.addEventListener("input", (e) => onCodeInput(i, e.target));
    card.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]");
      if (!act) return;
      if (act.dataset.act === "random") { state.codes[i] = { ...state.codes[i], addr: rand(), cmd: rand() }; select(i); syncAll(); toast(`${BUTTONS[i].name} randomized`, "ok"); }
      if (act.dataset.act === "unique") { state.codes[i] = { ...state.codes[i], cmd: uniqueCmd(i) }; select(i); syncAll(); }
      if (act.dataset.act === "factory") { state.codes[i] = { ...FACTORY[i] }; select(i); syncAll(); }
      if (act.dataset.act === "preview") { select(i); firePreview(i); }
    });

    el.codePanel.appendChild(card);
  });
}

function syncAll() {
  state.codes.forEach((c, i) => {
    const card = el.codePanel.querySelector(`.code-card[data-index="${i}"]`);
    if (!card) return;
    const set = (sel, val) => { const n = card.querySelector(sel); if (n && n.value !== String(val)) n.value = String(val); };
    set('[data-field="addr"]', c.addr);
    set('[data-field="cmd"]', c.cmd);
    set('[data-field="addrRange"]', c.addr);
    set('[data-field="cmdRange"]', c.cmd);
    set('[data-field="addrHex"]', hex(c.addr));
    set('[data-field="cmdHex"]', hex(c.cmd));
    set('[data-field="proto"]', c.proto);

    card.querySelector("[data-summary]").textContent =
      `${TG_PROTO[c.proto]} · addr ${hex(c.addr)} · cmd ${hex(c.cmd)} → ${hex32(c.addr, c.cmd, c.proto)}`;

    const flag = card.querySelector("[data-flag]");
    const dirty = state.stored && (state.stored[i].addr !== c.addr || state.stored[i].cmd !== c.cmd ||
                                   state.stored[i].proto !== c.proto);
    flag.textContent = state.stored ? (dirty ? "not on device" : "on device") : "never read";
    flag.className = state.stored ? (dirty ? "dirty" : "clean") : "dirty";

    const code = el.remote.querySelector(`[data-code="${i}"]`);
    if (code) code.textContent = `${TG_PROTO[c.proto]} · addr ${hex(c.addr)} · cmd ${hex(c.cmd)}`;
  });
  const sel = state.codes[state.selected];
  renderWave(sel.addr, sel.cmd, sel.proto);
  renderGenerate();
}

function onCodeInput(i, input) {
  const field = input.dataset.field;
  if (!field) return;
  const c = state.codes[i];
  if (field === "addrHex" || field === "cmdHex") {
    const raw = input.value.replace(/^0x/i, "").trim();
    if (!/^[0-9a-fA-F]{0,2}$/.test(raw)) { input.value = hex(field.startsWith("addr") ? c.addr : c.cmd); return; }
    if (raw === "") return;
    c[field.startsWith("addr") ? "addr" : "cmd"] = Number.parseInt(raw, 16) & 0xff;
  } else if (field === "addr" || field === "cmd") {
    const n = Number.parseInt(input.value, 10);
    if (Number.isNaN(n)) return;
    c[field] = clamp(n);
  } else if (field === "addrRange" || field === "cmdRange") {
    c[field.startsWith("addr") ? "addr" : "cmd"] = clamp(Number(input.value));
  } else if (field === "proto") {
    c.proto = Number(input.value) === TG_SAMSUNG ? TG_SAMSUNG : TG_NEC;
  }
  select(i);
  syncAll();
}

/* ------------------------------------------------------- target awareness */

function startPolling() {
  stopPolling();
  if (!state.scan || !state.open) return;
  state.poll = setInterval(probeTarget, 2000);
  probeTarget();
}

function stopPolling() {
  if (state.poll) { clearInterval(state.poll); state.poll = null; }
}

/* Probing is opt-in now. chipInfo() halts and resumes the core, so a probe does
   not disturb the remote, but it also holds the target's 6-second debug window
   open indefinitely, and Detect plus the halt a write performs already cover
   everything the page needs. startPolling() therefore does nothing until the
   switch is on, which keeps its existing callers - link open, end of an action -
   correct without each of them having to ask. */
function setScan(on) {
  state.scan = on;
  el.scanToggle.checked = on;
  stopPolling();
  if (on) {
    if (state.open) startPolling();
    else setScanWaiting();
  } else {
    setScanIdle();
  }
  log(on
    ? "constant chip scan on - probing the target every 2 s"
    : "constant chip scan off - Detect chip and Program codes still talk to the target when clicked",
    "info");
}

/* Scan on with no bridge: the first probe goes out the moment the link is up. */
function setScanWaiting() {
  state.awake = null;
  setChip("target-status", "wait", "waiting for bridge");
  el.wakeBox.dataset.state = "warn";
  el.wakeBox.querySelector("strong").textContent = "Waiting for the bridge.";
  $("#wake-text").textContent =
    "Constant chip scan is on, but the Bear-Buddy bridge is not connected. It " +
    "reconnects on its own, and the chip is probed as soon as the link is up.";
}

/* With nothing probing, the page cannot claim awake or standby, so the chip and
   the guidance both go neutral rather than showing a stale answer. */
function setScanIdle() {
  state.awake = null;
  setChip("target-status", "idle", "scan off");
  el.wakeBox.dataset.state = "off";
  el.wakeBox.querySelector("strong").textContent = "Constant chip scan is off.";
  $("#wake-text").textContent = SCAN_OFF_TEXT;
}

const SCAN_OFF_TEXT =
  "Nothing is polling the CH32V003. Press a button on the remote to open its " +
  "6-second SWIO window, then click Detect chip or Program codes before it closes " +
  "- once SWIO is moving, that window stays open. Switch the scan on to have this " +
  "page hold it open for you.";

/* chipInfo() halts and then resumes the core, so this probe does not disturb
   the remote. A target in standby cannot answer at all, which is how the
   asleep state is detected. */
let probeInFlight = null;

function probeTarget() {
  if (!state.open || state.pending || probeInFlight) return;
  probeInFlight = request("info", "#i;", 6000)
    // The switch can go off while a probe is still in flight; its answer is
    // then stale on arrival and must not overwrite the neutral state.
    .then((raw) => { if (state.scan) { setAwake(true); showDeviceInfo(parseChipInfo(raw)); } })
    .catch((err) => { if (state.scan) { setAwake(false); log(`probe: ${err.message}`, "warn"); } })
    .finally(() => { probeInFlight = null; });
}

async function settleProbe() {
  if (probeInFlight) await probeInFlight;
}

function setAwake(awake) {
  if (state.awake === awake) return;
  state.awake = awake;
  if (awake) {
    setChip("target-status", "ok", "target awake");
    el.wakeBox.dataset.state = "ok";
    el.wakeBox.querySelector("strong").textContent = "Target is awake - programming window open.";
    $("#wake-text").textContent = "SWIO is reachable right now. Click Program codes before the chip returns to standby.";
  } else {
    setChip("target-status", "warn", "target in standby");
    el.wakeBox.dataset.state = "warn";
    el.wakeBox.querySelector("strong").textContent = "Wake the remote before programming.";
    $("#wake-text").textContent =
      "SWIO is dead while the CH32V003 is in standby. Press any button on the remote: " +
      "that opens a 6-second window, and " +
      (state.scan
        ? "it stays open while this page keeps probing the chip."
        : "click Detect chip or Program codes before it closes.");
  }
}

/* The option word holds RDPR in its low half and the complement in the high
   half; 0x5AA5 is the only unprotected value. When it is anything else the
   flash array refuses reads and programs over SWIO, but the option bytes and
   the ESIG unique ID are separate memory and stay accessible - which is why a
   protected chip detects perfectly and still cannot be read or written. */
const RDPR_UNPROTECTED = 0x5aa5;

function parseChipInfo(raw) {
  const f = raw.split(";");
  const rdpr = Number.parseInt(f[1], 16);
  return {
    user: f[0],
    rdpr: f[1],
    flash: f[11] || "?",
    uid: (f[8] + f[9] + f[10]).toUpperCase(),
    protected: Number.isFinite(rdpr) && rdpr !== RDPR_UNPROTECTED,
  };
}

function showDeviceInfo(info) {
  state.protected = info.protected;
  el.deviceInfo.replaceChildren(
    kv("Chip", "CH32V003J4M6"),
    kv("Flash reported", info.flash),
    kv("Unique ID", info.uid),
    kv("Read protection", info.protected ? `ENABLED (RDPR 0x${info.rdpr})` : `disabled (RDPR 0x${info.rdpr})`),
    kv("Config page", `${hexAddr(CFG_ADDR)} (${CFG_SIZE} B)`),
  );
  $("#target-chip").querySelector("[data-text]").textContent =
    info.protected ? "CH32V003 · read-protected" : "CH32V003 · 16 kB";
}

/* --------------------------------------------------------------- actions */

async function doDetect() {
  await run("detect", async () => {
    const raw = await request("info", "#i;", 15000);
    const info = parseChipInfo(raw);
    showDeviceInfo(info);
    setAwake(true);
    log(`chip: ${info.uid}, flash ${info.flash}, RDPR 0x${info.rdpr}`, "ok");
    if (info.protected) {
      log("RDPR is not 0x5AA5, so the flash array refuses reads and programs over SWIO. The option bytes and the unique ID live in separate memory, which is why Detect still works. Download the image and flash it with your own programmer, or click Unbrick to erase the chip and clear protection.", "warn");
      toast("Read protection is ON - download the image instead", "warn");
    } else {
      toast("Chip detected", "ok");
    }
  });
}

/* The bridge answers "#r;" with "#0;Ready for download" before it has touched
   the target, and its page-aligned write path never reads back to verify, so
   nothing here counts as a read unless the payload is a full page holding
   something other than fill. A failed read must never overwrite the codes on
   screen - they are the only trustworthy copy when the chip will not talk. */
async function doRead() {
  await run("read", async () => {
    state.expected = CFG_SIZE;
    const page = await request("read", `#r;${CFG_ADDR};${CFG_SIZE};`, 30000, /complete/i);

    if (page.length !== CFG_SIZE) {
      throw new Error(`read returned ${page.length} bytes, expected ${CFG_SIZE}`);
    }
    if (page.every((b) => b === page[0])) {
      state.stored = null;
      syncAll();
      log(`${page.length} bytes of ${hex(page[0])} came back. That is a blocked or never-programmed read, not data - the codes on screen were left untouched.`, "warn");
      toast("Read returned fill, not data", "warn");
      return;
    }

    const codes = parseConfig(page);
    if (!codes) {
      state.stored = null;
      syncAll();
      log("the page holds data but fails its magic, checksum or protocol byte, so the chip is running factory NEC codes 152 / 31 / 62. The codes on screen were left untouched.", "warn");
      toast("Page present but invalid", "warn");
      return;
    }

    state.stored = codes.map((c) => ({ ...c }));
    state.codes = codes.map((c) => ({ ...c }));
    syncAll();
    log(`read codes: ${codes.map((c) => `${TG_PROTO[c.proto]} addr ${hex(c.addr)} cmd ${hex(c.cmd)}`).join(", ")}`, "ok");
    toast("Codes read from device", "ok");
  });
}

function warnIfProtected(what) {
  if (!state.protected) return;
  log(`the target reports read protection, so ${what} will most likely be blocked. Download the image and use your own programmer, or Unbrick first.`, "warn");
}

/* Writes one 64-byte page. The bridge erases every page it programs, so
   keeping this to the config page is what makes it incapable of damaging the
   firmware. The target reboots afterwards and re-reads the page on wake. */
async function doProgram() {
  await run("program", async () => {
    warnIfProtected("the page write");
    const page = buildConfig(state.codes);
    if (!parseConfig(page)) throw new Error("internal error: built config page failed its own checksum");

    log(`config page ${page.length} bytes -> ${hexAddr(CFG_ADDR)}`, "info");
    setProgress(0, page.length, "arming the bridge");

    await request("program-setup", `#w;${CFG_ADDR};${page.length};`, 15000);
    const done = waitFor("program", 60000, /success|complete|done|failed/i);
    state.ws.send(page.buffer.slice(page.byteOffset, page.byteOffset + page.byteLength));
    setProgress(page.length, page.length, "writing 1 flash page");
    await done;

    state.stored = state.codes.map((c) => ({ ...c }));
    syncAll();
    log("config page written - target rebooted with the new codes", "ok");
    toast("Programmed - remote rebooted", "ok");
    firePreview(state.selected);
  });
}

/* The only action that replaces the firmware: the whole generated image, for a
   board still running the old build with the codes compiled in. */
async function doFlashFirmware() {
  await run("flash-firmware", async () => {
    warnIfProtected("the firmware write");
    const image = await buildImage();

    log(`image ${image.length} bytes: firmware ${CODE_SIZE} B + config ${CFG_SIZE} B -> ${hexAddr(FLASH_BASE)}`, "info");
    setProgress(0, image.length, "arming the bridge");

    await request("program-setup", `#w;${FLASH_BASE};${image.length};`, 15000);
    const done = waitFor("program", 120000, /success|complete|done|failed/i);
    state.ws.send(image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength));
    setProgress(image.length, image.length, `writing ${image.length / CFG_SIZE} flash pages`);
    await done;

    state.stored = state.codes.map((c) => ({ ...c }));
    syncAll();
    log("firmware and config page written - target rebooted", "ok");
    toast("Firmware flashed - remote rebooted", "ok");
  });
}

/* Whole-chip erase, which is also how read protection comes off. It destroys
   the firmware, so Flash firmware always has to follow it. */
async function doUnbrick() {
  const ok = window.confirm(
    "Erase the entire CH32V003 flash?\n\n" +
    "This clears read protection and destroys the firmware.\n" +
    "You must click Flash firmware afterwards."
  );
  if (!ok) return;
  await run("unbrick", async () => {
    await request("unbrick", "#E;", 90000, /success|erased|unbrick|failed/i);
    state.stored = null;
    state.protected = null;
    syncAll();
    log("chip erased - click Flash firmware to reinstall, then Detect to confirm protection is gone", "ok");
    toast("Chip erased - flash the firmware next", "warn");
  });
}

async function run(kind, fn) {
  const buttons = ["btn-detect", "btn-read", "btn-program", "btn-firmware", "btn-unbrick", "scan-toggle"]
    .map((id) => $(`#${id}`))
    .filter(Boolean);
  buttons.forEach((b) => { b.disabled = true; });
  showProgress(true);
  log(`--- ${kind} ---`, "info");
  // A background probe must never make a user action fail, so pause polling
  // and wait out any probe already in flight before touching the bridge. The
  // switch is locked for the same reason: starting a scan mid-write would fire
  // a probe the bridge can only refuse.
  stopPolling();
  await settleProbe();
  try {
    await fn();
  } catch (err) {
    log(err.message, "err");
    toast(err.message, "err");
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
    hideProgressSoon();
    if (state.open) startPolling();
  }
}

/* ------------------------------------------------------------- simulation */

function select(i) {
  state.selected = i;
  el.remote.querySelectorAll(".remote-btn").forEach((b) => {
    b.setAttribute("aria-pressed", String(Number(b.dataset.index) === i));
  });
  const c = state.codes[i];
  el.frameTitle.textContent = `${BUTTONS[i].name} · ${BUTTONS[i].pin} · ${TG_PROTO[c.proto]}`;
  renderWave(c.addr, c.cmd, c.proto);
}

/* Animates the emitter so the user can see what pressing the button does. */
function firePreview(i) {
  const badge = el.remote.querySelector(`[data-fire="${i}"]`);
  el.remoteLens.dataset.firing = "true";
  if (badge) badge.textContent = "sending";
  const c = state.codes[i];
  const total = frameSegments(c.addr, c.cmd, c.proto).reduce((n, s) => n + s.us, 0);
  setTimeout(() => {
    el.remoteLens.dataset.firing = "false";
    if (badge) badge.textContent = "idle";
  }, Math.min(total / 1000, 400));
}

/* --------------------------------------------------------------- helpers */

const clamp = (n) => Math.max(0, Math.min(255, n | 0));
const rand = () => Math.floor(Math.random() * 256);
const hex = (n) => `0x${clamp(n).toString(16).padStart(2, "0").toUpperCase()}`;
const hexAddr = (n) => `0x${n.toString(16).padStart(8, "0").toUpperCase()}`;

/* A command no other button already uses, so the three never collide. */
function uniqueCmd(index) {
  const taken = new Set(state.codes.filter((_, i) => i !== index).map((c) => c.cmd));
  let cmd = rand();
  let guard = 0;
  while (taken.has(cmd) && guard++ < 64) cmd = rand();
  return cmd;
}

function randomizeAll() {
  state.codes = state.codes.map((c, i) => ({ ...c, cmd: uniqueCmd(i) }));
  syncAll();
  toast("All three commands randomized", "ok");
}

function setChip(id, stateName, text) {
  const chip = $(`#${id}`);
  chip.dataset.state = stateName;
  chip.querySelector("[data-text]").textContent = text;
}

function setProgress(done, total, text) {
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  el.progressBar.style.width = `${pct}%`;
  el.progressMeta.textContent = text || `${done} / ${total} bytes`;
}

function showProgress(on) { el.progress.hidden = !on; }
let progressTimer = null;
function hideProgressSoon() {
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => showProgress(false), 1400);
}

function stamp() {
  return new Date().toLocaleTimeString([], { hour12: false });
}

function log(message, level = "info") {
  const line = document.createElement("div");
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = `[${stamp()}] `;
  const body = document.createElement("span");
  body.className = `l-${level}`;
  body.textContent = message;
  line.append(t, body);
  el.console.appendChild(line);
  while (el.console.childElementCount > 800) el.console.firstElementChild.remove();
  el.console.scrollTop = el.console.scrollHeight;
}

function toast(message, level = "info") {
  const t = document.createElement("div");
  t.className = `toast ${level}`;
  t.textContent = message;
  el.toasts.appendChild(t);
  setTimeout(() => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 220);
  }, 4200);
}

/* --------------------------------------------------- bridge IR receiver */

/* Bear-Buddy has its own 38 kHz receiver on IO21, so the bridge can hear the
   remote it is programming. It reports on a second socket: keeping these frames
   off /wsflash means an incoming code can never be mistaken for the reply to a
   program or read that is still in flight. */
const IR_WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/wsir`;
const IR_HISTORY_MAX = 12;

/* Protocol ids the firmware sends with each frame. Samsung shares NEC's bit
   timings but not its header or its address check, so the decoder labels which
   one it locked onto and the panel has to show it rather than guess. */
const IR_PROTO_NEC = 0;
const IR_PROTO_NEC_EXT = 1;
const IR_PROTO_SAMSUNG = 2;
const IR_PROTO_NAME = ["NEC standard", "NEC extended - 16-bit address", "Samsung - address repeated"];
const IR_PROTO_TAG = ["std", "ext", "sam"];

/* The bridge sends the 32-bit word as big-endian hex, so the address that went
   out first on the wire is the last byte pair: addr, ~addr, cmd, ~cmd. */
function necBytes(frame) {
  const r = String(frame.raw || "").toUpperCase().padStart(8, "0");
  return [r.slice(6, 8), r.slice(4, 6), r.slice(2, 4), r.slice(0, 2)].map((h) => parseInt(h, 16));
}

/* NEC standard sends the address twice, once inverted. When the second byte is
   not the complement of the first it is extended NEC, where the pair is one
   16-bit address rather than a checksum. */
function necAddress(frame, bytes) {
  return frame.ext ? ((bytes[1] << 8) | bytes[0]) & 0xffff : frame.addr & 0xff;
}

function necAddressText(frame, bytes) {
  return frame.ext
    ? necAddress(frame, bytes).toString(16).toUpperCase().padStart(4, "0")
    : hex(frame.addr).slice(2).padStart(2, "0");
}

function describeNec(frame) {
  const b = necBytes(frame);
  const tag = IR_PROTO_TAG[frame.proto] || "ir";
  return `${tag} addr 0x${necAddressText(frame, b)} cmd ${hex(frame.cmd)}`;
}

/* Samsung repeats its address byte instead of complementing it, so the same
   pair of bytes means something different depending on which protocol the
   decoder locked onto. */
function addressCheck(frame, bytes) {
  if (frame.proto === IR_PROTO_SAMSUNG) {
    return bytes[0] === bytes[1] ? "address repeated valid" : "repeat FAILED";
  }
  if (frame.ext) return "not a complement - extended NEC";
  return bytes[1] === (~bytes[0] & 0xff) ? "complement valid" : "complement FAILED";
}

function setRxBadge() {
  const badge = $("#rx-badge");
  badge.textContent = state.irOpen ? "listening" : "offline";
  badge.className = `badge ${state.irOpen ? "rx-on" : "rx-off"}`;
}

function connectIr() {
  if (state.irWs) {
    try { state.irWs.close(); } catch (_) { /* already gone */ }
  }
  const ws = new WebSocket(IR_WS_URL);
  state.irWs = ws;
  ws.addEventListener("open", () => {
    state.irOpen = true;
    setRxBadge();
    log("connected to /wsir - bridge IR receiver listening", "ok");
  });
  ws.addEventListener("close", () => {
    state.irOpen = false;
    setRxBadge();
    setTimeout(connectIr, 3000);
  });
  ws.addEventListener("message", (event) => onIrMessage(event.data));
}

function onIrMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  if (!msg || msg.t !== "ir") return;

  const proto = msg.proto | 0;
  const frame = {
    addr: msg.addr & 0xff,
    cmd: msg.cmd & 0xff,
    raw: String(msg.raw || "").toUpperCase(),
    proto,
    ext: proto === IR_PROTO_NEC_EXT,
    rep: msg.rep | 0,
    at: Date.now(),
    cached: !!msg.last,
  };

  /* A held button emits repeat frames that carry no data of their own, so they
     bump the count on the frame already on screen instead of piling up
     identical history entries. */
  const head = state.irHistory[0];
  if (frame.rep > 0 && head && head.addr === frame.addr && head.cmd === frame.cmd && head.proto === frame.proto) {
    head.rep = frame.rep;
    head.at = frame.at;
  } else {
    state.irHistory.unshift(frame);
    if (state.irHistory.length > IR_HISTORY_MAX) state.irHistory.length = IR_HISTORY_MAX;
  }
  state.irLast = state.irHistory[0];
  renderIr();

  if (!frame.cached) {
    log(`IR receiver got ${describeNec(state.irLast)}${state.irLast.rep ? `, repeat x${state.irLast.rep}` : ""}`, "ok");
  }
}

function rxBlock(label, value) {
  const box = document.createElement("div");
  box.className = "rx-block";
  const l = document.createElement("span");
  l.className = "rx-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "rx-value";
  v.textContent = value;
  box.append(l, v);
  return box;
}

function renderIr() {
  const frame = state.irLast;
  if (!frame) {
    const empty = document.createElement("span");
    empty.className = "rx-empty";
    empty.textContent = "no code received yet";
    $("#rx-now").replaceChildren(empty);
    $("#rx-detail").replaceChildren();
    $("#rx-history").replaceChildren();
    return;
  }

  const b = necBytes(frame);
  $("#rx-now").replaceChildren(
    rxBlock(frame.ext ? "ADDR16" : "ADDRESS", necAddressText(frame, b)),
    rxBlock("COMMAND", hex(frame.cmd).slice(2).padStart(2, "0")),
    rxBlock("DEC", `${necAddress(frame, b)} / ${frame.cmd}`),
  );

  $("#rx-detail").replaceChildren(
    kv("Protocol", IR_PROTO_NAME[frame.proto] || "unknown"),
    kv("Bytes on wire", b.map((n) => hex(n)).join(" ")),
    kv("Address check", addressCheck(frame, b)),
    kv("Command check", b[3] === (~b[2] & 0xff) ? "complement valid" : "complement FAILED"),
    kv("Raw 32-bit", hexAddr(parseInt(frame.raw, 16) || 0)),
    kv("Repeats", frame.rep ? String(frame.rep) : "none"),
    kv("Received", new Date(frame.at).toLocaleTimeString()),
  );

  $("#rx-history").replaceChildren(...state.irHistory.map((h) => {
    const hb = necBytes(h);
    const li = document.createElement("li");
    li.className = "rx-item";

    const code = document.createElement("code");
    code.textContent = `${necAddressText(h, hb)}-${hex(h.cmd).slice(2).padStart(2, "0")}`;

    const meta = document.createElement("span");
    meta.className = "rx-meta";
    meta.textContent = `${IR_PROTO_TAG[h.proto] || "ir"} · raw ${hexAddr(parseInt(h.raw, 16) || 0)}${h.rep ? ` · rep ${h.rep}` : ""}`;

    const use = document.createElement("button");
    use.type = "button";
    use.className = "rx-use";
    use.textContent = "use";
    use.title = `put addr 0x${necAddressText(h, hb)} cmd ${hex(h.cmd)} on the selected button`;
    use.addEventListener("click", () => useReceived(h));

    li.append(code, meta, use);
    return li;
  }));
}

/* The reason to listen at all: a code read off a real remote becomes a code on
   one of the three buttons without retyping it. */
function useReceived(frame) {
  const b = necBytes(frame);
  const i = state.selected;
  const addr = necAddress(frame, b);
  /* The target's config page holds one address byte, so an extended-NEC remote
     can only be reproduced by the address byte it actually sent first. Say so
     rather than let a truncated value report itself as a clean copy. */
  const wide = addr > 0xff;
  /* A Samsung frame the receiver decoded becomes a Samsung button: the target
     can send that 4.5 ms header itself, so the copy is faithful rather than a
     NEC look-alike the original set would ignore. */
  const proto = frame.proto === IR_PROTO_SAMSUNG ? TG_SAMSUNG : TG_NEC;
  state.codes[i] = { addr: clamp(addr & 0xff), cmd: clamp(frame.cmd), proto };
  syncAll();
  renderIr();

  if (wide) {
    log(`SW${i + 1}: extended address 0x${addr.toString(16).toUpperCase().padStart(4, "0")} does not fit the target's 8-bit field, so only ${hex(addr & 0xff)} was kept and the button will send standard NEC`, "warn");
    toast(`SW${i + 1} address truncated to ${hex(addr & 0xff)}`, "warn");
    return;
  }
  if (proto === TG_SAMSUNG) {
    log(`received ${describeNec(frame)} copied onto SW${i + 1}, which now transmits Samsung`, "ok");
    toast(`SW${i + 1} set to Samsung ${hex(state.codes[i].addr)}/${hex(state.codes[i].cmd)}`, "ok");
    return;
  }
  log(`received ${describeNec(frame)} copied onto SW${i + 1}`, "ok");
  toast(`SW${i + 1} set to ${hex(state.codes[i].addr)}/${hex(state.codes[i].cmd)}`, "ok");
}

/* --------------------------------------------------------------- wiring */

function initCollapsibles(root = document) {
  root.querySelectorAll("[data-collapse]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const body = btn.closest(".card").querySelector(".card-body");
      const open = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!open));
      btn.innerHTML = open ? "+" : "&minus;";
      body.hidden = open;
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  buildRemote();
  buildCodeCards();
  initCollapsibles();
  select(0);
  syncAll();

  $("#btn-random-all").addEventListener("click", randomizeAll);
  $("#btn-factory").addEventListener("click", () => {
    state.codes = FACTORY.map((c) => ({ ...c }));
    syncAll();
    toast("Factory codes 152 / 31 / 62 restored", "ok");
  });
  el.scanToggle.addEventListener("change", (e) => setScan(e.target.checked));
  $("#btn-detect").addEventListener("click", doDetect);
  $("#btn-read").addEventListener("click", doRead);
  $("#btn-program").addEventListener("click", doProgram);
  $("#btn-firmware").addEventListener("click", doFlashFirmware);
  $("#btn-unbrick").addEventListener("click", doUnbrick);
  $("#btn-download").addEventListener("click", () => doDownload("bin"));
  $("#btn-download-hex").addEventListener("click", () => doDownload("hex"));
  $("#btn-download-page").addEventListener("click", doDownloadPage);
  $("#btn-clear-log").addEventListener("click", () => el.console.replaceChildren());
  $("#btn-rx-assign").addEventListener("click", () => {
    if (state.irLast) useReceived(state.irLast);
    else toast("Nothing received yet", "warn");
  });
  $("#btn-rx-clear").addEventListener("click", () => {
    state.irHistory = [];
    state.irLast = null;
    renderIr();
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input")) return;
    if (e.key === "1" || e.key === "2" || e.key === "3") select(Number(e.key) - 1);
    if (e.key.toLowerCase() === "r") firePreview(state.selected);
    if (e.key.toLowerCase() === "d") doDownload("bin");
  });

  log("IR Remote Configurator ready", "ok");
  log(`generate the codes, download the ${CODE_SIZE + CFG_SIZE}-byte image to test it, then program the ${CFG_SIZE}-byte page at ${hexAddr(CFG_ADDR)}`, "info");
  setRxBadge();
  renderIr();
  connect();
  connectIr();
});
