// Bedrock NBT: the little-endian flavour of Minecraft's Named Binary Tag format.
//
// Every tag is kept as { t, v } (type and value), with n (name) on compound
// children, so a value can be written back exactly as it was read.
//   compound: v = [ { n, t, v }, ... ]   (order preserved)
//   list:     v = [ { t, v }, ... ], plus et = element type
//   long:     v = BigInt
//   arrays:   v = Int8Array / Int32Array / BigInt64Array
//   string:   v = string; raw = original bytes if they were not valid UTF-8

import { Reader, Writer } from './bytes.js';

export const T = {
  End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6,
  ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12,
};
export const TYPE_NAMES = ['end', 'byte', 'short', 'int', 'long', 'float', 'double', 'byte[]', 'string', 'list', 'compound', 'int[]', 'long[]'];

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const latin1 = new TextDecoder('latin1');
const encoder = new TextEncoder();

function readString(r) {
  const bytes = r.bytes(r.u16());
  try {
    return { v: strictUtf8.decode(bytes) };
  } catch {
    return { v: latin1.decode(bytes), raw: bytes.slice() };
  }
}

const MAX_DEPTH = 512;

function readPayload(r, t, depth) {
  if (depth > MAX_DEPTH) throw new Error('NBT nested too deeply');
  switch (t) {
    case T.Byte: return { t, v: r.i8() };
    case T.Short: return { t, v: r.i16() };
    case T.Int: return { t, v: r.i32() };
    case T.Long: return { t, v: r.i64() };
    case T.Float: return { t, v: r.f32() };
    case T.Double: return { t, v: r.f64() };
    case T.ByteArray: { const n = r.i32(); if (n < 0) throw new Error('Bad NBT array length'); return { t, v: new Int8Array(r.bytes(n).slice().buffer) }; }
    case T.String: return { t, ...readString(r) };
    case T.List: {
      const et = r.u8_();
      const n = r.i32();
      if (n < 0 || n > r.remaining) throw new Error('Bad NBT list length');
      const v = [];
      for (let i = 0; i < n; i++) v.push(readPayload(r, et, depth + 1));
      return { t, et, v };
    }
    case T.Compound: {
      const v = [];
      for (;;) {
        const ct = r.u8_();
        if (ct === T.End) break;
        const name = readString(r);
        const child = readPayload(r, ct, depth + 1);
        child.n = name.v;
        if (name.raw) child.nraw = name.raw;
        v.push(child);
      }
      return { t, v };
    }
    case T.IntArray: {
      const n = r.i32();
      if (n < 0 || n * 4 > r.remaining) throw new Error('Bad NBT array length');
      const v = new Int32Array(n);
      for (let i = 0; i < n; i++) v[i] = r.i32();
      return { t, v };
    }
    case T.LongArray: {
      const n = r.i32();
      if (n < 0 || n * 8 > r.remaining) throw new Error('Bad NBT array length');
      const v = new BigInt64Array(n);
      for (let i = 0; i < n; i++) v[i] = r.i64();
      return { t, v };
    }
    default: throw new Error(`Unknown NBT tag type ${t}`);
  }
}

// Reads one named root tag. Returns the tag with its name in n.
export function readTag(r) {
  const t = r.u8_();
  if (t === T.End) return null;
  const name = readString(r);
  const tag = readPayload(r, t, 0);
  tag.n = name.v;
  if (name.raw) tag.nraw = name.raw;
  return tag;
}

// Parses a value holding one or more root tags back to back (block entity
// records, for example, hold one compound per block entity).
// Returns { roots, rest } where rest is any trailing bytes that were not NBT.
export function parseAll(u8) {
  const r = new Reader(u8);
  const roots = [];
  while (r.remaining > 0) {
    const start = r.pos;
    try {
      const tag = readTag(r);
      if (!tag) break;
      roots.push(tag);
    } catch (e) {
      if (!roots.length) throw e;
      r.pos = start;
      break;
    }
  }
  return { roots, rest: u8.subarray(r.pos) };
}

export function parse(u8) {
  const r = new Reader(u8);
  const tag = readTag(r);
  if (!tag) throw new Error('Empty NBT');
  return tag;
}

// Quick check for whether a value looks like NBT, without fully parsing it.
export function looksLikeNbt(u8) {
  if (u8.length < 3) return false;
  const t = u8[0];
  if (t !== T.Compound && t !== T.List) return false;
  const nameLen = u8[1] | (u8[2] << 8);
  return 3 + nameLen <= u8.length;
}

function writeString(w, s, raw) {
  const bytes = raw ?? encoder.encode(s);
  if (bytes.length > 0xffff) throw new Error('String too long for NBT');
  w.u16(bytes.length);
  w.bytes(bytes);
}

function writePayload(w, tag) {
  const { t, v } = tag;
  switch (t) {
    case T.Byte: w.i8(v); break;
    case T.Short: w.i16(v); break;
    case T.Int: w.i32(v); break;
    case T.Long: w.i64(v); break;
    case T.Float: w.f32(v); break;
    case T.Double: w.f64(v); break;
    case T.ByteArray: w.i32(v.length); for (let i = 0; i < v.length; i++) w.i8(v[i]); break;
    case T.String: writeString(w, v, tag.raw); break;
    case T.List: {
      const et = v.length ? v[0].t : (tag.et ?? T.End);
      w.u8(et);
      w.i32(v.length);
      for (const item of v) {
        if (item.t !== et) throw new Error('NBT list items must all have the same type');
        writePayload(w, item);
      }
      break;
    }
    case T.Compound:
      for (const child of v) {
        w.u8(child.t);
        writeString(w, child.n, child.nraw);
        writePayload(w, child);
      }
      w.u8(T.End);
      break;
    case T.IntArray: w.i32(v.length); for (let i = 0; i < v.length; i++) w.i32(v[i]); break;
    case T.LongArray: w.i32(v.length); for (let i = 0; i < v.length; i++) w.i64(v[i]); break;
    default: throw new Error(`Unknown NBT tag type ${t}`);
  }
}

export function writeTag(w, tag) {
  w.u8(tag.t);
  writeString(w, tag.n ?? '', tag.nraw);
  writePayload(w, tag);
}

export function serialize(tag) {
  const w = new Writer(4096);
  writeTag(w, tag);
  return w.result();
}

export function serializeAll(roots, rest) {
  const w = new Writer(4096);
  for (const r of roots) writeTag(w, r);
  if (rest && rest.length) w.bytes(rest);
  return w.result();
}

// ---------------------------------------------------------------------------
// Convenience accessors

export function child(tag, name) {
  if (!tag || tag.t !== T.Compound) return undefined;
  return tag.v.find((c) => c.n === name);
}

export function val(tag, ...path) {
  let cur = tag;
  for (const p of path) {
    if (!cur) return undefined;
    if (typeof p === 'number') cur = cur.t === T.List ? cur.v[p] : undefined;
    else cur = child(cur, p);
  }
  return cur ? cur.v : undefined;
}

// A plain JavaScript view of a tag, for display and searching.
export function toPlain(tag) {
  switch (tag.t) {
    case T.Compound: { const o = {}; for (const c of tag.v) o[c.n] = toPlain(c); return o; }
    case T.List: return tag.v.map(toPlain);
    case T.Long: return tag.v;
    case T.ByteArray: case T.IntArray: case T.LongArray: return Array.from(tag.v);
    default: return tag.v;
  }
}

// Bedrock's level.dat: 4 byte storage version, 4 byte length, then NBT.
export function parseLevelDat(u8) {
  const r = new Reader(u8);
  const version = r.i32();
  const length = r.i32();
  const tag = parse(u8.subarray(8, 8 + length));
  return { version, tag };
}

export function serializeLevelDat(version, tag) {
  const body = serialize(tag);
  const w = new Writer(body.length + 8);
  w.i32(version);
  w.i32(body.length);
  w.bytes(body);
  return w.result();
}
