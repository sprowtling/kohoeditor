// World: general facts, and the level.dat settings (game rules, spawn, name...).

import { h, clear, fmt, formatBytes, toast, confirmBox } from '../ui.js';
import { nbtTree } from './nbtview.js';

export class WorldView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.content = h('div', { class: 'content' });
    this.expanded = new Map();
    clear(el, this.content);
    this.render();
  }

  onShow() { this.render(); }
  onPendingChanged() { if (!this.el.hidden) this.render(); }

  async render() {
    const info = this.app.info;
    const stats = this.app.stats;
    const { tag, edited } = await this.app.call('levelDat');
    const row = (k, v) => (v == null ? null : h('tr', {}, h('td', {}, k), h('td', {}, v)));
    const onEdit = async (ops, question) => {
      if (question && !(await confirmBox({ title: question, body: 'Nothing changes until you save the world.', ok: 'Delete', danger: true }))) return false;
      try {
        await this.app.call('editLevelDat', { ops });
        await this.app.refreshPending();
        this.render();
        return true;
      } catch (e) {
        toast(e.message, true);
        return false;
      }
    };
    const scroll = this.content.scrollTop;
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
      tag ? h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('h2', { style: { margin: 0, flex: 1 } }, 'World settings (level.dat)'),
          edited ? h('span', { class: 'badge warn' }, 'edited') : null),
        h('p', { class: 'muted small-text' }, 'Game rules, difficulty, spawn point, world name and more. Click a value to change it; game rules are the ones with names like ', h('span', { class: 'mono' }, 'keepinventory'), ' (1 = on, 0 = off). Changing ', h('span', { class: 'mono' }, 'LevelName'), ' renames the world.'),
        nbtTree([tag], { editable: true, onEdit, open: 1, expanded: this.expanded })) : h('div', { class: 'card muted' }, info.levelDatError ? `level.dat could not be read: ${info.levelDatError}` : 'This world has no level.dat.'));
    this.content.scrollTop = scroll;
  }
}
