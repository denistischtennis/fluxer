#!/usr/bin/env bash
# Runs INSIDE emscripten/emsdk: bootstraps vcpkg (cached in /vcpkg volume) and
# builds the requested libdave WASM variant(s) into /dave/wasm-{web,node}/.
# Env: VCPKG_REF, DAVE_BUILD_TARGET (web|node|all)
set -eux

export VCPKG_DEFAULT_BINARY_CACHE=/downloads
mkdir -p /downloads

# vcpkg ports (openssl pkgconfig fixup) need pkg-config; emsdk image lacks it.
if ! command -v pkg-config >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq pkg-config >/dev/null
fi

# --emit-tsd needs TypeScript available to emscripten (not in the base image).
if [ ! -x /emsdk/upstream/emscripten/node_modules/.bin/tsc ]; then
  (cd /emsdk/upstream/emscripten && npm install --no-audit --no-fund --loglevel=error)
fi

if [ ! -d /vcpkg/.git ]; then
  # /vcpkg is a named volume; never rm the mountpoint. An empty dir clones fine.
  git clone --filter=blob:none https://github.com/microsoft/vcpkg /vcpkg
fi
git -C /vcpkg fetch --quiet origin "${VCPKG_REF}" || true
git -C /vcpkg checkout --quiet "${VCPKG_REF}"
if [ ! -x /vcpkg/vcpkg ]; then
  /vcpkg/bootstrap-vcpkg.sh -disableMetrics
fi

build_variant() {
  local out_dir="$1"; shift
  cmake -S /dave/cpp -B "/tmp/${out_dir}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DVCPKG_MANIFEST_DIR=/dave/cpp/vcpkg-alts/wasm \
    -DCMAKE_TOOLCHAIN_FILE=/vcpkg/scripts/buildsystems/vcpkg.cmake \
    -DVCPKG_CHAINLOAD_TOOLCHAIN_FILE="${EMSDK}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
    -DVCPKG_TARGET_TRIPLET=wasm32-emscripten \
    "$@"
  cmake --build "/tmp/${out_dir}" --target libdave -j "$(nproc)"
  mkdir -p "/dave/${out_dir}"
  cp "/tmp/${out_dir}/libdave.js" "/tmp/${out_dir}/libdave.wasm" "/tmp/${out_dir}/libdave.d.ts" "/dave/${out_dir}/"
}

case "${DAVE_BUILD_TARGET}" in
  web)  build_variant wasm-web ;;
  node) build_variant wasm-node -DDAVE_ENVIRONMENT=node -DDAVE_DELIVERY=ON ;;
  all)
    build_variant wasm-web
    build_variant wasm-node -DDAVE_ENVIRONMENT=node -DDAVE_DELIVERY=ON
    ;;
  *) echo "bad target: ${DAVE_BUILD_TARGET}" >&2; exit 2 ;;
esac
