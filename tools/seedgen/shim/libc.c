/* Minimal C library for the seed map module. Memory is a simple arena: the
 * module resets it between requests (see koho_seed.c), so free() does nothing. */
#include <stddef.h>
#include <stdint.h>

extern unsigned char __heap_base;
static uintptr_t heap_top = 0;

uintptr_t koho_heap_mark(void) { if (!heap_top) heap_top = (uintptr_t)&__heap_base; return heap_top; }
void koho_heap_reset(uintptr_t mark) { heap_top = mark; }

void *malloc(size_t n) {
  if (!heap_top) heap_top = (uintptr_t)&__heap_base;
  uintptr_t p = (heap_top + 15) & ~(uintptr_t)15;
  uintptr_t end = p + n;
  size_t have = __builtin_wasm_memory_size(0) * 65536;
  if (end > have) {
    size_t pages = (end - have + 65535) / 65536;
    if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) return 0;
  }
  heap_top = end;
  return (void *)p;
}
void free(void *p) { (void)p; }
void *memset(void *d, int c, size_t n) { unsigned char *p = d; while (n--) *p++ = (unsigned char)c; return d; }
void *memcpy(void *d, const void *s, size_t n) { unsigned char *a = d; const unsigned char *b = s; while (n--) *a++ = *b++; return d; }
void *memmove(void *d, const void *s, size_t n) {
  unsigned char *a = d; const unsigned char *b = s;
  if (a < b) while (n--) *a++ = *b++; else { a += n; b += n; while (n--) *--a = *--b; }
  return d;
}
int memcmp(const void *x, const void *y, size_t n) { const unsigned char *a = x, *b = y; for (; n; n--, a++, b++) if (*a != *b) return *a - *b; return 0; }
void *calloc(size_t n, size_t size) { void *p = malloc(n * size); if (p) memset(p, 0, n * size); return p; }
void *realloc(void *old, size_t n) { void *p = malloc(n); if (p && old) memmove(p, old, n); return p; }
size_t strlen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
int strcmp(const char *a, const char *b) { while (*a && *a == *b) a++, b++; return (unsigned char)*a - (unsigned char)*b; }
_Noreturn void exit(int code) { (void)code; __builtin_trap(); }
_Noreturn void abort(void) { __builtin_trap(); }
int abs(int x) { return x < 0 ? -x : x; }
long labs(long x) { return x < 0 ? -x : x; }
long long llabs(long long x) { return x < 0 ? -x : x; }
void qsort(void *base, size_t n, size_t size, int (*cmp)(const void *, const void *)) {
  /* insertion sort: only small arrays are ever sorted here */
  unsigned char *b = base, tmp[64];
  for (size_t i = 1; i < n; i++) {
    for (size_t j = i; j > 0 && cmp(b + (j - 1) * size, b + j * size) > 0; j--) {
      memcpy(tmp, b + j * size, size); memcpy(b + j * size, b + (j - 1) * size, size); memcpy(b + (j - 1) * size, tmp, size);
    }
  }
}
double round(double x) { return x < 0 ? -__builtin_floor(-x + 0.5) : __builtin_floor(x + 0.5); }
float roundf(float x) { return x < 0 ? -__builtin_floorf(-x + 0.5f) : __builtin_floorf(x + 0.5f); }
long lround(double x) { return (long)round(x); }
long long llround(double x) { return (long long)round(x); }
double exp(double x) {
  /* exp(x) = 2^k * exp(r), |r| <= ln2/2; series for exp(r) */
  if (x > 709) return __builtin_inf();
  if (x < -745) return 0;
  double k = __builtin_floor(x / 0.6931471805599453 + 0.5);
  double r = x - k * 0.6931471805599453;
  double term = 1, sum = 1;
  for (int i = 1; i < 25; i++) { term *= r / i; sum += term; }
  long long kk = (long long)k;
  while (kk > 0) { sum *= 2; kk--; }
  while (kk < 0) { sum *= 0.5; kk++; }
  return sum;
}
double log(double x) {
  if (x <= 0) return -__builtin_inf();
  int k = 0;
  while (x > 2) { x *= 0.5; k++; }
  while (x < 1) { x *= 2; k--; }
  /* log(x) = 2 atanh((x-1)/(x+1)) */
  double t = (x - 1) / (x + 1), t2 = t * t, term = t, sum = 0;
  for (int i = 1; i < 60; i += 2) { sum += term / i; term *= t2; }
  return 2 * sum + k * 0.6931471805599453;
}
double pow(double x, double y) {
  if (y == __builtin_floor(y) && __builtin_fabs(y) < 1e6) {
    long long n = (long long)y; double r = 1, b = x; int neg = n < 0; if (neg) n = -n;
    while (n) { if (n & 1) r *= b; b *= b; n >>= 1; }
    return neg ? 1 / r : r;
  }
  return exp(y * log(x));
}
double fmod(double x, double y) { return x - __builtin_trunc(x / y) * y; }
double sin(double x) {
  double pi2 = 6.283185307179586; x = fmod(x, pi2); if (x > 3.141592653589793) x -= pi2; if (x < -3.141592653589793) x += pi2;
  double term = x, sum = x; for (int i = 1; i < 15; i++) { term *= -x * x / ((2 * i) * (2 * i + 1)); sum += term; } return sum;
}
double cos(double x) { return sin(x + 1.5707963267948966); }
