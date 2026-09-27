#!/usr/bin/env bash
# Build the @fluxer/libdave WASM artefacts (browser + node) inside Docker.
#
# Usage:  bash scripts/build_wasm.sh [web|node|all]
#
# Artefacts land in ./wasm-web/ and ./wasm-node/ (commit them). vcpkg state is
# cached in named docker volumes; delete `fluxer-dave-*` volumes for a cold build.
# The actual compile logic lives in scripts/docker_build_steps.sh (runs in-container).
set -euo pipefail

IMAGE="${DAVE_EMSDK_IMAGE:-emscripten/emsdk:3.1.64}"
VCPKG_REF="7adc2e4d49e8d0efc07a369079faa6bc3dbb90f3"   # cpp/vcpkg-alts/wasm/vcpkg.json builtin-baseline
TARGET="${1:-all}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

docker run --rm \
  -v "${HERE}:/dave:rw" \
  -v fluxer-dave-vcpkg:/vcpkg \
  -v fluxer-dave-downloads:/downloads \
  -e VCPKG_REF="${VCPKG_REF}" \
  -e DAVE_BUILD_TARGET="${TARGET}" \
  "${IMAGE}" \
  bash /dave/scripts/docker_build_steps.sh

echo "done: ${TARGET}"
