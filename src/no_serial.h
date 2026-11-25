#pragma once

/*
 * The console is gone on purpose.
 *
 * "Serial" on this board is the ESP32-C3's USB CDC port, and a CDC write blocks
 * until the host drains it. With nothing attached to COM11 every print waits out
 * the full TX timeout, and boot alone printed a directory listing of LittleFS
 * plus the entire config file. Those stalls starve the WiFi stack and the web
 * server: the board stays associated and even hands out DHCP leases while its
 * pages stop answering, and the CDC port drops and re-enumerates, which looks
 * exactly like a board that keeps rebooting.
 *
 * Include this first in every source file. It retargets the Serial name to an
 * object that discards whatever it is handed, so no call site has to change and
 * no byte is ever queued for the CDC port. The UART0 debug terminal is a
 * separate object ("Uart") and is untouched - it stays gated behind the config
 * flag, because its TX pin is IO21, which belongs to the IR receiver.
 */

#include <Arduino.h>

class NullConsole : public Stream {
 public:
  void begin(unsigned long baud) { (void)baud; }
  void begin(unsigned long baud, uint32_t config) { (void)baud; (void)config; }
  void end() {}
  void setDebugOutput(bool on) { (void)on; }
  int available() override { return 0; }
  int availableForWrite() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  size_t write(uint8_t c) override { (void)c; return 1; }
  size_t write(const uint8_t *buf, size_t size) override { (void)buf; return size; }
  void flush() override {}
  operator bool() const { return false; }

  /* These hide every print/println overload Print offers. Without them the
     base class still formats each message and only the final write is dropped,
     so the CPU cost of 140 debug strings would survive the removal. */
  template <typename... Args> size_t print(Args... args) { (void)sizeof...(args); return 0; }
  template <typename... Args> size_t println(Args... args) { (void)sizeof...(args); return 0; }
  int printf(const char *fmt, ...) { (void)fmt; return 0; }
};

extern NullConsole NullSerial;

#define Serial NullSerial
