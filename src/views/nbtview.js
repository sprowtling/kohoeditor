// A collapsible tree for NBT, with in-place editing of single values.

import { h } from '../ui.js';

const T = { Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6, ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12 };
const TYPE = ['end', 'byte', 'short', 'int', 'long', 'float', 'double', 'byte[]', 'string', 'list', 'compound', 'int[]', 'long[]'];
const PAGE = 200;

function scalarText(tag) {
  if (tag.t === T.String) return JSON.stringify(tag.v);
  if (tag.t === T.Float || tag.t === T.Double) return Number.isInteger(tag.v) ? tag.v.toFixed(1) : String(tag.v);
  return String(tag.v);
}

function arrayText(v) {
  const head = Array.from(v.slice(0, 16), String).join(', ');
  return `[${head}${v.length > 16 ? ', …' : ''}]`;
}

// opts: { editable, onEdit(ops) -> Promise, open: depth to expand initially,
//         expanded: a Map kept by the caller so open/closed parts survive re-rendering }
export function nbtTree(roots, opts = {}) {
  const ul = h('ul');
  roots.forEach((tag, i) => ul.append(node(tag, [i], 0, opts, roots.length > 1 ? `#${i}` : null)));
  return h('div', { class: 'nbt' }, ul);
}

function node(tag, path, depth, opts, labelOverride) {
  const name = labelOverride ?? tag.n;
  const nameEl = name != null && name !== '' ? h('span', { class: 'name' }, name) : h('span', { class: 'name muted' }, name === '' ? '(root)' : '');
  const isContainer = tag.t === T.Compound || tag.t === T.List;
  const li = h('li');
  const line = h('span', { class: 'line' });
  li.append(line);
  const del = opts.editable && path.length > 1
    ? h('button', { class: 'del', title: 'Delete this entry', onclick: () => opts.onEdit([{ path, action: 'delete' }], `Delete “${name ?? 'this entry'}”?`) }, 'delete')
    : null;

  if (isContainer) {
    const n = tag.v.length;
    const kind = tag.t === T.Compound ? `{${n} ${n === 1 ? 'entry' : 'entries'}}` : n ? `[${n} × ${TYPE[tag.v[0].t]}]` : '[empty list]';
    const tog = h('span', { class: 'tog' }, '▸');
    const childList = h('ul');
    let built = false, open = false;
    const build = () => {
      built = true;
      let shown = 0;
      const more = () => {
        const end = Math.min(n, shown + PAGE);
        for (let i = shown; i < end; i++) {
          const c = tag.v[i];
          childList.append(node(c, [...path, i], depth + 1, opts, tag.t === T.List ? String(i) : null));
        }
        shown = end;
        if (shown < n) {
          const btn = h('li', {}, h('button', { class: 'small', onclick: () => { btn.remove(); more(); } }, `Show ${Math.min(PAGE, n - shown)} more of ${n - shown}`));
          childList.append(btn);
        }
      };
      more();
    };
    const pathKey = path.join('.');
    const setOpen = (v) => {
      open = v;
      opts.expanded?.set(pathKey, v);
      if (open && !built) build();
      childList.hidden = !open;
      tog.textContent = open ? '▾' : '▸';
    };
    tog.addEventListener('click', () => setOpen(!open));
    nameEl.style.cursor = 'pointer';
    nameEl.addEventListener('click', () => setOpen(!open));
    line.append(tog, nameEl, h('span', { class: 'summary' }, ' ', kind), del ?? '');
    li.append(childList);
    setOpen(opts.expanded?.has(pathKey) ? opts.expanded.get(pathKey) : depth < (opts.open ?? 1) && n <= PAGE);
    return li;
  }

  line.append(h('span', { class: 'tog' }), nameEl, h('span', { class: 'type' }, TYPE[tag.t]));
  if (tag.t === T.ByteArray || tag.t === T.IntArray || tag.t === T.LongArray) {
    line.append(h('span', { class: 'summary' }, `${tag.v.length} values ${arrayText(tag.v)}`));
  } else {
    const text = scalarText(tag);
    const val = h('span', { class: 'val' + (tag.t === T.String ? ' str' : ''), title: text.length > 80 ? text : opts.editable ? 'Click to edit' : '' }, text.length > 80 ? text.slice(0, 80) + '…' : text);
    if (opts.editable) {
      val.addEventListener('click', () => {
        const input = h('input', { type: 'text', value: tag.t === T.String ? tag.v : String(tag.v) });
        const done = async (save) => {
          if (!input.isConnected) return;
          if (save && input.value !== (tag.t === T.String ? tag.v : String(tag.v))) {
            const ok = await opts.onEdit([{ path, action: 'set', value: input.value }]);
            if (ok === false) { input.focus(); return; }
          } else input.replaceWith(val);
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') done(true);
          if (e.key === 'Escape') input.replaceWith(val);
        });
        input.addEventListener('blur', () => { if (input.isConnected) input.replaceWith(val); });
        val.replaceWith(input);
        input.focus();
        input.select();
      });
    }
    line.append(val);
  }
  if (del) line.append(del);
  return li;
}
