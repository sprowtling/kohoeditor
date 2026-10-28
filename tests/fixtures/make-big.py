# Builds a large test world by repeating the chunks of a small real one across
# a wide area, plus many player records. Used to measure scan speed.
# Usage: python make-big.py <small world dir> <out world dir> <copies> <players>
import leveldb, os, random, shutil, struct, sys, tempfile
src, out, copies, nplayers = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
tmp = tempfile.mkdtemp()
shutil.copytree(os.path.join(src, 'db'), os.path.join(tmp, 'db'))
db = leveldb.LevelDB(os.path.join(tmp, 'db'))
items = list(db.iterate())
db.close()
shutil.rmtree(out, ignore_errors=True)
shutil.copytree(src, out, ignore=shutil.ignore_patterns('db'))
os.makedirs(os.path.join(out, 'db'))
big = leveldb.LevelDB(os.path.join(out, 'db'), create_if_missing=True)
chunk = [(k, v) for k, v in items if len(k) in (9, 10) and k[3] in (0, 255) and k[7] in (0, 255)]
rest = [(k, v) for k, v in items if not (len(k) in (9, 10) and k[3] in (0, 255) and k[7] in (0, 255))]
random.seed(1)
side = int(copies ** 0.5) + 1
for c in range(copies):
    ox, oz = (c % side) * 16 - side * 8, (c // side) * 16 - side * 8
    for k, v in chunk:
        x, z = struct.unpack('<ii', k[:8])
        nk = struct.pack('<ii', x + ox, z + oz) + k[8:]
        b = bytearray(v)
        if len(b) > 64:
            for _ in range(4):
                b[random.randrange(16, len(b))] = random.randrange(256)
        big.put(nk, bytes(b))
for k, v in rest:
    big.put(k, v)
local = dict(items)[b'~local_player']
for i in range(nplayers):
    big.put(('player_server_%08x-0000-4000-8000-%012x' % (i, i)).encode(), local)
big.close(compact=True)
print('done')
