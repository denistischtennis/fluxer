// SPDX-License-Identifier: AGPL-3.0-or-later

// Proves the verification UI primitives produce matching values across peers:
// every established member sees the same room code, and the pairwise safety
// number A computes for B equals the one B computes for A. Runs against the real
// libdave WASM via the group-founding relay.

import {beforeAll, describe, expect, test} from 'vitest';
import {DaveNodeModuleFactory, type DaveNodeModule} from '@fluxer/libdave/delivery';
import {DaveClient, type DaveTransport, type DaveUpMessage} from '../src/DaveClient.js';
import {roomDisplayCode, safetyNumber} from '../src/safetyNumbers.js';

const GROUP = '777';
const USER_A = '1000000000000000011';
const USER_B = '1000000000000000022';

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

async function foundGroup(): Promise<{a: DaveClient; b: DaveClient}> {
	const delivery = new mod.DaveDelivery();
	const gen = delivery.GenerateExternalSender(Array.from({length: 32}, (_, i) => (i * 7 + 3) & 0xff));
	const senderB64 = b64(gen.senderPackage as number[]);

	const tA = new RecordingTransport();
	const tB = new RecordingTransport();
	const a = new DaveClient({mod, selfUserId: USER_A, channelId: GROUP, transport: tA});
	const b = new DaveClient({mod, selfUserId: USER_B, channelId: GROUP, transport: tB});

	a.onEvent({type: 'select_protocol_ack', version: 1});
	b.onEvent({type: 'select_protocol_ack', version: 1});
	a.onEvent({type: 'external_sender_package', data: senderB64});
	b.onEvent({type: 'external_sender_package', data: senderB64});
	a.recognizeUser(USER_B);
	b.recognizeUser(USER_A);

	const kpB = tB.last('key_package')?.data;
	expect(kpB).toBeTruthy();
	const proposals = delivery.CreateProposals(GROUP, 0, [unb64(kpB as string)], []);
	a.onEvent({type: 'proposals', data: b64(proposals as number[])});
	const commitWelcome = tA.last('commit_welcome')?.data;
	expect(commitWelcome).toBeTruthy();
	const parsed = delivery.ParseCommitWelcome(GROUP, 0, USER_A, unb64(commitWelcome as string), proposals, []);
	expect(parsed.ok).toBe(true);
	a.onEvent({type: 'announce_commit_transition', transition_id: 1, data: b64(parsed.commit as number[])});
	b.onEvent({type: 'welcome', transition_id: 1, data: b64(parsed.welcome as number[])});
	return {a, b};
}

describe('DAVE verification primitives', () => {
	beforeAll(async () => {
		mod = await DaveNodeModuleFactory();
	});

	test('both members derive the identical room display code', async () => {
		const {a, b} = await foundGroup();
		const codeA = roomDisplayCode(a.epochAuthenticator());
		const codeB = roomDisplayCode(b.epochAuthenticator());
		expect(codeA).toBe(codeB);
		// 20 digits grouped by 5 -> "xxxxx xxxxx xxxxx xxxxx"
		expect(codeA).toMatch(/^\d{5}( \d{5}){3}$/);
		a.destroy();
		b.destroy();
	});

	test('pairwise safety number is symmetric between A and B', async () => {
		const {a, b} = await foundGroup();
		const aSelf = a.getRatchet(USER_A);
		const aPeer = a.getRatchet(USER_B);
		const bSelf = b.getRatchet(USER_B);
		const bPeer = b.getRatchet(USER_A);
		expect(aSelf && aPeer && bSelf && bPeer).toBeTruthy();

		const snAB = await safetyNumber(aSelf!, USER_A, aPeer!, USER_B);
		const snBA = await safetyNumber(bSelf!, USER_B, bPeer!, USER_A);
		expect(snAB).toBe(snBA);
		// 60 digits grouped by 5 -> 12 blocks
		expect(snAB).toMatch(/^(\d{5} ){11}\d{5}$/);
		a.destroy();
		b.destroy();
	});

	test('safety number differs for a different counterpart', async () => {
		const {a, b} = await foundGroup();
		const aSelf = a.getRatchet(USER_A)!;
		const aPeer = a.getRatchet(USER_B)!;
		const snReal = await safetyNumber(aSelf, USER_A, aPeer, USER_B);
		// Same keys but swapped user ids must NOT collide (ids are bound in).
		const snSwappedIds = await safetyNumber(aSelf, USER_B, aPeer, USER_A);
		expect(snReal).not.toBe(snSwappedIds);
		a.destroy();
		b.destroy();
	});
});
