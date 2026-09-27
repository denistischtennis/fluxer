// SPDX-License-Identifier: AGPL-3.0-or-later

// `crypto.randomUUID` is only exposed in secure contexts (HTTPS / localhost).
// The dev stack served over plain HTTP on a LAN address therefore lacks it, and
// several call sites (Toasts, member-search contexts, ...) use it unguarded.
// Provide the standard v4 shape from `crypto.getRandomValues`, which IS
// available in insecure contexts. Imported first from index.tsx.

interface MaybeCrypto {
	crypto?: Crypto & {randomUUID?: () => string};
}

const g = globalThis as MaybeCrypto;

if (
	typeof g.crypto !== 'undefined' &&
	typeof g.crypto.getRandomValues === 'function' &&
	typeof g.crypto.randomUUID !== 'function'
) {
	const hex: string[] = [];
	for (let i = 0; i < 256; i++) {
		hex.push(i.toString(16).padStart(2, '0'));
	}

	Object.defineProperty(g.crypto, 'randomUUID', {
		configurable: true,
		value(): string {
			const b = new Uint8Array(16);
			g.crypto!.getRandomValues(b);
			b[6] = ((b[6] ?? 0) & 0x0f) | 0x40; // version 4
			b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
			return (
				hex[b[0]] + hex[b[1]] + hex[b[2]] + hex[b[3]] + '-' +
				hex[b[4]] + hex[b[5]] + '-' +
				hex[b[6]] + hex[b[7]] + '-' +
				hex[b[8]] + hex[b[9]] + '-' +
				hex[b[10]] + hex[b[11]] + hex[b[12]] + hex[b[13]] + hex[b[14]] + hex[b[15]]
			);
		},
	});

	// Functional marker so the bundle (and tests) can prove the polyfill shipped.
	(g.crypto as Record<string, unknown>).__fluxer_uuid_polyfilled__ = true;
}
