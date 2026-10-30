# Koho Editor

A world editor for **Minecraft Bedrock Edition** that runs in your browser,
in the spirit of the old MCEdit: open a world, look inside it, make careful
changes, and save it again.

- **Players**: every player who has joined the world, with their inventory,
  armor, offhand and ender chest. Shulker box contents, enchantments, custom
  names and signed books are all shown. Click any slot to change its item,
  count, damage, custom name and enchantments, put a new item in an empty
  slot, or remove one. Search every player at once for an item (try
  `netherite` or `tnt`). Give players nicknames and notes, or import the
  spreadsheet you already keep (see *Player names* below).
- **Map**: a top-down map of every chunk that exists in the Overworld, Nether
  and End. Views:
  - **Blocks from above**: the actual top block of every spot, coloured and
    shaded like an in-game map, so builds, roads and towns stand out. It's
    drawn in the background, starting wherever you're looking.
  - **Biomes** (with gentle hill shading), **amount of data**, and where the
    chests and mobs are.

  A grid labelled with block coordinates scales with the zoom, and **Go to**
  takes you to any coordinates (paste `x y z` straight from the game).
  Player dots show where everyone logged off (click one to open that player,
  or hide them all with the **Players** switch).

  **The seed map**: switch on *Show the seed's biomes underneath the map*
  (in the *World seed* card) to see the biomes your world's seed generates
  today, which is what new or regenerated chunks get, underneath your world.
  Slide *Your world on top* to fade your world in and out, and hover to
  compare the two at any spot. It's built in (it works offline) using
  [cubiomes](https://github.com/Cubitect/cubiomes); it matches Bedrock's own
  biomes closely, though edges such as riverbanks can be a few blocks off.
  **Open this spot in Chunkbase** shows the same place there. Select
  chunks by dragging or by typing block coordinates, then:
  - **regenerate** them from the seed, or
  - **copy** them and **paste** them somewhere else, in this world or (by
    saving a `.kohochunks` file) in a different world. Chests, signs and mobs
    come along, moved to their new positions.
- **Art**: every map in the world as a picture: map art, exploration maps
  and blank ones. Name, tag (art, keep, discard) and add notes to each; see
  where every copy is (item frames, chests, shulker boxes, inventories);
  spot duplicates; download one map or a whole set as PNGs (original size or
  enlarged, pixel-crisp); and clear out maps you don't want. **Murals** puts
  walls of maps hung side by side in item frames back together as one
  picture, the way it looks standing in front of it, ready to download.
- **Library**: every written book and book & quill in the world, gathered
  from inventories, ender chests, chests, shulker boxes, lecterns, frames,
  minecart chests and pack animals (Bedrock keeps no list of books; each one
  lives inside its item). Copies are grouped, the original is marked, and
  each copy says where it is. Read them with their colours and styles, add
  notes, and download any book, or the whole library, as text.
- **Pets**: every named mob and every tamed animal (wolves, cats, horses,
  donkeys, parrots…), who it belongs to (matched to the player, nicknames
  and all), where it is right now with a button to the map, and details like
  health, saddle and what a donkey is carrying. Each player's page lists
  their pets too, and the whole list downloads as a spreadsheet.
- **Records**: every other entry in the world's database (villages, maps,
  scoreboard, portals and more), shown as a readable NBT tree. Click a value
  to change it.
- **World**: the seed, spawn point and other facts, plus every world setting
  and game rule in `level.dat`, all editable. Changing `LevelName` renames
  the world.

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
   In Chrome and Edge it asks where to save the file, then writes it straight
   to disk as it's built, so worlds of any size save fine. Other browsers
   build the file in memory and download it, which can fail for very large
   worlds (a couple of GB or more); use Chrome or Edge for those.
   Open the new file in Minecraft once to check it, then upload it: for a
   Realm, use **Replace World** in the Realm's settings; for a server, upload
   the world folder the way you normally would.

Always keep your original download somewhere safe.

### Regenerating chunks

When a chunk is deleted, Minecraft generates it again from the world seed the
next time a player comes near it, as if nobody had ever been there.
Everything in the chunk goes: blocks, builds, chests and their contents,
signs, and the mobs and other entities standing in it. Players are stored
separately and are not affected.

### Copying and pasting chunks

Select an area on the map and choose **Copy**. Then choose **Paste…** and
click where the copy's north-west corner should go, or type block
coordinates. Pasting replaces whatever was at the destination completely.
Positions inside the chunks (chests, signs, item frames, mobs) are moved
along. Each pasted mob gets a fresh id, so it can't clash with anything the
game creates later.

To move chunks to **another world**, choose **Save as file** after copying.
That gives you a `.kohochunks` file. Open the other world, choose **Open
file…** on the map, and paste as usual. The chunks keep their biomes, and
any world-generation settings they depend on are copied over too.

Every change (each regenerate, each paste, each edited player) appears in the
*changes* list at the top, and each one can be undone by itself until you
save.

### Player names

Bedrock does not save gamertags in the world file, only an id per player.
Click a player's name to give them a nickname, and use the notes box for
anything else worth remembering.

Names live in your browser, not in the world, so they work for every world
you open there. They're kept per web address, so keep opening the editor at
the same address (for example always `http://localhost:8000`). **Names
list…** on the Players tab can:

- **import a spreadsheet**: save it as CSV (in Excel or Google Sheets: *File →
  Save As / Download → CSV*). Each row needs a player id and a name; a notes
  column is picked up too. The id can be the `player_server_…` tag, just the
  id after it, or the Microsoft account id. Header rows are optional.
- **download everything as a CSV**, as a backup or to move to another
  computer.

## How saving works

A Bedrock world's `db` folder is a LevelDB database (Mojang's version, which
compresses with zlib). LevelDB records every write in a `.log` file before
folding it into its table files. Koho Editor uses that same mechanism: it
writes your changes as one new `.log` file and leaves every existing file
exactly as it was. When Minecraft next opens the world, LevelDB replays the
log and absorbs the changes, as if the game had made them itself.

Large sets of changes are split over several log files (about 128 MB each),
which LevelDB replays in order. The writer is tested against Mojang's own
LevelDB library. See *Tests* below.

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
src/lib/export.js     writes the edited world out piece by piece
src/lib/items.js      readable item names, enchantments, containers
src/lib/biomes.js     biome names and colours, surface biome sampling
src/lib/blockmap.js   the block view: reading subchunks, colours, top blocks
src/lib/scaninfo.js   what the scan notes per record (biomes; which hold books or maps)
src/lib/collect.js    finding every book and map item, and where it is
src/views/art.js, src/views/library.js, src/views/pets.js   the Art, Library and Pets tabs
src/mapworker.js      helper workers that draw the block view in parallel
vendor/fflate.js      zlib decompression (MIT licence)
vendor/seedgen.wasm   cubiomes' biome generator, built by tools/seedgen/build.sh (MIT licence)
src/lib/seedgen.js    loads it and turns its biome ids into Bedrock's
src/views/seedlayer.js, src/seedworker.js   the seed map layer and its helpers
tests/                unit tests, fixture world, Mojang LevelDB cross-checks
```
