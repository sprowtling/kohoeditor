// Biomes: names, map colours, and reading the surface biome of a chunk.
//
// Chunks store biomes in one of two records:
//   Data3D (tag 0x2b, Bedrock 1.18 and later): a 16×16 heightmap, then one
//     palette of biome ids per 16-block vertical section.
//   Data2D (tag 0x2d, older worlds): a 16×16 heightmap, then one biome byte
//     per column.
// For the map we only need the biome at the surface, sampled on a 4×4 grid
// per chunk (biomes themselves vary at about that scale).

// Bedrock biome ids with the usual map colours (as used by rbedrock and Amidst).
export const BIOMES = {
  0: ['Ocean', '#000070'], 1: ['Plains', '#8db360'], 2: ['Desert', '#fa9418'], 3: ['Windswept Hills', '#606060'],
  4: ['Forest', '#056621'], 5: ['Taiga', '#0b6a5f'], 6: ['Swamp', '#07f9b2'], 7: ['River', '#0000ff'],
  8: ['Nether Wastes', '#572526'], 9: ['The End', '#8080ff'], 10: ['Legacy Frozen Ocean', '#7070d6'], 11: ['Frozen River', '#a0a0ff'],
  12: ['Snowy Plains', '#ffffff'], 13: ['Snowy Mountains', '#a0a0a0'], 14: ['Mushroom Fields', '#ff00ff'], 15: ['Mushroom Field Shore', '#a000ff'],
  16: ['Beach', '#fade55'], 17: ['Desert Hills', '#d25f12'], 18: ['Wooded Hills', '#22551c'], 19: ['Taiga Hills', '#163933'],
  20: ['Mountain Edge', '#72789a'], 21: ['Jungle', '#507b0a'], 22: ['Jungle Hills', '#2c4205'], 23: ['Sparse Jungle', '#60930f'],
  24: ['Deep Ocean', '#000030'], 25: ['Stony Shore', '#a2a284'], 26: ['Snowy Beach', '#faf0c0'], 27: ['Birch Forest', '#307444'],
  28: ['Birch Forest Hills', '#1f5f32'], 29: ['Dark Forest', '#40511a'], 30: ['Snowy Taiga', '#31554a'], 31: ['Snowy Taiga Hills', '#243f36'],
  32: ['Old Growth Pine Taiga', '#596651'], 33: ['Giant Tree Taiga Hills', '#454f3e'], 34: ['Windswept Forest', '#5b7352'], 35: ['Savanna', '#bdb25f'],
  36: ['Savanna Plateau', '#a79d64'], 37: ['Badlands', '#d94515'], 38: ['Wooded Badlands', '#b09765'], 39: ['Badlands Plateau', '#ca8c65'],
  40: ['Warm Ocean', '#0000ac'], 41: ['Deep Warm Ocean', '#000050'], 42: ['Lukewarm Ocean', '#000090'], 43: ['Deep Lukewarm Ocean', '#000040'],
  44: ['Cold Ocean', '#202070'], 45: ['Deep Cold Ocean', '#202038'], 46: ['Frozen Ocean', '#7070d6'], 47: ['Deep Frozen Ocean', '#404090'],
  48: ['Bamboo Jungle', '#849500'], 49: ['Bamboo Jungle Hills', '#5c6c04'],
  129: ['Sunflower Plains', '#b5db88'], 130: ['Desert Lakes', '#ffbc40'], 131: ['Windswept Gravelly Hills', '#888888'], 132: ['Flower Forest', '#2d8e49'],
  133: ['Taiga Mountains', '#339287'], 134: ['Swamp Hills', '#2fffda'], 140: ['Ice Spikes', '#b4dcdc'], 149: ['Modified Jungle', '#78a332'],
  151: ['Modified Jungle Edge', '#88bb37'], 155: ['Old Growth Birch Forest', '#589c6c'], 156: ['Tall Birch Hills', '#47875a'], 157: ['Dark Forest Hills', '#687942'],
  158: ['Snowy Taiga Mountains', '#597d72'], 160: ['Old Growth Spruce Taiga', '#818e79'], 161: ['Giant Spruce Taiga Hills', '#6d7766'], 162: ['Modified Gravelly Mountains', '#839b7a'],
  163: ['Windswept Savanna', '#e5da87'], 164: ['Shattered Savanna Plateau', '#cfc58c'], 165: ['Eroded Badlands', '#ff6d3d'], 166: ['Modified Wooded Badlands', '#d8bf8d'],
  167: ['Modified Badlands Plateau', '#f2b48d'], 178: ['Soul Sand Valley', '#4d3a2e'], 179: ['Crimson Forest', '#981a11'], 180: ['Warped Forest', '#49907b'],
  181: ['Basalt Deltas', '#645f63'], 182: ['Jagged Peaks', '#dcdcc8'], 183: ['Frozen Peaks', '#b0b3ce'], 184: ['Snowy Slopes', '#c4c4c4'],
  185: ['Grove', '#47726c'], 186: ['Meadow', '#60a445'], 187: ['Lush Caves', '#283c00'], 188: ['Dripstone Caves', '#4e3012'],
  189: ['Stony Peaks', '#7b8f74'], 190: ['Deep Dark', '#031f29'], 191: ['Mangrove Swamp', '#2ccc8e'], 192: ['Cherry Grove', '#ff91c8'],
  193: ['Pale Garden', '#696d95'],
};

export const biomeName = (id) => BIOMES[id]?.[0] ?? `Biome #${id}`;

// RGB for each id 0..255, with grey for ids we don't know.
export const BIOME_RGB = (() => {
  const t = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const hex = BIOMES[i]?.[1] ?? '#9a9a9a';
    t[i * 3] = parseInt(hex.slice(1, 3), 16);
    t[i * 3 + 1] = parseInt(hex.slice(3, 5), 16);
    t[i * 3 + 2] = parseInt(hex.slice(5, 7), 16);
  }
  return t;
})();

// A surface sample: 16 biome ids (one byte each), then 16 heights (uint16, y + 64),
// for the columns at x, z = 2, 6, 10, 14 within the chunk, row by row.
export const SAMPLE_SIZE = 48;
const SAMPLE_AT = [2, 6, 10, 14];
const NO_BIOME = 255;

// Reads the palette-encoded section that starts at p. Returns { next, at(x, y, z) } or
// { next, copy: true } for "same as the section below".
function readSection(v, p) {
  if (p >= v.length) return null;
  const flags = v[p++];
  const bits = flags >> 1;
  if (bits === 127) return { next: p, copy: true };
  const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
  if (bits === 0) {
    if (p + 4 > v.length) return null;
    const id = dv.getInt32(p, true);
    return { next: p + 4, at: () => id };
  }
  const perWord = Math.floor(32 / bits);
  const words = Math.ceil(4096 / perWord);
  const wordsAt = p;
  p += words * 4;
  if (p + 4 > v.length) return null;
  const count = dv.getInt32(p, true);
  p += 4;
  if (count < 0 || p + count * 4 > v.length) return null;
  const palette = new Int32Array(count);
  for (let i = 0; i < count; i++) palette[i] = dv.getInt32(p + i * 4, true);
  p += count * 4;
  const mask = (1 << bits) - 1;
  return {
    next: p,
    at(x, y, z) {
      const u = (x << 8) | (z << 4) | y; // stored in x, z, y order
      const word = dv.getUint32(wordsAt + Math.floor(u / perWord) * 4, true);
      return palette[(word >>> ((u % perWord) * bits)) & mask] ?? NO_BIOME;
    },
  };
}

export function sampleData3D(v) {
  if (v.length < 512 + 5) return null;
  const sections = [];
  let p = 512;
  while (p < v.length && sections.length < 32) {
    const s = readSection(v, p);
    if (!s) break;
    sections.push(s.copy ? sections[sections.length - 1] ?? null : s);
    p = s.next;
  }
  if (!sections.length || !sections[0]) return null;
  const out = new Uint8Array(SAMPLE_SIZE);
  const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
  const hv = new DataView(out.buffer);
  let i = 0;
  for (const z of SAMPLE_AT) {
    for (const x of SAMPLE_AT) {
      const h = dv.getInt16((x + 16 * z) * 2, true); // height above the bottom of the world
      const y = Math.max(0, h - 1);
      const si = Math.min(sections.length - 1, y >> 4);
      const s = sections[si] ?? sections[0];
      const id = s.at(x, y & 15, z);
      out[i] = id >= 0 && id < 255 ? id : NO_BIOME;
      hv.setUint16(16 + i * 2, Math.max(0, h), true);
      i++;
    }
  }
  return out;
}

export function sampleData2D(v) {
  if (v.length < 512 + 256) return null;
  const out = new Uint8Array(SAMPLE_SIZE);
  const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
  const hv = new DataView(out.buffer);
  let i = 0;
  for (const z of SAMPLE_AT) {
    for (const x of SAMPLE_AT) {
      out[i] = v[512 + x + 16 * z];
      // Old heightmaps count from y = 0; store them on the same y + 64 scale.
      hv.setUint16(16 + i * 2, Math.max(0, dv.getInt16((x + 16 * z) * 2, true) + 64), true);
      i++;
    }
  }
  return out;
}

// Called for every database entry during a scan: returns a surface sample for
// biome records and null for everything else. Must be cheap for other keys.
export function extractSurface(ukey, value) {
  const n = ukey.length;
  if (n !== 9 && n !== 13) return null;
  const tag = ukey[n - 1];
  if (tag !== 0x2b && tag !== 0x2d) return null;
  if ((ukey[3] !== 0 && ukey[3] !== 0xff) || (ukey[7] !== 0 && ukey[7] !== 0xff)) return null;
  try {
    return tag === 0x2b ? sampleData3D(value) : sampleData2D(value);
  } catch {
    return null;
  }
}
