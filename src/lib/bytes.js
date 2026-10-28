// Small helpers for reading and writing little-endian binary data.

export class Reader {
  constructor(u8, pos = 0, end = u8.length) {
    this.u8 = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.pos = pos;
    this.end = end;
  }
  get remaining() { return this.end - this.pos; }
  need(n) {
    if (this.pos + n > this.end) throw new Error('Unexpected end of data');
  }
  u8_() { this.need(1); return this.u8[this.pos++]; }
  i8() { this.need(1); return this.dv.getInt8(this.pos++); }
  u16() { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { this.need(2); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  i64() { this.need(8); const v = this.dv.getBigInt64(this.pos, true); this.pos += 8; return v; }
  f32() { this.need(4); const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  f64() { this.need(8); const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v; }
  // Unsigned 64-bit as a Number (exact below 2^53, which covers file sizes and sequence numbers).
  u64n() { this.need(8); const lo = this.dv.getUint32(this.pos, true); const hi = this.dv.getUint32(this.pos + 4, true); this.pos += 8; return hi * 0x100000000 + lo; }
  bytes(n) { this.need(n); const v = this.u8.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  varint() {
    // LevelDB varints, decoded as a Number (up to 2^53).
    let result = 0, mul = 1;
    for (let i = 0; i < 10; i++) {
      const b = this.u8_();
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
    }
    throw new Error('Bad varint');
  }
  lenPrefixed() { return this.bytes(this.varint()); }
}

export class Writer {
  constructor(initial = 1024) {
    this.buf = new Uint8Array(initial);
    this.dv = new DataView(this.buf.buffer);
    this.pos = 0;
  }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
    this.dv = new DataView(nb.buffer);
  }
  u8(v) { this.ensure(1); this.buf[this.pos++] = v; }
  i8(v) { this.ensure(1); this.dv.setInt8(this.pos++, v); }
  u16(v) { this.ensure(2); this.dv.setUint16(this.pos, v, true); this.pos += 2; }
  i16(v) { this.ensure(2); this.dv.setInt16(this.pos, v, true); this.pos += 2; }
  u32(v) { this.ensure(4); this.dv.setUint32(this.pos, v, true); this.pos += 4; }
  i32(v) { this.ensure(4); this.dv.setInt32(this.pos, v, true); this.pos += 4; }
  i64(v) { this.ensure(8); this.dv.setBigInt64(this.pos, BigInt(v), true); this.pos += 8; }
  f32(v) { this.ensure(4); this.dv.setFloat32(this.pos, v, true); this.pos += 4; }
  f64(v) { this.ensure(8); this.dv.setFloat64(this.pos, v, true); this.pos += 8; }
  u64n(v) { this.ensure(8); this.dv.setUint32(this.pos, v % 0x100000000, true); this.dv.setUint32(this.pos + 4, Math.floor(v / 0x100000000), true); this.pos += 8; }
  bytes(u8) { this.ensure(u8.length); this.buf.set(u8, this.pos); this.pos += u8.length; }
  varint(v) {
    while (v >= 0x80) { this.u8((v % 128) | 0x80); v = Math.floor(v / 128); }
    this.u8(v);
  }
  lenPrefixed(u8) { this.varint(u8.length); this.bytes(u8); }
  result() { return this.buf.slice(0, this.pos); }
}

export function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function startsWith(a, prefix) {
  if (a.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (a[i] !== prefix[i]) return false;
  return true;
}

export function concatBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export function toHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += HEX[u8[i]];
  return s;
}
export function fromHex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
export const utf8 = (s) => enc.encode(s);
export const fromUtf8 = (u8) => dec.decode(u8);

// Shows a key the way a person can read it: printable ASCII as-is, other bytes as \xNN.
export function printableKey(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) {
    const c = u8[i];
    s += c >= 0x20 && c < 0x7f && c !== 0x5c ? String.fromCharCode(c) : '\\x' + HEX[c];
  }
  return s;
}
