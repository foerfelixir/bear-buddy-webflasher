#pragma once

/*
 * Bear-Buddy onboard peripherals: the 5x5 serpentine NeoPixel matrix, the
 * 38 kHz IR receiver and the two tactile switches.
 *
 * Pin map is fixed by the board (TomatoCube "Box 10 - Bear-Buddy DIY Desk
 * Companion"): LED IO3, button A IO9 (wired together with the BOOT strap
 * pin), button B IO4, buzzer IO10, NeoPixel matrix IO7, IR receiver IO21,
 * I2C SDA IO5 / SCL IO6. IO5 is also what this build bit-bangs SWIO on, so
 * none of these peripherals overlap the programmer link.
 *
 * The one real conflict is UART0: on the ESP32-C3 its default pins are
 * IO20/IO21, so enabling the debug terminal takes IO21 away from the IR
 * receiver. bbBegin() is told about that and leaves the receiver alone
 * rather than fighting the terminal for the pin.
 */

#include <Arduino.h>
#include <Adafruit_NeoPixel.h>
#include "font5x5.h"

#define BB_LED_PIN     3
#define BB_BTN_A_PIN   9
#define BB_BTN_B_PIN   4
#define BB_BUZZER_PIN  10
#define BB_MATRIX_PIN  7
#define BB_IR_PIN      21

#define MATRIX_W       5
#define MATRIX_H       5
#define MATRIX_N       (MATRIX_W * MATRIX_H)
#define MATRIX_BRIGHT  32   /* 25 pixels share one USB port with WiFi bursts */

#define BB_SCROLL_MS   90   /* one column per tick */
#define BB_DEBOUNCE_MS 30

/* A NEC frame is a 9 ms leading mark plus 32 bits of mark+space, so 67
   edges is a whole frame with room to spare. */
#define IR_BUF_LEN     96

typedef void (*BbIrCallback)(uint8_t addr, uint8_t cmd, uint32_t raw,
                             uint8_t proto, uint16_t repeats);

/* ------------------------------------------------------------ pixel matrix */

static Adafruit_NeoPixel bbStrip(MATRIX_N, BB_MATRIX_PIN, NEO_GRB + NEO_KHZ800);

static char     bbText[48];
static int      bbScrollPos;
static uint32_t bbScrollNext;
static bool     bbScrolling;
static bool     bbBusy;
static const uint8_t bbR = 255, bbG = 150, bbB = 0;   /* amber marquee */

/* The chain starts at the top-right: even rows run right to left, odd rows
   left to right. */
static inline uint16_t bbIndex(uint8_t x, uint8_t y)
{
  return (y & 1) ? y * MATRIX_W + x
                 : y * MATRIX_W + (MATRIX_W - 1 - x);
}

static inline int bbAdvance(void) { return FONT5X5_W + 1; }

static inline int bbTextWidth(const char *s)
{
  int len = strlen(s);
  return len ? len * bbAdvance() - 1 : 0;
}

/* The bitmap column of the scrolling text that lands on screen column x. */
static uint8_t bbGlyphCol(const char *s, int gcol)
{
  int adv = bbAdvance();
  int ci = gcol / adv;
  int cx = gcol - ci * adv;
  if (ci < 0 || ci >= (int)strlen(s)) return 0;
  if (cx >= FONT5X5_W) return 0;   /* inter-character gap */
  return font5x5[(uint8_t)s[ci]][cx];
}

static void bbRender(void)
{
  if (bbBusy) return;
  for (uint8_t x = 0; x < MATRIX_W; x++) {
    uint8_t col = bbGlyphCol(bbText, bbScrollPos + x);
    for (uint8_t y = 0; y < MATRIX_H; y++) {
      uint32_t c = ((col >> y) & 1) ? bbStrip.Color(bbR, bbG, bbB) : 0;
      bbStrip.setPixelColor(bbIndex(x, y), c);
    }
  }
  bbStrip.show();
}

static void bbClear(void)
{
  bbScrolling = false;
  bbText[0] = '\0';
  bbScrollPos = 0;
  if (!bbBusy) { bbStrip.clear(); bbStrip.show(); }
}

/* Marquee the text; it wraps until bbClear() or a new message replaces it. */
static void bbScroll(const char *text)
{
  strncpy(bbText, text, sizeof(bbText) - 1);
  bbText[sizeof(bbText) - 1] = '\0';
  bbScrollPos = MATRIX_W;      /* start just off the right edge */
  bbScrollNext = millis() + BB_SCROLL_MS;
  bbScrolling = true;
  bbRender();
}

static void bbScrollTick(void)
{
  if (!bbScrolling || bbBusy) return;
  if ((int32_t)(millis() - bbScrollNext) < 0) return;
  bbScrollNext = millis() + BB_SCROLL_MS;
  bbScrollPos++;
  if (bbScrollPos > bbTextWidth(bbText)) {
    /* One pass, then dark. Wrapping forever kept all 25 pixels lit, and that
       draw on top of a WiFi transmit burst is more than a USB port supplies -
       the board browned out and restarted over and over. */
    bbClear();
    return;
  }
  bbRender();
}

/* ------------------------------------------------------------------ IR NEC */

/* The receiver idles HIGH and pulls LOW for every burst of 38 kHz carrier,
   so a NEC mark is a LOW interval and a space is HIGH. The interrupt only
   timestamps edges; decoding runs in bbPoll, which keeps the handler short
   and lets a frame be rejected in one place. */
static volatile uint16_t bbIrBuf[IR_BUF_LEN];
static volatile uint16_t bbIrHead;    /* first delta the decoder has not seen */
static volatile uint16_t bbIrCount;
static volatile uint32_t bbIrLastEdge;
static volatile uint32_t bbIrEdges;   /* every edge since boot, for diagnostics */

/* Delta histogram, bands in us: <380, 380-900, 901-1300, 1300-2000,
   2001-3000, 3001-6000, 6001-12000, >12000. Shows what the receiver actually
   hears - ambient noise, or NEC marks and spaces - without a serial cable. */
/* The most recent deltas are kept only as a histogram: dumping a raw ring over
   HTTP needed a kilobyte of stack in the web server task and hundreds of
   format calls per request, which is what made /rest/ir take the board down. */
#define BB_IR_HIST_N 8
static volatile uint32_t bbIrHist[BB_IR_HIST_N];

static inline uint8_t bbIrBand(uint16_t d)
{
  if (d < 380) return 0;
  if (d <= 900) return 1;
  if (d <= 1300) return 2;
  if (d <= 2000) return 3;
  if (d <= 3000) return 4;
  if (d <= 6000) return 5;
  if (d <= 12000) return 6;
  return 7;
}

static void IRAM_ATTR bbIrEdge(void)
{
  uint32_t now = micros();
  uint32_t d = now - bbIrLastEdge;
  bbIrLastEdge = now;
  if (d > 60000) d = 60000;    /* idle gap, saturates and decodes to nothing */
  bbIrEdges++;
  bbIrHist[bbIrBand((uint16_t)d)]++;
  if (bbIrCount < IR_BUF_LEN) bbIrBuf[bbIrCount++] = (uint16_t)d;
  /* A full frame is 67 deltas and the queue drains every poll, so overflowing
     here means the loop stalled; the decoder resyncs on the next header. */
}

static inline bool bbNear(uint16_t v, uint16_t lo, uint16_t hi)
{
  return v >= lo && v <= hi;
}

/*
 * NEC carries 32 bits LSB first: address, inverted address, command,
 * inverted command. A bit is a 560 us mark then a space of 560 us for 0 or
 * 1690 us for 1, so only the space has to be measured. A repeat frame keeps
 * the 9 ms mark but shortens the space to 2250 us and carries no data.
 *
 * When the second byte is not the complement of the first it is extended
 * NEC, where those two bytes are one 16-bit address rather than a checksum.
 *
 * Samsung remotes use a different frame: a 4.5 ms header mark instead of
 * 9 ms, and the address byte sent twice rather than complemented (the
 * well-known TV power code is E0 E0 99 66). Bit timings match NEC's, so only
 * the header and the validation differ. A 4.5 ms delta seen while idle is
 * ambiguous - a Samsung header mark, or a NEC header space whose mark was
 * lost - so the protocol is settled by the delta that follows it, or by the
 * frame contents when the header alone cannot decide.
 *
 * A frame spends ~70 ms on the wire while the loop polls every few
 * milliseconds, so edges queue up and feed this state machine one at a time.
 * A decoder that copied and cleared the queue on every look would only ever
 * see fragments of a frame and never match one.
 */
enum { RX_IDLE = 0, RX_HEADER_SPACE, RX_BIT_MARK, RX_BIT_SPACE, RX_HEAD2 };
enum { PROTO_NEC = 0, PROTO_NEC_EXT = 1, PROTO_SAMSUNG = 2, PROTO_UNKNOWN = 3 };
static uint8_t  bbRxState = RX_IDLE;
static uint8_t  bbRxProto = PROTO_NEC;
static uint8_t  bbRxBit;
static uint32_t bbRxWord;

/* Returns 1 with the frame in *raw, 2 for a repeat, 0 while still collecting. */
static uint8_t bbIrStep(uint16_t d, uint32_t *raw)
{
  switch (bbRxState) {
  case RX_IDLE:
    if (bbNear(d, 7500, 10500)) {                 /* NEC 9 ms mark */
      bbRxState = RX_HEADER_SPACE;
      bbRxProto = PROTO_NEC;
    } else if (bbNear(d, 3800, 5200)) {           /* Samsung mark, or NEC space */
      bbRxState = RX_HEAD2;
    }
    return 0;
  case RX_HEAD2:
    if (bbNear(d, 3800, 5200)) {                  /* Samsung 4.5 ms space */
      bbRxState = RX_BIT_MARK;
      bbRxProto = PROTO_SAMSUNG;
      bbRxBit = 0;
      bbRxWord = 0;
      return 0;
    }
    if (bbNear(d, 380, 800)) {                    /* NEC space lost its mark */
      bbRxState = RX_BIT_SPACE;
      bbRxProto = PROTO_UNKNOWN;
      bbRxBit = 0;
      bbRxWord = 0;
      return 0;
    }
    if (bbNear(d, 1800, 2900)) { bbRxState = RX_IDLE; return 2; }
    bbRxState = bbNear(d, 7500, 10500) ? RX_HEADER_SPACE : RX_IDLE;
    if (bbRxState == RX_HEADER_SPACE) bbRxProto = PROTO_NEC;
    return 0;
  case RX_HEADER_SPACE:
    if (bbNear(d, 1800, 2900)) { bbRxState = RX_IDLE; return 2; }
    if (bbNear(d, 3800, 5200)) {                                 /* 4.5 ms space */
      bbRxState = RX_BIT_MARK;
      bbRxBit = 0;
      bbRxWord = 0;
      return 0;
    }
    if (bbNear(d, 7500, 10500)) { bbRxProto = PROTO_NEC; return 0; }
    bbRxState = RX_IDLE;
    return 0;
  case RX_BIT_MARK:
    if (bbNear(d, 380, 800)) { bbRxState = RX_BIT_SPACE; return 0; }
    if (bbNear(d, 7500, 10500)) { bbRxState = RX_HEADER_SPACE; bbRxProto = PROTO_NEC; return 0; }
    if (bbNear(d, 3800, 5200)) { bbRxState = RX_HEAD2; return 0; }
    bbRxState = RX_IDLE;
    return 0;
  case RX_BIT_SPACE:
    if (bbNear(d, 380, 900)) { /* 0 */ }
    else if (bbNear(d, 1300, 2000)) bbRxWord |= 1UL << bbRxBit;  /* 1 */
    else {
      if (bbNear(d, 7500, 10500)) { bbRxState = RX_HEADER_SPACE; bbRxProto = PROTO_NEC; }
      else if (bbNear(d, 3800, 5200)) bbRxState = RX_HEAD2;
      else bbRxState = RX_IDLE;
      return 0;
    }
    if (++bbRxBit == 32) { bbRxState = RX_IDLE; *raw = bbRxWord; return 1; }
    bbRxState = RX_BIT_MARK;
    return 0;
  }
  return 0;
}

static inline void bbIrFlush(void)
{
  noInterrupts();
  bbIrHead = 0;
  bbIrCount = 0;
  bbIrLastEdge = micros();
  bbRxState = RX_IDLE;
  interrupts();
}

/* --------------------------------------------------------------- buttons */

static bool     bbBtnALevel, bbBtnBLevel;
static uint32_t bbBtnANext, bbBtnBNext;
static bool     bbBtnAPress, bbBtnBPress;

static bool bbButton(uint8_t pin, bool &level, uint32_t &next, bool &press)
{
  bool now = digitalRead(pin) == LOW;   /* active low against the pull-up */
  press = false;
  if (now == level) return false;
  if ((int32_t)(millis() - next) < 0) return false;
  next = millis() + BB_DEBOUNCE_MS;
  level = now;
  press = now;
  return true;
}

/* ------------------------------------------------------------------ driver */

static BbIrCallback bbIrCb;
static bool     bbIrArmed;
static uint8_t  bbLastAddr, bbLastCmd;
static uint32_t bbLastRaw;
static uint8_t  bbLastProto;
static uint16_t bbRepeats;
static bool     bbHaveLast;
static uint32_t bbLastAt;

/* A held key resends the whole frame, and a Samsung remote does that instead
   of sending NEC's repeat code, so an identical frame inside this window is
   counted as a repeat rather than announced again. */
#define BB_IR_RESEND_MS 600

void bbSetIrCallback(BbIrCallback cb) { bbIrCb = cb; }

static void bbFormat(char *out, size_t len, uint8_t addr, uint8_t cmd, uint8_t proto, uint32_t raw)
{
  /* Extended NEC is rendered high byte first so the matrix and the web panel
     show the same 16-bit address. Samsung repeats an 8-bit address, so it
     uses the short form too. */
  if (proto == PROTO_NEC_EXT)
    snprintf(out, len, "IR:%02X%02X-%02X", (raw >> 8) & 0xFF, raw & 0xFF, cmd);
  else
    snprintf(out, len, "IR:%02X-%02X", addr, cmd);
}

static void bbAnnounce(uint8_t addr, uint8_t cmd, uint32_t raw, uint8_t proto, uint16_t repeats)
{
  char msg[sizeof(bbText)];
  bbFormat(msg, sizeof(msg), addr, cmd, proto, raw);
  /* A pass takes about four seconds, and holding a button down delivers a code
     every few hundred, so restarting the pass each time kept all 25 pixels
     cycling for as long as the button was held. That draw on top of a WiFi
     transmit burst is more than a USB port supplies. One pass per distinct
     code, then dark. */
  if (!(bbScrolling && strcmp(msg, bbText) == 0))
    bbScroll(msg);
  bbLastAt = millis();
  if (bbIrCb) bbIrCb(addr, cmd, raw, proto, repeats);
}

bool bbIrEnabled(void) { return bbIrArmed; }

/* Live receiver health: total edges since boot, decoder state, edges still
   queued and the delta histogram. Enough to tell a dead receiver from ambient
   noise, and noise from real NEC timings, without a serial cable. */
void bbIrDiag(uint32_t *edges, uint8_t *state, uint16_t *queued, uint32_t *hist)
{
  noInterrupts();
  *edges = bbIrEdges;
  *state = bbRxState;
  *queued = bbIrCount - bbIrHead;
  for (uint8_t i = 0; i < BB_IR_HIST_N; i++) hist[i] = bbIrHist[i];
  interrupts();
}

void bbGetLast(uint8_t *addr, uint8_t *cmd, uint32_t *raw, uint8_t *proto, bool *valid)
{
  *addr = bbLastAddr;  *cmd = bbLastCmd; *raw = bbLastRaw;
  *proto = bbLastProto; *valid = bbHaveLast;
}

static void bbFrame(uint32_t raw)
{
  uint8_t b0 = raw & 0xFF, b1 = (raw >> 8) & 0xFF;
  uint8_t b2 = (raw >> 16) & 0xFF, b3 = (raw >> 24) & 0xFF;
  /* A bad command complement means noise, not a remote. NEC and Samsung both
     carry the inverted command, so that half of the check is common. */
  if ((uint8_t)~b2 != b3) return;
  uint8_t proto = bbRxProto;
  /* The header was ambiguous, so let the address bytes decide: repeated is
     Samsung, anything else is standard or extended NEC. */
  if (proto == PROTO_UNKNOWN) proto = (b0 == b1) ? PROTO_SAMSUNG : PROTO_NEC;
  if (proto == PROTO_SAMSUNG && b0 != b1) return;
  else if (proto == PROTO_NEC) proto = ((uint8_t)~b0 == b1) ? PROTO_NEC : PROTO_NEC_EXT;

  if (bbHaveLast && raw == bbLastRaw && proto == bbLastProto &&
      (uint32_t)(millis() - bbLastAt) < BB_IR_RESEND_MS) {
    if (bbRepeats < 0xFFFF) bbRepeats++;
    bbLastAt = millis();
    if (bbIrCb) bbIrCb(bbLastAddr, bbLastCmd, bbLastRaw, bbLastProto, bbRepeats);
    return;
  }
  bbLastAddr = b0; bbLastCmd = b2; bbLastRaw = raw;
  bbLastProto = proto; bbRepeats = 0; bbHaveLast = true;
  bbAnnounce(b0, b2, raw, proto, 0);
}

static void bbRepeatFrame(void)
{
  if (!bbHaveLast) return;
  if (bbRepeats < 0xFFFF) bbRepeats++;
  bbLastAt = millis();
  if (bbIrCb) bbIrCb(bbLastAddr, bbLastCmd, bbLastRaw, bbLastProto, bbRepeats);
}

static void bbIrDrain(void)
{
  for (;;) {
    noInterrupts();
    if (bbIrHead == bbIrCount) {
      bbIrHead = 0;
      bbIrCount = 0;
      interrupts();
      return;
    }
    uint16_t d = bbIrBuf[bbIrHead++];
    interrupts();

    uint32_t raw = 0;
    uint8_t r = bbIrStep(d, &raw);
    if (r == 1) bbFrame(raw);
    else if (r == 2) bbRepeatFrame();
  }
}

/* irPinTaken is true when the debug terminal owns UART0, and therefore IO21. */
void bbBegin(bool irPinTaken)
{
  bbStrip.begin();
  bbStrip.setBrightness(MATRIX_BRIGHT);
  bbStrip.clear();
  bbStrip.show();

  pinMode(BB_BTN_A_PIN, INPUT_PULLUP);
  pinMode(BB_BTN_B_PIN, INPUT_PULLUP);
  bbBtnALevel = digitalRead(BB_BTN_A_PIN) == LOW;
  bbBtnBLevel = digitalRead(BB_BTN_B_PIN) == LOW;

  /* Doubles as proof the matrix is alive before any remote is involved. */
  bbScroll("IR READY");

  if (irPinTaken) {
    Serial.println("Bear-Buddy: debug terminal owns UART0/IO21, IR receiver left disabled");
    return;
  }
  pinMode(BB_IR_PIN, INPUT_PULLUP);
  bbIrLastEdge = micros();
  attachInterrupt(digitalPinToInterrupt(BB_IR_PIN), bbIrEdge, CHANGE);
  bbIrArmed = true;
}

/* busy suppresses both the matrix and the decoder: a flash or read is
   bit-banging SWIO with interrupts masked, so any frame sampled across it
   would be missing edges and decode to garbage. */
void bbPoll(bool busy)
{
  if (busy != bbBusy) {
    bbBusy = busy;
    if (busy) bbIrFlush();
    else bbRender();
  }
  if (busy) return;

  if (bbIrArmed) bbIrDrain();

  if (bbButton(BB_BTN_A_PIN, bbBtnALevel, bbBtnANext, bbBtnAPress) && bbBtnAPress)
    bbClear();
  /* B replays the last frame, so a code seen before the page was open is not
     lost to it. */
  if (bbButton(BB_BTN_B_PIN, bbBtnBLevel, bbBtnBNext, bbBtnBPress) && bbBtnBPress && bbHaveLast)
    bbAnnounce(bbLastAddr, bbLastCmd, bbLastRaw, bbLastProto, bbRepeats);

  bbScrollTick();
}
