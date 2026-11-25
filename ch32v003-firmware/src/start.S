/* CH32V003 reset/vector entry. No interrupts are used; any unexpected
   exception vectors to address 0, which restarts the firmware. */

    .section .init, "ax", @progbits
    .globl _start
    .type _start, @function
_start:
    .option push
    .option norvc
    j reset_handler
    .option pop

    /* exception vectors 1..63 -> address 0 (restart) */
    .rept 63
    .word 0
    .endr

    .size _start, .-_start

    .section .text.start, "ax", @progbits
    .type reset_handler, @function
reset_handler:
    .option push
    .option norelax
    la gp, __global_pointer$
    .option pop
    la sp, _eusrstack

    la a0, _sbss
    la a1, _ebss
    bgeu a0, a1, 2f
1:  sw zero, 0(a0)
    addi a0, a0, 4
    bltu a0, a1, 1b
2:
    la a0, _data_lma
    la a1, _data_vma
    la a2, _edata
    beq a1, a2, 4f
3:  lw a3, 0(a0)
    sw a3, 0(a1)
    addi a0, a0, 4
    addi a1, a1, 4
    bltu a1, a2, 3b
4:
    call main
5:  j 5b
    .size reset_handler, .-reset_handler
