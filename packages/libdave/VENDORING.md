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

## Artefact integrity (SHA-256)

| Artefact | SHA-256 |
|---|---|
| `wasm-web/libdave.wasm` | `f989f2e9e9d0b29e514082ca40cc706969a0d5dcace3fc5ef22e18e068631e83` |
| `wasm-node/libdave.wasm` | `25a9cff81a13365062f57f76a30461e65c389df048763e8f1f9318206bfd9c37` |

Rebuilt 2026-09-27 with the hardened delivery bindings (in-order proposal
application, commit-path leaf verification bound to (group_id, leaf_index),
prior-occupancy check). The web artefact is byte-identical to the original
vendored build because `DAVE_DELIVERY=OFF` excludes those bindings from it.
Verify with `sha256sum wasm-*/libdave.wasm` after every rebuild; update this
table in the same commit.

## Delivery trust model (known limitation)

`ParseCommitWelcome` validates what a stateless delivery service can validate
without full MLS verifier state: group/epoch/content-type binding, exact
coverage of the pending external-proposal set (by ref), committer path
self-signature under the deployment ciphersuite bound to the sender leaf, and
prior occupancy of the claimed leaf. It does **not** verify the commit's
PublicMessage signature or the update-path secrets/parent hashes — that would
require keeping the full ratchet tree per room in the signer. Forged commits
that pass these checks are still rejected by every honest client (MLS layer),
which reports `invalid_commit_welcome` and triggers the coordinator's
re-founding path; the residual risk is therefore transition churn
(availability), never confidentiality. If stronger server-side validation
is ever required, extend the shadow roster with per-leaf signature keys and
verify the commit signature in `bindings_wasm_delivery.cpp`.

## Updating from upstream

1. Drop the new upstream `cpp/` over this copy (keep `vcpkg` submodule out), re-apply
   the three CMakeLists changes above, keep `bindings_wasm_delivery.cpp`.
2. Re-copy `js/src/*` if upstream changed the helpers; re-convert test imports to Vitest.
3. `bash scripts/build_wasm.sh`, run `pnpm --filter @fluxer/libdave test`.
4. Update the snapshot date in this file.
