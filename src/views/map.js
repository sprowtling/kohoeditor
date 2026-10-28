// Map: every chunk that exists in the world, seen from above. Select chunks
// and mark them for deletion so the game regenerates them from the seed.

import { h, clear, toast, confirmBox, fmt, formatBytes, DIM_NAMES, notes } from '../ui.js';

const TILE = 128; // chunks per tile edge; each chunk is one pixel in a tile
const MIN_SCALE = 0.05, MAX_SCALE = 48;

const FLAG_DELETED = 1, FLAG_ENTITIES = 2, FLAG_BLOCK_ENTITIES = 4;

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

export class MapView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.dim = 0;
    this.mode = 'size';
    this.tool = 'pan';
    this.sel = null; // { x0, z0, x1, z1 } in chunks, inclusive
    this.view = { cx: 0, cz: 0, scale: 4 };
    this.hover = null;
    this.canvas = h('canvas');
    this.status = h('div', { class: 'map-status' }, 'Move the mouse over the map');
    this.legend = h('div', { class: 'map-legend' });
    this.side = h('div', { class: 'map-side' });
    this.dimSeg = h('div', { class: 'seg' }, DIM_NAMES.map((n, d) => h('button', { onclick: () => this.setDim(d) }, n)));
    this.toolSeg = h('div', { class: 'seg' },
      h('button', { dataset: { tool: 'pan' }, onclick: () => this.setTool('pan'), title: 'Drag to move around (hold Shift to select instead)' }, 'Move'),
      h('button', { dataset: { tool: 'select' }, onclick: () => this.setTool('select'), title: 'Drag to select chunks' }, 'Select'));
    this.modeSelect = h('select', { onchange: (e) => { this.mode = e.target.value; this.buildTiles(); this.draw(); } },
      h('option', { value: 'size' }, 'Shade: amount of data'),
      h('option', { value: 'blockEntities' }, 'Highlight: chests, signs & other block entities'),
      h('option', { value: 'entities' }, 'Highlight: chunks with mobs or other entities'));
    clear(el,
      h('div', { class: 'map-wrap' },
        this.canvas,
        h('div', { class: 'map-toolbar' }, this.dimSeg, this.toolSeg, this.modeSelect,
          h('button', { onclick: () => this.fit() }, 'Fit world'),
          h('button', { onclick: () => this.centerOn(0, 0) }, 'Go to 0, 0')),
        this.status, this.legend),
      this.side);
    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement);
    this.setTool('pan');
    this.loaded = this.setDim(0, true);
  }

  async onShow(opts = {}) {
    await this.loaded;
    if (opts.dim !== undefined && opts.dim !== this.dim) await this.setDim(opts.dim, opts.x === undefined);
    if (opts.x !== undefined) {
      this.sel = { x0: opts.x, z0: opts.z, x1: opts.x, z1: opts.z };
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
    this.chunks = await this.app.call('chunkList', { dim: this.dim });
    this.index = new Map();
    let maxBytes = 1;
    for (let i = 0; i < this.chunks.length; i += 4) {
      this.index.set(this.chunks[i] + ',' + this.chunks[i + 1], i);
      if (this.chunks[i + 2] > maxBytes) maxBytes = this.chunks[i + 2];
    }
    this.maxBytes = maxBytes;
    this.buildTiles();
    this.draw();
    this.renderSide();
  }

  setTool(tool) {
    this.tool = tool;
    for (const b of this.toolSeg.children) b.classList.toggle('active', b.dataset.tool === tool);
    this.canvas.style.cursor = tool === 'select' ? 'crosshair' : 'grab';
  }

  // -------------------------------------------------------------------------
  // Drawing

  buildTiles() {
    this.tiles = new Map();
    const c = this.chunks;
    const danger = hexToRgb(cssVar('--danger') || '#b33a2b');
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
      if (!t) { t = { tx, tz, img: new ImageData(TILE, TILE), canvas: null }; this.tiles.set(key, t); }
      let rgb;
      if (flags & FLAG_DELETED) rgb = danger;
      else if (this.mode === 'blockEntities') rgb = flags & FLAG_BLOCK_ENTITIES ? [230, 150, 40] : [200, 205, 190];
      else if (this.mode === 'entities') rgb = flags & FLAG_ENTITIES ? [140, 90, 210] : [200, 205, 190];
      else rgb = rampColor(rank(bytes));
      const px = ((z - tz * TILE) * TILE + (x - tx * TILE)) * 4;
      t.img.data[px] = rgb[0]; t.img.data[px + 1] = rgb[1]; t.img.data[px + 2] = rgb[2]; t.img.data[px + 3] = 255;
    }
    for (const t of this.tiles.values()) {
      t.canvas = document.createElement('canvas');
      t.canvas.width = TILE; t.canvas.height = TILE;
      t.canvas.getContext('2d').putImageData(t.img, 0, 0);
      t.img = null;
    }
    this.renderLegend();
  }

  renderLegend() {
    const sw = (color, text) => h('div', {}, h('span', { class: 'legend-swatch', style: { background: color } }), text);
    const danger = cssVar('--danger') || '#b33a2b';
    if (this.mode === 'size') clear(this.legend, sw('rgb(214,230,190)', 'less data than most'), sw('rgb(28,60,40)', 'more data (often builds)'), sw(danger, 'will regenerate'));
    else if (this.mode === 'blockEntities') clear(this.legend, sw('rgb(230,150,40)', 'has block entities'), sw(danger, 'will regenerate'));
    else clear(this.legend, sw('rgb(140,90,210)', 'has entities'), sw(danger, 'will regenerate'));
  }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.w = r.width; this.hgt = r.height; this.dpr = dpr;
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

  drawNow() {
    const ctx = this.canvas.getContext('2d');
    const { scale } = this.view;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = cssVar('--panel-2');
    ctx.fillRect(0, 0, this.w, this.hgt);
    ctx.imageSmoothingEnabled = false;
    const [x0, z0] = this.toChunk(0, 0), [x1, z1] = this.toChunk(this.w, this.hgt);
    for (const t of this.tiles.values()) {
      const bx = t.tx * TILE, bz = t.tz * TILE;
      if (bx > x1 || bx + TILE < x0 || bz > z1 || bz + TILE < z0) continue;
      const [sx, sy] = this.toScreen(bx, bz);
      ctx.drawImage(t.canvas, sx, sy, TILE * scale, TILE * scale);
    }
    // Chunk grid when zoomed in, region grid (32 chunks) when zoomed out a bit.
    const step = scale >= 6 ? 1 : scale >= 0.5 ? 32 : 512;
    ctx.strokeStyle = cssVar('--line');
    ctx.globalAlpha = step === 1 ? 0.5 : 0.35;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = Math.floor(x0 / step) * step; gx <= x1; gx += step) { const [sx] = this.toScreen(gx, 0); ctx.moveTo(Math.round(sx) + 0.5, 0); ctx.lineTo(Math.round(sx) + 0.5, this.hgt); }
    for (let gz = Math.floor(z0 / step) * step; gz <= z1; gz += step) { const [, sy] = this.toScreen(0, gz); ctx.moveTo(0, Math.round(sy) + 0.5); ctx.lineTo(this.w, Math.round(sy) + 0.5); }
    ctx.stroke();
    ctx.globalAlpha = 1;
    // Origin
    const [ox, oy] = this.toScreen(0, 0);
    ctx.strokeStyle = cssVar('--muted');
    ctx.beginPath(); ctx.moveTo(ox - 8, oy); ctx.lineTo(ox + 8, oy); ctx.moveTo(ox, oy - 8); ctx.lineTo(ox, oy + 8); ctx.stroke();
    // Players
    ctx.font = '600 11px system-ui, sans-serif';
    for (const p of this.app.players) {
      const s = p.summary;
      if (!s || !s.pos || s.dim !== this.dim) continue;
      const [px, py] = this.toScreen(s.pos[0] / 16, s.pos[2] / 16);
      if (px < -20 || py < -20 || px > this.w + 20 || py > this.hgt + 20) continue;
      ctx.fillStyle = '#2a7de1';
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
      if (scale >= 1) {
        const nick = notes.get('nick:' + p.id) ?? (p.id === 'local' ? 'Local player' : p.id.slice(0, 8));
        ctx.fillStyle = cssVar('--text');
        ctx.fillText(nick, px + 8, py + 4);
      }
    }
    // Hover and selection
    if (this.hover && scale >= 2) {
      const [hx, hy] = this.toScreen(this.hover[0], this.hover[1]);
      ctx.strokeStyle = cssVar('--text');
      ctx.strokeRect(hx + 0.5, hy + 0.5, scale, scale);
    }
    const sel = this.dragSel ?? this.sel;
    if (sel) {
      const [sx, sy] = this.toScreen(sel.x0, sel.z0);
      const [ex, ey] = this.toScreen(sel.x1 + 1, sel.z1 + 1);
      ctx.fillStyle = 'rgba(42,125,225,0.15)';
      ctx.fillRect(sx, sy, ex - sx, ey - sy);
      ctx.strokeStyle = '#2a7de1';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx, sy, Math.max(ex - sx, 2), Math.max(ey - sy, 2));
      ctx.lineWidth = 1;
    }
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

  bindEvents() {
    const cv = this.canvas;
    let drag = null;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      const [sx, sy] = pos(e);
      const selecting = this.tool === 'select' || e.shiftKey;
      drag = { sx, sy, cx: this.view.cx, cz: this.view.cz, selecting, moved: false };
      if (!selecting) cv.style.cursor = 'grabbing';
    });
    cv.addEventListener('pointermove', (e) => {
      const [sx, sy] = pos(e);
      const [fx, fz] = this.toChunk(sx, sy);
      const x = Math.floor(fx), z = Math.floor(fz);
      if (!this.hover || this.hover[0] !== x || this.hover[1] !== z) {
        this.hover = [x, z];
        const i = this.index?.get(x + ',' + z);
        this.status.textContent = `Chunk ${x}, ${z} · blocks ${x * 16}…${x * 16 + 15}, ${z * 16}…${z * 16 + 15}` +
          (i !== undefined ? ` · ${formatBytes(this.chunks[i + 2])}${this.chunks[i + 3] & FLAG_DELETED ? ' · will regenerate' : ''}` : ' · not generated');
        this.draw();
      }
      if (!drag) return;
      if (Math.abs(sx - drag.sx) + Math.abs(sy - drag.sy) > 3) drag.moved = true;
      if (drag.selecting) {
        const [ax, az] = this.toChunk(drag.sx, drag.sy);
        this.dragSel = { x0: Math.floor(Math.min(ax, fx)), z0: Math.floor(Math.min(az, fz)), x1: Math.floor(Math.max(ax, fx)), z1: Math.floor(Math.max(az, fz)) };
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
        this.sel = { x0: x, z0: z, x1: x, z1: z };
        this.renderSide();
      } else if (drag.selecting && this.dragSel) {
        this.sel = this.dragSel;
        this.renderSide();
      }
      this.dragSel = null;
      drag = null;
      this.setTool(this.tool);
      this.draw();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
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
  // Side panel

  selectedChunks() {
    const s = this.sel;
    if (!s) return [];
    const out = [];
    const area = (s.x1 - s.x0 + 1) * (s.z1 - s.z0 + 1);
    if (area < this.chunks.length / 4) {
      for (let x = s.x0; x <= s.x1; x++) for (let z = s.z0; z <= s.z1; z++) {
        const i = this.index.get(x + ',' + z);
        if (i !== undefined) out.push(i);
      }
    } else {
      for (let i = 0; i < this.chunks.length; i += 4) {
        const x = this.chunks[i], z = this.chunks[i + 1];
        if (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1) out.push(i);
      }
    }
    return out;
  }

  async renderSide() {
    const total = this.chunks ? this.chunks.length / 4 : 0;
    let deletedTotal = 0;
    if (this.chunks) for (let i = 3; i < this.chunks.length; i += 4) if (this.chunks[i] & FLAG_DELETED) deletedTotal++;
    const s = this.sel;
    const head = h('div', { class: 'card' },
      h('h2', {}, DIM_NAMES[this.dim]),
      h('div', { class: 'muted' }, `${fmt(total)} chunks generated`, deletedTotal ? ` · ${fmt(deletedTotal)} marked to regenerate` : ''));

    const form = this.coordForm();
    const help = h('div', { class: 'card muted small-text' },
      h('p', { style: { marginTop: 0 } }, 'Drag to move, scroll to zoom. To select, use the Select tool or hold Shift while dragging. Click one chunk to look inside it.'),
      h('p', { style: { marginBottom: 0 } }, 'Deleted chunks regenerate from the world seed the next time a player comes near. Builds, chests, signs and mobs in them are removed.'));

    if (!s) { clear(this.side, head, form, help); return; }

    const picked = this.selectedChunks();
    const del = picked.filter((i) => this.chunks[i + 3] & FLAG_DELETED).length;
    const live = picked.length - del;
    const w = s.x1 - s.x0 + 1, d = s.z1 - s.z0 + 1;
    const coordsOf = (list) => list.map((i) => [this.chunks[i], this.chunks[i + 1]]);
    const selCard = h('div', { class: 'card' },
      h('h3', {}, w * d === 1 ? `Chunk ${s.x0}, ${s.z0}` : `Selection: ${fmt(w)} × ${fmt(d)} chunks`),
      h('table', { class: 'kv small-text' },
        h('tr', {}, h('td', {}, 'Blocks X'), h('td', { class: 'mono' }, `${s.x0 * 16} to ${s.x1 * 16 + 15}`)),
        h('tr', {}, h('td', {}, 'Blocks Z'), h('td', { class: 'mono' }, `${s.z0 * 16} to ${s.z1 * 16 + 15}`)),
        h('tr', {}, h('td', {}, 'Generated'), h('td', {}, `${fmt(picked.length)} of ${fmt(w * d)}`)),
        del ? h('tr', {}, h('td', {}, 'To regenerate'), h('td', {}, fmt(del))) : null),
      h('div', { class: 'row', style: { marginTop: '10px' } },
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
        }, 'Regenerate these chunks'),
        del ? h('button', {
          onclick: async () => {
            const n = await this.app.call('restoreChunks', { dim: this.dim, coords: coordsOf(picked) });
            await this.app.refreshPending();
            toast(`Kept ${fmt(n)} chunk${n === 1 ? '' : 's'} as they were.`);
          },
        }, 'Undo') : null,
        h('button', { class: 'ghost', onclick: () => { this.sel = null; this.renderSide(); this.draw(); } }, 'Clear')));

    clear(this.side, head, selCard, form, help);

    if (w * d === 1 && picked.length === 1) {
      const detail = await this.app.call('chunkDetail', { dim: this.dim, x: s.x0, z: s.z0 });
      if (this.sel !== s) return;
      const subs = detail.keys.filter((k) => k.sub !== null).length;
      const card = h('div', { class: 'card' },
        h('h3', {}, 'Inside this chunk'),
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
      this.side.insertBefore(card, form);
    }
  }

  coordForm() {
    const s = this.sel;
    const num = (v) => h('input', { type: 'number', value: v ?? '', step: 1 });
    const ix0 = num(s ? s.x0 * 16 : ''), ix1 = num(s ? s.x1 * 16 + 15 : ''), iz0 = num(s ? s.z0 * 16 : ''), iz1 = num(s ? s.z1 * 16 + 15 : '');
    const apply = () => {
      const vals = [ix0, ix1, iz0, iz1].map((i) => i.value.trim());
      if (vals.some((v) => v === '' || Number.isNaN(Number(v)))) { toast('Please fill in all four block coordinates.', true); return; }
      const [a, b, c, d] = vals.map(Number);
      this.sel = { x0: Math.floor(Math.min(a, b) / 16), x1: Math.floor(Math.max(a, b) / 16), z0: Math.floor(Math.min(c, d) / 16), z1: Math.floor(Math.max(c, d) / 16) };
      const cx = (this.sel.x0 + this.sel.x1 + 1) / 2, cz = (this.sel.z0 + this.sel.z1 + 1) / 2;
      const span = Math.max(this.sel.x1 - this.sel.x0 + 1, this.sel.z1 - this.sel.z0 + 1);
      this.view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, 0.6 * Math.min(this.w, this.hgt) / span));
      this.centerOn(cx, cz);
      this.renderSide();
    };
    return h('div', { class: 'card' },
      h('h3', {}, 'Select by block coordinates'),
      h('div', { class: 'coord-form' },
        h('span', {}, 'X'), ix0, ix1,
        h('span', {}, 'Z'), iz0, iz1),
      h('p', { class: 'muted small-text' }, 'Whole chunks are selected, so the edges snap outward to the nearest chunk border.'),
      h('button', { onclick: apply }, 'Select area'));
  }
}
