/*
 * Proves the browser's config page and the CH32V003 firmware agree, without a
 * RISC-V runner: the constants on both sides are read out of the two source
 * files and compared, then ir.js's own buildConfig/parseConfig are evaluated
 * against the layout main.c's load_config() indexes.
 *
 * node test_config_page.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const IR_JS = join(ROOT, "data", "www", "js", "ir.js");
const TEMPLATE = join(ROOT, "data", "www", "fw", "ir_remote.bin");

const c = readFileSync(join(HERE, "src", "main.c"), "utf8");
const js = readFileSync(IR_JS, "utf8");

let fails = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${what}`);
  if (!cond) fails++;
};

/* ---- 1. the two sides must name the same numbers ---- */
const cNum = (name) => {
  const m = c.match(new RegExp(`#define\\s+${name}\\s+(0x[0-9a-fA-F]+|\\d+)u?\\b`));
  return m ? Number(m[1]) : null;
};
const jsNum = (name) => {
  const m = js.match(new RegExp(`const\\s+${name}\\s*=\\s*(0x[0-9a-fA-F]+|\\d+)`));
  return m ? Number(m[1]) : null;
};

for (const [name, cName] of [["CFG_MAGIC", "CFG_MAGIC"], ["CFG_SUM_LEN", "CFG_SUM_LEN"], ["CFG_STRIDE", "CFG_STRIDE"]]) {
  ok(jsNum(name) === cNum(cName) && jsNum(name) !== null, `${name}: ir.js ${jsNum(name)} === main.c ${cNum(cName)}`);
}
ok(jsNum("CFG_SUM_OFF") === cNum("CFG_SUM_LEN"), `checksum offset ${jsNum("CFG_SUM_OFF")} === main.c CFG_SUM_LEN`);
ok(/0x32435249/.test(js) && /0x32435249u/.test(c), 'magic is "IRC2" on both sides');

/* main.c's read indices, verbatim */
for (const [off, field] of [[4, "addr"], [5, "cmd"], [6, "proto"]]) {
  ok(c.includes(`p[${off} + i * CFG_STRIDE]`), `main.c reads ${field} from p[${off} + i * CFG_STRIDE]`);
}
ok(c.includes("read_le32(p + CFG_SUM_LEN) == sum"), "main.c checks the checksum at CFG_SUM_LEN");

/* ---- 2. run ir.js's own codec ---- */
const grab = (name) => {
  const start = js.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0, i = js.indexOf("{", start);
  for (let j = i; j < js.length; j++) {
    if (js[j] === "{") depth++;
    else if (js[j] === "}") { depth--; if (!depth) return js.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
};

const consts = js.slice(js.indexOf("const CFG_SIZE"), js.indexOf("const NEC = {"));
const codec = new Function(`${consts}\n${grab("buildConfig")}\n${grab("parseConfig")}\nreturn { buildConfig, parseConfig, CFG_SIZE, TG_NEC, TG_SAMSUNG };`)();

const codes = [
  { addr: 0xE0, cmd: 0x99, proto: codec.TG_SAMSUNG },
  { addr: 0x00, cmd: 152, proto: codec.TG_NEC },
  { addr: 0x07, cmd: 0x02, proto: codec.TG_SAMSUNG },
];
const page = codec.buildConfig(codes);

ok(page.length === 64, `page is ${page.length} bytes`);
ok(String.fromCharCode(...page.subarray(0, 4)) === "IRC2", `magic bytes spell "${String.fromCharCode(...page.subarray(0, 4))}"`);
codes.forEach((cd, i) => {
  const base = 4 + i * 4;
  ok(page[base] === cd.addr && page[base + 1] === cd.cmd && page[base + 2] === cd.proto && page[base + 3] === 0xff,
    `button ${i}: ${page[base]}/${page[base + 1]}/${page[base + 2]}/${page[base + 3]} at offset ${base}`);
});

let sum = 0;
for (let i = 0; i < 16; i++) sum += page[i];
const le32 = page[16] | (page[17] << 8) | (page[18] << 16) | (page[19] << 24);
ok(le32 === sum, `checksum at 0x10 is 0x${sum.toString(16)} over bytes 0x00..0x0F`);
ok(page.subarray(20).every((b) => b === 0xff), "bytes 0x14..0x3F left erased");

const back = codec.parseConfig(page);
ok(back && back.every((c2, i) => c2.addr === codes[i].addr && c2.cmd === codes[i].cmd && c2.proto === codes[i].proto),
  "parseConfig round-trips addr, cmd and proto");

/* ---- 3. what the firmware rejects, the page must reject too ---- */
const bad = page.slice();
bad[6] = 2;                                   /* a protocol main.c does not implement */
let badSum = 0;
for (let i = 0; i < 16; i++) badSum += bad[i];
bad[16] = badSum & 0xff; bad[17] = (badSum >> 8) & 0xff; bad[18] = (badSum >> 16) & 0xff; bad[19] = (badSum >> 24) & 0xff;
ok(codec.parseConfig(bad) === null, "proto 2 with a valid checksum is still rejected");

const old = page.slice();
old[0] = 0x49; old[1] = 0x52; old[2] = 0x43; old[3] = 0x31;   /* "IRC1" */
ok(codec.parseConfig(old) === null, "an IRC1 page is rejected, so it cannot be half-read");

const blank = new Uint8Array(64).fill(0xff);
ok(codec.parseConfig(blank) === null, "a blank page is rejected");

/* ---- 4. the deployed template must be the new firmware plus a blank page ---- */
const tpl = readFileSync(TEMPLATE);
const bin = readFileSync(join(HERE, "build", "ir_remote.bin"));
ok(tpl.length === 2112, `template is ${tpl.length} bytes`);
ok(tpl.subarray(0, bin.length).equals(bin), `template starts with the ${bin.length}-byte firmware`);
ok(tpl.subarray(bin.length).every((b) => b === 0xff), "rest of the template is 0xFF fill");
ok(bin.length <= 2048, `firmware ${bin.length} B fits the 2048 B code region`);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
