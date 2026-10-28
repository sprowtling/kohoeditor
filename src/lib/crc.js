// CRC-32 (zip files) and CRC-32C (LevelDB log records).

function makeTable(poly) {
  const t = new Uint32Array(256 * 8);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ poly : c >>> 1;
    t[i] = c >>> 0;
  }
  // Slicing-by-8 tables, so large files hash quickly.
  for (let i = 0; i < 256; i++) {
    for (let s = 1; s < 8; s++) t[s * 256 + i] = (t[(s - 1) * 256 + i] >>> 8) ^ t[t[(s - 1) * 256 + i] & 0xff];
  }
  return t;
}

const T32 = makeTable(0xedb88320);
const T32C = makeTable(0x82f63b78);

function update(t, crc, u8) {
  let c = ~crc >>> 0;
  let i = 0;
  const n = u8.length;
  for (; i + 8 <= n; i += 8) {
    const a = (u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24)) ^ c;
    c = t[7 * 256 + (a & 0xff)] ^ t[6 * 256 + ((a >>> 8) & 0xff)] ^ t[5 * 256 + ((a >>> 16) & 0xff)] ^ t[4 * 256 + (a >>> 24)] ^
      t[3 * 256 + u8[i + 4]] ^ t[2 * 256 + u8[i + 5]] ^ t[256 + u8[i + 6]] ^ t[u8[i + 7]];
  }
  for (; i < n; i++) c = t[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export const crc32 = (u8, crc = 0) => update(T32, crc, u8);
export const crc32c = (u8, crc = 0) => update(T32C, crc, u8);

const MASK_DELTA = 0xa282ead8;
export function maskCrc(crc) {
  return ((((crc >>> 15) | (crc << 17)) >>> 0) + MASK_DELTA) >>> 0;
}
