// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {describe, expect, test} from 'vitest';
import {createDaveDecodeTransform, createDaveEncodeTransform} from './DaveTransform.ts';

// Reversible fake cryptors: XOR every byte with 0x5a. Symmetric so encode->decode
// returns the original, and the transformed bytes differ from input (proving the
// DAVE path ran, not WebCrypto).
function xorBytes(bytes: Uint8Array): Uint8Array {
	const out = new Uint8Array(bytes.length);
	for (let i = 0; i < bytes.length; i++) out[i] = bytes[i]! ^ 0x5a;
	return out;
}

function fakeSend(): {encrypt: (mt: number, p: Uint8Array) => {bytes: Uint8Array; encrypted: boolean}} {
	return {
		encrypt(_mt, plain) {
			return {bytes: xorBytes(plain), encrypted: true};
		},
	};
}

function fakeRecv(ok = true): {decrypt: (mt: number, c: Uint8Array) => {bytes: Uint8Array; ok: boolean}} {
	return {
		decrypt(_mt, cipher) {
			if (!ok) return {bytes: new Uint8Array(), ok: false};
			return {bytes: xorBytes(cipher), ok: true};
		},
	};
}

function audioFrame(data: ArrayBuffer): RTCEncodedAudioFrame {
	return {
		data,
		timestamp: 0,
		getMetadata: () => ({synchronizationSource: 1}),
	} as unknown as RTCEncodedAudioFrame;
}

async function runThrough<T>(stream: TransformStream<T, T>, input: T): Promise<T[]> {
	const reader = stream.readable.getReader();
	const writer = stream.writable.getWriter();
	// Drain concurrently to avoid TransformStream backpressure deadlock.
	const collected = (async () => {
		const out: T[] = [];
		for (;;) {
			const {value, done} = await reader.read();
			if (done) break;
			out.push(value as T);
		}
		return out;
	})();
	await writer.write(input);
	await writer.close();
	return collected;
}

describe('DAVE encode transform', () => {
	test('replaces frame payload with ciphertext via the send cryptor', async () => {
		const t = createDaveEncodeTransform(fakeSend() as never);
		const plain = new Uint8Array([1, 2, 3, 4]);
		const [frame] = await runThrough<RTCEncodedAudioFrame>(t, audioFrame(plain.buffer.slice(0)));
		const bytes = new Uint8Array(frame!.data);
		expect(Array.from(bytes)).toEqual([1 ^ 0x5a, 2 ^ 0x5a, 3 ^ 0x5a, 4 ^ 0x5a]);
		expect(bytes).not.toEqual(plain);
	});

	test('empty frames pass through untouched', async () => {
		const t = createDaveEncodeTransform(fakeSend() as never);
		const [frame] = await runThrough<RTCEncodedAudioFrame>(t, audioFrame(new ArrayBuffer(0)));
		expect(new Uint8Array(frame!.data).length).toBe(0);
	});
});

describe('DAVE decode transform', () => {
	test('round-trips an encoded frame back to plaintext', async () => {
		const enc = createDaveEncodeTransform(fakeSend() as never);
		const dec = createDaveDecodeTransform(fakeRecv(true) as never);
		const plain = new Uint8Array([9, 8, 7, 6]);
		const [ct] = await runThrough<RTCEncodedAudioFrame>(enc, audioFrame(plain.buffer.slice(0)));
		const [pt] = await runThrough<RTCEncodedAudioFrame>(dec, ct!);
		expect(Array.from(new Uint8Array(pt!.data))).toEqual([9, 8, 7, 6]);
	});

	test('drops undecryptable frames when not passthrough', async () => {
		const dec = createDaveDecodeTransform(fakeRecv(false) as never);
		const out = await runThrough<RTCEncodedAudioFrame>(dec, audioFrame(new Uint8Array([1, 2, 3]).buffer.slice(0)));
		expect(out.length).toBe(0);
	});
});
