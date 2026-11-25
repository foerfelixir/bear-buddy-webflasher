/*
 * CH32V003J4M6 three-button IR remote, NEC or Samsung per button.
 *
 * SW1 (PC4), SW2 (PC2) and SW3 (PC1) each send their own code, read from
 * a config page in flash at 0x08000800 so a web programmer can rewrite them
 * over SWIO without rebuilding. A blank or corrupt page falls back to the
 * factory codes: address 0x00, commands 152 / 31 / 62, all NEC.
 * NEC frame:     address, ~address, command, ~command, LSB first, 9 ms mark.
 * Samsung frame: address,  address, command, ~command, LSB first, 4.5 ms mark.
 * The two share every bit timing, so only the header mark and the second byte
 * differ; the config page picks which one each button sends.
 * PA2 (TIM1_CH2N) drives the IR LED and the indicator LED, active low.
 *
 * While a button is held its frame repeats every 200 ms. Releasing it
 * opens a window in which the core stays awake so the SWIO debug pin remains
 * reachable; the window closes at once if a button is pressed again, so the
 * remote is never deaf. With several buttons held, SW1 wins over SW2, which
 * wins over SW3. The 38 kHz carrier is pure timer hardware; the core only
 * gates it.
 */

#include <stdint.h>

#define REG32(a) (*(volatile uint32_t *)(a))
#define REG16(a) (*(volatile uint16_t *)(a))

/* RCC */
#define RCC_CFGR0       REG32(0x40021004u)
#define RCC_APB2PCENR   REG32(0x40021018u)
#define RCC_APB1PCENR   REG32(0x4002101Cu)

/* AFIO / EXTI */
#define AFIO_EXTICR     REG32(0x40010008u)
#define EXTI_EVENR      REG32(0x40010404u)
#define EXTI_FTENR      REG32(0x4001040Cu)
#define EXTI_INTFR      REG32(0x40010414u)

/* GPIO */
#define GPIOA_CFGLR     REG32(0x40010800u)
#define GPIOA_BSHR      REG32(0x40010810u)
#define GPIOC_CFGLR     REG32(0x40011000u)
#define GPIOC_INDR      REG32(0x40011008u)
#define GPIOC_BSHR      REG32(0x40011010u)
#define GPIOD_CFGLR     REG32(0x40011400u)
#define GPIOD_INDR      REG32(0x40011408u)
#define GPIOD_BSHR      REG32(0x40011410u)

/* TIM1 */
#define TIM1_CTLR1      REG16(0x40012C00u)
#define TIM1_SWEVGR     REG16(0x40012C14u)
#define TIM1_CHCTLR1    REG16(0x40012C18u)
#define TIM1_CCER       REG16(0x40012C20u)
#define TIM1_ATRLR      REG16(0x40012C2Cu)
#define TIM1_CH2CVR     REG32(0x40012C38u)
#define TIM1_BDTR       REG16(0x40012C44u)

/* PWR / core */
#define PWR_CTLR        REG32(0x40007000u)
#define SYSTICK_CTLR    REG32(0xE000F000u)
#define SYSTICK_CNT     REG32(0xE000F008u)
#define PFIC_SCTLR      REG32(0xE000ED10u)

#define RCC_AFIOEN      (1u << 0)
#define RCC_IOPAEN      (1u << 2)
#define RCC_IOPCEN      (1u << 4)
#define RCC_IOPDEN      (1u << 5)
#define RCC_TIM1EN      (1u << 11)
#define RCC_PWREN       (1u << 28)

#define PWR_PDDS        (1u << 1)
#define PFIC_SLEEPDEEP  (1u << 2)
#define PFIC_WFITOWFE   (1u << 3)  /* make wfi wait for events, not IRQs */

#define KEY_MASK        ((1u << 1) | (1u << 2) | (1u << 4))  /* PC1, PC2, PC4 */
#define SWIO_PIN        (1u << 1)  /* PD1, the single-wire debug pin */

/* Factory codes, used when the config page has never been programmed. */
#define NEC_ADDR        0x00u
#define NEC_CMD_SW1     152u
#define NEC_CMD_SW2     31u
#define NEC_CMD_SW3     62u

#define NUM_BUTTONS     3u

/*
 * Config page layout, 64 bytes at the start of flash page 32. link.ld caps
 * FLASH at 2K so code and rodata can never grow into it, and the page is
 * 64-byte aligned so the programmer can erase and rewrite it on its own.
 *
 *   0x00  magic, little endian "IRC2"
 *   0x04  addr[0], cmd[0], proto[0], 0xFF   SW1
 *   0x08  addr[1], cmd[1], proto[1], 0xFF   SW2
 *   0x0C  addr[2], cmd[2], proto[2], 0xFF   SW3
 *   0x10  checksum, little endian: sum of bytes 0x00..0x0F
 *   0x14  unused, 0xFF
 *
 * The magic went from "IRC1" to "IRC2" when the protocol byte was added: an
 * old page has its checksum where a protocol byte now sits, so it must be
 * rejected rather than half-read. The programmer rewrites the page anyway.
 */
#define CFG_ADDR        0x08000800u
#define CFG_MAGIC       0x32435249u  /* "IRC2" */
#define CFG_SUM_LEN     16u
#define CFG_STRIDE      4u

#define PROTO_NEC       0u
#define PROTO_SAMSUNG   1u

#define NEC_HDR_MARK_US     9000u
#define NEC_HDR_SPACE_US    4500u
#define NEC_BIT_MARK_US     560u
#define NEC_ZERO_SPACE_US   560u
#define NEC_ONE_SPACE_US    1690u
/* Samsung halves the header mark and repeats the address byte; the 4.5 ms
   header space and all bit timings are the same as NEC's. */
#define SAMSUNG_HDR_MARK_US 4500u

/* SysTick ticks at HCLK = 1.5 MHz; 9000 ticks = 6 ms debounce. */
#define DEBOUNCE_TICKS  9000u
/* Gap between frames while a button is held: 300000 ticks = 200 ms. */
#define REPEAT_GAP_TICKS 300000u
/* Standby kills the SWIO debug pin until a button wakes the chip, so after
   power-up and after every release the core stays awake to keep a programmer
   able to reach it. This is deliberately not a blind delay: a button press
   ends it immediately, and movement on SWIO pushes it back out so an active
   session is never cut off mid-write. Checked every 1 ms. */
#define WINDOW_IDLE_TICKS 9000000u  /* 6 s */
#define WINDOW_STEP_TICKS 1500u     /* 1 ms */

static uint8_t btn_addr[NUM_BUTTONS];
static uint8_t btn_cmd[NUM_BUTTONS];
static uint8_t btn_proto[NUM_BUTTONS];

static inline void delay_ticks(uint32_t n)
{
    uint32_t end = SYSTICK_CNT + n;
    while ((int32_t)(SYSTICK_CNT - end) < 0)
        ;
}

static inline void delay_us(uint32_t us)
{
    delay_ticks(us + (us >> 1));
}

static inline __attribute__((always_inline)) void ir_on(void)
{
    /* PA2 alternate-function push-pull: TIM1_CH2N drives the LEDs */
    GPIOA_CFGLR = (GPIOA_CFGLR & ~(0xFu << 8)) | (0x9u << 8);
}

static inline __attribute__((always_inline)) void ir_off(void)
{
    /* preset the output latch high (LEDs off) before leaving AF mode */
    GPIOA_BSHR = 1u << 2;
    GPIOA_CFGLR = (GPIOA_CFGLR & ~(0xFu << 8)) | (0x1u << 8);
}

static inline void ir_mark(uint32_t us)
{
    ir_on();
    delay_us(us);
    ir_off();
}

/* One byte, LSB first. Both protocols use identical bit timings: a 560 us
   mark, then a space of 560 us for 0 or 1690 us for 1. */
static void ir_byte(uint8_t value)
{
    for (uint8_t i = 0; i < 8; i++, value >>= 1) {
        ir_mark(NEC_BIT_MARK_US);
        delay_us((value & 1u) ? NEC_ONE_SPACE_US : NEC_ZERO_SPACE_US);
    }
}

static uint32_t read_le32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

/* Re-read on every wake so a code written while the core was halted takes
   effect without waiting for the next power cycle. */
static void load_config(void)
{
    const uint8_t *p = (const uint8_t *)CFG_ADDR;
    uint32_t sum = 0;

    for (uint32_t i = 0; i < CFG_SUM_LEN; i++)
        sum += p[i];

    if (read_le32(p) == CFG_MAGIC && read_le32(p + CFG_SUM_LEN) == sum) {
        uint8_t protos_ok = 1;
        for (uint32_t i = 0; i < NUM_BUTTONS; i++) {
            btn_addr[i]  = p[4 + i * CFG_STRIDE];
            btn_cmd[i]   = p[5 + i * CFG_STRIDE];
            btn_proto[i] = p[6 + i * CFG_STRIDE];
            if (btn_proto[i] > PROTO_SAMSUNG)
                protos_ok = 0;
        }
        if (protos_ok)
            return;
    }

    for (uint32_t i = 0; i < NUM_BUTTONS; i++) {
        btn_addr[i]  = NEC_ADDR;
        btn_proto[i] = PROTO_NEC;
    }
    btn_cmd[0] = NEC_CMD_SW1;
    btn_cmd[1] = NEC_CMD_SW2;
    btn_cmd[2] = NEC_CMD_SW3;
}

static void ir_send(uint8_t addr, uint8_t cmd, uint8_t proto)
{
    if (proto == PROTO_SAMSUNG) {
        ir_mark(SAMSUNG_HDR_MARK_US);
        delay_us(NEC_HDR_SPACE_US);
        ir_byte(addr);
        ir_byte(addr);              /* repeated, not complemented */
    } else {
        ir_mark(NEC_HDR_MARK_US);
        delay_us(NEC_HDR_SPACE_US);
        ir_byte(addr);
        ir_byte((uint8_t)~addr);
    }
    ir_byte(cmd);
    ir_byte((uint8_t)~cmd);
    ir_mark(NEC_BIT_MARK_US);
    ir_off();
}

static void clock_init(void)
{
    RCC_CFGR0 = 0x000000B0u;  /* HSI 24 MHz / 16 = 1.5 MHz */
}

static void gpio_init(void)
{
    /* PA2 output push-pull high: both LEDs off */
    GPIOA_BSHR = 1u << 2;
    GPIOA_CFGLR = (GPIOA_CFGLR & ~(0xFu << 8)) | (0x1u << 8);

    /* PC1, PC2, PC4 input with internal pull-up (buttons to GND) */
    uint32_t cfg = GPIOC_CFGLR;
    cfg &= ~((0xFu << 4) | (0xFu << 8) | (0xFu << 16));
    cfg |= (0x8u << 4) | (0x8u << 8) | (0x8u << 16);
    GPIOC_CFGLR = cfg;
    GPIOC_BSHR = (1u << 1) | (1u << 2) | (1u << 4);

    /* PD6 is not connected: pull it up so it cannot float */
    uint32_t dcfg = GPIOD_CFGLR;
    dcfg &= ~(0xFu << 24);
    dcfg |= (0x8u << 24);
    GPIOD_CFGLR = dcfg;
    GPIOD_BSHR = 1u << 6;
}

static void systick_init(void)
{
    SYSTICK_CTLR = 0x5;  /* enable counter, clock = HCLK */
}

static void pwm_init(void)
{
    TIM1_CCER = 0x0040;      /* CC2NE: complementary output 2 enable */
    TIM1_CHCTLR1 = 0x7000;   /* OC2M = PWM mode 2 */
    TIM1_BDTR = 0x8000;      /* MOE: main output enable */
    TIM1_ATRLR = 38;         /* 1.5 MHz / 39 = 38.46 kHz carrier */
    TIM1_CH2CVR = 10;        /* 10/39 = 25.6 % LED on-time */
    TIM1_SWEVGR = 0x0001;    /* update generation */
    TIM1_CTLR1 = 0x0081;     /* ARPE | CEN */
}

static void exti_init(void)
{
    AFIO_EXTICR = (AFIO_EXTICR & ~((3u << 2) | (3u << 4) | (3u << 8)))
                | ((2u << 2) | (2u << 4) | (2u << 8));  /* lines 1,2,4 -> port C */
    EXTI_EVENR |= KEY_MASK;  /* wake the core with an event, no ISR needed */
    EXTI_FTENR |= KEY_MASK;
}

static void hw_init(void)
{
    clock_init();
    RCC_APB2PCENR |= RCC_AFIOEN | RCC_IOPAEN | RCC_IOPCEN | RCC_IOPDEN | RCC_TIM1EN;
    RCC_APB1PCENR |= RCC_PWREN;
    gpio_init();
    systick_init();
    pwm_init();
    exti_init();
    ir_off();
    load_config();
}

static void standby(void)
{
    EXTI_INTFR = KEY_MASK;   /* drop edges latched while awake */

    PWR_CTLR |= PWR_PDDS;    /* PDDS: deep sleep = standby */
    /* CH32V003 has no WFE; ch32fun maps wfi to event wait in SCTLR.
       The extra bit-5 pulse is part of that well-tested sequence. */
    uint32_t sctlr = PFIC_SCTLR;
    PFIC_SCTLR |= PFIC_SLEEPDEEP | PFIC_WFITOWFE | (1u << 5);
    PFIC_SCTLR = (PFIC_SCTLR & ~(1u << 5)) | (sctlr & (1u << 5));

    __asm__ volatile("wfi" ::: "memory");
    __asm__ volatile("wfi" ::: "memory");

    PFIC_SCTLR = sctlr;
    PWR_CTLR &= ~PWR_PDDS;
}

/* Index of the highest-priority held button, or -1 when none are. */
static int pressed_button(void)
{
    uint32_t pins = GPIOC_INDR;
    if (!(pins & (1u << 4)))
        return 0;
    if (!(pins & (1u << 2)))
        return 1;
    if (!(pins & (1u << 1)))
        return 2;
    return -1;
}

static uint32_t swio_level;

/* SWIO idles high on its 10 K pull-up and the programmer drives it low, so a
   change of level means the link is in use. Sampling only sees edges the core
   was awake for, which is exactly the set that matters. */
static int swio_moved(void)
{
    uint32_t now = GPIOD_INDR & SWIO_PIN;
    int moved = now != swio_level;
    swio_level = now;
    return moved;
}

static void link_window(void)
{
    swio_level = GPIOD_INDR & SWIO_PIN;

    for (uint32_t left = WINDOW_IDLE_TICKS; left > 0;) {
        if (pressed_button() >= 0)
            return;
        if (swio_moved())
            left = WINDOW_IDLE_TICKS;
        else
            left = left > WINDOW_STEP_TICKS ? left - WINDOW_STEP_TICKS : 0;
        delay_ticks(WINDOW_STEP_TICKS);
    }
}

void main(void)
{
    hw_init();
    link_window();

    for (;;) {
        standby();
        /* Re-running init is harmless if state survived standby and
           mandatory if the clock tree was reset on wake. */
        hw_init();
        delay_ticks(DEBOUNCE_TICKS);

        /* A press that lands while the window is open gets served rather than
           dropped, so the window re-runs until the remote is genuinely idle. */
        do {
            int btn;
            while ((btn = pressed_button()) >= 0) {
                ir_send(btn_addr[btn], btn_cmd[btn], btn_proto[btn]);
                delay_ticks(REPEAT_GAP_TICKS);
            }

            ir_off();
            link_window();
        } while (pressed_button() >= 0);
    }
}
