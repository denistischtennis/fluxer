// SPDX-License-Identifier: AGPL-3.0-or-later

// Stage-1 live verification of the DAVE crypto service. Exercises the REAL
// DaveSignerService (worker thread + libdave delivery WASM + seed-derived
// external sender) exactly as the Erlang gateway calls it over /internal/rpc.
// Proves the deployment-critical property: a given FLUXER_DAVE_SEED yields a
// byte-identical external sender package across independent instances, so every
// API node shares ONE external-sender identity with no DB persistence.
//
// Also covers the worker-lifecycle invariants with injected fake workers:
// a failed init must not poison the service, concurrent first callers share
// one startup, and the process-wide singleton is created once and disposed.

import {afterEach, describe, expect, test, vi} from 'vitest';
import {
	DaveSignerService,
	type DaveWorkerHandle,
	getDaveSignerService,
	shutdownDaveSignerService,
} from '@app/api/voice/dave/DaveSignerService';

// getDaveSignerService reads the seed from Config; stub the throwing
// pre-initialization proxy with just the voice slice the factory needs.
const {mockConfig} = vi.hoisted(() => ({
	mockConfig: {voice: {daveSeed: Buffer.alloc(32, 11).toString('base64')}},
}));
vi.mock('@app/api/Config', () => ({Config: mockConfig}));

const SEED_A = new Uint8Array(32).fill(7);
const SEED_B = new Uint8Array(32).fill(9);

const services: DaveSignerService[] = [];

function svc(seed: Uint8Array | null): DaveSignerService {
	const s = new DaveSignerService(seed);
	services.push(s);
	return s;
}

afterEach(() => {
	// Terminate any spawned workers to keep the test process clean.
	for (const s of services.splice(0)) {
		try {
			s.dispose();
		} catch {
			/* best effort */
		}
	}
});

/**
 * In-process stand-in for the crypto worker thread. Answers `init` with either
 * an ok:false reply (mirroring a handler error, without exiting) or a canned
 * sender package; records termination so lifecycle assertions can observe it.
 */
class FakeDaveWorker implements DaveWorkerHandle {
	terminated = false;
	initCalls = 0;
	private readonly listeners = new Map<string, Array<(arg: never) => void>>();

	constructor(private readonly failInit: boolean) {}

	postMessage(message: {id: number; op?: string}): void {
		if (message.op !== 'init') {
			return;
		}
		this.initCalls++;
		queueMicrotask(() => {
			if (this.failInit) {
				// Same shape the real worker sends when a handler throws:
				// ok:false reply, worker stays alive.
				this.emit('message', {
					id: message.id,
					ok: false,
					error: 'external sender generation failed',
				});
			} else {
				this.emit('message', {
					id: message.id,
					ok: true,
					value: {senderPackage: [1, 2, 3]},
				});
			}
		});
	}

	on(event: 'error' | 'exit' | 'message', listener: (arg: never) => void): void {
		const list = this.listeners.get(event) ?? [];
		list.push(listener);
		this.listeners.set(event, list);
	}

	terminate(): Promise<number> {
		this.terminated = true;
		queueMicrotask(() => this.emit('exit', 1));
		return Promise.resolve(1);
	}

	private emit(event: string, arg: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) {
			(listener as (value: unknown) => void)(arg);
		}
	}
}

const FAKE_SENDER_B64 = Buffer.from([1, 2, 3]).toString('base64');

describe('DaveSignerService (fake worker lifecycle)', () => {
	test('failed init does not poison: worker terminated, later call retries and succeeds', async () => {
		const workers: FakeDaveWorker[] = [];
		let failNext = true;
		const service = new DaveSignerService(SEED_A, () => {
			const w = new FakeDaveWorker(failNext);
			failNext = false;
			workers.push(w);
			return w;
		});

		await expect(service.getExternalSenderPackageB64()).rejects.toThrow(
			/external sender generation failed/,
		);
		expect(workers).toHaveLength(1);
		expect(workers[0].terminated).toBe(true);

		// The failure must be retryable, not memoized forever.
		const pkg = await service.getExternalSenderPackageB64();
		expect(pkg).toBe(FAKE_SENDER_B64);
		expect(workers).toHaveLength(2);
		expect(workers[1].terminated).toBe(false);
		service.dispose();
	});

	test('concurrent first callers share one worker startup', async () => {
		const workers: FakeDaveWorker[] = [];
		const service = new DaveSignerService(SEED_A, () => {
			const w = new FakeDaveWorker(false);
			workers.push(w);
			return w;
		});

		const [p1, p2] = await Promise.all([
			service.getExternalSenderPackageB64(),
			service.getExternalSenderPackageB64(),
		]);
		expect(workers).toHaveLength(1);
		expect(workers[0].initCalls).toBe(1);
		expect(p1).toBe(FAKE_SENDER_B64);
		expect(p2).toBe(FAKE_SENDER_B64);
		service.dispose();
	});

	test('dispose during startup terminates the starting worker and rejects waiters', async () => {
		const worker = new FakeDaveWorker(false);
		const service = new DaveSignerService(SEED_A, () => worker);

		const starting = service.getExternalSenderPackageB64();
		service.dispose();

		await expect(starting).rejects.toThrow(/disposed/);
		expect(worker.terminated).toBe(true);
	});
});

describe('process-wide DAVE signer singleton', () => {
	test('all requests share one instance; shutdown disposes and clears it', async () => {
		const s1 = getDaveSignerService();
		const s2 = getDaveSignerService();
		expect(s1).not.toBeNull();
		expect(s1).toBe(s2);
		expect(s1?.isEnabled()).toBe(true);
		shutdownDaveSignerService();
		// Shutdown disposed the shared worker; the getter lazily builds a fresh
		// service from config rather than locking out forever.
		const s3 = getDaveSignerService();
		expect(s3).not.toBeNull();
		expect(s3).not.toBe(s1);
		expect(s3?.isEnabled()).toBe(true);
		shutdownDaveSignerService();
	});
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
