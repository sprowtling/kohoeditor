// The pet carrier: picks up pets (any named or tamed mob), carries them in a
// file if need be, and sets them down somewhere else, in this world or
// another one, still belonging to their owners.
//
// A pet remembers its owner by the owner's UniqueID, which is different in
// every world. Players' Microsoft account ids are the same everywhere, so the
// carrier notes those and uses them to find the owner again.

import { T, child, val, parse, parseAll, serialize, serializeAll, toPlain } from './nbt.js';
import { actorKey, digpKey, parseChunkKey, isActorKey } from './keys.js';
import { utf8, fromUtf8, fromHex, toHex, concatBytes, toBase64, fromBase64 } from './bytes.js';
import { deflateSync, inflateSync } from '../../vendor/fflate.js';
import { prettyName, stripFormatting } from './items.js';
import { EntityIds } from './world.js';

const MAGIC = 'KOHOPETS';
const SPREAD = [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];

// Something that tells worlds apart well enough to know a pet is going home.
export function worldToken(world) {
  return `${world.info().seed}:${world.levelName ?? ''}`;
}

// The players in a world as owners: { key, msaId, selfSignedId, uid, dim, pos }.
export function ownersOf(world) {
  return world.players().filter((p) => p.summary).map((p) => {
    let uid = null;
    try { uid = String(val(parseAll(world.get(fromHex(p.key))).roots[0], 'UniqueID')); } catch { /* none */ }
    return { key: p.key, id: p.id, msaId: p.link?.msaId ?? null, selfSignedId: p.link?.selfSignedId ?? null, uid, dim: p.summary.dim, pos: p.summary.pos };
  });
}

// picks: [{ recordKey, index }] as listed by World.mobs(). Returns carrier entries.
export function pickUp(world, picks) {
  const owners = ownersOf(world);
  const token = worldToken(world);
  const out = [];
  for (const { recordKey, index } of picks) {
    const v = world.get(fromHex(recordKey));
    if (!v) continue;
    const root = parseAll(v).roots[index];
    if (!root) continue;
    const ownerUid = val(root, 'OwnerNew');
    const owner = ownerUid !== undefined ? owners.find((o) => o.uid === String(ownerUid)) : null;
    const identifier = val(root, 'identifier') ?? 'unknown';
    const c = parseChunkKey(fromHex(recordKey));
    out.push({
      name: stripFormatting(val(root, 'CustomName') ?? '') || null,
      identifier,
      kind: prettyName(identifier),
      owner: owner ? { msaId: owner.msaId, selfSignedId: owner.selfSignedId, playerId: owner.id } : null,
      from: { world: token, recordKey, index, dim: c ? c.dim : world.actorDimension(recordKey), pos: (child(root, 'Pos')?.v ?? []).map((x) => Math.floor(x.v)) },
      nbt: serialize(root),
    });
  }
  return out;
}

export function encodeCarrier(pets, worldName) {
  const json = JSON.stringify({ version: 1, world: worldName, created: Date.now(), pets: pets.map((p) => ({ ...p, nbt: toBase64(p.nbt) })) });
  return concatBytes([utf8(MAGIC), deflateSync(utf8(json), { level: 6 })]);
}

export function decodeCarrier(bytes) {
  if (bytes.length < MAGIC.length || fromUtf8(bytes.subarray(0, MAGIC.length)) !== MAGIC) throw new Error('That file is not a Koho Editor pet carrier (.kohopets).');
  const data = JSON.parse(fromUtf8(inflateSync(bytes.subarray(MAGIC.length))));
  return data.pets.map((p) => ({ ...p, nbt: fromBase64(p.nbt) }));
}

// The player in this world a carried pet belongs to, matched by Microsoft
// account id (or, failing that, the other ids players are known by).
export function findOwner(world, pet, owners = ownersOf(world)) {
  const o = pet.owner;
  if (!o) return null;
  return owners.find((p) => (o.msaId && p.msaId === o.msaId) || (o.selfSignedId && p.selfSignedId === o.selfSignedId) || (o.playerId && p.id === o.playerId))?.key ?? null;
}

function setPos(root, [x, y, z]) {
  const pos = child(root, 'Pos');
  const v = [{ t: T.Float, v: x }, { t: T.Float, v: y }, { t: T.Float, v: z }];
  if (pos) { pos.v = v; pos.et = T.Float; } else root.v.push({ n: 'Pos', t: T.List, et: T.Float, v });
}

function setLong(root, name, value) {
  const c = child(root, name);
  if (c) { c.t = T.Long; c.v = value; } else root.v.push({ n: name, t: T.Long, v: value });
}

// Sets carried pets down in this world.
// where: { mode: 'owner' | 'coords', dim, pos: [x, y, z] }   (pos/dim for 'coords')
// owners: per pet, the player key to belong to, or null for no owner.
// Pets that came from this world are moved (the original is taken away).
// Returns { op, placed: [{ name, at, dim }], problems: [text] }.
export function setDown(world, pets, where, owners) {
  const ownerList = ownersOf(world);
  const token = worldToken(world);
  const ids = new EntityIds(world);
  const op = world.newOp('pets', '');
  const placed = [], problems = [];
  const removals = new Map(); // record key -> root indexes to take out (older in-chunk entities)
  pets.forEach((pet, i) => {
    const title = pet.name || `Unnamed ${pet.kind.toLowerCase()}`;
    const ownerKey = owners[i] ?? null;
    const owner = ownerList.find((o) => o.key === ownerKey) ?? null;
    let dim, at;
    if (where.mode === 'owner') {
      if (!owner) { problems.push(`${title}: no owner to set it down next to.`); return; }
      dim = owner.dim;
      at = [Math.floor(owner.pos[0]) + 1.5, Math.floor(owner.pos[1]), Math.floor(owner.pos[2]) + 0.5];
    } else {
      dim = where.dim;
      // The first exactly there, the rest in a little ring around it.
      const [ox, oz] = SPREAD[i % SPREAD.length];
      at = [Math.floor(where.pos[0]) + 0.5 + ox, Math.floor(where.pos[1]), Math.floor(where.pos[2]) + 0.5 + oz];
    }
    const cx = Math.floor(at[0] / 16), cz = Math.floor(at[2] / 16);
    const chunk = world.chunks[dim]?.get(cx + ',' + cz);
    if (!chunk || world.deleted[dim]?.has(cx + ',' + cz)) {
      problems.push(`${title}: the spot ${at.map(Math.floor).join(', ')} hasn't been generated yet. Walk there in the game first, or pick a spot nearby that has.`);
      return;
    }
    const root = parse(pet.nbt);
    const fresh = ids.next();
    setLong(root, 'UniqueID', fresh.uid);
    setLong(root, 'OwnerNew', owner?.uid != null && owner.uid !== 'null' ? BigInt(owner.uid) : -1n);
    if (child(root, 'LeasherID')) setLong(root, 'LeasherID', -1n); // whatever held its lead isn't coming along
    root.v = root.v.filter((c) => c.n !== 'LinksTag'); // nor is anything riding it
    setPos(root, at);
    let internal = child(root, 'internalComponents');
    if (!internal) { internal = { n: 'internalComponents', t: T.Compound, v: [] }; root.v.push(internal); }
    let sk = child(internal, 'EntityStorageKeyComponent');
    if (!sk) { sk = { n: 'EntityStorageKeyComponent', t: T.Compound, v: [] }; internal.v.push(sk); }
    const keyTag = child(sk, 'StorageKey');
    const keyVal = { n: 'StorageKey', t: T.String, v: String.fromCharCode(...fresh.key8), raw: fresh.key8.slice() };
    if (keyTag) Object.assign(keyTag, keyVal); else sk.v.push(keyVal);

    world.setEdit(op, actorKey(fresh.key8), serialize(root), `pet ${title}`);
    const dk = digpKey(cx, cz, dim);
    world.setEdit(op, dk, concatBytes([world.get(dk) ?? new Uint8Array(0), fresh.key8]), `pet ${title}`);
    chunk.hasDigpKey = true;
    chunk.digp = true;

    // Coming from this very world: it moves, rather than being copied.
    if (pet.from?.world === token) {
      const rk = pet.from.recordKey;
      const orig = fromHex(rk);
      if (isActorKey(orig) && world.get(orig)) {
        const home = world.actorHome(rk);
        world.setEdit(op, orig, null, `pet ${title} moved`);
        if (home) {
          const hk = digpKey(home.x, home.z, home.dim);
          const list = world.get(hk) ?? new Uint8Array(0);
          const kept = [];
          for (let j = 0; j + 8 <= list.length; j += 8) if (toHex(actorKey(list.subarray(j, j + 8))) !== rk) kept.push(list.subarray(j, j + 8));
          world.setEdit(op, hk, concatBytes(kept), `pet ${title} moved`);
        }
      } else if (!isActorKey(orig)) {
        if (!removals.has(rk)) removals.set(rk, []);
        removals.get(rk).push(pet.from.index);
      }
    }
    placed.push({ name: title, at: at.map(Math.floor), dim, index: i });
  });
  // Older worlds keep a chunk's entities together in one record: take the moved ones out of it.
  for (const [rk, indexes] of removals) {
    const v = world.get(fromHex(rk));
    if (!v) continue;
    const { roots, rest } = parseAll(v);
    const keep = roots.filter((_, j) => !indexes.includes(j));
    world.setEdit(op, fromHex(rk), serializeAll(keep, rest), 'pets moved');
  }
  if (!placed.length) { world.undoOperation(op.id); return { op: null, placed, problems }; }
  op.label = placed.length === 1 ? `Set down ${placed[0].name} at ${placed[0].at.join(', ')}` : `Set down ${placed.length} pets`;
  return { op: op.id, placed, problems };
}

export { toPlain };
