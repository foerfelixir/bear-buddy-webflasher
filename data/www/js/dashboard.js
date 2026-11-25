const FLASH_BASE = 0x08000000;
const MAX_TRANSFER = 16384;
const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/wsflash`;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  ws: null,
  open: false,
  busy: false,
  pending: null,
  chunks: [],
  expected: 0,
  chip: null,
  dump: null,
  image: null,
  reconnect: null,
};

/* ------------------------------------------------------------------ logging */

const consoleEl = $("#console");

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
  consoleEl.appendChild(line);
  while (consoleEl.childElementCount > 800) consoleEl.firstElementChild.remove();
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function toast(message, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 220);
  }, 4200);
}

/* ------------------------------------------------------------------- status */

function setLink(stateName, label) {
  const el = $("#link-status");
  el.dataset.state = stateName;
  $("#link-status-label").textContent = label;
}

function setBusy(busy, label) {
  state.busy = busy;
  $$(".action, .btn").forEach((b) => { b.disabled = busy; });
  setLink(busy ? "busy" : state.open ? "on" : "off", busy ? "Working" : state.open ? "Connected" : "Disconnected");
  const badge = $("#op-badge");
  badge.className = `badge ${busy ? "warn" : "idle"}`;
  badge.textContent = busy ? label : "idle";
  const bar = $("#progress-bar");
  if (busy) {
    $("#progress").hidden = false;
    $("#progress-label").textContent = label;
    $("#progress-pct").textContent = "0%";
    bar.style.width = "0%";
    bar.classList.add("indeterminate");
  } else {
    bar.classList.remove("indeterminate");
  }
}

function setProgress(done, total, label) {
  const bar = $("#progress-bar");
  bar.classList.remove("indeterminate");
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  bar.style.width = `${pct}%`;
  $("#progress-pct").textContent = `${pct}%`;
  if (label) $("#progress-label").textContent = label;
}

/* ---------------------------------------------------------------- websocket */

function connect() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
  const ws = new WebSocket(WS_URL);
  ws.binaryType = "arraybuffer";
  state.ws = ws;

  ws.onopen = () => {
    state.open = true;
    clearTimeout(state.reconnect);
    setLink("on", "Connected");
    log("Bridge link established", "ok");
    toast("Connected to programmer bridge", "ok");
  };

  ws.onclose = () => {
    state.open = false;
    if (state.pending) settlePending(new Error("bridge link closed mid-operation"));
    setLink("off", "Disconnected");
    log("Bridge link closed - retrying in 3s", "warn");
    clearTimeout(state.reconnect);
    state.reconnect = setTimeout(connect, 3000);
  };

  ws.onerror = () => log("Bridge link error", "err");
  ws.onmessage = onMessage;
}

function onMessage(event) {
  if (event.data instanceof ArrayBuffer) {
    const bytes = new Uint8Array(event.data);
    state.chunks.push(bytes);
    const got = state.chunks.reduce((n, c) => n + c.length, 0);
    if (state.pending && state.pending.kind === "read") setProgress(got, state.expected, `reading ${got} / ${state.expected} bytes`);
    log(`<< ${bytes.length} bytes of data (${got} total)`, "tx");
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
  log(`<< #${code} ${msg}`, code === 0 ? "info" : "err");

  const p = state.pending;
  if (!p) return;
  if (code !== 0) {
    settlePending(new Error(describe(code, msg)));
    return;
  }
  // Chip info is the one reply the firmware sends without a "#code;" prefix.
  if (p.kind === "info") return;
  // Multi-stage operations emit several "#0;" messages; only the completion counts.
  if (p.until && !p.until.test(msg)) return;
  settlePending(null, p.kind === "read" ? concatenate() : msg);
}

function describe(code, msg) {
  const known = {
    1: "bridge is busy with another operation",
    2: "SWIO link init failed - check wiring, 10K pull-up to 3.3V and target power",
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

function waitFor(kind, timeoutMs, until = null) {
  return beginOp(kind, timeoutMs, until);
}

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

/* ------------------------------------------------------------- input parsing */

function parseOffset(raw) {
  const text = String(raw || "").trim();
  if (!text) return FLASH_BASE;
  const value = /^0x/i.test(text) ? Number.parseInt(text, 16) : Number.parseInt(text, 10);
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid start address "${text}"`);
  return value >>> 0;
}

function parseLength(raw) {
  const value = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error("invalid length");
  if (value > MAX_TRANSFER) {
    log(`length ${value} exceeds the ${MAX_TRANSFER} byte bridge buffer - clamping`, "warn");
    return MAX_TRANSFER;
  }
  return value;
}

const hex = (n, w = 8) => n.toString(16).toUpperCase().padStart(w, "0");

/* -------------------------------------------------------------- chip detect */

function parseChipInfo(raw) {
  const f = raw.trim().split(";");
  if (f.length < 12) throw new Error(`unexpected chip info payload (${f.length} fields)`);
  const num = (i) => Number.parseInt(f[i], 16);
  const info = {
    user: f[0], rdpr: f[1], data1: f[2], data0: f[3],
    wrpr1: f[4], wrpr0: f[5], wrpr3: f[6], wrpr2: f[7],
    uniqueId: (f[8] + f[9] + f[10]).toUpperCase(),
    flashSize: f[11].trim(),
  };
  const rdprValue = num(1);
  // WCH convention: RDPR low byte 0xA5 means read protection is off.
  info.protected = (rdprValue & 0xff) !== 0xa5;
  return info;
}

function renderChip(info) {
  state.chip = info;
  const put = (key, value) => { const el = document.querySelector(`#chip-summary [data-k="${key}"], .two-col [data-k="${key}"]`); if (el) el.textContent = value; };

  put("device", "CH32V003");
  put("flashSize", info.flashSize);
  put("uniqueId", info.uniqueId);
  put("user", `0x${info.user}`);
  put("rdpr", `0x${info.rdpr}`);
  put("data0", `0x${info.data0}`);
  put("data1", `0x${info.data1}`);
  put("wrpr0", `0x${info.wrpr0}`);
  put("wrpr1", `0x${info.wrpr1}`);
  put("wrpr2", `0x${info.wrpr2}`);
  put("wrpr3", `0x${info.wrpr3}`);

  const rdprState = document.querySelector('#chip-summary [data-k="rdprState"]');
  rdprState.innerHTML = "";
  rdprState.appendChild(badge(info.protected ? "warn" : "ok", info.protected ? "ENABLED" : "DISABLED"));

  $("#target-chip").textContent = `CH32V003 / ${info.flashSize}`;
  const cb = $("#chip-badge");
  cb.className = "badge ok";
  cb.textContent = "detected";

  $("#protection-status").innerHTML = "";
  addStatus("ok", "SWIO link established");
  if (info.protected) addStatus("warn", `Read protection ENABLED (RDPR 0x${info.rdpr}) - flash will read back blank`);
  else addStatus("ok", "Read protection disabled");

  $("#chip-note").textContent = "Package marking is not readable over SWIO; the device is reported by family and flash size.";
  renderOptionTable(info);
}

function badge(kind, text) {
  const b = document.createElement("span");
  b.className = `badge ${kind}`;
  b.textContent = text;
  return b;
}

function addStatus(kind, text) {
  const li = document.createElement("li");
  li.className = kind;
  const mark = document.createElement("span");
  mark.className = "mark";
  mark.textContent = kind === "ok" ? "\u2713" : kind === "warn" ? "\u26A0" : "\u2715";
  li.append(mark, document.createTextNode(text));
  $("#protection-status").appendChild(li);
}

const OPT_ROWS = [
  ["USER", "user", "0x1FFFF800", "User option byte - boot and debug configuration"],
  ["RDPR", "rdpr", "0x1FFFF800", "Read protection. Low byte 0xA5 = unprotected"],
  ["DATA0", "data0", "0x1FFFF804", "User data byte 0"],
  ["DATA1", "data1", "0x1FFFF804", "User data byte 1"],
  ["WRPR0", "wrpr0", "0x1FFFF808", "Write protection register 0"],
  ["WRPR1", "wrpr1", "0x1FFFF808", "Write protection register 1"],
  ["WRPR2", "wrpr2", "0x1FFFF80C", "Write protection register 2"],
  ["WRPR3", "wrpr3", "0x1FFFF80C", "Write protection register 3"],
];

function renderOptionTable(info) {
  const tbody = $("#opt-table tbody");
  tbody.innerHTML = "";
  for (const [name, key, addr, meaning] of OPT_ROWS) {
    const tr = document.createElement("tr");
    const raw = info[key];
    const flag = name === "RDPR" && info.protected;
    tr.append(
      cell(name), cell(`0x${raw.toUpperCase()}`), cell(addr), cell(meaning)
    );
    if (flag) tr.children[1].style.color = "var(--warn)";
    tbody.appendChild(tr);
  }
}

function cell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

/* -------------------------------------------------------------- flash reads */

function summariseDump(bytes, offset) {
  let sum = 0;
  for (const b of bytes) sum = (sum + b) >>> 0;
  const allFF = bytes.every((b) => b === 0xff);
  const all00 = bytes.every((b) => b === 0x00);
  $("#read-result").hidden = false;
  $("#rr-bytes").textContent = `${bytes.length} bytes`;
  $("#rr-from").textContent = `0x${hex(offset)}`;
  $("#rr-sum").textContent = `0x${hex(sum)}`;
  const content = $("#rr-content");
  content.innerHTML = "";
  if (allFF) content.appendChild(badge("warn", "all 0xFF - blank or read-protected"));
  else if (all00) content.appendChild(badge("err", "all 0x00 - read did not reach the chip"));
  else content.appendChild(badge("ok", "contains data"));
  return { allFF, all00 };
}

function renderHex(bytes, offset, maxRows) {
  const view = $("#hexview");
  const totalRows = Math.ceil(bytes.length / 16);
  const rows = Math.min(totalRows, maxRows);
  const out = ['<span class="h">Address     00 01 02 03 04 05 06 07  08 09 0A 0B 0C 0D 0E 0F   ASCII</span>\n'];
  for (let r = 0; r < rows; r++) {
    const i = r * 16;
    let line = `<span class="a">${hex(offset + i)}</span>  `;
    let ascii = "";
    for (let c = 0; c < 16; c++) {
      const idx = i + c;
      if (idx >= bytes.length) { line += "   "; ascii += " "; }
      else {
        const b = bytes[idx];
        const cls = b === 0x00 ? "z" : b === 0xff ? "f" : "p";
        line += `<span class="${cls}">${b.toString(16).toUpperCase().padStart(2, "0")}</span>`;
        line += c === 7 ? "  " : " ";
        ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
      }
    }
    out.push(`${line}  <span class="p">${escapeHtml(ascii)}</span>\n`);
  }
  view.innerHTML = out.join("");
  $("#hex-meta").textContent = `${bytes.length} bytes from 0x${hex(offset)} - showing ${rows} of ${totalRows} rows`;
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function download(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function toIntelHex(bytes, base) {
  const record = (type, addr, data) => {
    const head = [data.length, (addr >> 8) & 0xff, addr & 0xff, type];
    const all = head.concat(data);
    const sum = all.reduce((a, b) => a + b, 0) & 0xff;
    const csum = ((~sum) + 1) & 0xff;
    return ":" + all.concat(csum).map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join("");
  };
  const lines = [record(4, 0, [(base >>> 24) & 0xff, (base >>> 16) & 0xff])];
  for (let i = 0; i < bytes.length; i += 16) {
    lines.push(record(0, i & 0xffff, Array.from(bytes.subarray(i, i + 16))));
  }
  lines.push(record(1, 0, []));
  return lines.join("\r\n") + "\r\n";
}

/* ------------------------------------------------------------------ actions */

function recordOperation(op, range, bytes, ms, ok) {
  const put = (k, v) => { const el = document.querySelector(`#op-summary [data-k="${k}"]`); if (el) el.textContent = v; };
  put("op", op);
  put("range", range);
  put("bytes", bytes);
  put("duration", ms);
  const res = document.querySelector('#op-summary [data-k="result"]');
  res.innerHTML = "";
  res.appendChild(badge(ok ? "ok" : "err", ok ? "SUCCESS" : "FAILED"));
  const b = $("#op-badge");
  b.className = `badge ${ok ? "ok" : "err"}`;
  b.textContent = ok ? "success" : "failed";
}

async function run(opName, fn) {
  if (state.busy) { toast("Bridge is busy", "warn"); return; }
  setBusy(true, opName);
  const started = performance.now();
  log(`${opName} started`, "info");
  try {
    const result = await fn();
    const ms = `${Math.round(performance.now() - started)} ms`;
    recordOperation(opName, result?.range || "-", result?.bytes ?? "-", ms, true);
    toast(`${opName} completed`, "ok");
    log(`${opName} completed in ${ms}`, "ok");
  } catch (err) {
    const ms = `${Math.round(performance.now() - started)} ms`;
    recordOperation(opName, "-", "-", ms, false);
    log(`${opName} failed: ${err.message}`, "err");
    toast(`${opName} failed: ${err.message}`, "err");
  } finally {
    setBusy(false);
  }
}

async function doDetect() {
  return run("Detect Chip", async () => {
    const raw = await request("info", "#i;", 20000);
    const info = parseChipInfo(raw);
    renderChip(info);
    return { range: "option bytes", bytes: 12 };
  });
}

async function doRead(silent = false) {
  const offset = parseOffset($("#in-offset").value);
  const size = parseLength($("#in-length").value);
  state.expected = size;
  if (!silent) setBusy(true, "Read Flash");
  const started = performance.now();
  try {
    const bytes = await request("read", `#r;${offset};${size};`, 60000, /complete/i);
    if (!bytes || bytes.length === 0) throw new Error("bridge returned no data");
    state.dump = { offset, bytes };
    const flags = summariseDump(bytes, offset);
    renderHex(bytes, offset, Number.parseInt($("#hex-rows").value, 10) || 256);
    setProgress(bytes.length, size, `read ${bytes.length} bytes`);
    switchTab("hex");
    const ms = `${Math.round(performance.now() - started)} ms`;
    recordOperation("Read Flash", `0x${hex(offset)} +${bytes.length}`, `${bytes.length} bytes`, ms, true);
    if (flags.allFF) { log("dump is all 0xFF - target is blank or read-protected", "warn"); toast("Flash reads back blank", "warn"); }
    else if (flags.all00) { log("dump is all 0x00 - the read likely did not reach the chip", "err"); toast("Read returned only zeros", "err"); }
    else { log(`captured ${bytes.length} bytes of flash content`, "ok"); if (!silent) toast("Flash read complete", "ok"); }
    return bytes;
  } catch (err) {
    recordOperation("Read Flash", `0x${hex(offset)} +${size}`, "-", `${Math.round(performance.now() - started)} ms`, false);
    log(`Read Flash failed: ${err.message}`, "err");
    if (!silent) toast(`Read failed: ${err.message}`, "err");
    throw err;
  } finally {
    if (!silent) setBusy(false);
  }
}

async function doProgram() {
  if (!state.image) { toast("Choose a binary first", "warn"); log("Program Flash needs a file - use Choose binary", "warn"); return; }
  const { bytes } = state.image;
  if (bytes.length > MAX_TRANSFER) { toast(`Image is ${bytes.length} bytes; bridge limit is ${MAX_TRANSFER}`, "err"); return; }
  const offset = parseOffset($("#in-offset").value);
  await run("Program Flash", async () => {
    await request("program-setup", `#w;${offset};${bytes.length};`, 15000);
    // Arm the completion listener before uploading so the result cannot be missed.
    const done = waitFor("program", 90000, /success|complete|done|failed/i);
    log(`>> uploading ${bytes.length} bytes as one binary frame`, "tx");
    setProgress(0, bytes.length, "uploading");
    state.ws.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    setProgress(bytes.length, bytes.length, "flashing target");
    await done;
    return { range: `0x${hex(offset)} +${bytes.length}`, bytes: `${bytes.length} bytes` };
  });
}

async function doVerify() {
  if (!state.image) { toast("Choose a binary first", "warn"); return; }
  const { bytes, name } = state.image;
  const offset = parseOffset($("#in-offset").value);
  const verifyBadge = $("#img-verify");
  await run("Verify Flash", async () => {
    $("#in-length").value = String(bytes.length);
    const read = await doRead(true);
    let firstDiff = -1;
    let diffs = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (read[i] !== bytes[i]) { diffs++; if (firstDiff < 0) firstDiff = i; }
    }
    verifyBadge.innerHTML = "";
    if (diffs === 0) {
      verifyBadge.appendChild(badge("ok", "MATCH"));
      log(`${name} verified: ${bytes.length} bytes identical`, "ok");
      return { range: `0x${hex(offset)} +${bytes.length}`, bytes: `${bytes.length} bytes` };
    }
    verifyBadge.appendChild(badge("err", `${diffs} BYTES DIFFER`));
    log(`verify mismatch: ${diffs} bytes differ, first at 0x${hex(offset + firstDiff)}`, "err");
    throw new Error(`${diffs} bytes differ, first at 0x${hex(offset + firstDiff)}`);
  });
}

async function doErase() {
  if (!window.confirm("Erase the entire target flash? This cannot be undone.")) return;
  await run("Erase Chip", async () => {
    await request("erase", "#E;", 90000, /success|complete|done|failed/i);
    return { range: "full flash", bytes: "-" };
  });
}

async function doReset() {
  await run("Reset Device", async () => {
    await request("reset", "#b;", 10000);
    return { range: "-", bytes: "-" };
  });
}

/* --------------------------------------------------------------------- tabs */

function switchTab(name) {
  $$(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
  });
  $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === name));
}

/* ----------------------------------------------------------------- settings */

async function loadSettings() {
  try {
    const res = await fetch("/rest/settings", { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cfg = await res.json();
    $("#set-swio").value = cfg.swio_pin ?? "";
    $("#set-t1").value = cfg.t1coeff ?? "";
    $("#set-3v3").value = cfg.pin3v3 ?? "";
    $("#set-poll").value = cfg.poll_delay ?? "";
    log(`bridge settings loaded (swio_pin=${cfg.swio_pin}, t1coeff=${cfg.t1coeff})`, "ok");
  } catch (err) {
    log(`could not load bridge settings: ${err.message}`, "warn");
  }
}

async function saveSettings() {
  const payload = {
    swio_pin: Number.parseInt($("#set-swio").value, 10),
    t1coeff: Number.parseInt($("#set-t1").value, 10),
    pin3v3: Number.parseInt($("#set-3v3").value, 10),
    poll_delay: Number.parseInt($("#set-poll").value, 10),
  };
  try {
    const res = await fetch("/rest/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log(`bridge settings saved: ${JSON.stringify(payload)}`, "ok");
    toast("Bridge settings saved", "ok");
  } catch (err) {
    log(`could not save bridge settings: ${err.message}`, "err");
    toast("Save failed", "err");
  }
}

/* ------------------------------------------------------------------- wiring */

function init() {
  const mode = document.querySelector('meta[name="wifi"]')?.content;
  $("#bridge-mode").textContent = mode ? `${mode} mode` : "unknown";
  log(`dashboard ready - bridge reports ${mode || "unknown"} mode`, "info");

  $$("[data-collapse]").forEach((head) => {
    head.addEventListener("click", () => head.closest("[data-card]").classList.toggle("collapsed"));
  });

  $$(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
  $("#btn-clear-log").addEventListener("click", () => { consoleEl.innerHTML = ""; log("console cleared", "info"); });

  $("#btn-detect").addEventListener("click", doDetect);
  $("#btn-read").addEventListener("click", () => doRead(false));
  $("#btn-read-flash").addEventListener("click", () => doRead(false));
  $("#btn-program").addEventListener("click", () => $("#firmware-file").click());
  $("#btn-pick").addEventListener("click", () => $("#firmware-file").click());
  $("#btn-verify").addEventListener("click", doVerify);
  $("#btn-erase").addEventListener("click", doErase);
  $("#btn-reset").addEventListener("click", doReset);

  $("#firmware-file").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    state.image = { bytes, name: file.name };
    $("#img-name").textContent = file.name;
    $("#img-size").textContent = `${bytes.length} bytes`;
    $("#img-verify").innerHTML = "";
    $("#img-verify").appendChild(badge("idle", "not verified"));
    log(`loaded image ${file.name} (${bytes.length} bytes)`, "ok");
    if (bytes.length > MAX_TRANSFER) {
      toast(`Image exceeds the ${MAX_TRANSFER} byte bridge buffer`, "warn");
      log(`image is larger than the ${MAX_TRANSFER} byte buffer - programming will be rejected`, "warn");
    }
    await doProgram();
  });

  $$("[data-offset]").forEach((b) => b.addEventListener("click", () => { $("#in-offset").value = b.dataset.offset; }));

  $("#btn-save-bin").addEventListener("click", () => {
    if (!state.dump) return;
    const { offset, bytes } = state.dump;
    download(new Blob([bytes], { type: "application/octet-stream" }), `ch32v003_0x${hex(offset)}_${bytes.length}B.bin`);
    log(`saved BIN dump (${bytes.length} bytes)`, "ok");
  });

  $("#btn-save-hex").addEventListener("click", () => {
    if (!state.dump) return;
    const { offset, bytes } = state.dump;
    download(new Blob([toIntelHex(bytes, offset)], { type: "text/plain" }), `ch32v003_0x${hex(offset)}_${bytes.length}B.hex`);
    log(`saved Intel HEX dump (${bytes.length} bytes)`, "ok");
  });

  $("#btn-hex-render").addEventListener("click", () => {
    if (!state.dump) { toast("Nothing to render yet", "warn"); return; }
    const { offset, bytes } = state.dump;
    renderHex(bytes, offset, Number.parseInt($("#hex-rows").value, 10) || 256);
  });

  $("#btn-settings-load").addEventListener("click", loadSettings);
  $("#btn-settings-save").addEventListener("click", saveSettings);

  setLink("off", "Disconnected");
  connect();
  loadSettings();
}

init();
