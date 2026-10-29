#pragma once
#include <stddef.h>
typedef struct FILE FILE;
#define stderr ((FILE *)0)
#define stdout ((FILE *)0)
static inline int printf(const char *f, ...) { (void)f; return 0; }
static inline int fprintf(FILE *s, const char *f, ...) { (void)s; (void)f; return 0; }
static inline int sprintf(char *b, const char *f, ...) { (void)f; if (b) b[0] = 0; return 0; }
static inline int snprintf(char *b, size_t n, const char *f, ...) { (void)f; if (b && n) b[0] = 0; return 0; }
static inline int puts(const char *s) { (void)s; return 0; }
