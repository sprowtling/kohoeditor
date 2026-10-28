// World: general facts and the level.dat settings.

import { h, clear, fmt, formatBytes } from '../ui.js';
import { nbtTree } from './nbtview.js';

export class WorldView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.content = h('div', { class: 'content' });
    clear(el, this.content);
    this.render();
  }

  async render() {
    const info = this.app.info;
    const stats = this.app.stats;
    const levelDat = await this.app.call('levelDat');
    const row = (k, v) => (v == null ? null : h('tr', {}, h('td', {}, k), h('td', {}, v)));
    clear(this.content,
      h('div', { class: 'card' },
        h('h2', {}, info.levelName ?? 'World'),
        h('table', { class: 'kv' },
          row('Seed', info.seed && h('span', { class: 'mono' }, info.seed)),
          row('World spawn', info.spawn && info.spawn.join(', ')),
          row('Last opened with', info.version && `Minecraft ${info.version}`),
          row('Last played', info.lastPlayed && new Date(info.lastPlayed).toLocaleString()),
          row('Chunks', `${fmt(stats.chunks[0])} Overworld · ${fmt(stats.chunks[1] ?? 0)} Nether · ${fmt(stats.chunks[2] ?? 0)} End`),
          row('Separately stored entities', fmt(stats.actors)),
          row('Database records', fmt(stats.keys)),
          row('Database size', `${formatBytes(info.tableBytes)} in ${fmt(info.tableCount)} table files`),
          info.pendingFromLog ? row('Recent writes', `${fmt(info.pendingFromLog)} records still in the write log (normal when a world was not fully closed)`) : null)),
      levelDat ? h('div', { class: 'card' },
        h('h2', {}, 'level.dat'),
        h('p', { class: 'muted small-text' }, 'World settings and game rules. Read only for now.'),
        nbtTree([levelDat], { editable: false, open: 1 })) : h('div', { class: 'card muted' }, info.levelDatError ? `level.dat could not be read: ${info.levelDatError}` : 'This world has no level.dat.'));
  }
}
