// What a world seed generates: biomes from Minecraft's world generator, as
// re-created by cubiomes (https://github.com/Cubitect/cubiomes, MIT licence),
// compiled to WebAssembly (vendor/seedgen.wasm; build files in tools/seedgen).
// Bedrock lays out biomes the same way as Java from 1.18 on.

// cubiomes uses Java's biome numbers; most match Bedrock's, these don't.
const TO_BEDROCK = new Uint8Array(256).map((_, i) => i);
Object.entries({
  10: 46, 40: 9, 41: 9, 42: 9, 43: 9, 44: 40, 45: 42, 46: 44, 47: 41, 48: 43, 49: 45, 50: 47,
  127: 255, 168: 48, 169: 49, 170: 178, 171: 179, 172: 180, 173: 181, 174: 188, 175: 187,
  177: 186, 178: 185, 179: 184, 180: 182, 181: 183, 182: 189, 183: 190, 184: 191, 185: 192, 186: 193,
}).forEach(([java, bedrock]) => { TO_BEDROCK[java] = bedrock; });

export const DIM_IDS = [0, -1, 1]; // overworld, nether, end in cubiomes

export class SeedGen {
  // bytes: the contents of seedgen.wasm
  static async load(bytes) {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new SeedGen(instance.exports);
  }

  constructor(exports) {
    this.x = exports;
    this.mc = exports.koho_mc_newest();
    this.ready = false;
  }

  // seed: a BigInt or a string of digits (it can be negative); dim: 0, 1 or 2.
  setup(seed, dim) {
    const s = BigInt.asUintN(64, BigInt(seed));
    this.x.koho_setup(this.mc, DIM_IDS[dim], Number(s & 0xffffffffn), Number(s >> 32n));
    this.ready = true;
    this.dim = dim;
  }

  // Bedrock biome ids over sx by sz cells of `scale` blocks (1, 4, 16, 64 or
  // 256), starting at cell x, z, at height y (in blocks).
  biomes(scale, x, z, sx, sz, y = 64) {
    const p = this.x.koho_biomes(scale, x, z, sx, sz, Math.floor(y / 4));
    if (!p) throw new Error('The seed map could not be generated here.');
    const ids = new Int32Array(this.x.memory.buffer, p, sx * sz);
    const out = new Uint8Array(sx * sz);
    for (let i = 0; i < out.length; i++) out[i] = ids[i] >= 0 && ids[i] < 256 ? TO_BEDROCK[ids[i]] : 255;
    return out;
  }

  // Biomes at the approximate surface, over w by h cells of 4 blocks, plus the
  // surface heights. Overworld only.
  surface(x, z, w, h) {
    const p = this.x.koho_surface(x, z, w, h);
    if (!p) throw new Error('The seed map could not be generated here.');
    const ids = new Int32Array(this.x.memory.buffer, p, w * h);
    const ys = new Float32Array(this.x.memory.buffer, p + w * h * 4, w * h);
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = ids[i] >= 0 && ids[i] < 256 ? TO_BEDROCK[ids[i]] : 255;
    return { ids: out, heights: Float32Array.from(ys) };
  }
}
