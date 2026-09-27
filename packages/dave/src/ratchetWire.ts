// SPDX-License-Identifier: AGPL-3.0-or-later

// Wire encoding for DAVE key ratchets as they cross the JS boundary (client
// session -> e2ee worker, roster storage). A ratchet is the pair
// {cipherSuite, baseSecret} produced by libdave's `Session.GetKeyRatchet`.
//
// The plan treats libdave's own JS tests (packages/libdave/js/__tests__) as
// normative for the byte shapes: `baseSecret` is a raw byte array and
// serialization to text is plain base64 (see KeySerialization.serializeKey).

export interface DaveKeyRatchet {
	cipherSuite: number;
	baseSecret: number[];
}

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] as number);
	}
	// btoa in browsers/workers; Buffer in node.
	if (typeof btoa === 'function') {
		return btoa(binary);
	}
	return Buffer.from(bytes).toString('base64');
}

function fromBase64(value: string): Uint8Array {
	if (typeof atob === 'function') {
		const binary = atob(value);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			out[i] = binary.charCodeAt(i);
		}
		return out;
	}
	return new Uint8Array(Buffer.from(value, 'base64'));
}

/** Encode a ratchet to a compact base64 string (1-byte suite + secret bytes). */
export function encodeRatchet(ratchet: DaveKeyRatchet): string {
	const secret = Uint8Array.from(ratchet.baseSecret);
	const buf = new Uint8Array(2 + secret.length);
	buf[0] = (ratchet.cipherSuite >> 8) & 0xff;
	buf[1] = ratchet.cipherSuite & 0xff;
	buf.set(secret, 2);
	return toBase64(buf);
}

/** Decode a ratchet previously produced by {@link encodeRatchet}. */
export function decodeRatchet(encoded: string): DaveKeyRatchet {
	const buf = fromBase64(encoded);
	if (buf.length < 2) {
		throw new Error('ratchet too short');
	}
	const cipherSuite = (buf[0] as number) << 8 | (buf[1] as number);
	return {
		cipherSuite,
		baseSecret: Array.from(buf.subarray(2)),
	};
}

/** Convert a libdave ratchet object into the plain serializable form. */
export function ratchetFromWasm(raw: unknown): DaveKeyRatchet | null {
	if (raw === null || raw === undefined || typeof raw !== 'object') {
		return null;
	}
	const candidate = raw as {cipherSuite?: unknown; baseSecret?: unknown};
	if (typeof candidate.cipherSuite !== 'number' || !Array.isArray(candidate.baseSecret)) {
		return null;
	}
	return {
		cipherSuite: candidate.cipherSuite,
		baseSecret: candidate.baseSecret.map((b) => Number(b)),
	};
}
