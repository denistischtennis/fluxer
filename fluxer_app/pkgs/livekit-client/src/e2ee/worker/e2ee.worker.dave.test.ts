// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {beforeEach, describe, expect, test, vi} from 'vitest';

// Fakes standing in for @fluxer/dave's libdave-backed cryptors. XOR keeps the
// direction reversible so a decode of an encoded frame returns the original.
const fakes = vi.hoisted(() => {
	class FakeSendCryptor {
		static instances: FakeSendCryptor[] = [];
		ratchet: unknown = undefined;
		ssrc: number | null = null;
		codec: number | null = null;
		disposed = false;
		constructor(public mod: unknown) {
			FakeSendCryptor.instances.push(this);
		}
		setRatchet(r: unknown) {
			this.ratchet = r;
		}
		setPassthrough(_e: boolean) {}
		assignSsrc(s: number, c: number) {
			this.ssrc = s;
			this.codec = c;
		}
		encrypt(_mt: number, pt: Uint8Array) {
			return {bytes: Uint8Array.from(pt, (b) => b ^ 0x5a), encrypted: true};
		}
		dispose() {
			this.disposed = true;
		}
	}
	class FakeReceiveCryptor {
		static instances: FakeReceiveCryptor[] = [];
		transitions: unknown[] = [];
		passthrough: boolean | null = null;
		disposed = false;
		constructor(public mod: unknown) {
			FakeReceiveCryptor.instances.push(this);
		}
		transitionTo(r: unknown) {
			this.transitions.push(r);
		}
		setPassthrough(e: boolean) {
			this.passthrough = e;
		}
		decrypt(_mt: number, ct: Uint8Array) {
			return {bytes: Uint8Array.from(ct, (b) => b ^ 0x5a), ok: true};
		}
		dispose() {
			this.disposed = true;
		}
	}
	return {FakeSendCryptor, FakeReceiveCryptor};
});

vi.mock('@fluxer/dave', () => ({
	DaveSendCryptor: fakes.FakeSendCryptor,
	DaveReceiveCryptor: fakes.FakeReceiveCryptor,
}));
vi.mock('@fluxer/libdave/wasm', () => ({
	DaveModuleFactory: async () => ({}) as never,
}));

interface WorkerHarness {
	send: (msg: unknown) => void;
	dispatchTransform: (options: Record<string, unknown>, readable: ReadableStream, writable: WritableStream) => void;
	posted: unknown[];
}

// The worker's queue and WASM-loading are promise-driven with no completion
// events to await; poll the asserted condition itself (bounded, fails with the
// named condition, never a guessed fixed sleep).
async function waitFor(cond: () => boolean, what = 'condition', ms = 2000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) {
			throw new Error(`timed out waiting for ${what}`);
		}
		const {promise, resolve} = Promise.withResolvers<void>();
		setTimeout(resolve, 1);
		await promise;
	}
}

async function loadDaveWorker(): Promise<WorkerHarness> {
	const posted: unknown[] = [];
	let messageListener: ((ev: {data: unknown}) => void) | undefined;
	const stub: Record<string, unknown> = {
		addEventListener: (type: string, fn: (ev: {data: unknown}) => void) => {
			if (type === 'message') {
				messageListener = fn;
			}
		},
		RTCTransformEvent: class {},
		onrtctransform: null,
	};
	(globalThis as Record<string, unknown>).self = stub;
	(globalThis as Record<string, unknown>).postMessage = (msg: unknown) => {
		posted.push(msg);
	};
	await import('./e2ee.worker.ts');
	const send = (msg: unknown) => {
		messageListener!({data: msg});
	};
	send({
		kind: 'init',
		data: {
			keyProviderOptions: {
				ratchetSalt: 'salt',
				ratchetWindowSize: 8,
				failureTolerance: 10,
				keyringSize: 16,
				keySize: 128,
			},
			loglevel: 'error',
			mode: 'dave',
		},
	});
	await waitFor(() => posted.some((m) => (m as {kind?: string}).kind === 'initAck'), 'worker initAck');
	return {
		send,
		dispatchTransform: (options, readable, writable) => {
			const handler = stub.onrtctransform as (ev: unknown) => void;
			handler({transformer: {options, readable, writable}});
		},
	};
}

function audioFrame(bytes: number[]): RTCEncodedAudioFrame {
	const data = Uint8Array.from(bytes).buffer;
	return {
		data,
		timestamp: 0,
		getMetadata: () => ({synchronizationSource: 1}),
	} as unknown as RTCEncodedAudioFrame;
}

function collectStream(): {writable: WritableStream<RTCEncodedAudioFrame>; chunks: RTCEncodedAudioFrame[]} {
	const chunks: RTCEncodedAudioFrame[] = [];
	const writable = new WritableStream<RTCEncodedAudioFrame>({
		write(frame) {
			chunks.push(frame);
		},
	});
	return {writable, chunks};
}

function singleFrameSource(bytes: number[]): ReadableStream<RTCEncodedAudioFrame> {
	return new ReadableStream<RTCEncodedAudioFrame>({
		start(controller) {
			controller.enqueue(audioFrame(bytes));
			controller.close();
		},
	});
}

beforeEach(() => {
	vi.resetModules();
	fakes.FakeSendCryptor.instances.length = 0;
	fakes.FakeReceiveCryptor.instances.length = 0;
});

describe('e2ee worker DAVE routing (F2)', () => {
	test('onrtctransform encode routes frames through the DAVE send cryptor', async () => {
		const h = await loadDaveWorker();
		const {writable, chunks} = collectStream();
		h.dispatchTransform(
			{kind: 'encode', participantIdentity: 'alice', trackId: 'mic', hasPacketTrailer: false},
			singleFrameSource([1, 2, 3]),
			writable,
		);
		await waitFor(() => chunks.length === 1, 'encoded frame');
		expect(Array.from(new Uint8Array(chunks[0]!.data))).toEqual([1 ^ 0x5a, 2 ^ 0x5a, 3 ^ 0x5a]);
		expect(fakes.FakeSendCryptor.instances.length).toBe(1);
		// No receive cryptor may be created for our own outbound sender.
		expect(fakes.FakeReceiveCryptor.instances.length).toBe(0);
	});

	test('onrtctransform decode routes frames through the DAVE receive cryptor', async () => {
		const h = await loadDaveWorker();
		const {writable, chunks} = collectStream();
		h.dispatchTransform(
			{kind: 'decode', participantIdentity: 'bob', trackId: 'remote-mic', hasPacketTrailer: false},
			singleFrameSource([10, 20, 30]),
			writable,
		);
		await waitFor(() => chunks.length === 1, 'decoded frame');
		expect(Array.from(new Uint8Array(chunks[0]!.data))).toEqual([10 ^ 0x5a, 20 ^ 0x5a, 30 ^ 0x5a]);
		expect(fakes.FakeReceiveCryptor.instances.length).toBe(1);
		expect(fakes.FakeSendCryptor.instances.length).toBe(0);
	});

	test('message-driven encode/decode also route through DAVE in dave mode', async () => {
		const h = await loadDaveWorker();
		const enc = collectStream();
		h.send({
			kind: 'encode',
			data: {
				participantIdentity: 'alice',
				trackId: 'mic',
				readableStream: singleFrameSource([5]),
				writableStream: enc.writable,
				hasPacketTrailer: false,
			},
		});
		await waitFor(() => enc.chunks.length === 1, 'message-driven encoded frame');
		expect(Array.from(new Uint8Array(enc.chunks[0]!.data))).toEqual([5 ^ 0x5a]);

		const dec = collectStream();
		h.send({
			kind: 'decode',
			data: {
				participantIdentity: 'bob',
				trackId: 'remote-mic',
				readableStream: singleFrameSource([7]),
				writableStream: dec.writable,
				hasPacketTrailer: false,
			},
		});
		await waitFor(() => dec.chunks.length === 1, 'message-driven decoded frame');
		expect(Array.from(new Uint8Array(dec.chunks[0]!.data))).toEqual([7 ^ 0x5a]);
	});
});

describe('e2ee worker DAVE cryptor lifecycle (F4)', () => {
	test('daveSetRatchet for a remote identity never creates a send cryptor', async () => {
		const h = await loadDaveWorker();
		const ratchet = {cipherSuite: 1, baseSecret: [9, 9]};
		h.send({kind: 'daveSetRatchet', data: {participantIdentity: 'bob', isLocal: false, ratchet}});
		await waitFor(() => fakes.FakeReceiveCryptor.instances.length >= 1, 'remote receive cryptor');
		expect(fakes.FakeSendCryptor.instances.length).toBe(0);
		expect(fakes.FakeReceiveCryptor.instances[0]!.transitions).toEqual([ratchet]);
	});

	test('local ratchet fans out to live send cryptors and to tracks created later', async () => {
		const h = await loadDaveWorker();
		const {writable, chunks} = collectStream();
		h.dispatchTransform(
			{kind: 'encode', participantIdentity: 'alice', trackId: 'mic', hasPacketTrailer: false},
			singleFrameSource([1]),
			writable,
		);
		await waitFor(() => chunks.length === 1, 'first encoded frame');
		const first = fakes.FakeSendCryptor.instances[0]!;
		expect(first.ratchet).toBeUndefined();

		const ratchet = {cipherSuite: 1, baseSecret: [4]};
		h.send({kind: 'daveSetRatchet', data: {participantIdentity: 'alice', isLocal: true, ratchet}});
		await waitFor(() => first.ratchet !== undefined, 'fan-out to live send cryptor');

		// A second outbound track created after the ratchet push picks it up at construction.
		const cam = collectStream();
		h.dispatchTransform(
			{kind: 'encode', participantIdentity: 'alice', trackId: 'camera', hasPacketTrailer: false},
			singleFrameSource([2]),
			cam.writable,
		);
		await waitFor(() => cam.chunks.length === 1, 'second track encoded frame');
		const second = fakes.FakeSendCryptor.instances[1]!;
		expect(second.ratchet).toEqual(ratchet);
	});

	test('removeTransform releases the per-track send cryptor once its pipe ends', async () => {
		const h = await loadDaveWorker();
		const {writable, chunks} = collectStream();
		h.dispatchTransform(
			{kind: 'encode', participantIdentity: 'alice', trackId: 'mic', hasPacketTrailer: false},
			singleFrameSource([1]),
			writable,
		);
		await waitFor(() => chunks.length === 1, 'encoded frame before removal');
		const inst = fakes.FakeSendCryptor.instances[0]!;
		h.send({kind: 'removeTransform', data: {participantIdentity: 'alice', trackId: 'mic'}});
		await waitFor(() => inst.disposed, 'send cryptor disposal');
		// A fresh transform for the same track builds a NEW cryptor (map entry was released).
		const again = collectStream();
		h.dispatchTransform(
			{kind: 'encode', participantIdentity: 'alice', trackId: 'mic', hasPacketTrailer: false},
			singleFrameSource([3]),
			again.writable,
		);
		await waitFor(() => again.chunks.length === 1, 're-created track encoded frame');
		expect(fakes.FakeSendCryptor.instances.length).toBe(2);
		expect(fakes.FakeSendCryptor.instances[1]).not.toBe(inst);
	});

	test('null ratchet for a remote peer releases its receive cryptor', async () => {
		const h = await loadDaveWorker();
		const ratchet = {cipherSuite: 1, baseSecret: [9]};
		h.send({kind: 'daveSetRatchet', data: {participantIdentity: 'bob', isLocal: false, ratchet}});
		await waitFor(() => fakes.FakeReceiveCryptor.instances.length >= 1, 'remote receive cryptor');
		const recv = fakes.FakeReceiveCryptor.instances[0]!;
		h.send({kind: 'daveSetRatchet', data: {participantIdentity: 'bob', isLocal: false, ratchet: null}});
		await waitFor(() => recv.disposed, 'receive cryptor release on forget');
	});

	test('daveAssignCodec before transform setup is applied at cryptor creation', async () => {
		const h = await loadDaveWorker();
		h.send({
			kind: 'daveAssignCodec',
			data: {participantIdentity: 'alice', trackId: 'mic', ssrc: 123456, codec: 1},
		});
		// The codec assignment alone must not instantiate a cryptor...
		expect(fakes.FakeSendCryptor.instances.length).toBe(0);
		// ...but the later transform creation consumes the pending assignment.
		const {writable, chunks} = collectStream();
		h.dispatchTransform(
			{kind: 'encode', participantIdentity: 'alice', trackId: 'mic', hasPacketTrailer: false},
			singleFrameSource([1]),
			writable,
		);
		await waitFor(() => fakes.FakeSendCryptor.instances.length >= 1 && chunks.length === 1, 'codec-bound cryptor');
		const inst = fakes.FakeSendCryptor.instances[0]!;
		expect(inst.ssrc).toBe(123456);
		expect(inst.codec).toBe(1);
	});

	test('davePassthrough applies to lazily created receive cryptors', async () => {
		const h = await loadDaveWorker();
		h.send({kind: 'davePassthrough', data: {participantIdentity: 'bob', enabled: true}});
		expect(fakes.FakeReceiveCryptor.instances.length).toBe(0);
		const {writable, chunks} = collectStream();
		h.dispatchTransform(
			{kind: 'decode', participantIdentity: 'bob', trackId: 'remote-mic', hasPacketTrailer: false},
			singleFrameSource([4]),
			writable,
		);
		await waitFor(() => chunks.length === 1, 'passthrough-mode frame');
		expect(fakes.FakeReceiveCryptor.instances[0]!.passthrough).toBe(true);
	});
});
