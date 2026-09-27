// SPDX-License-Identifier: AGPL-3.0-or-later

// Stage-1 live verification of the DAVE crypto service. Exercises the REAL
// DaveSignerService (worker thread + libdave delivery WASM + seed-derived
// external sender) exactly as the Erlang gateway calls it over /internal/rpc.
// Proves the deployment-critical property: a given FLUXER_DAVE_SEED yields a
// byte-identical external sender package across independent instances, so every
// API node shares ONE external-sender identity with no DB persistence.

import {afterEach, describe, expect, test} from 'vitest';
import {DaveSignerService} from '@app/api/voice/dave/DaveSignerService';

const SEED_A = new Uint8Array(32).fill(7);
const SEED_B = new Uint8Array(32).fill(9);

const services: DaveSignerService[] = [];

function svc(seed: Uint8Array | null): DaveSignerService {
	const s = new DaveSignerService(seed);
	services.push(s);
	return s;
}

afterEach(async () => {
	// Terminate any spawned workers to keep the test process clean.
	for (const s of services.splice(0)) {
		try {
			await (s as unknown as {terminate?: () => void}).terminate?.();
		} catch {
			/* best effort */
		}
	}
});

describe('DaveSignerService (stage-1 live crypto)', () => {
	test('enabled only with a >=16-byte seed', () => {
		expect(svc(SEED_A).isEnabled()).toBe(true);
		expect(svc(new Uint8Array(8)).isEnabled()).toBe(false);
		expect(svc(null).isEnabled()).toBe(false);
	});

	test('disabled service rejects instead of returning garbage', async () => {
		await expect(svc(null).getExternalSenderPackageB64()).rejects.toThrow(/DAVE is disabled/);
	});

	test('same seed -> byte-identical external sender package (single identity)', async () => {
		const p1 = await svc(SEED_A).getExternalSenderPackageB64();
		const p2 = await svc(SEED_A).getExternalSenderPackageB64();
		expect(p1.length).toBeGreaterThan(0);
		expect(p1).toBe(p2);
	});

	test('different seed -> different external sender package', async () => {
		const pa = await svc(SEED_A).getExternalSenderPackageB64();
		const pb = await svc(SEED_B).getExternalSenderPackageB64();
		expect(pa).not.toBe(pb);
	});

	test('sender package is valid base64', async () => {
		const p = await svc(SEED_A).getExternalSenderPackageB64();
		// Round-trips through base64 without corruption.
		expect(Buffer.from(p, 'base64').toString('base64')).toBe(p);
	});
});
