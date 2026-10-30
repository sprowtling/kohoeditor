// Saying where an item is ("Chest at 72, 65, 72 › Shulker Box “Archive”"),
// with a button that goes there.

import { h, DIM_NAMES, nickname } from '../ui.js';

export function whereText(loc, app) {
  const inside = loc.path?.length ? ` › ${loc.path.join(' › ')}` : '';
  if (loc.kind === 'player') {
    const p = app.players.find((x) => x.key === loc.playerKey);
    return `${p ? nickname(p) : 'A player'}'s ${loc.list}${inside}`;
  }
  const pos = loc.pos?.every((n) => n != null) ? loc.pos.join(', ') : 'unknown place';
  const dim = loc.dim != null ? ` (${DIM_NAMES[loc.dim] ?? 'dim ' + loc.dim})` : '';
  return `${loc.container} ${loc.kind === 'entity' ? 'near' : 'at'} ${pos}${dim}${inside}`;
}

// A row describing one location, with a button to see it on the map or the player.
export function whereRow(loc, app, extra = null) {
  const go = loc.kind === 'player'
    ? h('button', { class: 'small', onclick: () => app.showPlayer(loc.playerKey) }, 'Player')
    : loc.dim != null && loc.pos?.every((n) => n != null)
      ? h('button', { class: 'small', onclick: () => app.showChunk(loc.dim, Math.floor(loc.pos[0] / 16), Math.floor(loc.pos[2] / 16)) }, 'Map')
      : null;
  return h('div', { class: 'change' }, extra, h('span', { class: 'what', title: whereText(loc, app) }, whereText(loc, app)), go);
}
