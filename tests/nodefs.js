// Node file access in the same shape the browser worker uses.
import fs from 'node:fs';
import path from 'node:path';

export function nodeDir(dirPath) {
  const names = fs.readdirSync(dirPath).filter((n) => fs.statSync(path.join(dirPath, n)).isFile());
  return {
    names,
    open(name) {
      const p = path.join(dirPath, name);
      if (!fs.existsSync(p)) return null;
      const size = fs.statSync(p).size;
      return {
        size,
        read(offset, length) {
          const fd = fs.openSync(p, 'r');
          const buf = Buffer.alloc(length);
          fs.readSync(fd, buf, 0, length, offset);
          fs.closeSync(fd);
          return new Uint8Array(buf.buffer, buf.byteOffset, length);
        },
      };
    },
  };
}
