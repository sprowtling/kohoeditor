// Library: every written and writable book in the world, gathered from
// inventories, ender chests, chests, shulker boxes, lecterns, item frames and
// entities. Copies of the same book are grouped, with the original marked.

import { h, clear, toast, fmt, notes } from '../ui.js';
import { whereRow, whereText } from './where.js';
import { buildZip } from '../lib/zip.js';
import { crc32 } from '../lib/crc.js';
import { utf8 } from '../lib/bytes.js';

const GENERATION = ['Original', 'Copy of the original', 'Copy of a copy', 'Tattered'];

// Minecraft's § colour and style codes, as CSS.
const COLOURS = {
  0: '#000000', 1: '#0000AA', 2: '#00AA00', 3: '#00AAAA', 4: '#AA0000', 5: '#AA00AA', 6: '#FFAA00', 7: '#AAAAAA',
  8: '#555555', 9: '#5555FF', a: '#55FF55', b: '#55FFFF', c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF', g: '#DDD605',
};
const plain = (s) => String(s ?? '').replace(/§./g, '');

// A page with its § codes shown as colour, bold and italic.
function formatted(text) {
  const out = h('div', { class: 'page-text' });
  let span = h('span');
  out.append(span);
  const parts = String(text ?? '').split(/(§.)/);
  let style = {};
  for (const part of parts) {
    const m = /^§(.)$/.exec(part);
    if (!m) { span.append(part); continue; }
    const code = m[1].toLowerCase();
    if (COLOURS[code]) style = { color: COLOURS[code] };
    else if (code === 'l') style = { ...style, fontWeight: '700' };
    else if (code === 'o') style = { ...style, fontStyle: 'italic' };
    else if (code === 'n') style = { ...style, textDecoration: 'underline' };
    else if (code === 'm') style = { ...style, textDecoration: 'line-through' };
    else if (code === 'r') style = {};
    span = h('span', { style });
    out.append(span);
  }
  return out;
}

const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export class LibraryView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.query = '';
    this.kind = 'all';
    this.selected = null;
    this.page = 0;
    this.labels = notes.get('books') ?? {};
    this.list = h('div', { class: 'sidebar-list' });
    this.content = h('div', { class: 'content' });
    const search = h('input', { type: 'search', placeholder: 'Search titles, authors and text', oninput: (e) => { this.query = e.target.value.toLowerCase(); this.renderList(); } });
    const kind = h('select', { onchange: (e) => { this.kind = e.target.value; this.renderList(); } },
      h('option', { value: 'all' }, 'All books'), h('option', { value: 'written' }, 'Signed books'), h('option', { value: 'writable' }, 'Unsigned (book & quill)'), h('option', { value: 'noted' }, 'Books with notes'));
    clear(el,
      h('div', { class: 'sidebar' },
        h('div', { class: 'sidebar-head' }, search, h('div', { class: 'row' }, kind, h('button', { class: 'small', onclick: () => this.exportAll() }, 'Download all'))),
        this.list),
      this.content);
    clear(this.content, h('div', { class: 'empty' }, 'Open this tab to gather every book in the world.'));
  }

  async onShow() { if (!this.groups) await this.load(); }

  async onPendingChanged() { if (this.groups && !this.el.hidden) await this.load(); else this.groups = null; }

  async load() {
    const { books } = await this.app.call('items');
    // Group copies of the same book together.
    const groups = new Map();
    for (const b of books) {
      if (!groups.has(b.content)) groups.set(b.content, { id: b.content, kind: b.kind, title: b.title, author: b.author, pages: b.pages, copies: [] });
      groups.get(b.content).copies.push({ generation: b.generation, location: b.location });
    }
    for (const g of groups.values()) g.copies.sort((a, b) => (a.generation ?? 9) - (b.generation ?? 9));
    this.groups = [...groups.values()].sort((a, b) => (a.kind === 'writable') - (b.kind === 'writable') || plain(a.title ?? a.pages[0]).localeCompare(plain(b.title ?? b.pages[0])));
    this.renderList();
    this.renderBook();
  }

  name(g) { return plain(g.title) || (plain(g.pages[0]).split('\n')[0].slice(0, 40) || 'Untitled book'); }

  renderList() {
    if (!this.groups) return;
    const q = this.query;
    const shown = this.groups.filter((g) => {
      if (this.kind === 'noted') { if (!this.labels[g.id]) return false; } else if (this.kind !== 'all' && g.kind !== this.kind) return false;
      if (!q) return true;
      return `${g.title ?? ''} ${g.author ?? ''} ${g.pages.join(' ')} ${this.labels[g.id] ?? ''}`.toLowerCase().includes(q);
    });
    const copies = this.groups.reduce((n, g) => n + g.copies.length, 0);
    clear(this.list,
      h('div', { class: 'muted small-text', style: { padding: '8px 12px' } }, `${fmt(this.groups.length)} different books, ${fmt(copies)} copies in all${shown.length !== this.groups.length ? ` · ${fmt(shown.length)} shown` : ''}`),
      shown.map((g) => {
        const original = g.copies.find((c) => c.generation === 0);
        return h('button', { class: 'list-item' + (g.id === this.selected ? ' active' : ''), onclick: () => { this.selected = g.id; this.page = 0; this.renderList(); this.renderBook(); } },
          h('div', { class: 'title' }, h('span', {}, this.name(g)), g.kind === 'writable' ? h('span', { class: 'badge' }, 'unsigned') : null, g.copies.length > 1 ? h('span', { class: 'badge' }, `${g.copies.length} copies`) : null),
          h('div', { class: 'sub' }, g.author ? `by ${plain(g.author)}` : 'Book & quill', ` · ${g.pages.length} page${g.pages.length === 1 ? '' : 's'}`, original ? ' · original found' : ''));
      }));
  }

  renderBook() {
    const g = this.groups?.find((x) => x.id === this.selected);
    if (!g) {
      clear(this.content, this.groups && !this.groups.length
        ? h('div', { class: 'empty' }, 'No books were found in this world.')
        : h('div', { class: 'empty' }, 'Choose a book on the left to read it and see where every copy is.'));
      return;
    }
    const pages = g.pages.length ? g.pages : [''];
    this.page = Math.max(0, Math.min(this.page, pages.length - 1));
    const noteBox = h('textarea', { rows: 2, placeholder: 'Notes (only in this browser): which quest it belongs to, where it should go…', onchange: (e) => { const v = e.target.value.trim(); if (v) this.labels[g.id] = v; else delete this.labels[g.id]; notes.set('books', this.labels); } });
    noteBox.value = this.labels[g.id] ?? '';
    clear(this.content,
      h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('h2', {}, this.name(g)),
            h('div', { class: 'muted' }, g.author ? `by ${plain(g.author)}` : 'An unsigned book & quill', ` · ${pages.length} page${pages.length === 1 ? '' : 's'}`)),
          h('button', { onclick: () => download(new Blob([this.asText(g)], { type: 'text/plain' }), `${safeName(this.name(g))}.txt`) }, 'Download as text')),
        noteBox),
      h('div', { class: 'book' },
        h('div', { class: 'book-page' },
          h('div', { class: 'page-number muted small-text' }, `Page ${this.page + 1} of ${pages.length}`),
          formatted(pages[this.page])),
        h('div', { class: 'row book-nav' },
          h('button', { disabled: this.page === 0, onclick: () => { this.page--; this.renderBook(); } }, '‹ Previous'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'ghost small', onclick: () => { this.allPages = !this.allPages; this.renderBook(); } }, this.allPages ? 'Hide all pages' : 'Show all pages'),
          h('span', { class: 'spacer' }),
          h('button', { disabled: this.page >= pages.length - 1, onclick: () => { this.page++; this.renderBook(); } }, 'Next ›')),
        this.allPages ? h('div', { class: 'all-pages' }, pages.map((p, i) => h('div', { class: 'book-page' }, h('div', { class: 'page-number muted small-text' }, `Page ${i + 1}`), formatted(p)))) : null),
      h('div', { class: 'card' },
        h('h3', {}, g.copies.length === 1 ? 'Where it is' : `Where the ${g.copies.length} copies are`),
        g.copies.map((c) => whereRow(c.location, this.app,
          g.kind === 'written' ? h('span', { class: 'badge' + (c.generation === 0 ? ' ok' : '') }, GENERATION[c.generation] ?? `Copy (${c.generation})`) : null)),
        g.kind === 'written' && !g.copies.some((c) => c.generation === 0)
          ? h('p', { class: 'muted small-text', style: { marginBottom: 0 } }, 'The original isn\'t anywhere in this world (it may have been lost or thrown away); these are copies.') : null));
  }

  asText(g) {
    const head = [this.name(g), g.author ? `by ${plain(g.author)}` : 'Unsigned book & quill', ''];
    const body = g.pages.map((p, i) => `--- Page ${i + 1} ---\n${plain(p)}\n`);
    const where = ['', '--- Copies in the world ---', ...g.copies.map((c) => `${g.kind === 'written' ? (GENERATION[c.generation] ?? 'Copy') + ': ' : ''}${whereText(c.location, this.app)}`)];
    if (this.labels[g.id]) where.push('', `Notes: ${this.labels[g.id]}`);
    return [...head, ...body, ...where].join('\n') + '\n';
  }

  exportAll() {
    if (!this.groups?.length) { toast('There are no books to download yet.'); return; }
    const used = new Set();
    const entries = [];
    const index = ['title,author,pages,copies,original found,file'];
    const esc = (s) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
    for (const g of this.groups) {
      let name = safeName(`${this.name(g)}${g.author ? ' - ' + plain(g.author) : ''}`);
      while (used.has(name)) name += ' (2)';
      used.add(name);
      const bytes = utf8(this.asText(g));
      entries.push({ name: `${name}.txt`, method: 0, crc: crc32(bytes), compSize: bytes.length, size: bytes.length, data: bytes });
      index.push([this.name(g), plain(g.author ?? ''), g.pages.length, g.copies.length, g.copies.some((c) => c.generation === 0) ? 'yes' : 'no', `${name}.txt`].map(esc).join(','));
    }
    const idx = utf8(index.join('\n') + '\n');
    entries.unshift({ name: 'index.csv', method: 0, crc: crc32(idx), compSize: idx.length, size: idx.length, data: idx });
    download(new Blob(buildZip(entries), { type: 'application/zip' }), `${safeName(this.app.info.levelName || 'world')} library.zip`);
    toast(`Downloaded ${fmt(this.groups.length)} books.`);
  }
}
