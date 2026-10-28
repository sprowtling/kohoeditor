# Writes {hexKey: hexValue} from a JSON file into a database with Mojang's LevelDB.
# Usage: python put.py <db dir> puts.json
import json, sys, leveldb
db = leveldb.LevelDB(sys.argv[1])
for k, v in json.load(open(sys.argv[2])).items():
    db.put(bytes.fromhex(k), bytes.fromhex(v))
db.close(compact=True)
