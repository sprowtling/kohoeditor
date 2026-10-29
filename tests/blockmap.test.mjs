// The top-down block map: decoding subchunks and picking each column's top block.
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderChunk, readSubchunk, blockStyle, CELL } from '../src/lib/blockmap.js';
import { serialize, T } from '../src/lib/nbt.js';
import { Writer, concatBytes } from '../src/lib/bytes.js';

const block = (name, states = []) => serialize({ n: '', t: T.Compound, v: [{ n: 'name', t: T.String, v: name }, { n: 'states', t: T.Compound, v: states }, { n: 'version', t: T.Int, v: 18100737 }] });

// A palette subchunk (version 9). pick(x, y, z) returns a palette index.
function subchunk(palette, pick, sub = 0) {
  const bits = palette.length <= 2 ? 1 : palette.length <= 4 ? 2 : 4;
  const perWord = Math.floor(32 / bits);
  const words = new Uint32Array(Math.ceil(4096 / perWord));
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) {
    const u = (x << 8) | (z << 4) | y;
    words[Math.floor(u / perWord)] |= pick(x, y, z) << ((u % perWord) * bits);
  }
  const w = new Writer(1 << 16);
  w.u8(9); w.u8(1); w.i8(sub);
  w.u8(bits << 1);
  for (const word of words) w.u32(word);
  w.i32(palette.length);
  return concatBytes([w.result(), ...palette]);
}

const cell = (out, cx, cz) => {
  const i = cz * CELL + cx;
  return { rgb: [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]], h: new DataView(out.buffer).getUint16(192 + i * 2, true) };
};

test('each column shows its top block, and its height', () => {
  const air = block('minecraft:air'), stone = block('minecraft:stone'), grass = block('minecraft:grass_block');
  // Sub 4 (y 64 to 79): grass at y 66 on the west half, nothing on the east half.
  const top = subchunk([air, grass], (x, y) => (x < 8 && y === 2 ? 1 : 0), 4);
  // Sub 3 (y 48 to 63): stone everywhere at y 60.
  const low = subchunk([air, stone], (x, y) => (y === 12 ? 1 : 0), 3);
  const out = renderChunk([3, 4], (s) => (s === 4 ? top : s === 3 ? low : null));
  assert.deepEqual(cell(out, 0, 0).rgb, blockStyle('minecraft:grass_block').rgb);
  assert.equal(cell(out, 0, 0).h, 66 + 64);
  assert.deepEqual(cell(out, 7, 7).rgb, blockStyle('minecraft:stone').rgb);
  assert.equal(cell(out, 7, 7).h, 60 + 64);
});

test('water tints what is under it, and decorations are seen through', () => {
  const air = block('minecraft:air'), water = block('minecraft:water'), sand = block('minecraft:sand'), torch = block('minecraft:torch');
  const sc = subchunk([air, water, sand, torch], (x, y) => (y === 15 && x >= 8 ? 3 : y >= 10 && y < 15 ? 1 : y === 9 ? 2 : 0), 4);
  const out = renderChunk([4], () => sc);
  const shallow = cell(out, 0, 0);
  assert.equal(shallow.h, 64 + 14 + 64, 'height is the water surface');
  assert.ok(shallow.rgb[2] > shallow.rgb[0], 'looks blue');
  // Where a torch stands on top, the map still shows the water below it.
  assert.deepEqual(cell(out, 7, 0).rgb, shallow.rgb);
});

test('2018-era palettes ("val") and old numeric subchunks are read', () => {
  // A palette entry with a data value instead of block states: red wool.
  const old = serialize({ n: '', t: T.Compound, v: [{ n: 'name', t: T.String, v: 'minecraft:wool' }, { n: 'val', t: T.Short, v: 14 }] });
  const air = serialize({ n: '', t: T.Compound, v: [{ n: 'name', t: T.String, v: 'minecraft:air' }, { n: 'val', t: T.Short, v: 0 }] });
  const sc = subchunk([air, old], (x, y) => (y === 0 ? 1 : 0));
  sc[0] = 8; // version 8 has no y index byte
  const v8 = concatBytes([sc.subarray(0, 2), sc.subarray(3)]);
  const at = readSubchunk(v8);
  assert.deepEqual(at(0, 0, 0).rgb, [153, 51, 51]);
  assert.equal(at(0, 1, 0).skip, true);
  // Pre-palette format: 4096 block ids then 2048 bytes of data values.
  const legacy = new Uint8Array(1 + 4096 + 2048 + 4096);
  legacy[0] = 0;
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
    const i = (x << 8) | (z << 4) | 5;
    legacy[1 + i] = 35; // wool
    const d = 1 + 4096 + (i >> 1);
    legacy[d] |= i & 1 ? 11 << 4 : 11; // blue
  }
  const out = renderChunk([2], () => legacy);
  assert.deepEqual(cell(out, 3, 3).rgb, [51, 76, 178].map((v) => v)); // blue wool
  assert.equal(cell(out, 3, 3).h, 2 * 16 + 5 + 64);
});

test('colours come from names and old-style states', () => {
  assert.deepEqual(blockStyle('minecraft:red_concrete').rgb, [153, 51, 51]);
  assert.deepEqual(blockStyle('minecraft:spruce_planks').rgb, blockStyle('minecraft:planks', [{ n: 'wood_type', t: T.String, v: 'spruce' }]).rgb);
  assert.equal(blockStyle('minecraft:air').skip, true);
  assert.equal(blockStyle('minecraft:water').water, true);
  assert.ok(blockStyle('minecraft:some_new_block_from_2027').rgb, 'unknown blocks still get a colour');
  assert.equal(readSubchunk(Uint8Array.of(9, 0, 0))(0, 0, 0).skip, true, 'empty subchunk');
});
