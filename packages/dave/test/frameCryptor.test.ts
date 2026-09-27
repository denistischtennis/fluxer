// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeAll, describe, expect, test} from 'vitest';
import {DaveNodeModuleFactory, type DaveNodeModule} from '@fluxer/libdave/delivery';
import {DaveSendCryptor, DaveReceiveCryptor} from '../src/DaveFrameCryptor.js';
import {MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO, DAVE_CODEC} from '../src/frameMapping.js';

let mod: DaveNodeModule;

function b64(bytes: number[] | Uint8Array): string {
	const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
	return Buffer.from(arr).toString('base64');
}
function unb64(s: string): Uint8Array {
	return new Uint8Array(Buffer.from(s, 'base64'));
}

beforeAll(async () => {
	mod = await DaveNodeModuleFactory();
});

// Build two joined sessions sharing a group so we have a real sender ratchet.
function establishSenderRatchet() {
	const delivery = new mod.DaveDelivery();
	const gen = delivery.GenerateExternalSender(Array.from({length: 32}, (_, i) => (i * 17 + 5) & 0xff));
	const senderPkg = Array.from(gen.senderPackage as number[]);
	const A = '1000000000000000001';
	const B = '1000000000000000002';
	function mk(u: string) {
		const tk = new mod.TransientKeys();
		const k = tk.GetTransientPrivateKey(1);
		const s = new mod.Session('', '', () => {});
		s.Init(1, 777n, u, k);
		s.SetExternalSender(senderPkg);
		return {tk, s};
	}
	const a = mk(A);
	const b = mk(B);
	const kpB = Array.from(b.s.GetMarshalledKeyPackage());
	const proposals = delivery.CreateProposals('777', 0, [kpB], []);
	const bundle = a.s.ProcessProposals(proposals, [A, B]);
	const parsed = delivery.ParseCommitWelcome('777', 0, A, bundle, proposals, []);
	a.s.ProcessCommit(parsed.commit);
	b.s.ProcessWelcome(unb64(b64(parsed.welcome as number[])), [A, B]);
	return {a, b, A, B};
}

describe('DaveFrameCryptor audio roundtrip', () => {
	test('encrypts then decrypts back to the original frame', () => {
		const {a, b, A} = establishSenderRatchet();
		const send = new DaveSendCryptor(mod);
		send.setRatchet({cipherSuite: 2, baseSecret: Array.from(a.s.GetKeyRatchet(A).baseSecret)});
		send.assignSsrc(0x12345678, DAVE_CODEC.Opus);

		const plain = Uint8Array.from([0xf8, 0xff, 0xfe, 9, 9, 9, 9, 9, 9, 9, 9]);
		const enc = send.encrypt(MEDIA_TYPE_AUDIO, plain);
		expect(enc.encrypted).toBe(true);
		expect(Array.from(enc.bytes)).not.toEqual(Array.from(plain));

		const recv = new DaveReceiveCryptor(mod);
		recv.transitionTo({cipherSuite: 2, baseSecret: Array.from(b.s.GetKeyRatchet(A).baseSecret)});
		const dec = recv.decrypt(MEDIA_TYPE_AUDIO, enc.bytes);
		expect(dec.ok).toBe(true);
		expect(Array.from(dec.bytes)).toEqual(Array.from(plain));

		send.dispose();
		recv.dispose();
	});

	test('no ratchet on send -> Opus silence for audio', () => {
		const send = new DaveSendCryptor(mod);
		const enc = send.encrypt(MEDIA_TYPE_AUDIO, Uint8Array.from([1, 2, 3, 4]));
		expect(enc.encrypted).toBe(false);
		expect(Array.from(enc.bytes)).toEqual([0xf8, 0xff, 0xfe]);
		send.dispose();
	});

	test('no ratchet on send -> video passthrough unchanged', () => {
		const send = new DaveSendCryptor(mod);
		const v = Uint8Array.from([0x10, 0x20, 0x30]);
		const enc = send.encrypt(MEDIA_TYPE_VIDEO, v);
		expect(enc.encrypted).toBe(false);
		expect(Array.from(enc.bytes)).toEqual(Array.from(v));
		send.dispose();
	});
});

describe('DaveFrameCryptor receive failure handling', () => {
	test('wrong ratchet fails; passthrough returns original', () => {
		const {a, A} = establishSenderRatchet();
		const send = new DaveSendCryptor(mod);
		send.setRatchet({cipherSuite: 2, baseSecret: Array.from(a.s.GetKeyRatchet(A).baseSecret)});
		send.assignSsrc(0xabcdef01, DAVE_CODEC.Opus);
		const enc = send.encrypt(MEDIA_TYPE_AUDIO, Uint8Array.from([0xf8, 0xff, 0xfe, 1, 2, 3]));

		// A receiver with an unrelated ratchet cannot decrypt.
		const wrongRatchet = {cipherSuite: 2, baseSecret: Array.from({length: 16}, (_, i) => i)};
		const recv = new DaveReceiveCryptor(mod);
		recv.transitionTo(wrongRatchet as never);
		const dec = recv.decrypt(MEDIA_TYPE_AUDIO, enc.bytes);
		expect(dec.ok).toBe(false);
		expect(dec.bytes.length).toBe(0);

		// With passthrough enabled, the same failure returns the ciphertext as-is.
		recv.setPassthrough(true);
		const decP = recv.decrypt(MEDIA_TYPE_AUDIO, enc.bytes);
		expect(decP.ok).toBe(true);
		expect(Array.from(decP.bytes)).toEqual(Array.from(enc.bytes));

		send.dispose();
		recv.dispose();
	});
});
