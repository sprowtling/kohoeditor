// What the scan notes about each record as it reads the database once:
// a biome sample for chunk biome records (see biomes.js), and for records
// that can hold items (block entities, entities), whether they contain any
// books or maps, so the Library and Art tabs only have to read those.

import { extractSurface } from './biomes.js';
import { utf8 } from './bytes.js';

export const HOLDS_BOOKS = 1;
export const HOLDS_MAPS = 2;

const NEEDLES = [
  [utf8('written_book'), HOLDS_BOOKS],
  [utf8('writable_book'), HOLDS_BOOKS],
  [utf8('filled_map'), HOLDS_MAPS],
];
const ACTOR_PREFIX = utf8('actorprefix');

function mayHoldItems(k) {
  const n = k.length;
  if ((n === 9 || n === 13) && (k[n - 1] === 0x31 || k[n - 1] === 0x32)) return (k[3] === 0 || k[3] === 0xff) && (k[7] === 0 || k[7] === 0xff);
  if (n !== ACTOR_PREFIX.length + 8) return false;
  for (let i = 0; i < ACTOR_PREFIX.length; i++) if (k[i] !== ACTOR_PREFIX[i]) return false;
  return true;
}

function contains(v, needle) {
  const first = needle[0], n = needle.length;
  for (let i = v.indexOf(first); i >= 0 && i + n <= v.length; i = v.indexOf(first, i + 1)) {
    let j = 1;
    while (j < n && v[i + j] === needle[j]) j++;
    if (j === n) return true;
  }
  return false;
}

export function extractScanInfo(ukey, value) {
  const surface = extractSurface(ukey, value);
  if (surface) return surface;
  if (!mayHoldItems(ukey)) return null;
  let flags = 0;
  for (const [needle, flag] of NEEDLES) if (!(flags & flag) && contains(value, needle)) flags |= flag;
  return flags ? Uint8Array.of(flags) : null;
}
