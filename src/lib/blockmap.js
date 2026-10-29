// The top-down block map: what a chunk looks like from above, coloured like
// an in-game map.
//
// Blocks are stored in 16×16×16 "subchunks". Since 2018 (Bedrock 1.2.13)
// each one holds a palette of block types (as NBT) and, for every block, an
// index into that palette. Older subchunks store a numeric block id and a
// data value per block instead. Both are read here.
//
// The result for a chunk is an 8×8 grid (each cell is 2×2 blocks, showing the
// tallest of the four so builds stand out): 64 colours (r, g, b) then 64
// heights (uint16, y + 64), 320 bytes in all.

import { Reader } from './bytes.js';
import { readTag, T } from './nbt.js';

export const CELL = 8;
export const RESULT_BYTES = CELL * CELL * 5;

// ---------------------------------------------------------------------------
// Colours

const DYE = {
  white: [255, 255, 255], orange: [216, 127, 51], magenta: [178, 76, 216], light_blue: [102, 153, 216],
  yellow: [229, 229, 51], lime: [127, 204, 25], pink: [242, 127, 165], gray: [76, 76, 76],
  light_gray: [153, 153, 153], silver: [153, 153, 153], cyan: [76, 127, 153], purple: [127, 63, 178],
  blue: [51, 76, 178], brown: [102, 76, 51], green: [102, 127, 51], red: [153, 51, 51], black: [25, 25, 25],
};
const DYE_ORDER = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const TERRACOTTA = {
  white: [209, 177, 161], orange: [159, 82, 36], magenta: [149, 87, 108], light_blue: [112, 108, 138],
  yellow: [186, 133, 36], lime: [103, 117, 53], pink: [160, 77, 78], gray: [57, 41, 35],
  light_gray: [135, 107, 98], silver: [135, 107, 98], cyan: [87, 92, 92], purple: [122, 73, 88],
  blue: [76, 62, 92], brown: [76, 50, 35], green: [76, 82, 42], red: [142, 60, 46], black: [37, 22, 16],
};
const WOOD = {
  oak: [143, 119, 72], spruce: [129, 86, 49], birch: [215, 203, 141], jungle: [151, 109, 77],
  acacia: [186, 99, 50], dark_oak: [102, 76, 51], mangrove: [126, 52, 50], cherry: [226, 178, 172],
  bamboo: [215, 197, 98], crimson: [148, 63, 97], warped: [58, 142, 140], pale_oak: [228, 220, 215],
};
const WOOD_ORDER = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak'];

const C = {
  stone: [112, 112, 112], deepslate: [92, 92, 96], grass: [127, 178, 56], dirt: [151, 109, 77],
  sand: [219, 207, 163], red_sand: [190, 102, 33], gravel: [130, 124, 122], water: [64, 64, 255],
  lava: [255, 90, 0], snow: [250, 250, 250], ice: [160, 160, 255], plant: [0, 124, 0], leaves: [40, 110, 30],
  clay: [164, 168, 184], netherrack: [112, 2, 0], end_stone: [219, 222, 158], obsidian: [20, 18, 30],
  quartz: [236, 230, 223], gold: [250, 238, 77], diamond: [92, 219, 213], emerald: [0, 217, 58],
  lapis: [74, 128, 255], iron: [200, 200, 200], copper: [192, 107, 79], oxidized_copper: [82, 162, 132],
  prismarine: [76, 127, 153], glass: [200, 220, 230], podzol: [129, 86, 49], mycelium: [127, 63, 178],
  soul: [102, 76, 51], basalt: [70, 70, 75], blackstone: [40, 34, 38], brick: [150, 74, 58],
  nether_brick: [60, 25, 30], terracotta: [152, 94, 67], purpur: [169, 125, 169], hay: [210, 180, 40],
  pumpkin: [216, 127, 51], melon: [127, 204, 25], mushroom_red: [180, 40, 40], mushroom_brown: [140, 105, 80],
  sandstone: [216, 203, 155], red_sandstone: [180, 98, 40], mud: [60, 57, 60], moss: [89, 109, 45],
  tuff: [108, 109, 102], calcite: [223, 224, 220], amethyst: [133, 97, 191], sculk: [12, 30, 36],
  bedrock: [60, 60, 60], cobblestone: [120, 120, 120], path: [148, 121, 65], farmland: [110, 75, 45],
  coal: [25, 25, 25], redstone: [170, 20, 10], glowstone: [220, 180, 90], sea_lantern: [190, 215, 220],
  bookshelf: [120, 90, 55], tnt: [200, 40, 40], cactus: [80, 125, 40], kelp: [40, 110, 60],
  honey: [240, 170, 40], slime: [110, 190, 90], bone: [225, 220, 200], unknown: [128, 128, 128],
};

// Blocks you can see through from above (or too small to show on a map).
const SEE_THROUGH = /(^|_)(air|light_block|structure_void|barrier|torch|button|lever|rail|redstone_wire|tripwire|string|sign|banner|frame|skull|head|candle|ladder|fire|pressure_plate|flower_pot|end_rod|lightning_rod|chain|scaffolding|cobweb|web|bubble_column|moving_block|piston_arm|redstone_torch|soul_torch|unlit_redstone_torch|powered_repeater|unpowered_repeater|powered_comparator|unpowered_comparator|repeater|comparator|daylight_detector|hopper|bell|lantern|soul_lantern|campfire|tripwire_hook|structure_block|portal)$/;

function stateText(states, ...names) {
  if (!states) return null;
  for (const n of names) {
    const c = states.find((s) => s.n === n);
    if (c && typeof c.v === 'string') return c.v;
  }
  return null;
}

const colorCache = new Map();

// name: 'minecraft:oak_planks'; states: an NBT compound's children, or null.
// Returns { skip, water, rgb }.
export function blockStyle(name, states = null) {
  if (typeof name !== 'string') name = '';
  if (!Array.isArray(states)) states = null;
  const key = states ? name + JSON.stringify(states.map((s) => [s.n, String(s.v)])) : name;
  let s = colorCache.get(key);
  if (!s) { s = computeStyle(name, states); colorCache.set(key, s); }
  return s;
}

function computeStyle(fullName, states) {
  const n = fullName.replace(/^minecraft:/, '');
  if (SEE_THROUGH.test(n) || n === 'air' || n === 'cave_air' || n === 'void_air' || n === '') return { skip: true };
  if (n === 'water' || n === 'flowing_water') return { water: true, rgb: C.water };
  const rgb = colorFor(n, states);
  return { rgb };
}

function colorFor(n, states) {
  // Old names keep the variant in a block state.
  const color = stateText(states, 'color');
  if (color && /^(wool|carpet|concrete|concrete_powder|stained_glass|stained_glass_pane|shulker_box)$/.test(n)) return DYE[color] ?? C.unknown;
  if (color && /stained_hardened_clay|terracotta/.test(n)) return TERRACOTTA[color] ?? C.terracotta;
  const wood = stateText(states, 'wood_type', 'old_log_type', 'new_log_type', 'old_leaf_type', 'new_leaf_type');
  if (wood && /^(planks|log|log2|wood|wooden_slab|double_wooden_slab|fence|leaves|leaves2)$/.test(n)) {
    if (/leaves/.test(n)) return C.leaves;
    return WOOD[wood] ?? C.unknown;
  }
  if (n === 'sand' && stateText(states, 'sand_type') === 'red') return C.red_sand;
  if (n === 'stone') {
    const t = stateText(states, 'stone_type');
    if (t && /granite/.test(t)) return [154, 106, 89];
    if (t && /diorite/.test(t)) return [188, 188, 188];
    if (t && /andesite/.test(t)) return [136, 136, 136];
  }

  // Coloured blocks by name: white_wool, red_concrete, blue_terracotta...
  for (const dye of Object.keys(DYE)) {
    if (n.startsWith(dye + '_')) {
      if (/terracotta|glazed/.test(n)) return TERRACOTTA[dye];
      if (/wool|carpet|concrete|glass|shulker|bed|candle|banner/.test(n)) return DYE[dye];
    }
  }
  if (/glazed_terracotta/.test(n)) return C.terracotta;
  for (const wood of Object.keys(WOOD)) {
    if (n.startsWith(wood + '_') || n.startsWith('stripped_' + wood + '_')) {
      if (/leaves/.test(n)) return wood === 'cherry' ? [230, 160, 190] : wood === 'pale_oak' ? [200, 205, 195] : C.leaves;
      if (/sapling|propagule/.test(n)) return C.plant;
      return WOOD[wood];
    }
  }
  const rules = [
    [/^grass_block$|^grass$/, C.grass], [/short_grass|tall_grass|tallgrass|fern|seagrass|vine|lily|sapling|flower|tulip|orchid|allium|azure|oxeye|cornflower|dandelion|poppy|daisy|bush|sugar|reeds|bamboo$|wheat|carrots|potatoes|beetroot|crop|sweet_berry|dripleaf|spore|azalea|moss_carpet|hanging_roots|glow_lichen|cave_vines/, C.plant],
    [/leaves/, C.leaves], [/kelp/, C.kelp], [/cactus/, C.cactus],
    [/^snow|powder_snow/, C.snow], [/blue_ice|packed_ice|^ice$|frosted_ice/, C.ice],
    [/lava/, C.lava], [/^dirt|coarse_dirt|rooted_dirt/, C.dirt], [/podzol/, C.podzol], [/mycelium/, C.mycelium],
    [/grass_path|dirt_path/, C.path], [/farmland/, C.farmland], [/mud_brick|packed_mud/, [140, 106, 79]], [/^mud$/, C.mud],
    [/red_sandstone/, C.red_sandstone], [/sandstone/, C.sandstone], [/^red_sand$/, C.red_sand], [/^sand$|suspicious_sand/, C.sand],
    [/gravel/, C.gravel], [/^clay$/, C.clay],
    [/deepslate/, C.deepslate], [/cobblestone|cobbled/, C.cobblestone], [/stone_?brick|stonebrick/, C.stone],
    [/blackstone/, C.blackstone], [/basalt/, C.basalt], [/nether_brick|red_nether/, C.nether_brick], [/netherrack|nylium|nether_wart_block|wart/, C.netherrack],
    [/soul_s/, C.soul], [/end_stone|end_brick/, C.end_stone], [/purpur/, C.purpur], [/obsidian|crying/, C.obsidian],
    [/quartz/, C.quartz], [/gold_block|^gold/, C.gold], [/diamond_block/, C.diamond], [/emerald_block/, C.emerald], [/lapis_block/, C.lapis],
    [/iron_block|iron_bars|iron_door|anvil|cauldron/, C.iron], [/oxidized|weathered/, C.oxidized_copper], [/copper/, C.copper],
    [/prismarine/, C.prismarine], [/sea_lantern/, C.sea_lantern], [/glowstone|shroomlight|froglight/, C.glowstone],
    [/glass/, C.glass], [/brick/, C.brick], [/terracotta|hardened_clay/, C.terracotta],
    [/hay/, C.hay], [/pumpkin|jack_o_lantern|carved/, C.pumpkin], [/melon/, C.melon],
    [/red_mushroom_block/, C.mushroom_red], [/brown_mushroom_block|mushroom_stem/, C.mushroom_brown], [/mushroom/, C.plant],
    [/moss/, C.moss], [/tuff/, C.tuff], [/calcite|dripstone/, C.calcite], [/amethyst/, C.amethyst], [/sculk/, C.sculk],
    [/bedrock/, C.bedrock], [/coal_block/, C.coal], [/redstone_block|redstone_lamp/, C.redstone], [/bookshelf/, C.bookshelf],
    [/tnt/, C.tnt], [/honey/, C.honey], [/slime/, C.slime], [/bone_block/, C.bone],
    [/chest|barrel|crafting|loom|lectern|composter|beehive|bee_nest|note|jukebox|smithing|fletching|cartography/, WOOD.oak],
    [/furnace|smoker|dispenser|dropper|observer|piston|grindstone|stonecutter/, C.stone],
    [/ore$|stone|andesite|diorite|granite|smooth_stone|polished/, C.stone],
    [/log|wood|planks|fence|door|trapdoor|stairs|slab/, WOOD.oak],
  ];
  for (const [re, rgb] of rules) if (re.test(n)) return rgb;
  return C.unknown;
}

// Pre-2018 subchunks: numeric block ids and data values.
function legacyStyle(id, data) {
  const key = id * 16 + data;
  let s = legacyCache[key];
  if (s) return s;
  s = computeLegacy(id, data);
  legacyCache[key] = s;
  return s;
}
const legacyCache = new Array(4096);
const SKIP = { skip: true };
const LEGACY_SKIP = new Set([0, 6, 27, 28, 30, 31, 32, 37, 38, 39, 40, 50, 51, 55, 59, 63, 65, 66, 68, 69, 70, 72, 75, 76, 77, 83, 90, 93, 94, 95, 104, 105, 106, 111, 115, 126, 131, 132, 141, 142, 143, 147, 148, 149, 150, 175, 199, 217, 239]);
function computeLegacy(id, data) {
  if (id === 8 || id === 9) return { water: true, rgb: C.water };
  if (LEGACY_SKIP.has(id)) return id === 111 || id === 31 || id === 37 || id === 38 || id === 175 ? { rgb: C.plant } : SKIP;
  const dye = DYE[DYE_ORDER[data & 15]];
  const wood = WOOD[WOOD_ORDER[data & 7]] ?? WOOD.oak;
  const table = {
    1: C.stone, 2: C.grass, 3: C.dirt, 4: C.cobblestone, 5: wood, 7: C.bedrock, 10: C.lava, 11: C.lava,
    12: data === 1 ? C.red_sand : C.sand, 13: C.gravel, 14: C.stone, 15: C.stone, 16: C.stone,
    17: WOOD[WOOD_ORDER[data & 3]], 18: C.leaves, 19: C.hay, 20: C.glass, 21: C.stone, 22: C.lapis, 24: C.sandstone,
    35: dye, 41: C.gold, 42: C.iron, 43: C.stone, 44: C.stone, 45: C.brick, 46: C.tnt, 47: C.bookshelf, 48: C.cobblestone,
    49: C.obsidian, 53: WOOD.oak, 54: WOOD.oak, 56: C.stone, 57: C.diamond, 58: WOOD.oak, 60: C.farmland, 61: C.stone, 62: C.stone,
    67: C.cobblestone, 73: C.stone, 74: C.stone, 78: C.snow, 79: C.ice, 80: C.snow, 81: C.cactus, 82: C.clay, 85: WOOD.oak,
    86: C.pumpkin, 87: C.netherrack, 88: C.soul, 89: C.glowstone, 91: C.pumpkin, 96: WOOD.oak, 97: C.stone, 98: C.stone,
    99: C.mushroom_brown, 100: C.mushroom_red, 101: C.iron, 102: C.glass, 103: C.melon, 107: WOOD.oak, 108: C.brick, 109: C.stone,
    110: C.mycelium, 112: C.nether_brick, 113: C.nether_brick, 114: C.nether_brick, 121: C.end_stone, 125: C.stone, 128: C.sandstone,
    129: C.stone, 133: C.emerald, 134: WOOD.spruce, 135: WOOD.birch, 136: WOOD.jungle, 139: C.cobblestone, 152: C.redstone,
    153: C.netherrack, 155: C.quartz, 156: C.quartz, 157: wood, 158: wood, 159: TERRACOTTA[DYE_ORDER[data & 15]], 160: dye,
    161: C.leaves, 162: data & 1 ? WOOD.dark_oak : WOOD.acacia, 163: WOOD.acacia, 164: WOOD.dark_oak, 168: C.prismarine,
    169: C.sea_lantern, 170: C.hay, 171: dye, 172: C.terracotta, 173: C.coal, 174: C.ice, 179: C.red_sandstone, 180: C.red_sandstone,
    198: C.path, 201: C.purpur, 206: C.end_stone, 213: C.netherrack, 214: C.nether_brick, 215: C.nether_brick, 216: C.bone,
    236: dye, 237: dye, 241: dye, 243: C.podzol, 266: C.ice,
  };
  return { rgb: table[id] ?? C.unknown };
}

// ---------------------------------------------------------------------------
// Reading subchunks

// Returns a function (x, y, z) -> style for one subchunk, or null if it can't be read.
export function readSubchunk(v) {
  if (!v || v.length < 2) return null;
  const version = v[0];
  if (version === 1 || version === 8 || version === 9) {
    let p = 1;
    if (version !== 1) { p = version === 9 ? 3 : 2; if (v[1] === 0) return () => SKIP; }
    return readStorage(v, p);
  }
  if (version <= 7 && v.length >= 1 + 4096 + 2048) {
    // Old format: 4096 block ids, then 2048 bytes of 4-bit data values, in x, z, y order.
    return (x, y, z) => {
      const i = (x << 8) | (z << 4) | y;
      const id = v[1 + i];
      if (id === 0) return SKIP;
      const d = v[1 + 4096 + (i >> 1)];
      return legacyStyle(id, i & 1 ? d >> 4 : d & 15);
    };
  }
  return null;
}

function readStorage(v, p) {
  const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
  const header = v[p++];
  const bits = header >> 1;
  let wordsAt = p, perWord = 0, mask = 0, count;
  if (bits === 0) {
    count = 1;
  } else {
    perWord = Math.floor(32 / bits);
    mask = (1 << bits) - 1;
    p += Math.ceil(4096 / perWord) * 4;
    if (p + 4 > v.length) return null;
    count = dv.getInt32(p, true);
    p += 4;
  }
  if (count < 1 || count > 4096) return null;
  const styles = new Array(count);
  const r = new Reader(v, p);
  for (let i = 0; i < count; i++) {
    let tag;
    try { tag = readTag(r); } catch { return null; }
    if (!tag || tag.t !== T.Compound) return null;
    const name = tag.v.find((c) => c.n === 'name')?.v ?? '';
    const statesTag = tag.v.find((c) => c.n === 'states');
    const states = statesTag && statesTag.t === T.Compound ? statesTag.v : null;
    let style = blockStyle(name, states);
    // 2018-2020 palettes give a data value ("val") instead of block states.
    const valTag = tag.v.find((c) => c.n === 'val');
    if (!states && valTag && name) {
      const legacyNamed = /^minecraft:(wool|carpet|concrete|concrete_powder|stained_glass|stained_glass_pane|stained_hardened_clay|planks|log|log2|wooden_slab|double_wooden_slab|sand)$/.exec(name);
      if (legacyNamed) {
        const d = valTag.v & 15;
        const kind = legacyNamed[1];
        const st = kind === 'sand' ? [{ n: 'sand_type', v: d === 1 ? 'red' : 'normal' }]
          : /planks|slab/.test(kind) ? [{ n: 'wood_type', v: WOOD_ORDER[d & 7] }]
            : kind === 'log' ? [{ n: 'old_log_type', v: WOOD_ORDER[d & 3] }]
              : kind === 'log2' ? [{ n: 'new_log_type', v: d & 1 ? 'dark_oak' : 'acacia' }]
                : [{ n: 'color', v: DYE_ORDER[d] }];
        style = blockStyle(name, st);
      }
    }
    styles[i] = style;
  }
  if (bits === 0) { const s = styles[0]; return () => s; }
  return (x, y, z) => {
    const u = (x << 8) | (z << 4) | y;
    const word = dv.getUint32(wordsAt + Math.floor(u / perWord) * 4, true);
    return styles[(word >>> ((u % perWord) * bits)) & mask] ?? SKIP;
  };
}

// ---------------------------------------------------------------------------
// One chunk from above

// subs: subchunk indices present, any order. getSub(index) -> bytes or null.
// Returns RESULT_BYTES bytes, or null if nothing could be read.
export function renderChunk(subs, getSub) {
  const order = [...subs].sort((a, b) => b - a);
  const colors = new Uint8Array(256 * 3);
  const heights = new Int16Array(256).fill(-32768);
  const waterTop = new Int16Array(256).fill(-32768);
  let unresolved = 256, any = false;
  const done = new Uint8Array(256);
  for (const sub of order) {
    if (!unresolved) break;
    const at = readSubchunk(getSub(sub));
    if (!at) continue;
    any = true;
    for (let col = 0; col < 256; col++) {
      if (done[col]) continue;
      const x = col & 15, z = col >> 4;
      for (let y = 15; y >= 0; y--) {
        const s = at(x, y, z);
        if (s.skip) continue;
        const wy = sub * 16 + y;
        if (s.water) { if (waterTop[col] === -32768) waterTop[col] = wy; continue; }
        let rgb = s.rgb;
        if (waterTop[col] !== -32768) {
          // Seen through water: bluer the deeper it is.
          const depth = Math.min(waterTop[col] - wy, 12);
          const k = 0.45 + depth * 0.04;
          rgb = [rgb[0] * (1 - k) + C.water[0] * k, rgb[1] * (1 - k) + C.water[1] * k, rgb[2] * (1 - k) + C.water[2] * k];
          heights[col] = waterTop[col];
        } else heights[col] = wy;
        colors[col * 3] = rgb[0]; colors[col * 3 + 1] = rgb[1]; colors[col * 3 + 2] = rgb[2];
        done[col] = 1;
        unresolved--;
        break;
      }
    }
  }
  if (!any) return null;
  // Columns that were water all the way down.
  for (let col = 0; col < 256; col++) {
    if (!done[col] && waterTop[col] !== -32768) {
      colors[col * 3] = 40; colors[col * 3 + 1] = 40; colors[col * 3 + 2] = 200;
      heights[col] = waterTop[col];
      done[col] = 1;
    }
  }
  const out = new Uint8Array(RESULT_BYTES);
  const hv = new DataView(out.buffer);
  for (let cz = 0; cz < CELL; cz++) {
    for (let cx = 0; cx < CELL; cx++) {
      // The tallest of the 2×2 columns, so walls and towers show up.
      let best = -1, bh = -32768;
      for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
        const col = (cz * 2 + dz) * 16 + cx * 2 + dx;
        if (done[col] && heights[col] > bh) { bh = heights[col]; best = col; }
      }
      const i = cz * CELL + cx;
      if (best < 0) { out[i * 3] = 0; out[i * 3 + 1] = 0; out[i * 3 + 2] = 0; hv.setUint16(192 + i * 2, 0, true); continue; }
      out[i * 3] = colors[best * 3]; out[i * 3 + 1] = colors[best * 3 + 1]; out[i * 3 + 2] = colors[best * 3 + 2];
      hv.setUint16(192 + i * 2, Math.max(1, bh + 64), true);
    }
  }
  return out;
}
