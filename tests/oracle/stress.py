# Builds a messy database with Mojang's LevelDB: many levels, overwritten and
# deleted keys, and writes left in the log. Then dumps the expected contents.
# Usage: python stress.py <dir> expected.json [nkeys]
import json, os, random, sys, leveldb
path, out = sys.argv[1], sys.argv[2]
n = int(sys.argv[3]) if len(sys.argv) > 3 else 60000
random.seed(7)
db = leveldb.LevelDB(path, create_if_missing=True)
model = {}
def rkey():
    kind = random.random()
    if kind < 0.7:  # chunk-like binary keys
        return random.randint(-300, 300).to_bytes(4, 'little', signed=True) + random.randint(-300, 300).to_bytes(4, 'little', signed=True) + bytes([random.choice([0x2f, 0x31, 0x2c])])
    return ('player_server_%d' % random.randint(0, 5000)).encode()
for i in range(n):
    k = rkey()
    if random.random() < 0.2 and model:
        k = random.choice(list(model.keys()))
        db.delete(k); del model[k]
    else:
        v = os.urandom(random.randint(10, 3000)) if random.random() < 0.5 else bytes([i % 7]) * random.randint(1, 5000)
        db.put(k, v); model[k] = v
db.close()
# reopen and write a little more without compaction so it stays in the log
db = leveldb.LevelDB(path)
for i in range(500):
    k = rkey()
    if random.random() < 0.3 and model:
        k = random.choice(list(model.keys())); db.delete(k); model.pop(k, None)
    else:
        v = os.urandom(50); db.put(k, v); model[k] = v
db.close()
json.dump({k.hex(): v.hex() for k, v in model.items()}, open(out, 'w'))
print(len(model), 'live keys')
