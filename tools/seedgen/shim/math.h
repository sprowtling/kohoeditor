#pragma once
#define floor __builtin_floor
#define ceil __builtin_ceil
#define sqrt __builtin_sqrt
#define fabs __builtin_fabs
#define floorf __builtin_floorf
#define ceilf __builtin_ceilf
#define sqrtf __builtin_sqrtf
#define fabsf __builtin_fabsf
#define trunc __builtin_trunc
#define INFINITY __builtin_inf()
#define NAN __builtin_nan("")
double round(double x);
float roundf(float x);
long lround(double x);
long long llround(double x);
double pow(double x, double y);
double exp(double x);
double log(double x);
double sin(double x);
double cos(double x);
double fmod(double x, double y);
static inline double nan(const char *s) { (void)s; return __builtin_nan(""); }
