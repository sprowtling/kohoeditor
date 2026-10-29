// Generates seed-map tiles: what the world seed produces, biome by biome.
// A few of these run at once; each keeps the generator set up for the last
// seed and dimension it was asked about.

import { SeedGen } from './lib/seedgen.js';

let gen = null;
let current = '';
const loading = fetch(new URL('../vendor/seedgen.wasm', import.meta.url))
  .then((r) => { if (!r.ok) throw new Error(`Couldn't load the seed generator (${r.status}).`); return r.arrayBuffer(); })
  .then((bytes) => SeedGen.load(bytes))
  .then((g) => { gen = g; });

// A tile is TILE_CELLS × TILE_CELLS cells of `scale` blocks.
const TILE_CELLS = 256;

self.onmessage = async (ev) => {
  const { id, seed, dim, scale, tx, tz, y } = ev.data;
  try {
    await loading;
    const key = `${seed}:${dim}`;
    if (key !== current) { gen.setup(seed, dim); current = key; }
    const ids = gen.biomes(scale, tx * TILE_CELLS, tz * TILE_CELLS, TILE_CELLS, TILE_CELLS, y);
    self.postMessage({ id, ids }, [ids.buffer]);
  } catch (e) {
    self.postMessage({ id, error: e.message || String(e) });
  }
};
