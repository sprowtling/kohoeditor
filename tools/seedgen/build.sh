#!/bin/sh
# Builds vendor/seedgen.wasm: cubiomes' biome generator plus the small wrapper
# in koho_seed.c, compiled to WebAssembly with clang (no Emscripten needed).
# Needs clang and wasm-ld (LLVM 15 or newer) and git.
#
# To pick up a newer Minecraft version, change COMMIT to a newer cubiomes
# commit, run this, then run the tests (npm test) to check it still matches.
set -e
here=$(cd "$(dirname "$0")" && pwd)
COMMIT=${COMMIT:-e61f90580cbdd883214a8054670dacae655e59c0}
src=$(mktemp -d)
git clone -q https://github.com/Cubitect/cubiomes "$src"
git -C "$src" checkout -q "$COMMIT"
clang --target=wasm32 -O3 -ffreestanding -nostdlib -isystem "$here/shim" -I"$src" -DNDEBUG -Wno-everything \
  -Wl,--no-entry -Wl,--export=koho_setup -Wl,--export=koho_biomes -Wl,--export=koho_surface -Wl,--export=koho_mc_newest \
  -Wl,--initial-memory=33554432 \
  -o "$here/../../vendor/seedgen.wasm" \
  "$here/koho_seed.c" "$here/shim/libc.c" \
  "$src/generator.c" "$src/biomenoise.c" "$src/layers.c" "$src/noise.c" "$src/biomes.c"
cp "$src/LICENSE" "$here/../../vendor/cubiomes.LICENSE"
rm -rf "$src"
echo "Built vendor/seedgen.wasm from cubiomes $COMMIT"
