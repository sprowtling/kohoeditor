// Reading and writing zip files (a .mcworld is a zip of the world folder).
//
// Reading uses random access, so a large world never has to be unpacked all at
// once: stored entries are read in place, and compressed entries are inflated
// one file at a time when first needed.
//
// Writing copies entries without recompressing them. An unchanged file from a
// .mcworld is carried over byte for byte; new files are stored uncompressed
// (world data is already compressed, so zipping it again gains almost nothing).

import { inflateSync } from '../../vendor/fflate.js';
import { Reader, Writer, utf8 } from './bytes.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const U32 = 0xffffffff;

const nameDecoder = new TextDecoder();

// file: { size, read(offset, length) -> Uint8Array }
export function readZipDirectory(file) {
  const tailLen = Math.min(file.size, 65557);
  const tail = file.read(file.size - tailLen, tailLen);
  const tdv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tdv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file is not a zip archive (.mcworld files are zips).');
  let count = tdv.getUint16(eocd + 10, true);
  let cdSize = tdv.getUint32(eocd + 12, true);
  let cdOffset = tdv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === U32 || cdOffset === U32) {
    const locAt = eocd - 20;
    if (locAt < 0 || tdv.getUint32(locAt, true) !== SIG_ZIP64_LOCATOR) throw new Error('Damaged zip64 archive');
    const r = new Reader(tail, locAt + 8);
    const z64Offset = r.u64n();
    const z = file.read(z64Offset, 56);
    const zr = new Reader(z);
    if (zr.u32() !== SIG_ZIP64_EOCD) throw new Error('Damaged zip64 archive');
    zr.pos = 32;
    count = zr.u64n();
    cdSize = zr.u64n();
    cdOffset = zr.u64n();
  }
  const cd = file.read(cdOffset, cdSize);
  const r = new Reader(cd);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (r.u32() !== SIG_CENTRAL) throw new Error('Damaged zip directory');
    r.pos += 4; // versions
    const flags = r.u16();
    const method = r.u16();
    const time = r.u16();
    const date = r.u16();
    const crc = r.u32();
    let compSize = r.u32();
    let size = r.u32();
    const nameLen = r.u16(), extraLen = r.u16(), commentLen = r.u16();
    r.pos += 8; // disk, internal and external attributes
    let localOffset = r.u32();
    const name = nameDecoder.decode(r.bytes(nameLen));
    const extraEnd = r.pos + extraLen;
    while (r.pos + 4 <= extraEnd) {
      const id = r.u16(), len = r.u16();
      const next = r.pos + len;
      if (id === 0x0001) {
        if (size === U32) size = r.u64n();
        if (compSize === U32) compSize = r.u64n();
        if (localOffset === U32) localOffset = r.u64n();
      }
      r.pos = next;
    }
    r.pos = extraEnd + commentLen;
    entries.push({ name, flags, method, time, date, crc, compSize, size, localOffset, dir: name.endsWith('/') });
  }
  return entries;
}

export function dataOffset(file, entry) {
  if (entry.dataOffset === undefined) {
    const h = file.read(entry.localOffset, 30);
    const dv = new DataView(h.buffer, h.byteOffset, 30);
    if (dv.getUint32(0, true) !== SIG_LOCAL) throw new Error(`Damaged zip entry ${entry.name}`);
    entry.dataOffset = entry.localOffset + 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
  }
  return entry.dataOffset;
}

// Opens zip entries as random-access files. Compressed entries are inflated on
// first use and kept in a small cache.
export class ZipFiles {
  constructor(file, cacheBytes = 384 << 20) {
    this.file = file;
    this.entries = readZipDirectory(file).filter((e) => !e.dir);
    this.byName = new Map(this.entries.map((e) => [e.name, e]));
    this.cache = new Map();
    this.cacheBytes = cacheBytes;
    this.cached = 0;
  }
  inflated(entry) {
    let data = this.cache.get(entry.name);
    if (data) {
      this.cache.delete(entry.name);
      this.cache.set(entry.name, data);
      return data;
    }
    const raw = this.file.read(dataOffset(this.file, entry), entry.compSize);
    data = entry.method === 8 ? inflateSync(raw, { out: new Uint8Array(entry.size) }) : raw;
    this.cache.set(entry.name, data);
    this.cached += data.length;
    while (this.cached > this.cacheBytes && this.cache.size > 1) {
      const [k, v] = this.cache.entries().next().value;
      this.cache.delete(k);
      this.cached -= v.length;
    }
    return data;
  }
  open(name) {
    const entry = this.byName.get(name);
    if (!entry) return null;
    if (entry.method !== 0 && entry.method !== 8) throw new Error(`${name} uses an unsupported zip compression method (${entry.method}).`);
    const self = this;
    if (entry.method === 0) {
      return {
        size: entry.size,
        read(offset, length) { return self.file.read(dataOffset(self.file, entry) + offset, length); },
      };
    }
    return {
      size: entry.size,
      read(offset, length) { return self.inflated(entry).subarray(offset, offset + length); },
    };
  }
}

function dosDateTime(d = new Date()) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Writes a zip one entry at a time, so a caller can stream it straight to disk.
// add() returns the parts for one entry (its header and its data); finish()
// returns the directory at the end. An entry is
// { name, method, crc, compSize, size, data, time?, date? }, where data is
// whatever the output accepts (a Blob, a Blob slice, or a Uint8Array)
// holding exactly compSize bytes. Zip64 is used wherever sizes need it.
export class ZipWriter {
  constructor() {
    this.central = new Writer(1 << 16);
    this.offset = 0;
    this.count = 0;
    this.now = dosDateTime();
  }

  add(e) {
    const name = utf8(e.name);
    const time = e.time ?? this.now.time, date = e.date ?? this.now.date;
    const offset = this.offset;
    const big = e.size >= U32 || e.compSize >= U32 || offset >= U32;
    const h = new Writer(30 + name.length + 20);
    h.u32(SIG_LOCAL);
    h.u16(big ? 45 : 20);
    h.u16(0x0800); // names are UTF-8
    h.u16(e.method);
    h.u16(time); h.u16(date);
    h.u32(e.crc);
    h.u32(big ? U32 : e.compSize);
    h.u32(big ? U32 : e.size);
    h.u16(name.length);
    h.u16(big ? 20 : 0);
    h.bytes(name);
    if (big) { h.u16(1); h.u16(16); h.u64n(e.size); h.u64n(e.compSize); }
    const header = h.result();

    const c = this.central;
    c.u32(SIG_CENTRAL);
    c.u16(big ? 45 : 20); c.u16(big ? 45 : 20);
    c.u16(0x0800);
    c.u16(e.method);
    c.u16(time); c.u16(date);
    c.u32(e.crc);
    c.u32(big ? U32 : e.compSize);
    c.u32(big ? U32 : e.size);
    c.u16(name.length);
    c.u16(big ? 28 : 0);
    c.u16(0); c.u16(0); c.u16(0);
    c.u32(0);
    c.u32(big ? U32 : offset);
    c.bytes(name);
    if (big) { c.u16(1); c.u16(24); c.u64n(e.size); c.u64n(e.compSize); c.u64n(offset); }
    this.offset += header.length + e.compSize;
    this.count++;
    return e.compSize > 0 ? [header, e.data] : [header];
  }

  finish() {
    const cd = this.central.result();
    const cdOffset = this.offset;
    const n = this.count;
    const tail = new Writer(100);
    const needs64 = n >= 0xffff || cdOffset >= U32 || cd.length >= U32;
    if (needs64) {
      const z64At = cdOffset + cd.length;
      tail.u32(SIG_ZIP64_EOCD);
      tail.u64n(44);
      tail.u16(45); tail.u16(45);
      tail.u32(0); tail.u32(0);
      tail.u64n(n); tail.u64n(n);
      tail.u64n(cd.length); tail.u64n(cdOffset);
      tail.u32(SIG_ZIP64_LOCATOR);
      tail.u32(0);
      tail.u64n(z64At);
      tail.u32(1);
    }
    tail.u32(SIG_EOCD);
    tail.u16(0); tail.u16(0);
    tail.u16(needs64 ? 0xffff : n);
    tail.u16(needs64 ? 0xffff : n);
    tail.u32(needs64 ? U32 : cd.length);
    tail.u32(needs64 ? U32 : cdOffset);
    tail.u16(0);
    return [cd, tail.result()];
  }
}

// The whole zip as a list of parts that, concatenated, form the file.
export function buildZip(entries) {
  const zw = new ZipWriter();
  const parts = [];
  for (const e of entries) parts.push(...zw.add(e));
  parts.push(...zw.finish());
  return parts;
}
