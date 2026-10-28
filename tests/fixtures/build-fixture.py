# Writes the fixture world's database with Mojang's LevelDB (pip install amulet-leveldb),
# over several sessions so it ends up with more than one table file and a live log.
# Then records what the database should contain in expected.json.
# Usage: node make-fixture.mjs world | python build-fixture.py world
import json, os, shutil, sys, leveldb
world = sys.argv[1]
data = json.load(sys.stdin)
dbdir = os.path.join(world, 'db')
shutil.rmtree(dbdir, ignore_errors=True)
items = list(data['puts'].items())
third = len(items) // 3
for part in (items[:third], items[third:2 * third]):
    db = leveldb.LevelDB(dbdir, create_if_missing=True)
    for k, v in part: db.put(bytes.fromhex(k), bytes.fromhex(v))
    db.close()
db = leveldb.LevelDB(dbdir)
for k, v in items[2 * third:]: db.put(bytes.fromhex(k), bytes.fromhex(v))
for k in data['deletes']: db.delete(bytes.fromhex(k))
# Overwrite a value so the log holds a newer version than a table does.
first = items[0][0]
db.put(bytes.fromhex(first), b'\x29')
db.close()
expected = {k: v for k, v in items if k not in data['deletes']}
expected[first] = '29'
json.dump(expected, open(os.path.join(world, '..', 'expected.json'), 'w'), sort_keys=True)
print(len(expected), 'keys;', sorted(os.listdir(dbdir)))
