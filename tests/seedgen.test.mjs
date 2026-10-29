// The seed map: does the built-in generator agree with what Bedrock generated?
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SeedGen } from '../src/lib/seedgen.js';

const wasm = fs.readFileSync(new URL('../vendor/seedgen.wasm', import.meta.url));
const real = JSON.parse(fs.readFileSync(new URL('./fixtures/bedrock-biomes.json', import.meta.url), 'utf8'));

test('seed biomes match a world Bedrock generated', async () => {
  const g = await SeedGen.load(wasm);
  g.setup(real.seed, 0);
  let same = 0;
  for (const [x, z, biome] of real.samples) if (g.biomes(4, Math.floor(x / 4), Math.floor(z / 4), 1, 1, 64)[0] === biome) same++;
  const share = same / real.samples.length;
  // Edges (riverbanks especially) can differ by a few blocks; the rest matches.
  assert.ok(share > 0.9, `only ${(share * 100).toFixed(1)}% matched`);
});

test('seed biomes come back as Bedrock ids, in every dimension', async () => {
  const g = await SeedGen.load(wasm);
  g.setup(real.seed, 1);
  const nether = new Set(g.biomes(16, -8, -8, 16, 16, 64));
  for (const id of nether) assert.ok([8, 178, 179, 180, 181].includes(id), `unexpected nether biome ${id}`);
  g.setup(real.seed, 2);
  assert.ok(g.biomes(16, 0, 0, 4, 4, 64).every((id) => id === 9), 'the End is all End');
  // Negative and very large seeds both work.
  g.setup('-9223372036854775808', 0);
  g.setup('9223372036854775807', 0);
  assert.equal(g.biomes(4, 0, 0, 8, 8, 64).length, 64);
});
