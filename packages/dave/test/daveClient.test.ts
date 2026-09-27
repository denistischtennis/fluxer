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
