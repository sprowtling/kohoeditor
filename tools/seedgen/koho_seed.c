/* What the editor calls: set up a seed, then ask for biomes over an area.
 * Biome ids are cubiomes' (Java) ids; the editor maps them to Bedrock's. */
#include "generator.h"

#define EXPORT __attribute__((visibility("default")))

uintptr_t koho_heap_mark(void);
void koho_heap_reset(uintptr_t mark);

static Generator g;
static SurfaceNoise sn;
static uintptr_t mark;
static int dimension;
static uint64_t world_seed;

EXPORT int koho_mc_newest(void) { return MC_NEWEST; }

EXPORT int koho_setup(int mc, int dim, uint32_t seed_lo, uint32_t seed_hi) {
  koho_heap_reset(0);
  world_seed = ((uint64_t)seed_hi << 32) | seed_lo;
  dimension = dim;
  setupGenerator(&g, mc, 0);
  applySeed(&g, dim, world_seed);
  if (dim == DIM_OVERWORLD) initSurfaceNoise(&sn, dim, world_seed);
  mark = koho_heap_mark();
  return 0;
}

/* Biomes over sx by sz cells at the given scale (1, 4, 16, 64 or 256 blocks
 * per cell), at height y in 1:4 units (y = 16 is block 64). Returns a pointer
 * to sx * sz ints, valid until the next call. */
EXPORT int *koho_biomes(int scale, int x, int z, int sx, int sz, int y) {
  koho_heap_reset(mark);
  Range r = { scale, x, z, sx, sz, y, 1 };
  int *cache = allocCache(&g, r);
  if (!cache || genBiomes(&g, cache, r)) return 0;
  return cache;
}

/* Biomes at the (approximate) surface over w by h cells of 4 blocks, with the
 * surface heights after them: returns w*h ints of ids, then w*h floats. */
EXPORT int *koho_surface(int x, int z, int w, int h) {
  koho_heap_reset(mark);
  int *ids = (int *)malloc(sizeof(int) * w * h * 2);
  float *ys = (float *)(ids + w * h);
  if (!ids || mapApproxHeight(ys, ids, &g, &sn, x, z, w, h)) return 0;
  return ids;
}
