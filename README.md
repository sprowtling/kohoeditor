# Koho Editor

A world editor for **Minecraft Bedrock Edition** that runs in your browser,
in the spirit of the old MCEdit: open a world, look inside it, make careful
changes, and save it again.

- **Players**: every player who has joined the world, with their inventory,
  armor, offhand and ender chest. Shulker box contents, enchantments, custom
  names and signed books are all shown. Search every player at once for an
  item (try `netherite` or `tnt`), and remove items if you need to.
- **Map**: a top-down map of every chunk that exists in the Overworld, Nether
  and End. Select chunks by dragging or by typing block coordinates, then
  mark them to **regenerate from the seed**. Click one chunk to see what's
  inside it, including its chests, signs and mobs.
- **Records**: every other entry in the world's database (players, villages,
  maps, scoreboard, portals and more), shown as a readable NBT tree. Click a
  value to change it.
- **World**: the seed, spawn point and other facts, plus the full `level.dat`.

Everything happens on your own computer. The world is never uploaded
anywhere, and your original files are never changed.

## Using it

1. **Get a copy of the world.**
   - *From a Realm:* in Minecraft, open the Realm's settings and choose
     **Download World**. Then, in the world's own settings, choose **Export
     World** to get a `.mcworld` file.
   - *From a server:* download the world folder (the one with `level.dat` and
     a `db` folder inside).
   - *From your own device:* worlds live in
     `com.mojang/minecraftWorlds/<world id>/`.
2. **Open Koho Editor** and choose the `.mcworld` file or the world folder.
   You can also drag either onto the page. A big world takes a little while to
   read the first time. Every part of the database is read once, using several
   threads at the same time.
3. **Look around and make changes.** Nothing is written yet. The *changes*
   button at the top lists everything waiting to be saved, and each change can
   be undone.
4. **Save edited world** builds a new `.mcworld` with your changes in it.
   Open it in Minecraft once to check it, then upload it: for a Realm, use
   **Replace World** in the Realm's settings; for a server, upload the world
   folder the way you normally would.

Always keep your original download somewhere safe.

### Regenerating chunks

When a chunk is deleted, Minecraft generates it again from the world seed the
next time a player comes near it, as if nobody had ever been there.
Everything in the chunk goes: blocks, builds, chests and their contents,
signs, and the mobs and other entities standing in it. Players are stored
separately and are not affected.

### About player names

Bedrock does not save gamertags in the world file, only an id per player, so
players are listed by id at first. Click a player's name to give them a
nickname. Nicknames are remembered in your browser only and never go into
the world.

## How saving works

A Bedrock world's `db` folder is a LevelDB database (Mojang's version, which
compresses with zlib). LevelDB records every write in a `.log` file before
folding it into its table files. Koho Editor uses that same mechanism: it
writes your changes as one new `.log` file and leaves every existing file
exactly as it was. When Minecraft next opens the world, LevelDB replays the
log and absorbs the changes, as if the game had made them itself.

The writer is tested against Mojang's own LevelDB library. See *Tests* below.

## Running it

It's a static site with no build step. Serve the folder with any web server
and open it in a current Chrome, Edge, Firefox or Safari:

```bash
python3 -m http.server 8000
```

Then visit <http://localhost:8000>. (Opening `index.html` straight from disk
won't work, because browsers only run its background workers from a web
server.) It can also be hosted as-is on GitHub Pages.

## Tests

```bash
npm test
```

runs the unit tests against a small test world in `tests/fixtures/world`.
That world was written by Mojang's LevelDB, with several table files and
recent writes still in its log, so the tests cover the tricky cases.

To cross-check our writer against Mojang's LevelDB directly (needs Python and
`pip install amulet-leveldb`):

```bash
tests/oracle/check.sh                  # the test world
tests/oracle/check.sh path/to/world    # any world folder (a copy is used)
```

This regenerates some chunks and edits a player with our code, then opens the
result with Mojang's LevelDB and checks every key and value.

## Layout

```
index.html            the page
src/app.js            opening worlds, tabs, saving
src/views/            Players, Map, Records, World, and the NBT tree
src/worker.js         background worker that holds the open world
src/scanworker.js     helper workers that read the database in parallel
src/lib/leveldb.js    LevelDB reader and change-log writer
src/lib/nbt.js        little-endian NBT reader and writer
src/lib/keys.js       what each database key means
src/lib/world.js      the world model: scan, players, chunks, edits
src/lib/zip.js        .mcworld (zip) reading and writing
src/lib/items.js      readable item names, enchantments, containers
vendor/fflate.js      zlib decompression (MIT licence)
tests/                unit tests, fixture world, Mojang LevelDB cross-checks
```
