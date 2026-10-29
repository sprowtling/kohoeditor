// The seed map layer: biomes as the world seed generates them now, drawn
// underneath the world on the map. Tiles are made by helper workers at a
// level of detail that suits the zoom, nearest the middle of the view first.

import { BIOME_RGB } from '../lib/biomes.js';

const CELLS = 256; // cells per tile edge (see seedworker.js)
const LEVELS = [4, 16, 64, 256]; // blocks per cell, finest first
const MAX_TILES = 320;

export class SeedLayer {
  constructor(onTile) {
    this.onTile = onTile;
    this.tiles = new Map(); // key -> { canvas, ids } (most recently used last)
    this.pending = new Set();
    this.queue = [];
    this.nextId = 1;
    this.waiting = new Map();
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency ?? 2) - 1));
    this.workers = Array.from({ length: n }, () => {
      const w = new Worker(new URL('../seedworker.js', import.meta.url), { type: 'module' });
      const slot = { w, busy: false };
      w.onmessage = (ev) => this.done(slot, ev.data);
      w.onerror = (e) => { this.error = e.message || 'The seed map helper stopped.'; slot.busy = false; };
      return slot;
    });
  }

  configure(seed, dim, y) {
    const key = `${seed}:${dim}:${y}`;
    if (key === this.key) return;
    this.key = key;
    this.seed = seed; this.dim = dim; this.y = y;
    this.queue = [];
  }

  tileKey(scale, tx, tz) { return `${this.key}:${scale}:${tx}:${tz}`; }

  // The finest level whose cells are at least about a pixel across.
  levelFor(pxPerBlock) {
    return LEVELS.find((s) => s * pxPerBlock >= 0.9) ?? LEVELS[LEVELS.length - 1];
  }

  // view: { blockRect: [bx0, bz0, bx1, bz1], toScreen(bx, bz) -> [sx, sy], pxPerBlock, center: [bx, bz] }
  draw(ctx, view) {
    const level = this.levelFor(view.pxPerBlock);
    const [bx0, bz0, bx1, bz1] = view.blockRect;
    const wanted = [];
    // Coarser levels first (as a quick backdrop), then the chosen level on top.
    for (let li = LEVELS.length - 1; li >= 0; li--) {
      const s = LEVELS[li];
      if (s < level) break;
      const span = CELLS * s;
      const tx0 = Math.floor(bx0 / span), tx1 = Math.floor(bx1 / span);
      const tz0 = Math.floor(bz0 / span), tz1 = Math.floor(bz1 / span);
      if ((tx1 - tx0 + 1) * (tz1 - tz0 + 1) > 64) continue; // too many to bother at this level
      for (let tz = tz0; tz <= tz1; tz++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const key = this.tileKey(s, tx, tz);
          const t = this.tiles.get(key);
          if (t) {
            this.tiles.delete(key); this.tiles.set(key, t); // keep recently used
            const [sx, sy] = view.toScreen(tx * span, tz * span);
            const [ex, ey] = view.toScreen((tx + 1) * span, (tz + 1) * span);
            ctx.drawImage(t.canvas, sx, sy, ex - sx, ey - sy);
          } else if (s === level || s === LEVELS[Math.min(LEVELS.length - 1, LEVELS.indexOf(level) + 1)]) {
            const cx = (tx + 0.5) * span, cz = (tz + 0.5) * span;
            wanted.push({ key, scale: s, tx, tz, d: (cx - view.center[0]) ** 2 + (cz - view.center[1]) ** 2 + (s === level ? 0 : -1e15) });
          }
        }
      }
    }
    // Ask for what's missing: the coarse backdrop first, then nearest first.
    this.queue = wanted.filter((w) => !this.pending.has(w.key)).sort((a, b) => a.d - b.d);
    this.pump();
  }

  pump() {
    for (const slot of this.workers) {
      if (slot.busy || !this.queue.length) continue;
      const job = this.queue.shift();
      if (this.pending.has(job.key)) continue;
      this.pending.add(job.key);
      slot.busy = true;
      const id = this.nextId++;
      this.waiting.set(id, job);
      slot.w.postMessage({ id, seed: this.seed, dim: this.dim, scale: job.scale, tx: job.tx, tz: job.tz, y: this.y });
    }
  }

  done(slot, msg) {
    slot.busy = false;
    const job = this.waiting.get(msg.id);
    this.waiting.delete(msg.id);
    if (job) {
      this.pending.delete(job.key);
      if (msg.error) this.error = msg.error;
      else if (job.key.startsWith(this.key + ':')) {
        this.tiles.set(job.key, { canvas: paint(msg.ids), ids: msg.ids });
        while (this.tiles.size > MAX_TILES) this.tiles.delete(this.tiles.keys().next().value);
        this.onTile();
      }
    }
    this.pump();
  }

  // The seed's biome at a block, from the finest tile already made, or null.
  biomeAt(bx, bz) {
    for (const s of LEVELS) {
      const span = CELLS * s;
      const tx = Math.floor(bx / span), tz = Math.floor(bz / span);
      const t = this.tiles.get(this.tileKey(s, tx, tz));
      if (!t) continue;
      const cx = Math.floor((bx - tx * span) / s), cz = Math.floor((bz - tz * span) / s);
      const id = t.ids[cz * CELLS + cx];
      return id === 255 ? null : id;
    }
    return null;
  }

  close() { for (const s of this.workers) s.w.terminate(); }
}

function paint(ids) {
  const img = new ImageData(CELLS, CELLS);
  for (let i = 0; i < ids.length; i++) {
    const b = ids[i];
    if (b === 255) continue;
    img.data[i * 4] = BIOME_RGB[b * 3];
    img.data[i * 4 + 1] = BIOME_RGB[b * 3 + 1];
    img.data[i * 4 + 2] = BIOME_RGB[b * 3 + 2];
    img.data[i * 4 + 3] = 255;
  }
  const canvas = document.createElement('canvas');
  canvas.width = CELLS; canvas.height = CELLS;
  canvas.getContext('2d').putImageData(img, 0, 0);
  return canvas;
}
