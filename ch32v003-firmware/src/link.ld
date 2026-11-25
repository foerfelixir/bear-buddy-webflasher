ENTRY(_start)

MEMORY
{
    /* The chip has 16K, but FLASH is capped at 2K so code and rodata can
       never grow into the IR config page at 0x800 (see CFG_ADDR in main.c). */
    FLASH (rx)  : ORIGIN = 0x00000000, LENGTH = 2K
    RAM   (xrw) : ORIGIN = 0x20000000, LENGTH = 2K
}

SECTIONS
{
    .init :
    {
        KEEP(*(.init))
    } >FLASH

    .text :
    {
        *(.text .text.*)
        *(.rodata .rodata.*)
        *(.srodata .srodata.*)
        . = ALIGN(4);
    } >FLASH

    .data :
    {
        . = ALIGN(4);
        _data_vma = .;
        *(.data .data.*)
        *(.sdata .sdata.*)
        . = ALIGN(4);
        _edata = .;
    } >RAM AT>FLASH
    _data_lma = LOADADDR(.data);

    .bss (NOLOAD) :
    {
        . = ALIGN(4);
        _sbss = .;
        *(.bss .bss.*)
        *(.sbss .sbss.*)
        *(COMMON)
        . = ALIGN(4);
        _ebss = .;
    } >RAM

    __global_pointer$ = ORIGIN(RAM) + 0x400;
    _eusrstack = ORIGIN(RAM) + LENGTH(RAM);

    /DISCARD/ :
    {
        *(.comment)
        *(.note .note.*)
        *(.eh_frame .eh_frame.*)
    }
}
