# Dumps every key/value of a Bedrock world database using Mojang's LevelDB
# (pip install amulet-leveldb). Used to check our reader against the real thing.
# Usage: python dump.py <world>/db out.json   (works on a copy; LevelDB may rewrite files)
import json, sys, leveldb
db = leveldb.LevelDB(sys.argv[1])
out = {k.hex(): v.hex() for k, v in db.iterate()}
db.close()
json.dump(out, open(sys.argv[2], 'w'))
print(len(out), 'keys')
