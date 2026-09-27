// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {describe, expect, test, vi} from 'vitest';
import {ParticipantEvent, RoomEvent} from '../room/events.ts';

// Browser capability gates are environment probes; force them supported so the
// manager takes the script-transform path in node.
vi.mock('./utils.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./utils.ts')>();
	return {
		...actual,
		isE2EESupported: () => true,
		isScriptTransformSupportedForWorker: () => true,
	};
});

// The script-transform capability probe lives in room utils; force it on so the
// manager installs RTCRtpScriptTransform instead of legacy encoded streams.
vi.mock('../room/utils.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../room/utils.ts')>();
	return {
		...actual,
		isScriptTransformSupportedForWorker: () => true,
		isLocalTrack: (track: unknown) => Boolean((track as {isLocal?: boolean} | null)?.isLocal),
	};
});

class FakeScriptTransform {
	constructor(
		public worker: Worker,
		public options: unknown,
	) {}
}

type FakeWorker = Worker & {postMessage: ReturnType<typeof vi.fn>};

function makeFakeWorker(): FakeWorker {
	return {
		postMessage: vi.fn(),
		onmessage: null,
		onerror: null,
		terminate: vi.fn(),
	} as unknown as FakeWorker;
}

function makeFakeRoom(localIdentity: string) {
	const events = new Map<string, Array<(...args: unknown[]) => void>>();
	const localEvents = new Map<string, Array<(...args: unknown[]) => void>>();
	const register = (
		store: Map<string, Array<(...args: unknown[]) => void>>,
		event: string,
		cb: (...args: unknown[]) => void,
	) => {
		const list = store.get(event) ?? [];
		list.push(cb);
		store.set(event, list);
	};
	const room = {
		name: 'test-room',
		localParticipant: {
			identity: localIdentity,
			isE2EEEnabled: true,
			on: (event: string, cb: (...args: unknown[]) => void) => register(localEvents, event, cb),
		},
		on: (event: string, cb: (...args: unknown[]) => void) => register(events, event, cb),
		emit: (event: string, ...args: unknown[]) => {
			for (const cb of events.get(event) ?? []) cb(...args);
		},
		getParticipantByIdentity: () => undefined,
		remoteParticipants: new Map(),
	};
	return {room, localEvents};
}

async function setupDaveManager() {
	(globalThis as Record<string, unknown>).RTCRtpScriptTransform = FakeScriptTransform;
	const {E2EEManager} = await import('./E2eeManager.ts');
	const worker = makeFakeWorker();
	const manager = new E2EEManager({worker, mode: 'dave'}, false);
	const {room, localEvents} = makeFakeRoom('alice');
	manager.setup(room as never);
	return {manager, worker, room, localEvents};
}

describe('E2EEManager DAVE-mode setup (F1)', () => {
	test('initializes the worker in dave mode', async () => {
		const {worker} = await setupDaveManager();
		const initMsg = worker.postMessage.mock.calls.map((c) => c[0]).find((m) => m?.kind === 'init');
		expect(initMsg).toBeDefined();
		expect(initMsg.data.mode).toBe('dave');
	});

	test('installs receiver/sender transform listeners in dave mode', async () => {
		const {room, localEvents} = await setupDaveManager();
		// The listeners that wire every subscribed remote receiver and every local
		// sender to the worker must be registered even without a key provider.
		expect(localEvents.has(ParticipantEvent.LocalSenderCreated)).toBe(true);

		const receiver: Record<string, unknown> = {};
		const remoteTrack = {receiver, mediaStreamID: 'remote-mic', kind: 'audio'};
		room.emit(RoomEvent.TrackSubscribed, remoteTrack, {trackInfo: {mimeType: 'audio/opus'}}, {identity: 'bob'});
		expect(receiver.transform).toBeInstanceOf(FakeScriptTransform);
		expect((receiver.transform as InstanceType<typeof FakeScriptTransform>).options).toMatchObject({
			kind: 'decode',
			participantIdentity: 'bob',
			trackId: 'remote-mic',
		});

		const sender: Record<string, unknown> = {};
		const localTrack = {mediaStreamID: 'local-mic', kind: 'audio', isLocal: true};
		const senderCreated = (localEvents.get(ParticipantEvent.LocalSenderCreated) ?? [])[0];
		expect(senderCreated).toBeDefined();
		await senderCreated(sender, localTrack, undefined, 'local-mic');
		expect(sender.transform).toBeInstanceOf(FakeScriptTransform);
		expect((sender.transform as InstanceType<typeof FakeScriptTransform>).options).toMatchObject({
			kind: 'encode',
			participantIdentity: 'alice',
			trackId: 'local-mic',
		});
	});

	test('unsubscribing a remote track removes the transform in the worker', async () => {
		const {worker, room} = await setupDaveManager();
		worker.postMessage.mockClear();
		room.emit(RoomEvent.TrackUnsubscribed, {mediaStreamID: 'remote-mic'}, {}, {identity: 'bob'});
		const removed = worker.postMessage.mock.calls.map((c) => c[0]).find((m) => m?.kind === 'removeTransform');
		expect(removed).toMatchObject({data: {participantIdentity: 'bob', trackId: 'remote-mic'}});
	});

	test('setParticipantRatchet marks only the local identity as isLocal', async () => {
		const {manager, worker} = await setupDaveManager();
		worker.postMessage.mockClear();
		const ratchet = {cipherSuite: 1, baseSecret: [1, 2, 3]};
		manager.setParticipantRatchet('alice', ratchet);
		manager.setParticipantRatchet('bob', ratchet);
		const msgs = worker.postMessage.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'daveSetRatchet');
		expect(msgs).toHaveLength(2);
		expect(msgs[0]).toMatchObject({data: {participantIdentity: 'alice', isLocal: true}});
		expect(msgs[1]).toMatchObject({data: {participantIdentity: 'bob', isLocal: false}});
	});
});
