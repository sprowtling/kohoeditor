// Map: every chunk that exists in the world, seen from above. Select chunks to
// regenerate them from the seed, or copy them and paste them somewhere else
// (in this world, or another one via a chunk file).

import { h, clear, toast, confirmBox, fmt, formatBytes, DIM_NAMES, nickname, notes } from '../ui.js';
import { BIOME_RGB, biomeName } from '../lib/biomes.js';
import { CELL, RESULT_BYTES } from '../lib/blockmap.js';
import { SeedLayer } from './seedlayer.js';

const TILE = 128; // chunks per tile edge
const MIN_SCALE = 0.05, MAX_SCALE = 48;

const FLAG_DELETED = 1, FLAG_ENTITIES = 2, FLAG_BLOCK_ENTITIES = 4, FLAG_PASTED = 16;
const SAMPLE = 48; // bytes of biome sample per chunk: 16 biome ids, then 16 heights

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [128, 128, 128];
}

// Light-to-dark ramp: chunks with more data (usually more building) are darker.
const RAMP = [[214, 230, 190], [160, 200, 120], [96, 150, 70], [50, 100, 50], [28, 60, 40]];
function rampColor(t) {
  t = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(Math.floor(t), RAMP.length - 2), f = t - i;
  const a = RAMP[i], b = RAMP[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

const PASTED_RGB = [90, 150, 230];
const BLOCK_BATCH = 1024; // chunks drawn per request in the block view

// The selection: areas (rectangles of chunks, inclusive) added or taken out,
// in order; where they overlap, the latest one wins.
const area = (x0, z0, x1, z1, remove = false) => ({ x0: Math.min(x0, x1), z0: Math.min(z0, z1), x1: Math.max(x0, x1), z1: Math.max(z0, z1), remove });
const newSelection = (a) => ({ parts: [a] });
function inSelection(sel, x, z) {
  let on = false;
  for (const p of sel.parts) if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1) on = !p.remove;
  return on;
}
function selectionBounds(sel) {
  const add = sel.parts.filter((p) => !p.remove);
  if (!add.length) return null;
  return { x0: Math.min(...add.map((p) => p.x0)), z0: Math.min(...add.map((p) => p.z0)), x1: Math.max(...add.map((p) => p.x1)), z1: Math.max(...add.map((p) => p.z1)) };
}

// Round numbers of blocks between labelled grid lines, smallest first.
const GRID_STEPS = [16, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
const PLAIN_RGB = [200, 205, 190];
const NO_BIOME_RGB = [150, 146, 160]; // chunks without biome data, distinct from every biome colour

export class MapView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.dim = 0;
    this.mode = 'size';
    this.tool = 'pan';
    this.sel = null; // { parts: [area] } (see newSelection), or null
    this.view = { cx: 0, cz: 0, scale: 4 };
    this.hover = null;
    this.clip = null; // what has been copied
    this.pasting = null; // { entities } while choosing where to paste
    this.canvas = h('canvas');
    this.status = h('div', { class: 'map-status' }, 'Move the mouse over the map');
    this.legend = h('div', { class: 'map-legend' });
    this.side = h('div', { class: 'map-side' });
    this.banner = h('div', { class: 'map-banner', hidden: true });
    this.loading = h('div', { class: 'map-loading', hidden: true });
    this.mode = notes.get('map:mode') ?? 'size';
    this.gotoMark = null;
    this.dimSeg = h('div', { class: 'seg' }, DIM_NAMES.map((n, d) => h('button', { onclick: () => this.setDim(d) }, n)));
    this.toolSeg = h('div', { class: 'seg' },
      h('button', { dataset: { tool: 'pan' }, onclick: () => this.setTool('pan'), title: 'Drag to move around (hold Shift to select instead)' }, 'Move'),
      h('button', { dataset: { tool: 'select' }, onclick: () => this.setTool('select'), title: 'Drag to select chunks' }, 'Select'));
    this.blockCache = [new Map(), new Map(), new Map()]; // "x,z" -> RESULT_BYTES, per dimension
    this.blockFailed = [new Set(), new Set(), new Set()];
    this.prevFlags = [new Map(), new Map(), new Map()];
    this.showPlayers = notes.get('map:players') ?? true;
    // The seed map underneath: off until asked for; the world drawn on top at worldAlpha.
    this.seedOn = false;
    this.worldAlpha = notes.get('map:worldAlpha') ?? 0.55;
    this.seedY = notes.get('map:seedY') ?? 64;
    this.seedLayer = null;
    this.modeSelect = h('select', { onchange: (e) => { this.mode = e.target.value; notes.set('map:mode', this.mode); this.buildTiles(); this.draw(); this.loadBlocks(); } },
      h('option', { value: 'blocks' }, 'Blocks from above (like an in-game map)'),
      h('option', { value: 'size' }, 'Shade: amount of data'),
      h('option', { value: 'biome' }, 'Biomes'),
      h('option', { value: 'blockEntities' }, 'Highlight: chests, signs & other block entities'),
      h('option', { value: 'entities' }, 'Highlight: chunks with mobs or other entities'));
    clear(el,
      h('div', { class: 'map-wrap' },
        this.canvas,
        this.toolbar = h('div', { class: 'map-toolbar' }, this.dimSeg, this.toolSeg, this.modeSelect,
          h('button', { onclick: () => this.fit() }, 'Fit world'),
          this.gotoForm(),
          h('label', { class: 'button toggle', title: 'Show or hide where players logged off' },
            h('input', { type: 'checkbox', checked: this.showPlayers, onchange: (e) => { this.showPlayers = e.target.checked; notes.set('map:players', this.showPlayers); this.hoverPlayer = null; this.draw(); } }),
            ' Players')),
        this.banner, this.loading, this.status, this.legend),
      this.side);
    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement);
    this.setTool('pan');
    this.modeSelect.value = this.mode;
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.pasting) this.stopPasting(); });
    this.loaded = this.setDim(0, true).then(() => this.app.call('clipboardInfo')).then((c) => { this.clip = c; this.renderSide(); });
  }

  async onShow(opts = {}) {
    await this.loaded;
    if (opts.dim !== undefined && opts.dim !== this.dim) await this.setDim(opts.dim, opts.x === undefined);
    if (opts.x !== undefined) {
      this.sel = newSelection(area(opts.x, opts.z, opts.x, opts.z));
      this.view.scale = Math.max(this.view.scale, 12);
      this.centerOn(opts.x + 0.5, opts.z + 0.5);
      this.renderSide();
    }
    this.resize();
  }

  async onPendingChanged() {
    if (!this.chunks) return;
    await this.reload();
  }

  async setDim(dim, fit = true) {
    this.dim = dim;
    this.sel = null;
    for (const [i, b] of [...this.dimSeg.children].entries()) b.classList.toggle('active', i === dim);
    await this.reload();
    if (fit) this.fit();
    this.renderSide();
  }

  async reload() {
    const { list, surface } = await this.app.call('chunkList', { dim: this.dim });
    this.chunks = list;
    this.surface = surface;
    this.index = new Map();
    // A chunk whose flags changed (pasted, say) must be drawn again in the block view.
    const prev = this.prevFlags[this.dim], next = new Map();
    for (let i = 0; i < list.length; i += 4) {
      const id = list[i] + ',' + list[i + 1];
      this.index.set(id, i);
      next.set(id, list[i + 3]);
      if (prev.size && prev.get(id) !== list[i + 3]) { this.blockCache[this.dim].delete(id); this.blockFailed[this.dim].delete(id); }
    }
    this.prevFlags[this.dim] = next;
    this.buildTiles();
    this.draw();
    this.renderSide();
    this.loadBlocks();
  }

  setTool(tool) {
    this.tool = tool;
    for (const b of this.toolSeg.children) b.classList.toggle('active', b.dataset.tool === tool);
    this.canvas.style.cursor = this.pasting ? 'copy' : tool === 'select' ? 'crosshair' : 'grab';
  }

  // -------------------------------------------------------------------------
  // Drawing

  // Biome id and height of one sample (sx, sz from 0 to 3) in a chunk, or null.
  sampleAt(x, z, sx, sz) {
    const i = this.index.get(x + ',' + z);
    if (i === undefined) return null;
    const o = (i / 4) * SAMPLE;
    const k = sz * 4 + sx;
    const biome = this.surface[o + k];
    if (biome === 255) return null;
    return { biome, height: this.surface[o + 16 + k * 2] | (this.surface[o + 17 + k * 2] << 8) };
  }

  buildTiles() {
    if (this.mode === 'blocks') { this.buildBlockTiles(); return; }
    this.tiles = new Map();
    const c = this.chunks;
    const danger = hexToRgb(cssVar('--danger') || '#b33a2b');
    const biome = this.mode === 'biome';
    const res = biome ? 4 : 1; // pixels per chunk edge
    const size = TILE * res;
    // Shade by rank rather than raw size, so a few huge chunks don't wash out the rest.
    const sizes = [];
    for (let i = 2; i < c.length; i += 4) sizes.push(c[i]);
    sizes.sort((a, b) => a - b);
    const rank = (b) => {
      let lo = 0, hi = sizes.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (sizes[m] < b) lo = m + 1; else hi = m; }
      return sizes.length > 1 ? lo / (sizes.length - 1) : 0.5;
    };
    for (let i = 0; i < c.length; i += 4) {
      const x = c[i], z = c[i + 1], bytes = c[i + 2], flags = c[i + 3];
      const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
      const key = tx + ',' + tz;
      let t = this.tiles.get(key);
      if (!t) { t = { tx, tz, img: new ImageData(size, size), canvas: null }; this.tiles.set(key, t); }
      const put = (px, pz, rgb) => {
        const o = (pz * size + px) * 4;
        t.img.data[o] = rgb[0]; t.img.data[o + 1] = rgb[1]; t.img.data[o + 2] = rgb[2]; t.img.data[o + 3] = 255;
      };
      const lx = (x - tx * TILE) * res, lz = (z - tz * TILE) * res;
      if (biome) {
        for (let sz = 0; sz < 4; sz++) for (let sx = 0; sx < 4; sx++) {
          let rgb;
          if (flags & FLAG_DELETED) rgb = danger;
          else {
            const s = this.sampleAt(x, z, sx, sz);
            if (!s) rgb = NO_BIOME_RGB;
            else {
              const b = s.biome * 3;
              // Light from the north-west: brighter on slopes facing it, darker behind.
              const nx = sx > 0 ? this.sampleAt(x, z, sx - 1, sz) : this.sampleAt(x - 1, z, 3, sz);
              const nz = sz > 0 ? this.sampleAt(x, z, sx, sz - 1) : this.sampleAt(x, z - 1, sx, 3);
              const slope = ((nx ? s.height - nx.height : 0) + (nz ? s.height - nz.height : 0)) / 8;
              const k = Math.max(0.65, Math.min(1.3, 1 + slope * 0.12));
              rgb = [Math.min(255, BIOME_RGB[b] * k), Math.min(255, BIOME_RGB[b + 1] * k), Math.min(255, BIOME_RGB[b + 2] * k)];
              if (flags & FLAG_PASTED) rgb = rgb.map((v, j) => v * 0.65 + PASTED_RGB[j] * 0.35);
            }
          }
          put(lx + sx, lz + sz, rgb);
        }
      } else {
        let rgb;
        if (flags & FLAG_DELETED) rgb = danger;
        else if (flags & FLAG_PASTED) rgb = PASTED_RGB;
        else if (this.mode === 'blockEntities') rgb = flags & FLAG_BLOCK_ENTITIES ? [230, 150, 40] : PLAIN_RGB;
        else if (this.mode === 'entities') rgb = flags & FLAG_ENTITIES ? [140, 90, 210] : PLAIN_RGB;
        else rgb = rampColor(rank(bytes));
        put(lx, lz, rgb);
      }
    }
    for (const t of this.tiles.values()) {
      t.canvas = document.createElement('canvas');
      t.canvas.width = size; t.canvas.height = size;
      t.canvas.getContext('2d').putImageData(t.img, 0, 0);
      t.img = null;
    }
    this.renderLegend();
  }

  // ---- Block view: what the world looks like from above, drawn as it's read.

  buildBlockTiles() {
    this.tiles = new Map();
    const size = TILE * CELL;
    for (let i = 0; i < this.chunks.length; i += 4) {
      const x = this.chunks[i], z = this.chunks[i + 1];
      const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
      const key = tx + ',' + tz;
      if (!this.tiles.has(key)) {
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        this.tiles.set(key, { tx, tz, canvas, ctx: canvas.getContext('2d'), img: new ImageData(size, size), dirty: true });
      }
      this.paintBlockChunk(x, z, i);
    }
    this.flushTiles();
    this.renderLegend();
  }

  tileFor(x, z) {
    return this.tiles.get(Math.floor(x / TILE) + ',' + Math.floor(z / TILE));
  }

  // Shading like an in-game map: brighter where the ground is higher than
  // just north of it, darker where lower.
  paintBlockChunk(x, z, i = this.index.get(x + ',' + z)) {
    if (i === undefined) return;
    const t = this.tileFor(x, z);
    if (!t) return;
    const flags = this.chunks[i + 3];
    const data = this.blockCache[this.dim].get(x + ',' + z);
    const north = this.blockCache[this.dim].get(x + ',' + (z - 1));
    const size = TILE * CELL;
    const lx = (x - t.tx * TILE) * CELL, lz = (z - t.tz * TILE) * CELL;
    const px = t.img.data;
    const danger = this.dangerRgb ??= hexToRgb(cssVar('--danger') || '#b33a2b');
    const hv = data && new DataView(data.buffer, data.byteOffset, data.byteLength);
    const nv = north && new DataView(north.buffer, north.byteOffset, north.byteLength);
    for (let cz = 0; cz < CELL; cz++) {
      for (let cx = 0; cx < CELL; cx++) {
        const o = ((lz + cz) * size + lx + cx) * 4;
        const k = cz * CELL + cx;
        let r, g, b;
        if (flags & FLAG_DELETED) [r, g, b] = (cx + cz) % 4 < 2 ? danger : danger.map((v) => v * 0.8);
        else if (!data) {
          // Not drawn yet: a soft checker so it's clear something is coming.
          const v = (cx >> 2) + (cz >> 2) & 1 ? 214 : 202;
          r = v; g = v; b = v - 6;
        } else {
          const hgt = hv.getUint16(192 + k * 2, true);
          if (!hgt) { r = 30; g = 30; b = 34; } else {
            const nh = cz > 0 ? hv.getUint16(192 + (k - CELL) * 2, true) : nv ? nv.getUint16(192 + (CELL * (CELL - 1) + cx) * 2, true) : 0;
            const f = !nh ? 0.86 : hgt > nh ? 1 : hgt < nh ? 0.71 : 0.86;
            r = data[k * 3] * f; g = data[k * 3 + 1] * f; b = data[k * 3 + 2] * f;
            if (flags & FLAG_PASTED && (cx === 0 || cz === 0)) { r = r * 0.5 + PASTED_RGB[0] * 0.5; g = g * 0.5 + PASTED_RGB[1] * 0.5; b = b * 0.5 + PASTED_RGB[2] * 0.5; }
          }
        }
        px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
      }
    }
    t.dirty = true;
  }

  flushTiles() {
    for (const t of this.tiles.values()) {
      if (!t.dirty) continue;
      t.ctx.putImageData(t.img, 0, 0);
      t.dirty = false;
    }
  }

  // Reads chunks in batches, nearest the middle of the view first, until every
  // chunk in this dimension is drawn. The map stays usable meanwhile.
  async loadBlocks() {
    if (this.mode !== 'blocks' || this.blockLoading) return;
    this.blockLoading = true;
    const dim = this.dim;
    try {
      for (;;) {
        if (this.mode !== 'blocks' || this.dim !== dim || !this.chunks) break;
        const cache = this.blockCache[dim], failed = this.blockFailed[dim];
        const todo = [];
        for (let i = 0; i < this.chunks.length; i += 4) {
          const id = this.chunks[i] + ',' + this.chunks[i + 1];
          if (!(this.chunks[i + 3] & FLAG_DELETED) && !cache.has(id) && !failed.has(id)) todo.push(i);
        }
        const total = this.chunks.length / 4;
        if (!todo.length) break;
        this.loading.hidden = false;
        this.loading.textContent = `Drawing blocks: ${fmt(total - todo.length)} of ${fmt(total)} chunks`;
        const { cx, cz } = this.view;
        const d = (i) => (this.chunks[i] + 0.5 - cx) ** 2 + (this.chunks[i + 1] + 0.5 - cz) ** 2;
        const batch = todo.length > BLOCK_BATCH ? todo.sort((a, b) => d(a) - d(b)).slice(0, BLOCK_BATCH) : todo;
        const coords = batch.map((i) => [this.chunks[i], this.chunks[i + 1]]);
        const r = await this.app.call('blockMap', { dim, coords });
        if (this.dim !== dim) break;
        coords.forEach(([x, z], k) => {
          const id = x + ',' + z;
          if (r.ok[k]) cache.set(id, r.data.slice(k * RESULT_BYTES, (k + 1) * RESULT_BYTES));
          else failed.add(id);
        });
        if (this.mode !== 'blocks') continue;
        for (const [x, z] of coords) {
          this.paintBlockChunk(x, z);
          if (this.index.has(x + ',' + (z + 1))) this.paintBlockChunk(x, z + 1); // its shading looks north
        }
        this.flushTiles();
        this.draw();
      }
    } catch (e) {
      toast(`Couldn't draw the blocks: ${e.message}`, true);
    } finally {
      this.blockLoading = false;
      this.loading.hidden = true;
    }
    // The view may have changed dimension or mode while this batch was running.
    if (this.mode === 'blocks' && this.dim !== dim) this.loadBlocks();
  }

  renderLegend() {
    this.renderModeLegend();
    if (this.seedOn) this.legend.prepend(h('div', { class: 'muted' }, 'Underneath: the seed\'s biomes'));
  }

  renderModeLegend() {
    const sw = (color, text) => h('div', {}, h('span', { class: 'legend-swatch', style: { background: color } }), text);
    const danger = cssVar('--danger') || '#b33a2b';
    const pasted = sw(`rgb(${PASTED_RGB})`, 'pasted');
    const regen = sw(danger, 'will regenerate');
    if (this.mode === 'blocks') {
      clear(this.legend, h('div', { class: 'muted' }, 'The top block of each spot, shaded'), h('div', { class: 'muted' }, 'like an in-game map'), sw(`rgb(${PASTED_RGB})`, 'pasted (edge)'), regen);
      return;
    }
    if (this.mode === 'size') clear(this.legend, sw('rgb(214,230,190)', 'less data than most'), sw('rgb(28,60,40)', 'more data (often builds)'), pasted, regen);
    else if (this.mode === 'blockEntities') clear(this.legend, sw('rgb(230,150,40)', 'has block entities'), pasted, regen);
    else if (this.mode === 'entities') clear(this.legend, sw('rgb(140,90,210)', 'has entities'), pasted, regen);
    else {
      // The biomes actually on screen in this dimension, most common first.
      const counts = new Map();
      for (let o = 0; o < this.surface.length; o += SAMPLE) {
        for (let k = 0; k < 16; k++) { const b = this.surface[o + k]; if (b !== 255) counts.set(b, (counts.get(b) ?? 0) + 1); }
      }
      const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8);
      const rgb = (b) => `rgb(${BIOME_RGB[b * 3]},${BIOME_RGB[b * 3 + 1]},${BIOME_RGB[b * 3 + 2]})`;
      clear(this.legend,
        top.length ? top.map(([b]) => sw(rgb(b), biomeName(b))) : h('div', { class: 'muted' }, 'No biome data in this dimension'),
        counts.size > top.length ? h('div', { class: 'muted' }, `and ${counts.size - top.length} more (hover to see)`) : null,
        sw(`rgb(${NO_BIOME_RGB})`, 'no biome data'), regen);
    }
  }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.w = r.width; this.hgt = r.height; this.dpr = dpr;
    // The toolbar wraps on narrow screens; keep the grid labels and loading note below it.
    this.toolbarBottom = this.toolbar.getBoundingClientRect().bottom - r.top + 6;
    this.loading.style.top = `${this.toolbarBottom + 24}px`;
    if (this.needFit) this.fit();
    this.draw();
  }

  toScreen(cx, cz) {
    const { scale } = this.view;
    return [(cx - this.view.cx) * scale + this.w / 2, (cz - this.view.cz) * scale + this.hgt / 2];
  }

  toChunk(sx, sy) {
    const { scale } = this.view;
    return [(sx - this.w / 2) / scale + this.view.cx, (sy - this.hgt / 2) / scale + this.view.cz];
  }

  draw() {
    if (!this.w || !this.tiles) return;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = null; this.drawNow(); });
  }

  // Screen positions of the player dots in this dimension.
  playerDots() {
    const out = [];
    if (!this.showPlayers) return out;
    for (const p of this.app.players) {
      const s = p.summary;
      if (!s || !s.pos || s.dim !== this.dim) continue;
      const [px, py] = this.toScreen(s.pos[0] / 16, s.pos[2] / 16);
      if (px < -20 || py < -20 || px > this.w + 20 || py > this.hgt + 20) continue;
      out.push({ p, px, py });
    }
    return out;
  }

  playerAt(sx, sy) {
    let best = null, bestD = 9 * 9;
    for (const d of this.playerDots()) {
      const dd = (d.px - sx) ** 2 + (d.py - sy) ** 2;
      if (dd <= bestD) { best = d.p; bestD = dd; }
    }
    return best;
  }

  drawNow() {
    const ctx = this.canvas.getContext('2d');
    const { scale } = this.view;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = cssVar('--panel-2');
    ctx.fillRect(0, 0, this.w, this.hgt);
    ctx.imageSmoothingEnabled = false;
    const [x0, z0] = this.toChunk(0, 0), [x1, z1] = this.toChunk(this.w, this.hgt);
    if (this.seedOn && this.app.info.seed) {
      this.seedLayer ??= new SeedLayer(() => this.draw());
      this.seedLayer.configure(this.app.info.seed, this.dim, this.seedY);
      this.seedLayer.draw(ctx, {
        blockRect: [x0 * 16, z0 * 16, x1 * 16, z1 * 16],
        toScreen: (bx, bz) => this.toScreen(bx / 16, bz / 16),
        pxPerBlock: scale / 16,
        center: [this.view.cx * 16, this.view.cz * 16],
      });
      ctx.globalAlpha = this.worldAlpha;
    }
    for (const t of this.tiles.values()) {
      const bx = t.tx * TILE, bz = t.tz * TILE;
      if (bx > x1 || bx + TILE < x0 || bz > z1 || bz + TILE < z0) continue;
      const [sx, sy] = this.toScreen(bx, bz);
      ctx.drawImage(t.canvas, sx, sy, TILE * scale, TILE * scale);
    }
    ctx.globalAlpha = 1;
    this.drawGrid(ctx, x0, z0, x1, z1);
    // Players
    ctx.font = '600 11px system-ui, sans-serif';
    for (const { p, px, py } of this.playerDots()) {
      const hot = this.hoverPlayer === p;
      ctx.fillStyle = hot ? '#f0a020' : '#2a7de1';
      ctx.beginPath(); ctx.arc(px, py, hot ? 7 : 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
      if (scale >= 1 || hot) {
        ctx.fillStyle = cssVar('--text');
        ctx.fillText(nickname(p), px + 9, py + 4);
      }
    }
    // Hover and selection
    if (this.hover && scale >= 2 && !this.pasting) {
      const [hx, hy] = this.toScreen(this.hover[0], this.hover[1]);
      ctx.strokeStyle = cssVar('--text');
      ctx.strokeRect(hx + 0.5, hy + 0.5, scale, scale);
    }
    // The selection, with the area being dragged out (added, taken out, or starting afresh).
    const parts = this.dragSel
      ? (this.dragSel.mode === 'new' || !this.sel ? [] : this.sel.parts).concat([this.dragSel.area])
      : this.sel?.parts ?? [];
    if (parts.length && !this.pasting) {
      for (const p of parts) {
        const [sx, sy] = this.toScreen(p.x0, p.z0);
        const [ex, ey] = this.toScreen(p.x1 + 1, p.z1 + 1);
        ctx.fillStyle = p.remove ? 'rgba(179,58,43,0.22)' : 'rgba(42,125,225,0.15)';
        ctx.fillRect(sx, sy, ex - sx, ey - sy);
        ctx.strokeStyle = p.remove ? '#b33a2b' : '#2a7de1';
        ctx.lineWidth = 2;
        ctx.setLineDash(p.remove ? [6, 4] : []);
        ctx.strokeRect(sx, sy, Math.max(ex - sx, 2), Math.max(ey - sy, 2));
      }
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    }
    // Where a paste would land
    if (this.pasting && this.hover && this.clip) {
      const [hx, hz] = this.hover;
      ctx.fillStyle = 'rgba(240,160,32,0.45)';
      for (const [cx, cz] of this.clip.cells) {
        const [sx, sy] = this.toScreen(hx + cx, hz + cz);
        ctx.fillRect(sx, sy, Math.max(scale, 1), Math.max(scale, 1));
      }
      const b = this.clip.bounds;
      const [sx, sy] = this.toScreen(hx, hz);
      const [ex, ey] = this.toScreen(hx + b.x1 - b.x0 + 1, hz + b.z1 - b.z0 + 1);
      ctx.strokeStyle = '#f0a020';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx, sy, Math.max(ex - sx, 2), Math.max(ey - sy, 2));
      ctx.lineWidth = 1;
    }
  }

  // Faint chunk lines when zoomed in, and labelled lines every round number of
  // blocks (100, 500, 1000...) at a spacing that suits the zoom.
  drawGrid(ctx, x0, z0, x1, z1) {
    const { scale } = this.view;
    const line = cssVar('--line'), text = cssVar('--text'), panel = cssVar('--panel');
    ctx.lineWidth = 1;
    if (scale >= 6) {
      ctx.strokeStyle = line;
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      for (let gx = Math.floor(x0); gx <= x1; gx++) { const [sx] = this.toScreen(gx, 0); ctx.moveTo(Math.round(sx) + 0.5, 0); ctx.lineTo(Math.round(sx) + 0.5, this.hgt); }
      for (let gz = Math.floor(z0); gz <= z1; gz++) { const [, sy] = this.toScreen(0, gz); ctx.moveTo(0, Math.round(sy) + 0.5); ctx.lineTo(this.w, Math.round(sy) + 0.5); }
      ctx.stroke();
    }
    const pxPerBlock = scale / 16;
    const step = GRID_STEPS.find((s) => s * pxPerBlock >= 110) ?? GRID_STEPS[GRID_STEPS.length - 1];
    const bx0 = Math.ceil((x0 * 16) / step) * step, bz0 = Math.ceil((z0 * 16) / step) * step;
    ctx.strokeStyle = text;
    ctx.globalAlpha = 0.28;
    ctx.beginPath();
    for (let b = bx0; b <= x1 * 16; b += step) { const [sx] = this.toScreen(b / 16, 0); ctx.moveTo(Math.round(sx) + 0.5, 0); ctx.lineTo(Math.round(sx) + 0.5, this.hgt); }
    for (let b = bz0; b <= z1 * 16; b += step) { const [, sy] = this.toScreen(0, b / 16); ctx.moveTo(0, Math.round(sy) + 0.5); ctx.lineTo(this.w, Math.round(sy) + 0.5); }
    ctx.stroke();
    // The x = 0 and z = 0 lines a little stronger.
    const [ox, oy] = this.toScreen(0, 0);
    ctx.globalAlpha = 0.55;
    ctx.beginPath(); ctx.moveTo(Math.round(ox) + 0.5, 0); ctx.lineTo(Math.round(ox) + 0.5, this.hgt); ctx.moveTo(0, Math.round(oy) + 0.5); ctx.lineTo(this.w, Math.round(oy) + 0.5); ctx.stroke();
    ctx.globalAlpha = 1;
    // Labels: x along the top (below the toolbar), z down the left side.
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const label = (t, x, y, align) => {
      const w = ctx.measureText(t).width + 8;
      const lx = align === 'center' ? x - w / 2 : x;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = panel;
      ctx.fillRect(lx, y - 8, w, 16);
      ctx.globalAlpha = 1;
      ctx.fillStyle = text;
      ctx.fillText(t, lx + 4, y);
    };
    const top = this.toolbarBottom ?? 56;
    for (let b = bx0; b <= x1 * 16; b += step) { const [sx] = this.toScreen(b / 16, 0); if (sx > 60) label(`x ${fmt(b)}`, sx, top + 10, 'center'); }
    for (let b = bz0; b <= z1 * 16; b += step) { const [, sy] = this.toScreen(0, b / 16); if (sy > top + 26 && sy < this.hgt - 40) label(`z ${fmt(b)}`, 4, sy, 'left'); }
    ctx.textBaseline = 'alphabetic';
    // Where "Go to" took us.
    if (this.gotoMark) {
      const [gx, gy] = this.toScreen(this.gotoMark[0] / 16, this.gotoMark[1] / 16);
      ctx.strokeStyle = '#f0a020';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(gx, gy, 9, 0, Math.PI * 2); ctx.moveTo(gx - 15, gy); ctx.lineTo(gx - 5, gy); ctx.moveTo(gx + 5, gy); ctx.lineTo(gx + 15, gy);
      ctx.moveTo(gx, gy - 15); ctx.lineTo(gx, gy - 5); ctx.moveTo(gx, gy + 5); ctx.lineTo(gx, gy + 15); ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  gotoForm() {
    const input = h('input', { type: 'text', placeholder: 'Go to x, z', class: 'goto', title: 'Block coordinates, like 1200, -340 (or x y z from the game)' });
    const go = () => {
      const nums = (input.value.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
      if (nums.length < 2) { toast('Type block coordinates, like 1200, -340.', true); return; }
      const [bx, bz] = nums.length >= 3 ? [nums[0], nums[2]] : nums; // "x y z" copied from the game
      this.gotoMark = [bx, bz];
      this.view.scale = Math.max(this.view.scale, 6);
      this.centerOn(bx / 16, bz / 16);
      this.loadBlocks();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return h('span', { class: 'goto-wrap' }, input, h('button', { onclick: go }, 'Go'));
  }

  fit() {
    const c = this.chunks;
    if (!c || !c.length) { this.centerOn(0, 0); return; }
    this.needFit = false;
    // Fit most of the world, ignoring a few far-flung chunks, so one stray
    // chunk a million blocks away doesn't shrink everything to a dot.
    const xs = [], zs = [];
    for (let i = 0; i < c.length; i += 4) { xs.push(c[i]); zs.push(c[i + 1]); }
    xs.sort((a, b) => a - b); zs.sort((a, b) => a - b);
    const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * f)))];
    const trim = c.length > 200 ? 0.005 : 0;
    const minX = q(xs, trim), maxX = q(xs, 1 - trim) + 1, minZ = q(zs, trim), maxZ = q(zs, 1 - trim) + 1;
    if (!this.w) { this.needFit = true; return; }
    const w = this.w, hh = this.hgt;
    this.view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, 0.9 * Math.min(w / (maxX - minX), hh / (maxZ - minZ))));
    this.view.cx = (minX + maxX) / 2;
    this.view.cz = (minZ + maxZ) / 2;
    this.draw();
  }

  centerOn(cx, cz) {
    this.view.cx = cx; this.view.cz = cz;
    this.draw();
  }

  // -------------------------------------------------------------------------
  // Mouse and touch

  describeHover(fx, fz) {
    const x = Math.floor(fx), z = Math.floor(fz);
    const i = this.index?.get(x + ',' + z);
    let text = `Chunk ${x}, ${z} · blocks ${x * 16}…${x * 16 + 15}, ${z * 16}…${z * 16 + 15}`;
    const seedBiome = this.seedOn ? this.seedLayer?.biomeAt(Math.floor(fx * 16), Math.floor(fz * 16)) : null;
    const seedText = seedBiome != null ? ` · seed makes ${biomeName(seedBiome)}` : '';
    if (i === undefined) return text + ' · not generated' + seedText;
    const flags = this.chunks[i + 3];
    const s = this.sampleAt(x, z, Math.min(3, Math.floor((fx - x) * 4)), Math.min(3, Math.floor((fz - z) * 4)));
    if (s) text += ` · ${biomeName(s.biome)}, surface y ${s.height - 64}`;
    text += ` · ${formatBytes(this.chunks[i + 2])}`;
    if (flags & FLAG_DELETED) text += ' · will regenerate';
    if (flags & FLAG_PASTED) text += ' · pasted';
    return text + seedText;
  }

  bindEvents() {
    const cv = this.canvas;
    let drag = null;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      const [sx, sy] = pos(e);
      // Ctrl (⌘ on a Mac) adds to the selection; Alt takes out of it.
      const mode = e.ctrlKey || e.metaKey ? 'add' : e.altKey ? 'remove' : 'new';
      const selecting = !this.pasting && (this.tool === 'select' || e.shiftKey || mode !== 'new');
      drag = { sx, sy, cx: this.view.cx, cz: this.view.cz, selecting, moved: false, mode };
      if (!selecting && !this.pasting) cv.style.cursor = 'grabbing';
    });
    cv.addEventListener('pointermove', (e) => {
      const [sx, sy] = pos(e);
      const [fx, fz] = this.toChunk(sx, sy);
      const x = Math.floor(fx), z = Math.floor(fz);
      const hp = drag ? null : this.playerAt(sx, sy);
      if (hp !== this.hoverPlayer) {
        this.hoverPlayer = hp;
        cv.style.cursor = hp ? 'pointer' : this.pasting ? 'copy' : this.tool === 'select' ? 'crosshair' : 'grab';
        this.draw();
      }
      if (!this.hover || this.hover[0] !== x || this.hover[1] !== z || this.mode === 'biome') {
        this.hover = [x, z];
        this.status.textContent = hp ? `${nickname(hp)} · click to open their inventory` : this.describeHover(fx, fz);
        this.draw();
      }
      if (!drag) return;
      if (Math.abs(sx - drag.sx) + Math.abs(sy - drag.sy) > 3) drag.moved = true;
      if (drag.selecting) {
        const [ax, az] = this.toChunk(drag.sx, drag.sy);
        this.dragSel = { mode: drag.mode, area: area(Math.floor(ax), Math.floor(az), Math.floor(fx), Math.floor(fz), drag.mode === 'remove') };
        this.draw();
      } else {
        this.view.cx = drag.cx - (sx - drag.sx) / this.view.scale;
        this.view.cz = drag.cz - (sy - drag.sy) / this.view.scale;
        this.draw();
      }
    });
    const end = (e) => {
      if (!drag) return;
      const [sx, sy] = pos(e);
      if (!drag.moved) {
        const [fx, fz] = this.toChunk(sx, sy);
        const x = Math.floor(fx), z = Math.floor(fz);
        const player = this.playerAt(sx, sy);
        if (player) this.app.showPlayer(player.key);
        else if (this.pasting) this.pasteAt(x, z);
        else {
          this.addToSelection(area(x, z, x, z, drag.mode === 'remove'), drag.mode);
          this.renderSide();
        }
      } else if (drag.selecting && this.dragSel) {
        this.addToSelection(this.dragSel.area, drag.mode);
        this.renderSide();
      }
      this.dragSel = null;
      drag = null;
      this.setTool(this.tool);
      this.draw();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { this.hover = null; this.hoverPlayer = null; this.draw(); });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [sx, sy] = pos(e);
      const [bx, bz] = this.toChunk(sx, sy);
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      this.view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.view.scale * factor));
      const [ax, az] = this.toChunk(sx, sy);
      this.view.cx += bx - ax;
      this.view.cz += bz - az;
      this.draw();
    }, { passive: false });
  }

  // -------------------------------------------------------------------------
  // Copy and paste

  openChunkbase() {
    const seed = this.app.info.seed;
    const dims = ['overworld', 'nether', 'end'];
    const bx = Math.round(this.view.cx * 16), bz = Math.round(this.view.cz * 16);
    navigator.clipboard?.writeText(seed).catch(() => {});
    const url = `https://www.chunkbase.com/apps/seed-map#seed=${encodeURIComponent(seed)}&platform=bedrock_1_21&dimension=${dims[this.dim]}&x=${bx}&z=${bz}&zoom=0.5`;
    window.open(url, '_blank', 'noopener');
  }

  async copySelection(picked) {
    const coords = picked.filter((i) => !(this.chunks[i + 3] & FLAG_DELETED)).map((i) => [this.chunks[i], this.chunks[i + 1]]);
    try {
      this.clip = await this.app.call('copyChunks', { dim: this.dim, coords });
      toast(`Copied ${fmt(this.clip.count)} chunk${this.clip.count === 1 ? '' : 's'}. Choose “Paste” to place them.`);
      this.renderSide();
    } catch (e) {
      toast(e.message, true);
    }
  }

  startPasting() {
    if (!this.clip) return;
    this.pasting = { entities: this.pasting?.entities ?? true };
    this.banner.hidden = false;
    clear(this.banner,
      h('span', {}, `Click where the top-left corner of the ${fmt(this.clip.count)} copied chunk${this.clip.count === 1 ? '' : 's'} should go.`),
      h('button', { class: 'small', onclick: () => this.stopPasting() }, 'Cancel (Esc)'));
    this.setTool(this.tool);
    this.renderSide();
    this.draw();
  }

  stopPasting() {
    this.pasting = null;
    this.banner.hidden = true;
    this.setTool(this.tool);
    this.renderSide();
    this.draw();
  }

  async pasteAt(x, z) {
    const clip = this.clip;
    const b = clip.bounds;
    // How many existing chunks will be replaced.
    let replaced = 0;
    for (const [cx, cz] of clip.cells) if (this.index.has((x + cx) + ',' + (z + cz))) replaced++;
    const entities = this.pasting?.entities ?? true;
    const ok = await confirmBox({
      title: `Paste ${fmt(clip.count)} chunk${clip.count === 1 ? '' : 's'} here?`,
      body: [
        `The copy's corner goes at chunk ${x}, ${z} (block ${x * 16}, ${z * 16}), covering blocks ${x * 16} to ${(x + b.x1 - b.x0) * 16 + 15} across and ${z * 16} to ${(z + b.z1 - b.z0) * 16 + 15} down.`,
        replaced ? `${fmt(replaced)} existing chunk${replaced === 1 ? '' : 's'} there will be replaced completely.` : 'Nothing is there yet, so no existing chunks are replaced.',
        clip.dim !== this.dim ? `These chunks were copied from the ${DIM_NAMES[clip.dim]} and are being pasted into the ${DIM_NAMES[this.dim]}.` : null,
        entities ? 'Mobs, armor stands and other entities come along too.' : 'Mobs and other entities are left out.',
        'Nothing happens to your world until you save it, and you can undo this before then.',
      ].filter(Boolean),
      ok: 'Paste', danger: replaced > 0,
    });
    if (!ok) return;
    this.stopPasting();
    try {
      const r = await this.app.call('pasteChunks', { dim: this.dim, x, z, entities });
      this.sel = newSelection(area(x, z, x + b.x1 - b.x0, z + b.z1 - b.z0));
      await this.app.refreshPending();
      toast(`Pasted ${fmt(r.count)} chunk${r.count === 1 ? '' : 's'}. Save the world to keep them.`);
    } catch (e) {
      toast(e.message, true);
    }
  }

  async saveClipFile() {
    try {
      const blob = await this.app.call('clipboardFile');
      const name = `${(this.clip.world || 'chunks').replace(/[\\/:*?"<>|]+/g, '_')} ${this.clip.count} chunks.kohochunks`;
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast(`Saved ${name} (${formatBytes(blob.size)}).`);
    } catch (e) {
      toast(e.message, true);
    }
  }

  async loadClipFile(file) {
    try {
      this.clip = await this.app.call('loadClipboard', { file });
      toast(`Loaded ${fmt(this.clip.count)} chunk${this.clip.count === 1 ? '' : 's'}${this.clip.world ? ` from ${this.clip.world}` : ''}.`);
      this.renderSide();
    } catch (e) {
      toast(e.message, true);
    }
  }

  clipCard() {
    const c = this.clip;
    const fileInput = h('input', { type: 'file', accept: '.kohochunks', hidden: true, onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.loadClipFile(f); } });
    if (!c) {
      return h('div', { class: 'card' },
        h('h3', {}, 'Copy and paste'),
        h('p', { class: 'muted small-text', style: { marginTop: 0 } }, 'Select some chunks and choose Copy. To bring chunks over from another world, open a chunk file you saved there.'),
        h('label', { class: 'button small' }, 'Open chunk file…', fileInput));
    }
    const w = c.bounds.x1 - c.bounds.x0 + 1, d = c.bounds.z1 - c.bounds.z0 + 1;
    const entities = h('input', { type: 'checkbox', checked: this.pasting?.entities ?? true, onchange: (e) => { this.pasting = { ...(this.pasting ?? {}), entities: e.target.checked }; if (!this.banner.hidden) this.pasting.entities = e.target.checked; } });
    return h('div', { class: 'card clip-card' },
      h('h3', {}, 'Copied'),
      h('div', { class: 'small-text' }, `${fmt(c.count)} chunk${c.count === 1 ? '' : 's'} (${fmt(w)} × ${fmt(d)}) from the ${DIM_NAMES[c.dim]}${c.world ? ` of ${c.world}` : ''}`),
      h('div', { class: 'muted small-text' }, `${fmt(c.entities)} entit${c.entities === 1 ? 'y' : 'ies'} · ${formatBytes(c.bytes)} of data`),
      h('label', { class: 'check small-text' }, entities, ' Include mobs, armor stands and other entities'),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        this.pasting
          ? h('button', { onclick: () => this.stopPasting() }, 'Cancel paste')
          : h('button', { class: 'primary', onclick: () => this.startPasting() }, 'Paste…'),
        h('button', { onclick: () => this.saveClipFile(), title: 'Save these chunks to a file you can paste into another world' }, 'Save as file'),
        h('label', { class: 'button', title: 'Open a chunk file saved from this or another world' }, 'Open file…', fileInput)),
      h('p', { class: 'muted small-text', style: { marginBottom: 0 } }, 'Block positions inside the chunks (chests, signs, mobs) move along with them. Pasting replaces whatever is at the destination.'));
  }

  // -------------------------------------------------------------------------
  // Side panel

  // mode: 'new' starts a fresh selection; 'add' and 'remove' change the one there is.
  addToSelection(a, mode) {
    if (mode === 'new' || !this.sel) {
      this.sel = a.remove ? null : newSelection(a);
      return;
    }
    this.sel = { parts: [...this.sel.parts, a] };
    if (!selectionBounds(this.sel)) this.sel = null;
  }

  // Indexes (into this.chunks) of the generated chunks that are selected.
  selectedChunks() {
    const s = this.sel;
    const b = s && selectionBounds(s);
    if (!b) return [];
    const out = [];
    const cells = (b.x1 - b.x0 + 1) * (b.z1 - b.z0 + 1);
    if (cells < this.chunks.length / 4) {
      for (let x = b.x0; x <= b.x1; x++) for (let z = b.z0; z <= b.z1; z++) {
        const i = this.index.get(x + ',' + z);
        if (i !== undefined && inSelection(s, x, z)) out.push(i);
      }
    } else {
      for (let i = 0; i < this.chunks.length; i += 4) {
        if (inSelection(s, this.chunks[i], this.chunks[i + 1])) out.push(i);
      }
    }
    return out;
  }

  async renderSide() {
    if (!this.chunks) return;
    const total = this.chunks.length / 4;
    let deletedTotal = 0, pastedTotal = 0;
    for (let i = 3; i < this.chunks.length; i += 4) {
      if (this.chunks[i] & FLAG_DELETED) deletedTotal++;
      else if (this.chunks[i] & FLAG_PASTED) pastedTotal++;
    }
    const s = this.sel;
    const head = h('div', { class: 'card' },
      h('h2', {}, DIM_NAMES[this.dim]),
      h('div', { class: 'muted' }, `${fmt(total)} chunks`, deletedTotal ? ` · ${fmt(deletedTotal)} marked to regenerate` : '', pastedTotal ? ` · ${fmt(pastedTotal)} pasted` : ''));

    const form = this.coordForm();
    const clipCard = this.clipCard();
    const seed = this.app.info.seed;
    const [bx, bz] = [Math.round(this.view.cx * 16), Math.round(this.view.cz * 16)];
    const alpha = h('input', {
      type: 'range', min: 0, max: 100, value: Math.round(this.worldAlpha * 100), disabled: !this.seedOn,
      oninput: (e) => { this.worldAlpha = e.target.value / 100; notes.set('map:worldAlpha', this.worldAlpha); this.draw(); },
    });
    const yInput = h('input', {
      type: 'number', value: this.seedY, step: 8, min: -64, max: 320, style: { width: '80px' }, disabled: !this.seedOn,
      onchange: (e) => { const v = Math.max(-64, Math.min(320, Math.round(Number(e.target.value) || 64))); this.seedY = v; notes.set('map:seedY', v); this.draw(); },
    });
    const seedCard = seed ? h('div', { class: 'card' },
      h('h3', {}, 'World seed'),
      h('div', { class: 'mono small-text', style: { wordBreak: 'break-all' } }, seed),
      h('label', { class: 'check small-text' },
        h('input', { type: 'checkbox', checked: this.seedOn, onchange: (e) => { this.seedOn = e.target.checked; this.renderSide(); this.renderLegend(); this.draw(); } }),
        ' Show the seed\'s biomes underneath the map'),
      this.seedOn ? [
        h('label', { class: 'field small-text', style: { marginTop: '8px' } }, h('span', { class: 'k' }, `Your world on top: ${Math.round(this.worldAlpha * 100)}%`), alpha),
        h('div', { class: 'row small-text', style: { marginTop: '6px' } }, 'Biomes at height y', yInput),
        h('p', { class: 'muted small-text', style: { marginBottom: 0 } },
          'This is what the seed generates today (as of Minecraft 1.21), which is what new or regenerated chunks will get. Slide your world down to see it on its own; hover anywhere to compare. It matches Bedrock\'s own biomes closely, though edges such as riverbanks can be a few blocks off. Biomes vary with height: 64 is around sea level.'),
      ] : null,
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'small', onclick: () => { navigator.clipboard?.writeText(seed).then(() => toast('Seed copied.'), () => toast(seed)); } }, 'Copy seed'),
        h('button', { class: 'small', title: 'Opens Chunkbase\'s seed map in a new tab, centred where you are looking', onclick: () => this.openChunkbase() }, 'Open this spot in Chunkbase')),
      h('p', { class: 'muted small-text', style: { marginBottom: 0 } }, 'Opening Chunkbase copies the seed too, in case you need to paste it there.')) : null;
    const help = h('div', { class: 'card muted small-text' },
      h('p', { style: { marginTop: 0 } }, 'Drag to move, scroll to zoom. To select, use the Select tool or hold Shift while dragging. Hold Ctrl (⌘ on a Mac) while dragging or clicking to add more to the selection, or Alt to take some out. Click one chunk to look inside it, or a player\'s dot to open their inventory.'),
      h('p', { style: { marginBottom: 0 } }, 'Regenerated chunks come back fresh from the world seed the next time a player comes near. Builds, chests, signs and mobs in them are removed.'));

    if (!s || this.pasting) { clear(this.side, head, clipCard, form, seedCard, help); return; }

    const picked = this.selectedChunks();
    const del = picked.filter((i) => this.chunks[i + 3] & FLAG_DELETED).length;
    const live = picked.length - del;
    const b = selectionBounds(s);
    const w = b.x1 - b.x0 + 1, d = b.z1 - b.z0 + 1;
    const simple = s.parts.length === 1;
    const singleChunk = simple && w * d === 1;
    const coordsOf = (list) => list.map((i) => [this.chunks[i], this.chunks[i + 1]]);
    const selCard = h('div', { class: 'card' },
      h('h3', {}, singleChunk ? `Chunk ${b.x0}, ${b.z0}` : simple ? `Selection: ${fmt(w)} × ${fmt(d)} chunks` : `Selection: ${s.parts.length} areas`),
      h('table', { class: 'kv small-text' },
        h('tr', {}, h('td', {}, simple ? 'Blocks X' : 'Within X'), h('td', { class: 'mono' }, `${b.x0 * 16} to ${b.x1 * 16 + 15}`)),
        h('tr', {}, h('td', {}, simple ? 'Blocks Z' : 'Within Z'), h('td', { class: 'mono' }, `${b.z0 * 16} to ${b.z1 * 16 + 15}`)),
        h('tr', {}, h('td', {}, 'Generated'), h('td', {}, simple ? `${fmt(picked.length)} of ${fmt(w * d)}` : `${fmt(picked.length)} chunks selected`)),
        del ? h('tr', {}, h('td', {}, 'To regenerate'), h('td', {}, fmt(del))) : null),
      singleChunk ? null : h('p', { class: 'muted small-text', style: { margin: '6px 0 0' } }, 'Ctrl-drag (⌘ on a Mac) to add more, Alt-drag to take some out.'),
      h('div', { class: 'row', style: { marginTop: '10px' } },
        h('button', { disabled: !live, onclick: () => this.copySelection(picked), title: 'Copy these chunks so you can paste them somewhere else' }, 'Copy'),
        h('button', {
          class: 'danger', disabled: !live,
          onclick: async () => {
            const targets = picked.filter((i) => !(this.chunks[i + 3] & FLAG_DELETED));
            const ok = await confirmBox({
              title: `Regenerate ${fmt(targets.length)} chunk${targets.length === 1 ? '' : 's'}?`,
              body: [
                'Everything in these chunks will be removed: blocks, builds, chests and their contents, signs and mobs. The game regenerates them from the seed the next time someone comes near.',
                'Nothing happens to your world until you save it, and you can undo this before then.',
              ],
              ok: 'Mark for regeneration', danger: true,
            });
            if (!ok) return;
            const n = await this.app.call('deleteChunks', { dim: this.dim, coords: coordsOf(targets) });
            await this.app.refreshPending();
            toast(`${fmt(n)} chunk${n === 1 ? '' : 's'} marked to regenerate.`);
          },
        }, 'Regenerate'),
        del ? h('button', {
          onclick: async () => {
            const n = await this.app.call('restoreChunks', { dim: this.dim, coords: coordsOf(picked) });
            await this.app.refreshPending();
            toast(`Kept ${fmt(n)} chunk${n === 1 ? '' : 's'} as they were.`);
          },
        }, 'Undo regenerate') : null,
        h('button', { class: 'ghost', onclick: () => { this.sel = null; this.renderSide(); this.draw(); } }, 'Clear')));

    clear(this.side, head, selCard, clipCard, form, seedCard, help);

    if (singleChunk && picked.length === 1) {
      const detail = await this.app.call('chunkDetail', { dim: this.dim, x: b.x0, z: b.z0 });
      if (this.sel !== s) return;
      const subs = detail.keys.filter((k) => k.sub !== null).length;
      const card = h('div', { class: 'card' },
        h('h3', {}, 'Inside this chunk', detail.pasted ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'pasted') : null),
        h('p', { class: 'muted small-text', style: { marginTop: 0 } }, `${subs} vertical section${subs === 1 ? '' : 's'} of blocks. Click a record to read it.`),
        h('table', { class: 'chunk-keys' },
          detail.keys.filter((k) => k.sub === null).map((k) => h('tr', {},
            h('td', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); this.app.showRecord(k.key); } }, k.label)),
            h('td', { class: 'muted' }, formatBytes(k.size))))),
        detail.entities.length ? [
          h('h3', { style: { marginTop: '12px' } }, `Entities (${detail.entities.length})`),
          h('table', { class: 'chunk-keys' }, detail.entities.map((e) => h('tr', {},
            h('td', {}, h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); this.app.showRecord(e.key); } }, (e.identifier ?? 'unknown').replace(/^minecraft:/, ''))),
            h('td', { class: 'muted' }, formatBytes(e.size))))),
        ] : null);
      this.side.insertBefore(card, clipCard);
    }
  }

  coordForm() {
    // Filled in from the latest area of the selection.
    const s = this.sel?.parts.at(-1);
    const num = (v) => h('input', { type: 'number', value: v ?? '', step: 1 });
    const ix0 = num(s ? s.x0 * 16 : ''), ix1 = num(s ? s.x1 * 16 + 15 : ''), iz0 = num(s ? s.z0 * 16 : ''), iz1 = num(s ? s.z1 * 16 + 15 : '');
    const apply = (mode) => {
      const vals = [ix0, ix1, iz0, iz1].map((i) => i.value.trim());
      if (vals.some((v) => v === '' || Number.isNaN(Number(v)))) { toast('Please fill in all four block coordinates.', true); return; }
      const [a, b, c, d] = vals.map(Number);
      const typed = area(Math.floor(a / 16), Math.floor(c / 16), Math.floor(b / 16), Math.floor(d / 16), mode === 'remove');
      this.addToSelection(typed, mode);
      const bounds = this.sel ? selectionBounds(this.sel) : typed;
      const cx = (bounds.x0 + bounds.x1 + 1) / 2, cz = (bounds.z0 + bounds.z1 + 1) / 2;
      const span = Math.max(bounds.x1 - bounds.x0 + 1, bounds.z1 - bounds.z0 + 1);
      this.view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, 0.6 * Math.min(this.w, this.hgt) / span));
      this.centerOn(cx, cz);
      this.renderSide();
    };
    // Typed paste coordinates survive the panel being redrawn (it is, after every change).
    this.pasteTyped ??= { x: '', z: '' };
    const pasteX = h('input', { type: 'number', step: 1, placeholder: 'block X', value: this.pasteTyped.x, oninput: (e) => { this.pasteTyped.x = e.target.value; } });
    const pasteZ = h('input', { type: 'number', step: 1, placeholder: 'block Z', value: this.pasteTyped.z, oninput: (e) => { this.pasteTyped.z = e.target.value; } });
    const pasteTyped = () => {
      if (pasteX.value === '' || pasteZ.value === '') { toast('Enter the block X and Z for the corner.', true); return; }
      const x = Math.floor(Number(pasteX.value) / 16), z = Math.floor(Number(pasteZ.value) / 16);
      if (!this.pasting) this.pasting = { entities: true };
      this.centerOn(x, z);
      this.pasteAt(x, z);
    };
    return h('div', { class: 'card' },
      h('h3', {}, 'Select by block coordinates'),
      h('div', { class: 'coord-form' },
        h('span', {}, 'X'), ix0, ix1,
        h('span', {}, 'Z'), iz0, iz1),
      h('p', { class: 'muted small-text' }, 'Whole chunks are selected, so the edges snap outward to the nearest chunk border.'),
      h('div', { class: 'row' },
        h('button', { onclick: () => apply('new') }, 'Select area'),
        this.sel ? h('button', { onclick: () => apply('add'), title: 'Add this area to what is already selected' }, 'Add area') : null,
        this.sel ? h('button', { class: 'ghost', onclick: () => apply('remove'), title: 'Take this area out of the selection' }, 'Take out') : null),
      this.clip ? [
        h('h3', { style: { marginTop: '14px' } }, 'Paste at block coordinates'),
        h('div', { class: 'row' }, pasteX, pasteZ, h('button', { onclick: pasteTyped }, 'Paste')),
        h('p', { class: 'muted small-text', style: { marginBottom: 0 } }, 'The copy\'s top-left (north-west) corner goes in the chunk containing this block.'),
      ] : null);
  }
}
