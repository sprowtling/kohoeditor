// What the scan notes about each record as it reads the database once:
// a biome sample for chunk biome records (see biomes.js), and for records
// that can hold items (block entities, entities), whether they contain any
// books or maps, or a named or tamed mob, so the Library, Art and Pets tabs
// only have to read those.

import { extractSurface } from './biomes.js';
import { utf8 } from './bytes.js';

export const HOLDS_BOOKS = 1;
export const HOLDS_MAPS = 2;
export const HOLDS_NAMED = 4;
export const HOLDS_TAMED = 8;

// NBT as stored: a string tag "CustomName" (type 8, name length 10), and a
// byte tag "IsTamed" (type 1, name length 7) set to 1.
const CUSTOM_NAME = Uint8Array.of(8, 10, 0, ...utf8('CustomName'));
const TAMED = Uint8Array.of(1, 7, 0, ...utf8('IsTamed'), 1);

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

// Where needle occurs in v (from `from`), or -1.
function find(v, needle, from = 0) {
  const first = needle[0], n = needle.length;
  for (let i = v.indexOf(first, from); i >= 0 && i + n <= v.length; i = v.indexOf(first, i + 1)) {
    let j = 1;
    while (j < n && v[i + j] === needle[j]) j++;
    if (j === n) return i;
  }
  return -1;
}
const contains = (v, needle) => find(v, needle) >= 0;

// A CustomName that isn't empty (unnamed mobs can carry an empty one).
function hasName(v) {
  for (let i = find(v, CUSTOM_NAME); i >= 0; i = find(v, CUSTOM_NAME, i + 1)) {
    const at = i + CUSTOM_NAME.length;
    if (at + 2 <= v.length && (v[at] | (v[at + 1] << 8)) > 0) return true;
  }
  return false;
}

function isEntityRecord(k) {
  const n = k.length;
  return n === ACTOR_PREFIX.length + 8 || ((n === 9 || n === 13) && k[n - 1] === 0x32);
}

export function extractScanInfo(ukey, value) {
  const surface = extractSurface(ukey, value);
  if (surface) return surface;
  if (!mayHoldItems(ukey)) return null;
  let flags = 0;
  for (const [needle, flag] of NEEDLES) if (!(flags & flag) && contains(value, needle)) flags |= flag;
  if (isEntityRecord(ukey)) {
    if (hasName(value)) flags |= HOLDS_NAMED;
    if (contains(value, TAMED)) flags |= HOLDS_TAMED;
  }
  return flags ? Uint8Array.of(flags) : null;
}
