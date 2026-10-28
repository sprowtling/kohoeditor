# Opens a database with Mojang's LevelDB and compares it with expected.json.
# Usage: python verify.py <db dir> expected.json
import json, sys, leveldb
db = leveldb.LevelDB(sys.argv[1])
got = {k.hex(): v.hex() for k, v in db.iterate()}
db.close()
want = json.load(open(sys.argv[2]))
missing = [k for k in want if k not in got]
extra = [k for k in got if k not in want]
diff = [k for k in want if k in got and got[k] != want[k]]
print('keys', len(got), 'expected', len(want), 'missing', len(missing), 'extra', len(extra), 'different', len(diff))
sys.exit(1 if missing or extra or diff else 0)
