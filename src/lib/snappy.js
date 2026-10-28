// Snappy decompression. Bedrock uses zlib, but plain LevelDB tools default to
// snappy, so supporting it lets us read databases made by those tools too.

export function snappyDecompress(src) {
  let pos = 0;
  let len = 0, shift = 0;
  for (;;) {
    const b = src[pos++];
    len |= (b & 0x7f) << shift;
    if (b < 0x80) break;
    shift += 7;
  }
  const out = new Uint8Array(len);
  let o = 0;
  while (pos < src.length) {
    const tag = src[pos++];
    const kind = tag & 3;
    if (kind === 0) {
      let n = tag >>> 2;
      if (n >= 60) {
        const bytes = n - 59;
        n = 0;
        for (let i = 0; i < bytes; i++) n |= src[pos++] << (8 * i);
      }
      n += 1;
      out.set(src.subarray(pos, pos + n), o);
      pos += n; o += n;
      continue;
    }
    let length, offset;
    if (kind === 1) {
      length = ((tag >>> 2) & 7) + 4;
      offset = ((tag >>> 5) << 8) | src[pos++];
    } else if (kind === 2) {
      length = (tag >>> 2) + 1;
      offset = src[pos] | (src[pos + 1] << 8);
      pos += 2;
    } else {
      length = (tag >>> 2) + 1;
      offset = (src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16) | (src[pos + 3] << 24)) >>> 0;
      pos += 4;
    }
    if (offset === 0 || offset > o) throw new Error('Bad snappy data');
    for (let i = 0; i < length; i++, o++) out[o] = out[o - offset];
  }
  if (o !== len) throw new Error('Bad snappy length');
  return out;
}
