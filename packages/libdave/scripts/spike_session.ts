// Gate 1 spike (throwaway): prove the built node WASM artefact loads and two
// client Sessions establish a shared MLS group relayed manually through the
// DaveDelivery bindings. Run after `bash scripts/build_wasm.sh node`:
//   node --experimental-strip-types scripts/spike_session.ts
import {DaveNodeModuleFactory} from '../js/wasm-node.ts';

const GROUP_ID = 123456789n;
const USER_A = '1000000000000000001';
const USER_B = '1000000000000000002';

async function main() {
	const mod = await DaveNodeModuleFactory();

	console.log('MaxSupportedProtocolVersion =', mod.MaxSupportedProtocolVersion());

	const delivery = new mod.DaveDelivery();
	const seed = Array.from({length: 32}, (_, i) => (i * 11) & 0xff);
	const gen = delivery.GenerateExternalSender(seed);
	if (gen.error) {
		throw new Error('generate failed: ' + String(gen.error));
	}
	console.log('senderPackage bytes =', (gen.senderPackage as unknown[]).length);

	const senderPkg = gen.senderPackage as number[];

	function makeSession(userId: string) {
		const tk = new mod.TransientKeys();
		const key = tk.GetTransientPrivateKey(1);
		const s = new mod.Session('', '', () => {});
		s.Init(1, GROUP_ID, userId, key);
		s.SetExternalSender(senderPkg);
		return {tk, s};
	}

	const a = makeSession(USER_A);
	const b = makeSession(USER_B);
	const kpB = Array.from(b.s.GetMarshalledKeyPackage() as number[]) as number[];
	if (kpB.length === 0) {
		throw new Error('empty key package');
	}
	console.log('keyPackage B bytes =', kpB.length);

	const vkp = delivery.ValidateKeyPackage(kpB, USER_B);
	if (!vkp.valid) {
		throw new Error('validate failed: ' + String(vkp.reason));
	}
	console.log('ValidateKeyPackage OK');

	const proposals = delivery.CreateProposals('123456789', 0, [kpB], []);
	const bundle = a.s.ProcessProposals(proposals, [USER_A, USER_B]);
	if (!bundle) {
		throw new Error('ProcessProposals returned null');
	}

	const parsed = delivery.ParseCommitWelcome('123456789', 0, USER_A, bundle, proposals, []);
	if (!parsed.ok) {
		throw new Error('ParseCommitWelcome failed: ' + String(parsed.reason));
	}
	console.log('newEpoch =', parsed.newEpoch, 'roster =', JSON.stringify(parsed.roster));

	const commitRes = a.s.ProcessCommit(parsed.commit);
	if (commitRes.failed) {
		throw new Error('committer ProcessCommit failed');
	}
	const welcRes = b.s.ProcessWelcome(Array.from(parsed.welcome as number[]), [USER_A, USER_B]);
	if (!welcRes) {
		throw new Error('welcome processing failed');
	}

	const rA = a.s.GetKeyRatchet(USER_A);
	const rB = b.s.GetKeyRatchet(USER_A);
	if (!rA || !rB) {
		throw new Error('missing ratchet');
	}
	if (rA.cipherSuite !== 2) {
		throw new Error('unexpected cipherSuite ' + rA.cipherSuite);
	}
	if (JSON.stringify(rA.baseSecret) !== JSON.stringify(rB.baseSecret)) {
		throw new Error('ratchet mismatch between sessions');
	}
	console.log('GATE 1 PASS: both sessions share epoch, ratchet =', {
		cipherSuite: rA.cipherSuite,
		baseSecretLen: (rA.baseSecret as number[]).length,
	});
}

main().catch((err: unknown) => {
	console.error('GATE 1 FAIL:', err);
	process.exit(1);
});
