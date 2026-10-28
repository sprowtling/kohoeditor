// What each database key means.
//
// Chunk data is keyed by: x (int32), z (int32), [dimension (int32) if not the
// Overworld], a tag byte saying what kind of data it is, and for subchunks one
// more byte giving the vertical index. Everything else is a text key
// ("~local_player", "portals", ...) or a text prefix plus binary
// ("digp" + chunk position, "actorprefix" + entity id).

import { fromUtf8, utf8, startsWith, printableKey } from './bytes.js';

export const DIMENSIONS = ['Overworld', 'Nether', 'The End'];

export const CHUNK_TAGS = {
  0x2b: 'Data3D (heightmap and biomes)',
  0x2c: 'Version',
  0x2d: 'Data2D (heightmap and biomes, old)',
  0x2e: 'Data2D (legacy)',
  0x2f: 'Subchunk blocks',
  0x30: 'Legacy terrain',
  0x31: 'Block entities (chests, signs...)',
  0x32: 'Entities (old format)',
  0x33: 'Pending ticks',
  0x34: 'Legacy block extra data',
  0x35: 'Biome state',
  0x36: 'Finalized state',
  0x37: 'Conversion data',
  0x38: 'Border blocks',
  0x39: 'Hardcoded spawn areas',
  0x3a: 'Random ticks',
  0x3b: 'Checksums',
  0x3c: 'Generation seed',
  0x3d: 'Pre-Caves & Cliffs blending flag',
  0x3e: 'Blending biome height',
  0x3f: 'Metadata hash',
  0x40: 'Blending data',
  0x41: 'Entity digest version',
  0x76: 'Version (old)',
};

// Tags whose values are NBT (one or more root compounds back to back).
export const NBT_CHUNK_TAGS = new Set([0x31, 0x32, 0x33, 0x3a]);

export const TAG_SUBCHUNK = 0x2f;

const ACTOR_PREFIX = utf8('actorprefix');
const DIGP_PREFIX = utf8('digp');

function i32(k, o) { return k[o] | (k[o + 1] << 8) | (k[o + 2] << 16) | (k[o + 3] << 24); }
function signByteOk(b) { return b === 0x00 || b === 0xff; }

// Chunk coordinates stay within about ±1.9 million, so the top byte of a real
// chunk x or z is always 0x00 or 0xff. That keeps text keys (which never have
// those bytes) from being mistaken for chunks.
export function parseChunkKey(k) {
  const n = k.length;
  let dim = 0, tagAt;
  if (n === 9 || n === 10) tagAt = 8;
  else if (n === 13 || n === 14) {
    dim = i32(k, 8);
    if (dim < 1 || dim > 2) return null;
    tagAt = 12;
  } else return null;
  if (!signByteOk(k[3]) || !signByteOk(k[7])) return null;
  const tag = k[tagAt];
  let sub = null;
  if (n === tagAt + 2) {
    if (tag !== TAG_SUBCHUNK) return null;
    sub = (k[tagAt + 1] << 24) >> 24;
  } else if (tag === TAG_SUBCHUNK) return null;
  return { x: i32(k, 0), z: i32(k, 4), dim, tag, sub };
}

export function chunkKey(x, z, dim, tag, sub = null) {
  const n = (dim ? 13 : 9) + (sub === null ? 0 : 1);
  const k = new Uint8Array(n);
  const dv = new DataView(k.buffer);
  dv.setInt32(0, x, true);
  dv.setInt32(4, z, true);
  let o = 8;
  if (dim) { dv.setInt32(8, dim, true); o = 12; }
  k[o] = tag;
  if (sub !== null) k[o + 1] = sub & 0xff;
  return k;
}

export function digpKey(x, z, dim) {
  const k = new Uint8Array(dim ? 16 : 12);
  k.set(DIGP_PREFIX);
  const dv = new DataView(k.buffer);
  dv.setInt32(4, x, true);
  dv.setInt32(8, z, true);
  if (dim) dv.setInt32(12, dim, true);
  return k;
}

export function parseDigpKey(k) {
  if ((k.length !== 12 && k.length !== 16) || !startsWith(k, DIGP_PREFIX)) return null;
  const dim = k.length === 16 ? i32(k, 12) : 0;
  return { x: i32(k, 4), z: i32(k, 8), dim };
}

export function actorKey(id8) {
  const k = new Uint8Array(ACTOR_PREFIX.length + 8);
  k.set(ACTOR_PREFIX);
  k.set(id8, ACTOR_PREFIX.length);
  return k;
}

export function isActorKey(k) { return k.length === ACTOR_PREFIX.length + 8 && startsWith(k, ACTOR_PREFIX); }

function isText(k) {
  for (let i = 0; i < k.length; i++) if (k[i] < 0x20 || k[i] >= 0x7f) return false;
  return true;
}

// Classifies a key for display. Returns { kind, label, ... }.
export function describeKey(k) {
  const c = parseChunkKey(k);
  if (c) {
    const what = CHUNK_TAGS[c.tag] ?? `Chunk data tag 0x${c.tag.toString(16)}`;
    return {
      kind: 'chunk', ...c,
      label: `Chunk ${c.x}, ${c.z} (${DIMENSIONS[c.dim] ?? 'dim ' + c.dim}) · ${what}${c.sub !== null ? ` · section ${c.sub} (y ${c.sub * 16} to ${c.sub * 16 + 15})` : ''}`,
      nbt: NBT_CHUNK_TAGS.has(c.tag),
    };
  }
  const d = parseDigpKey(k);
  if (d) return { kind: 'digp', ...d, label: `Entity list for chunk ${d.x}, ${d.z} (${DIMENSIONS[d.dim] ?? d.dim})`, nbt: false };
  if (isActorKey(k)) return { kind: 'actor', label: `Entity ${printableKey(k.subarray(11))}`, nbt: true };
  if (isText(k)) {
    const s = fromUtf8(k);
    if (s === '~local_player') return { kind: 'player', label: 'Local player (the world host on this device)', nbt: true, text: s };
    if (s.startsWith('player_server_')) return { kind: 'player', label: `Player ${s.slice(14)}`, nbt: true, text: s };
    if (s.startsWith('player_')) return { kind: 'playerid', label: `Player id link ${s.slice(7)}`, nbt: true, text: s };
    return { kind: 'text', label: s, nbt: true, text: s };
  }
  return { kind: 'other', label: printableKey(k), nbt: true };
}

export { printableKey };
