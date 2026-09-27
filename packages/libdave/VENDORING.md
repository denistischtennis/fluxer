# Vendored libdave (DAVE protocol)

Vendored from https://github.com/discord/libdave under the MIT licence (see `LICENSE`).
Snapshot taken 2026-09-26 from a local copy of upstream `main` (`libdave-main.zip` layout);
the vcpkg submodule itself is NOT vendored — it is bootstrapped by the build script.

## What lives where

- `cpp/` — upstream C++ core + our delivery bindings (`src/bindings_wasm_delivery.cpp`).
- `js/` — upstream JS helpers (`DisplayableCode`, `KeyFingerprint`, `KeySerialization`,
  `PairwiseFingerprint`) plus WASM module loaders:
  - `js/wasm-web.ts` → `wasm-web/libdave.*` (browser artefact, `@fluxer/libdave/wasm`)
  - `js/wasm-node.ts` → `wasm-node/libdave.*` (node artefact incl. delivery, `@fluxer/libdave/delivery`)
- `js/__tests__/` — upstream helper tests, converted from Jest to Vitest (import lines only).
- `wasm-web/`, `wasm-node/` — committed build artefacts (`libdave.js`, `libdave.wasm`, `libdave.d.ts`).
- `scripts/build_wasm.sh` — Dockerised build (emscripten/emsdk + vcpkg).

## Deviations from upstream

1. `cpp/CMakeLists.txt`:
   - `DAVE_DELIVERY` option (default OFF). When OFF, `bindings_wasm_delivery.cpp` is
     filtered out of the WASM link. The web artefact never contains delivery code.
   - `DAVE_ENVIRONMENT` cache var replaces the hardcoded `-sENVIRONMENT=web`, so the
     node artefact links with `-sENVIRONMENT=node`.
   - `-fexceptions` added to the Emscripten compile/link flags. Upstream ships without
     exception support, which turns every `try/catch` in `session.cpp` (and the delivery
     bindings) into an instance-aborting trap instead of a handled error. Required for
     the delivery bindings' error reporting and for graceful client error paths.
2. `bindings_wasm_delivery.cpp` is fluxer-authored: upstream libdave has no
   delivery-service functionality (no external-proposal creation, no key-package
   validation). Everything else in `cpp/` is byte-identical to upstream except where
   noted above.
3. `cpp/vcpkg-alts/wasm/vcpkg.json`: `gtest` dependency removed. Upstream builds C++
   gtest suites; fluxer verifies the artefacts through Vitest only, and skipping gtest
   avoids building an unneeded wasm port.
4. `scripts/docker_build_steps.sh` installs `pkg-config` into the emsdk image at build
   time (required by the OpenSSL port's pkgconfig fixup; absent from the base image).
5. Tests run under Vitest instead of Jest (config-level only; assertions identical).

## Rebuilding the WASM artefacts

Requires Docker. From this directory:

```bash
bash scripts/build_wasm.sh          # builds both artefacts (~30–60 min cold, minutes warm)
bash scripts/build_wasm.sh web      # browser artefact only
bash scripts/build_wasm.sh node     # node artefact (+delivery) only
```

Toolchain pins: image `emscripten/emsdk:3.1.64`, vcpkg baseline
`7adc2e4d49e8d0efc07a369079faa6bc3dbb90f3` (from `cpp/vcpkg-alts/wasm/vcpkg.json`),
mlspp `1cc50a124a3bc4e143a787ec934280dc70c1034d`. The script caches vcpkg state in
named Docker volumes (`fluxer-dave-vcpkg-*`); delete them to force a cold rebuild.

Commit the regenerated `wasm-web/` and `wasm-node/` directories together with any
`cpp/` change. Never hand-edit artefacts.

## Updating from upstream

1. Drop the new upstream `cpp/` over this copy (keep `vcpkg` submodule out), re-apply
   the three CMakeLists changes above, keep `bindings_wasm_delivery.cpp`.
2. Re-copy `js/src/*` if upstream changed the helpers; re-convert test imports to Vitest.
3. `bash scripts/build_wasm.sh`, run `pnpm --filter @fluxer/libdave test`.
4. Update the snapshot date in this file.
