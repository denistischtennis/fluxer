// SPDX-License-Identifier: MIT

// Browser loader for the vendored DAVE WASM artefact.
//
// The raw Emscripten glue (`../wasm-web/libdave.js`) locates its binary via a
// runtime string concatenation (`scriptDirectory + "libdave.wasm"`). Bundlers
// such as rspack cannot statically detect that reference, so the `.wasm` file is
// never emitted as an asset and instantiation fails at runtime. We resolve the
// binary through `new URL(..., import.meta.url)` — the pattern rspack's
// `asset/resource` rule understands — and hand the resulting served URL to the
// module via `locateFile`.

import DaveModuleRaw, {type MainModule} from '../wasm-web/libdave.js';

const daveWasmUrl = new URL('../wasm-web/libdave.wasm', import.meta.url);

/** Emscripten init options a caller wants merged into the loader's own. */
export type DaveModuleInit = Record<string, unknown>;

/** Resolves once the DAVE WASM module is instantiated. */
export type LoadedDaveModule = Promise<MainModule>;

export function DaveModuleFactory(moduleArg?: DaveModuleInit): LoadedDaveModule {
	return DaveModuleRaw({
		...(moduleArg ?? {}),
		locateFile: () => daveWasmUrl.href,
	});
}

export type { MainModule as DaveModule } from '../wasm-web/libdave.js';
export * from '../wasm-web/libdave.js';
