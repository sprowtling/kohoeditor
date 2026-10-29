/* Just enough of the C library for cubiomes' biome code, compiled to WebAssembly. */
#pragma once
#include <stddef.h>
void *malloc(size_t n);
void *calloc(size_t n, size_t size);
void *realloc(void *p, size_t n);
void free(void *p);
_Noreturn void exit(int code);
_Noreturn void abort(void);
int abs(int x);
long labs(long x);
long long llabs(long long x);
void qsort(void *base, size_t n, size_t size, int (*cmp)(const void *, const void *));
