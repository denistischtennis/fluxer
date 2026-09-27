// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, test} from 'vitest';
import {encodeRatchet, decodeRatchet, ratchetFromWasm, type DaveKeyRatchet} from '../src/ratchetWire.js';

describe('ratchetWire', () => {
	test('encode/decode roundtrips a ratchet', () => {
		const r: DaveKeyRatchet = {cipherSuite: 2, baseSecret: [1, 2, 3, 4, 5, 255]};
		const encoded = encodeRatchet(r);
		expect(typeof encoded).toBe('string');
		const decoded = decodeRatchet(encoded);
		expect(decoded.cipherSuite).toBe(2);
		expect(decoded.baseSecret).toEqual([1, 2, 3, 4, 5, 255]);
	});

	test('preserves large suite numbers and empty secret', () => {
		const r: DaveKeyRatchet = {cipherSuite: 0x1234, baseSecret: []};
		expect(decodeRatchet(encodeRatchet(r))).toEqual(r);
	});

	test('ratchetFromWasm accepts the wasm object shape', () => {
		const raw = {cipherSuite: 2, baseSecret: [10, 20, 30]};
		expect(ratchetFromWasm(raw)).toEqual({cipherSuite: 2, baseSecret: [10, 20, 30]});
	});

	test('ratchetFromWasm rejects null/non-conforming shapes', () => {
		expect(ratchetFromWasm(null)).toBeNull();
		expect(ratchetFromWasm(undefined)).toBeNull();
		expect(ratchetFromWasm({cipherSuite: 'x'})).toBeNull();
		expect(ratchetFromWasm({baseSecret: [1]})).toBeNull();
	});

	test('decode rejects too-short input', () => {
		const short = typeof btoa === 'function' ? btoa('\u0001') : Buffer.from([1]).toString('base64');
		expect(() => decodeRatchet(short)).toThrow();
	});
});
