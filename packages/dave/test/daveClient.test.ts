// SPDX-License-Identifier: AGPL-3.0-or-later

// Replay test: drive two DaveClient instances through a group founding using the
// REAL libdave WASM (node artefact injected as the module) plus a scripted
// delivery-service relay. Proves the client's down-event handling invokes the
// correct Session calls and that peers converge on identical ratchets.

import {beforeAll, describe, expect, test} from 'vitest';
import {DaveNodeModuleFactory, type DaveNodeModule} from '@fluxer/libdave/delivery';
import {DaveClient, type DaveUpMessage, type DaveTransport} from '../src/DaveClient.js';
import {TofuStore} from '../src/tofuStore.js';

class MemStorage {
	private map = new Map<string, string>();
	getItem(k: string): string | null {
		return this.map.has(k) ? (this.map.get(k) as string) : null;
	}
	setItem(k: string, v: string): void {
		this.map.set(k, v);
	}
	removeItem(k: string): void {
		this.map.delete(k);
	}
}

const GROUP = '999';
const USER_A = '1000000000000000001';
const USER_B = '1000000000000000002';

let mod: DaveNodeModule;

function b64(bytes: number[] | Uint8Array): string {
	const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
	return Buffer.from(arr).toString('base64');
}
function unb64(s: string): Uint8Array {
	return new Uint8Array(Buffer.from(s, 'base64'));
}

class RecordingTransport implements DaveTransport {
	public readonly sent: DaveUpMessage[] = [];
	send(msg: DaveUpMessage): void {
		this.sent.push(msg);
	}
	last(type: DaveUpMessage['type']): DaveUpMessage | undefined {
		return [...this.sent].reverse().find((m) => m.type === type);
	}
}

beforeAll(async () => {
	mod = await DaveNodeModuleFactory();
});

test('two clients found a group via the relay and share a ratchet', () => {
	const delivery = new mod.DaveDelivery();
	const gen = delivery.GenerateExternalSender(Array.from({length: 32}, (_, i) => (i * 13 + 1) & 0xff));
	expect(gen.error).toBeUndefined();
	const senderB64 = b64(gen.senderPackage as number[]);

	const tA = new RecordingTransport();
	const tB = new RecordingTransport();
	const a = new DaveClient({
		mod,
		selfUserId: USER_A,
		channelId: GROUP,
		transport: tA,
		tofu: new TofuStore(new MemStorage()),
	});
	const b = new DaveClient({
		mod,
		selfUserId: USER_B,
		channelId: GROUP,
		transport: tB,
		tofu: new TofuStore(new MemStorage()),
	});

	// Join handshake.
	a.onEvent({type: 'select_protocol_ack', version: 1});
	b.onEvent({type: 'select_protocol_ack', version: 1});
	a.onEvent({type: 'external_sender_package', data: senderB64});
	b.onEvent({type: 'external_sender_package', data: senderB64});

	// Voice-state roster recognition: each client must know the peer before the
	// MLS add proposal for that peer is accepted.
	a.recognizeUser(USER_B);
	b.recognizeUser(USER_A);
	const kpA = tA.last('key_package')?.data;
	const kpB = tB.last('key_package')?.data;
	expect(kpA).toBeTruthy();
	expect(kpB).toBeTruthy();

	// Delivery service proposes adding B to A's group at epoch 0.
	const proposals = delivery.CreateProposals(GROUP, 0, [unb64(kpB as string)], []);
	expect(proposals).not.toBeNull();
	const proposalsB64 = b64(proposals as number[]);

	// Only the existing member (A) processes proposals and commits.
	a.onEvent({type: 'proposals', data: proposalsB64});
	const commitWelcome = tA.last('commit_welcome')?.data;
	expect(commitWelcome).toBeTruthy();

	// DS parses the winning commit/welcome.
	const parsed = delivery.ParseCommitWelcome(GROUP, 0, USER_A, unb64(commitWelcome as string), proposals, []);
	expect(parsed.ok).toBe(true);
	const commitB64 = b64(parsed.commit as number[]);
	const welcomeB64 = b64(parsed.welcome as number[]);

	// Announce the commit to A; send the welcome to B.
	a.onEvent({type: 'announce_commit_transition', transition_id: 1, data: commitB64});
	b.onEvent({type: 'welcome', transition_id: 1, data: welcomeB64});

	// Both should now be able to derive the same ratchet for A.
	const rA = a.getRatchet(USER_A);
	const rB = b.getRatchet(USER_A);
	expect(rA).not.toBeNull();
	expect(rB).not.toBeNull();
	expect(rA?.cipherSuite).toBe(2);
	expect(rA?.baseSecret).toEqual(rB?.baseSecret);

	// TOFU pinned on first sender presentation; both clients report the group
	// established after applying the winning commit / welcome.
	expect(a.getTofuStatus()).toBe('pinned');
	expect(b.getTofuStatus()).toBe('pinned');
	expect(a.status).toBe('established');
	expect(b.status).toBe('established');

	a.destroy();
	b.destroy();
});

test('passthrough path (version 0) resets without MLS ops', () => {
	const t = new RecordingTransport();
	const c = new DaveClient({mod, selfUserId: USER_A, channelId: GROUP, transport: t});
	c.onEvent({type: 'select_protocol_ack', version: 0});
	// Version 0 -> no key_package emitted (init transition executes immediately).
	expect(t.last('key_package')).toBeUndefined();
	expect(c.getRatchet(USER_A)).toBeNull();
	c.destroy();
});

test('a bad commit after processing proposals flags invalid_commit_welcome', () => {
	const delivery = new mod.DaveDelivery();
	const gen = delivery.GenerateExternalSender(Array.from({length: 32}, (_, i) => i));
	const senderB64 = b64(gen.senderPackage as number[]);

	const tPeer = new RecordingTransport();
	const peer = new DaveClient({mod, selfUserId: USER_B, channelId: GROUP, transport: tPeer});
	peer.onEvent({type: 'select_protocol_ack', version: 1});
	peer.onEvent({type: 'external_sender_package', data: senderB64});
	const kpPeer = tPeer.last('key_package')?.data as string;

	const t = new RecordingTransport();
	const c = new DaveClient({mod, selfUserId: USER_A, channelId: GROUP, transport: t});
	c.onEvent({type: 'select_protocol_ack', version: 1});
	c.onEvent({type: 'external_sender_package', data: senderB64});
	c.recognizeUser(USER_B);

	// Queue a real proposal so the client has stateWithProposals_.
	const proposals = delivery.CreateProposals(GROUP, 0, [unb64(kpPeer)], []);
	c.onEvent({type: 'proposals', data: b64(proposals as number[])});
	expect(t.last('commit_welcome')).toBeTruthy();

	// Now a garbage commit announcement -> ProcessCommit fails (has state) -> invalid.
	c.onEvent({type: 'announce_commit_transition', transition_id: 5, data: b64([0x00, 0x01, 0x02])});
	expect(t.last('invalid_commit_welcome')).toBeTruthy();

	c.destroy();
	peer.destroy();
});

test('refound via prepare_epoch re-uploads key package without a new sender event', () => {
	const t = new RecordingTransport();
	const a = new DaveClient({mod, selfUserId: USER_A, channelId: GROUP, transport: t, tofu: new TofuStore(new MemStorage())});
	a.onEvent({type: 'select_protocol_ack', version: 1});
	// No sender installed yet -> founding upload deferred, nothing sent.
	expect(t.sent.filter((m) => m.type === 'key_package').length).toBe(0);
	const delivery = new mod.DaveDelivery();
	const gen = delivery.GenerateExternalSender(Array.from({length: 32}, (_, i) => (i * 7 + 3) & 0xff));
	a.onEvent({type: 'external_sender_package', data: b64(gen.senderPackage as number[])});
	const firstKp = t.sent.filter((m) => m.type === 'key_package');
	expect(firstKp.length).toBe(1);
	expect((firstKp[0].data ?? '').length).toBeGreaterThan(200);
	// Simulate the coordinator's single-member-reset / invalid-commit re-found:
	// a bare prepare_epoch(1) must immediately produce a fresh key package by
	// reinstalling the known DS sender into the re-initialized session.
	a.onEvent({type: 'prepare_epoch', epoch: 1, version: 1});
	const ups = t.sent.filter((m) => m.type === 'key_package');
	expect(ups.length).toBe(2);
	expect(ups[1].data).not.toBe(ups[0].data);
	expect(a.status).not.toBe('broken');
	a.destroy();
});

test('proposals for an unrecognized user defer and commit on recognition', () => {
	const delivery = new mod.DaveDelivery();
	const gen = delivery.GenerateExternalSender(Array.from({length: 32}, (_, i) => (i * 7 + 3) & 0xff));
	const senderB64 = b64(gen.senderPackage as number[]);
	// B's KP via a throwaway client B.
	const tb = new RecordingTransport();
	const b = new DaveClient({mod, selfUserId: USER_B, channelId: GROUP, transport: tb, tofu: new TofuStore(new MemStorage())});
	b.onEvent({type: 'select_protocol_ack', version: 1});
	b.onEvent({type: 'external_sender_package', data: senderB64});
	const kpB = unb64(tb.last('key_package')!.data as string);
	const bundle = b64(delivery.CreateProposals(GROUP, 0, [kpB], []) as number[]);

	const ta = new RecordingTransport();
	const a = new DaveClient({mod, selfUserId: USER_A, channelId: GROUP, transport: ta, tofu: new TofuStore(new MemStorage())});
	a.onEvent({type: 'select_protocol_ack', version: 1});
	a.onEvent({type: 'external_sender_package', data: senderB64});
	// Bundle arrives BEFORE B is recognized: must defer, not break.
	a.onEvent({type: 'proposals', data: bundle});
	expect(ta.last('commit_welcome')).toBeUndefined();
	expect(a.status).not.toBe('broken');
	// Recognition of the added user releases the held bundle.
	a.recognizeUser(USER_B);
	const cw = ta.last('commit_welcome');
	expect(cw).toBeDefined();
	expect((cw!.data ?? '').length).toBeGreaterThan(200);
	a.destroy();
	b.destroy();
});

test('duplicate deliveries of the same proposals bundle are processed once', async () => {
	const delivery = new mod.DaveDelivery();
	const gen = delivery.GenerateExternalSender(Array.from({length: 32}, (_, i) => (i * 7 + 3) & 0xff));
	const senderB64 = b64(gen.senderPackage as number[]);
	const tb = new RecordingTransport();
	const b = new DaveClient({mod, selfUserId: USER_B, channelId: GROUP, transport: tb, tofu: new TofuStore(new MemStorage())});
	b.onEvent({type: 'select_protocol_ack', version: 1});
	b.onEvent({type: 'external_sender_package', data: senderB64});
	const bundle = b64(delivery.CreateProposals(GROUP, 0, [unb64(tb.last('key_package')!.data as string)], []) as number[]);
	const ta = new RecordingTransport();
	const a = new DaveClient({mod, selfUserId: USER_A, channelId: GROUP, transport: ta, tofu: new TofuStore(new MemStorage())});
	a.onEvent({type: 'select_protocol_ack', version: 1});
	a.onEvent({type: 'external_sender_package', data: senderB64});
	a.recognizeUser(USER_B);
	a.onEvent({type: 'proposals', data: bundle});
	a.onEvent({type: 'proposals', data: bundle});
	a.onEvent({type: 'proposals', data: bundle});
	expect(ta.sent.filter((m) => m.type === 'commit_welcome').length).toBe(1);
	expect(a.status).not.toBe('broken');
	a.destroy();
	b.destroy();
});


// --- regression tests: rejoin / reset-flag hygiene -----------------------

function makeClient(userId: string, transport: RecordingTransport): DaveClient {
	return new DaveClient({mod, selfUserId: userId, channelId: GROUP, transport, tofu: new TofuStore(new MemStorage())});
}

interface EstablishedFixture {
	delivery: InstanceType<DaveNodeModule['DaveDelivery']>;
	senderB64: string;
	a: DaveClient;
	b: DaveClient;
	ta: RecordingTransport;
	tb: RecordingTransport;
}

function driveToEstablished(seed: number): EstablishedFixture {
	const delivery = new mod.DaveDelivery();
	const gen = delivery.GenerateExternalSender(Array.from({length: 32}, (_, i) => (i * seed + 5) & 0xff));
	const senderB64 = b64(gen.senderPackage as number[]);
	const ta = new RecordingTransport();
	const tb = new RecordingTransport();
	const a = makeClient(USER_A, ta);
	const b = makeClient(USER_B, tb);
	a.onEvent({type: 'select_protocol_ack', version: 1});
	b.onEvent({type: 'select_protocol_ack', version: 1});
	a.onEvent({type: 'external_sender_package', data: senderB64});
	b.onEvent({type: 'external_sender_package', data: senderB64});
	a.recognizeUser(USER_B);
	b.recognizeUser(USER_A);
	const kpB = tb.last('key_package')!.data as string;
	const proposals = delivery.CreateProposals(GROUP, 0, [unb64(kpB)], []);
	a.onEvent({type: 'proposals', data: b64(proposals as number[])});
	const parsed = delivery.ParseCommitWelcome(GROUP, 0, USER_A, unb64(ta.last('commit_welcome')!.data as string), proposals, []);
	a.onEvent({type: 'announce_commit_transition', transition_id: 1, data: b64(parsed.commit as number[])});
	b.onEvent({type: 'welcome', transition_id: 1, data: b64(parsed.welcome as number[])});
	return {delivery, senderB64, a, b, ta, tb};
}

test('established flag is cleared when a new group generation is prepared', () => {
	const f = driveToEstablished(11);
	expect(f.a.status).toBe('established');
	// A bare prepare_epoch(1) (coordinator re-found / single-member reset) must
	// drop establishment so the client re-handshakes instead of lying.
	f.a.onEvent({type: 'prepare_epoch', epoch: 1, version: 1});
	expect(f.a.status).not.toBe('established');
	expect(f.a.status).toBe('handshaking');
	// The fresh generation re-uploads a key package immediately (sender cached).
	expect(f.ta.sent.filter((m) => m.type === 'key_package').length).toBeGreaterThan(1);
	f.a.destroy();
	f.b.destroy();
});

test('a deferred proposals bundle is dropped when a new group is prepared', () => {
	const delivery = new mod.DaveDelivery();
	const gen = delivery.GenerateExternalSender(Array.from({length: 32}, (_, i) => (i * 3 + 1) & 0xff));
	const senderB64 = b64(gen.senderPackage as number[]);
	const tb = new RecordingTransport();
	const b = makeClient(USER_B, tb);
	b.onEvent({type: 'select_protocol_ack', version: 1});
	b.onEvent({type: 'external_sender_package', data: senderB64});
	const bundle = b64(delivery.CreateProposals(GROUP, 0, [unb64(tb.last('key_package')!.data as string)], []) as number[]);

	const ta = new RecordingTransport();
	const a = makeClient(USER_A, ta);
	a.onEvent({type: 'select_protocol_ack', version: 1});
	a.onEvent({type: 'external_sender_package', data: senderB64});
	// Defer the bundle (B not recognized yet).
	a.onEvent({type: 'proposals', data: bundle});
	expect(ta.last('commit_welcome')).toBeUndefined();
	// A new group generation invalidates the held bundle; recognition must NOT
	// resurrect it (its epoch binding belongs to the discarded group).
	a.onEvent({type: 'prepare_epoch', epoch: 1, version: 1});
	a.recognizeUser(USER_B);
	expect(ta.last('commit_welcome')).toBeUndefined();
	a.destroy();
	b.destroy();
});

test('getRatchet returns null before the group is established (no WASM log spam)', () => {
	const t = new RecordingTransport();
	const a = makeClient(USER_A, t);
	a.onEvent({type: 'select_protocol_ack', version: 1});
	a.onEvent({type: 'external_sender_package', data: b64(new mod.DaveDelivery().GenerateExternalSender(Array.from({length: 32}, (_, i) => i & 0xff)).senderPackage as number[])});
	// Not established yet: no ratchet available, and crucially we never call
	// into Session.GetKeyRatchet (which would log "Cannot get key ratchet").
	expect(a.getRatchet(USER_A)).toBeNull();
	expect(a.getRatchet(USER_B)).toBeNull();
	a.destroy();
});

test('external_sender_package arriving after establishment does not poison the session', () => {
	const f = driveToEstablished(17);
	expect(f.a.status).toBe('established');
	const before = f.ta.sent.length;
	// Coordinator re-sends the SAME DS package (e.g. another member rejoined).
	// Established session must NOT call SetExternalSender (WASM throws post-join
	// -> failure callback -> mlsFailed) and must stay usable.
	f.a.onEvent({type: 'external_sender_package', data: f.senderB64});
	expect(f.a.status).toBe('established');
	expect(f.a.getTofuStatus()).toBe('pinned');
	// No doomed KP re-upload attempt; the current session simply caches the
	// sender for the next generation and stays usable.
	expect(f.ta.sent.length).toBe(before);
	expect(f.a.getRatchet(USER_A)).not.toBeNull();
	f.a.destroy();
	f.b.destroy();
});

test('invalid commit recovery reports the flag and re-uploads a key package', () => {
	const f = driveToEstablished(19);
	const before = f.ta.sent.length;
	// Garbage commit -> ProcessCommit fails -> report invalid + fresh KP.
	f.a.onEvent({type: 'announce_commit_transition', transition_id: 7, data: b64([0x00, 0x01, 0x02])});
	expect(f.ta.last('invalid_commit_welcome')).toBeTruthy();
	expect(f.ta.last('key_package')).toBeTruthy();
	// The hard MLS failure marks the session broken (fail-closed) until the
	// coordinator recovers it with a fresh prepare_epoch.
	expect(f.a.status).toBe('broken');
	// Recovery: prepare_epoch clears the failure and starts a clean handshake.
	f.a.onEvent({type: 'prepare_epoch', epoch: 1, version: 1});
	expect(f.a.status).toBe('handshaking');
	// Only the two uplink messages were added at the failure point; no extra
	// init chatter from a self-triggered reset storm.
	expect(f.ta.sent[before].type).toBe('invalid_commit_welcome');
	expect(f.ta.sent[before + 1].type).toBe('key_package');
	f.a.destroy();
	f.b.destroy();
});

// Simulates the adapter's early-event-buffer replay: a fresh client receives
// [select_protocol_ack, external_sender_package] in one burst AFTER the LiveKit
// connect resolved (the gateway pushed them at token-issue time). The client must
// converge to an uploaded key package exactly as if they arrived live.
test('replayed ack+sender burst on a fresh client uploads its key package', () => {
	const delivery = new mod.DaveDelivery();
	const gen = delivery.GenerateExternalSender(Array.from({length: 32}, (_, i) => (i * 23 + 7) & 0xff));
	const senderB64 = b64(gen.senderPackage as number[]);
	const t = new RecordingTransport();
	const a = makeClient(USER_A, t);
	// Burst replay order mirrors the downlink stream: ack first, then DS package.
	a.onEvent({type: 'select_protocol_ack', version: 1});
	a.onEvent({type: 'external_sender_package', data: senderB64});
	const kp = t.last('key_package');
	expect(kp).toBeTruthy();
	expect((kp!.data ?? '').length).toBeGreaterThan(200);
	expect(a.status).toBe('handshaking');
	expect(a.getTofuStatus()).toBe('pinned');
	a.destroy();
});
