// Gate 2: delivery <-> client Session interop. Proves the fluxer-authored
// DaveDelivery bindings produce wire-compatible MLS messages consumed by the
// real client-side libdave Session, entirely in memory (no network, no server).
//
// Covers: external sender generate/load roundtrip, key-package validation,
// group founding, member add, member remove, and post-removal media isolation
// (the removed member must NOT be able to decrypt new frames with its stale
// ratchet, per the DAVE whitepaper).

import {beforeAll, describe, expect, test} from 'vitest';
import {DaveNodeModuleFactory, type DaveNodeModule} from '../js/wasm-node';
const PROTOCOL_VERSION = 1;
const GROUP_ID = 42424242424242424n;
const GROUP_ID_STR = '42424242424242424';

const USER_A = '1000000000000000001';
const USER_B = '1000000000000000002';
const USER_C = '1000000000000000003';

let mod: DaveNodeModule;
type Ratchet = {cipherSuite: number; baseSecret: number[]};

function createSession(userId: string, externalSenderPackage: number[]) {
	const tk = new mod.TransientKeys();
	const privKey = tk.GetTransientPrivateKey(PROTOCOL_VERSION);
	const session = new mod.Session('', '', () => {
		/* failure callback; assertions below surface real problems */
	});
	session.Init(PROTOCOL_VERSION, GROUP_ID, userId, privKey);
	session.SetExternalSender(externalSenderPackage);
	return {tk, session};
}

function encryptAudioFrame(ratchet: Ratchet, ssrc: number, plaintext: number[]): number[] {
	const enc = new mod.Encryptor();
	enc.SetKeyRatchet(ratchet);
	enc.AssignSsrcToCodec(ssrc, mod.Codec.Opus);
	const cap = enc.GetMaxCiphertextByteSize(mod.MediaType.Audio, plaintext.length);
	const ptr = mod._malloc(cap);
	try {
		mod.HEAPU8.set(plaintext, ptr);
		const written = enc.Encrypt(mod.MediaType.Audio, ssrc, ptr, plaintext.length, cap);
		if (written === 0) {
			throw new Error('encrypt failed');
		}
		return Array.from(mod.HEAPU8.slice(ptr, ptr + written));
	} finally {
		mod._free(ptr);
	}
}

function decryptAudioFrame(ratchet: Ratchet, ciphertext: number[]): {ok: boolean; plain: number[]} {
	const dec = new mod.Decryptor();
	dec.TransitionToKeyRatchet(ratchet);
	const cap = dec.GetMaxPlaintextByteSize(mod.MediaType.Audio, ciphertext.length);
	const ptr = mod._malloc(cap);
	try {
		mod.HEAPU8.set(ciphertext, ptr);
		const written = dec.Decrypt(mod.MediaType.Audio, ptr, ciphertext.length, cap);
		return {ok: written > 0, plain: Array.from(mod.HEAPU8.slice(ptr, ptr + written))};
	} finally {
		mod._free(ptr);
	}
}

beforeAll(async () => {
	mod = await DaveNodeModuleFactory();
});

describe('external sender identity', () => {
	test('generate -> key state reload reproduces the same sender package', () => {
		const delivery = new mod.DaveDelivery();
		const seed = Array.from({length: 32}, (_, i) => i * 7 + 1);
		const gen = delivery.GenerateExternalSender(seed);
		expect(gen.error).toBeUndefined();
		expect(typeof gen.keyState).toBe('string');
		expect(gen.senderPackage.length).toBeGreaterThan(0);

		const reloaded = new mod.DaveDelivery();
		expect(reloaded.LoadExternalSender(gen.keyState)).toBe(true);
		expect(Array.from(reloaded.ExternalSenderPackage())).toEqual(Array.from(gen.senderPackage));
	});

	test('different seeds produce different identities', () => {
		const d1 = new mod.DaveDelivery();
		const d2 = new mod.DaveDelivery();
		const g1 = d1.GenerateExternalSender(Array.from({length: 32}, (_, i) => i));
		const g2 = d2.GenerateExternalSender(Array.from({length: 32}, (_, i) => i + 100));
		expect(Array.from(g1.senderPackage)).not.toEqual(Array.from(g2.senderPackage));
	});

	test('deterministic across instances for the same seed', () => {
		const d1 = new mod.DaveDelivery();
		const d2 = new mod.DaveDelivery();
		const seed = Array.from({length: 24}, (_, i) => 200 - i);
		expect(Array.from(d1.GenerateExternalSender(seed).senderPackage)).toEqual(
			Array.from(d2.GenerateExternalSender(seed).senderPackage),
		);
	});
});

describe('key package validation', () => {
	test('accepts a well-formed package bound to the claimed user', () => {
		const delivery = new mod.DaveDelivery();
		delivery.GenerateExternalSender(Array.from({length: 16}, (_, i) => i + 50));
		const {session} = createSession(USER_A, delivery.ExternalSenderPackage());
		const kp = session.GetMarshalledKeyPackage();
		expect(kp.length).toBeGreaterThan(0);
		const result = delivery.ValidateKeyPackage(kp, USER_A);
		expect(result.valid).toBe(true);
	});

	test('rejects a package presented by the wrong user', () => {
		const delivery = new mod.DaveDelivery();
		delivery.GenerateExternalSender(Array.from({length: 16}, (_, i) => i + 50));
		const {session} = createSession(USER_A, delivery.ExternalSenderPackage());
		const kp = session.GetMarshalledKeyPackage();
		const result = delivery.ValidateKeyPackage(kp, USER_B);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain('user ID');
	});

	test('rejects malformed bytes', () => {
		const delivery = new mod.DaveDelivery();
		delivery.GenerateExternalSender(Array.from({length: 16}, (_, i) => i + 50));
		const result = delivery.ValidateKeyPackage([1, 2, 3], USER_A);
		expect(result.valid).toBe(false);
	});
});

describe('full group lifecycle through the delivery service', () => {
	test('found, add members, exchange media, remove a member, media isolation', () => {
		const delivery = new mod.DaveDelivery();
		const gen = delivery.GenerateExternalSender(Array.from({length: 32}, (_, i) => (i * 3) & 0xff));
		expect(gen.error).toBeUndefined();
		const senderPkg = Array.from(gen.senderPackage) as number[];

		const allUsers = [USER_A, USER_B, USER_C];

		// --- founding: A exists solo, DS proposes B and C -----------------
		const a = createSession(USER_A, senderPkg);
		const b = createSession(USER_B, senderPkg);
		const c = createSession(USER_C, senderPkg);

		const kpB = Array.from(b.session.GetMarshalledKeyPackage()) as number[];
		const kpC = Array.from(c.session.GetMarshalledKeyPackage()) as number[];
		expect(kpB.length).toBeGreaterThan(0);
		expect(kpC.length).toBeGreaterThan(0);

		const proposals1 = delivery.CreateProposals(GROUP_ID_STR, 0, [kpB, kpC], []);
		expect(proposals1).not.toBeNull();

		const bundle1 = a.session.ProcessProposals(proposals1, allUsers);
		expect(bundle1).not.toBeNull();

		const parse1 = delivery.ParseCommitWelcome(GROUP_ID_STR, 0, USER_A, bundle1, proposals1, []);
		expect(parse1.ok).toBe(true);
		expect(parse1.newEpoch).toBe(1);
		expect(parse1.committerUserId).toBe(USER_A);
		expect(parse1.welcome).not.toBeNull();
		const roster1 = parse1.roster as {userId: string; leafIndex: number}[];
		expect(roster1).toEqual([
			{userId: USER_A, leafIndex: 0},
			{userId: USER_B, leafIndex: 1},
			{userId: USER_C, leafIndex: 2},
		]);

		// A applies the winning commit (its own); B and C join via welcome.
		const commitA1 = a.session.ProcessCommit(parse1.commit);
		expect(commitA1.failed).toBe(false);
		expect(commitA1.rosterUpdate).not.toBeNull();

		const welcomeBytes = Array.from(parse1.welcome) as number[];
		const rosterB = b.session.ProcessWelcome(welcomeBytes, allUsers);
		expect(rosterB).not.toBeNull();
		const rosterC = c.session.ProcessWelcome(welcomeBytes, allUsers);
		expect(rosterC).not.toBeNull();

		expect(a.session.GetProtocolVersion()).toBe(PROTOCOL_VERSION);
		expect(b.session.GetProtocolVersion()).toBe(PROTOCOL_VERSION);
		expect(c.session.GetProtocolVersion()).toBe(PROTOCOL_VERSION);

		// --- epoch 1 media: A sends, B and C receive ---------------------
		const ratchetA1 = a.session.GetKeyRatchet(USER_A) as Ratchet;
		const ratchetA1ForB = b.session.GetKeyRatchet(USER_A) as Ratchet;
		const ratchetA1ForC = c.session.GetKeyRatchet(USER_A) as Ratchet;
		expect(ratchetA1.cipherSuite).toBe(2); // MLS suite 2: P256_AES128GCM_SHA256_P256
		expect(Array.from(ratchetA1.baseSecret)).toEqual(Array.from(ratchetA1ForB.baseSecret));
		expect(Array.from(ratchetA1)).toEqual(Array.from(ratchetA1ForC));

		const SSRC_A = 0x5eed0001;
		const frame1 = [0xf8, 0xff, 0xfe, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		const ct1 = encryptAudioFrame(ratchetA1, SSRC_A, frame1);
		expect(ct1).not.toEqual(frame1);
		expect(decryptAudioFrame(ratchetA1ForB, ct1).plain).toEqual(frame1);
		expect(decryptAudioFrame(ratchetA1ForC, ct1).plain).toEqual(frame1);

		// --- remove C at epoch 1 -----------------------------------------
		const proposals2 = delivery.CreateProposals(GROUP_ID_STR, 1, [], [2]);
		expect(proposals2).not.toBeNull();

		const bundle2 = a.session.ProcessProposals(proposals2, allUsers);
		expect(bundle2).not.toBeNull();

		const parse2 = delivery.ParseCommitWelcome(
			GROUP_ID_STR,
			1,
			USER_A,
			bundle2,
			proposals2,
			roster1.map((r) => ({userId: r.userId, leafIndex: r.leafIndex})),
		);
		expect(parse2.ok).toBe(true);
		expect(parse2.newEpoch).toBe(2);
		expect(parse2.welcome).toBeNull(); // no adds -> no welcome
		const roster2 = parse2.roster as {userId: string; leafIndex: number}[];
		expect(roster2).toEqual([
			{userId: USER_A, leafIndex: 0},
			{userId: USER_B, leafIndex: 1},
		]);

		// Every remaining member must have queued the proposals (Op 27) before
		// applying the winning commit announcement (Op 29). C never receives
		// either message: the gateway excludes removed members from the relay.
		expect(b.session.ProcessProposals(proposals2, allUsers)).not.toBeNull();
		expect(a.session.ProcessCommit(parse2.commit).failed).toBe(false);
		expect(b.session.ProcessCommit(parse2.commit).failed).toBe(false);

		// --- epoch 2 media isolation --------------------------------------
		const ratchetA2 = a.session.GetKeyRatchet(USER_A) as Ratchet;
		expect(Array.from(ratchetA2.baseSecret)).not.toEqual(Array.from(ratchetA1.baseSecret));

		const frame2 = [0xf8, 0xff, 0xfe, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42];
		const ct2 = encryptAudioFrame(ratchetA2, SSRC_A, frame2);

		// B still receives A.
		const bGot = decryptAudioFrame(b.session.GetKeyRatchet(USER_A) as Ratchet, ct2);
		expect(bGot.ok).toBe(true);
		expect(bGot.plain).toEqual(frame2);

		// C, holding only the epoch-1 ratchet, must NOT decrypt epoch-2 frames.
		const cGot = decryptAudioFrame(ratchetA1ForC, ct2);
		expect(cGot.ok).toBe(false);
	});

	test('a commit whose proposal set does not match the pending set is rejected', () => {
		const delivery = new mod.DaveDelivery();
		const gen = delivery.GenerateExternalSender(Array.from({length: 32}, (_, i) => i ^ 0x5a));
		const senderPkg = Array.from(gen.senderPackage) as number[];
		const allUsers = [USER_A, USER_B, USER_C];

		const a = createSession(USER_A, senderPkg);
		const b = createSession(USER_B, senderPkg);
		const c = createSession(USER_C, senderPkg);

		const kpB = Array.from(b.session.GetMarshalledKeyPackage()) as number[];
		const kpC = Array.from(c.session.GetMarshalledKeyPackage()) as number[];

		// Positive control: the exact bundle the commit was made from parses clean.
		const proposals = delivery.CreateProposals(GROUP_ID_STR, 0, [kpB, kpC], []);
		const bundle = a.session.ProcessProposals(proposals, allUsers);
		expect(bundle).not.toBeNull();
		const good = delivery.ParseCommitWelcome(GROUP_ID_STR, 0, USER_A, bundle, proposals, []);
		expect(good.ok).toBe(true);

		// A different issuance of the same key packages carries different signature
		// nonces, hence different refs: claiming a different pending set must be
		// rejected fail-closed (unknown ref or missing coverage).
		const otherPending = delivery.CreateProposals(GROUP_ID_STR, 0, [kpB, kpC], []);
		const bad = delivery.ParseCommitWelcome(GROUP_ID_STR, 0, USER_A, bundle, otherPending, []);
		expect(bad.ok).toBe(false);
		expect(String(bad.reason)).toMatch(/unknown|cover/);
	});

	test('external proposals for unrecognized users are rejected client-side', () => {
		const delivery = new mod.DaveDelivery();
		const gen = delivery.GenerateExternalSender(Array.from({length: 32}, (_, i) => i ^ 0x3c));
		const senderPkg = Array.from(gen.senderPackage) as number[];

		const a = createSession(USER_A, senderPkg);
		const stranger = createSession('9999999999999999999', senderPkg);
		const kpStranger = Array.from(stranger.session.GetMarshalledKeyPackage()) as number[];

		const proposals = delivery.CreateProposals(GROUP_ID_STR, 0, [kpStranger], []);
		expect(proposals).not.toBeNull();

		// recognizedUserIDs deliberately excludes the stranger.
		const out = a.session.ProcessProposals(proposals, [USER_A]);
		expect(out).toBeNull();
	});
});
