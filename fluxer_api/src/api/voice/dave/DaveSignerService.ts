// SPDX-License-Identifier: AGPL-3.0-or-later

// Stateful facade over the DAVE delivery crypto worker. The WASM instance runs
// on a dedicated worker_thread so MLS signing/validation never blocks the API
// event loop. The external-sender identity is derived deterministically from
// FLUXER_DAVE_SEED (mlspp HKDF derivation, verified by the libdave interop
// tests), so no database persistence is required: every API instance with the
// same seed produces byte-identical sender packages.

import {existsSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {fileURLToPath} from 'node:url';
import type {DaveOp} from '@app/api/voice/dave/DaveSignerWorker';
import {Logger} from '@app/api/Logger';

const CALL_TIMEOUT_MS = 10_000;

export interface DaveRosterEntry {
	userId: string;
	leafIndex: number;
}

export interface DaveParseCommitResult {
	ok: boolean;
	reason?: string;
	newEpoch?: number;
	committerUserId?: string;
	roster?: DaveRosterEntry[];
	commitB64?: string;
	welcomeB64?: string;
}

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

function b64ToBytes(value: string): number[] {
	return Array.from(Buffer.from(value, 'base64'));
}

function bytesToB64(value: unknown): string {
	if (Array.isArray(value)) {
		return Buffer.from(value as number[]).toString('base64');
	}
	if (value instanceof Uint8Array) {
		return Buffer.from(value).toString('base64');
	}
	throw new Error('expected byte array from dave worker');
}

/**
 * Resolve the worker script for both execution modes:
 *  - dev (`tsx`): the colocated TypeScript source, loaded via tsx's ESM hooks.
 *  - production (esbuild bundle): the separately-bundled worker under dist/,
 *    reachable relative to the entry bundle, or overridden explicitly via
 *    FLUXER_DAVE_WORKER_PATH.
 */
function resolveWorkerPath(): string {
	const explicit = process.env.FLUXER_DAVE_WORKER_PATH;
	if (explicit !== undefined && explicit.length > 0) {
		return explicit;
	}
	const candidates = [
		new URL('./DaveSignerWorker.ts', import.meta.url),
		new URL('./api/voice/dave/DaveSignerWorker.js', import.meta.url),
		new URL('./DaveSignerWorker.js', import.meta.url),
	];
	for (const candidate of candidates) {
		const path = fileURLToPath(candidate);
		if (existsSync(path)) {
			return path;
		}
	}
	throw new Error('DaveSignerWorker script not found (set FLUXER_DAVE_WORKER_PATH)');
}

export class DaveSignerService {
	private worker: Worker | null = null;
	private readonly pending = new Map<number, PendingCall>();
	private nextId = 1;
	private starting: Promise<void> | null = null;
	private senderPackageB64: string | null = null;

	constructor(private readonly seedBytes: Uint8Array | null) {}

	isEnabled(): boolean {
		return this.seedBytes !== null && this.seedBytes.length >= 16;
	}

	private ensureStarted(): Promise<void> {
		if (!this.isEnabled()) {
			return Promise.reject(
				new Error('DAVE is disabled: FLUXER_DAVE_SEED must be at least 16 bytes'),
			);
		}
		if (this.worker !== null) {
			return Promise.resolve();
		}
		if (this.starting !== null) {
			return this.starting;
		}
		this.starting = this.spawn();
		return this.starting;
	}

	private async spawn(): Promise<void> {
		const worker = new Worker(resolveWorkerPath());
		worker.on('error', (err) => {
			Logger.error({err}, 'DAVE signer worker crashed');
			this.failAll(err instanceof Error ? err : new Error(String(err)));
		});
		worker.on('exit', (code) => {
			if (code !== 0) {
				this.failAll(new Error(`DAVE signer worker exited with code ${String(code)}`));
			}
			this.worker = null;
			this.starting = null;
			this.senderPackageB64 = null;
		});
		worker.on('message', (msg: {id: number; ok: boolean; value?: unknown; error?: string}) => {
			const call = this.pending.get(msg.id);
			if (call === undefined) {
				return;
			}
			this.pending.delete(msg.id);
			clearTimeout(call.timer);
			if (msg.ok) {
				call.resolve(msg.value);
			} else {
				call.reject(new Error(msg.error ?? 'DAVE worker returned an error'));
			}
		});
		this.worker = worker;
		const seedBytes = Array.from(this.seedBytes ?? new Uint8Array());
		const result = (await this.callOn(worker, {op: 'init', seedBytes})) as {
			senderPackage: number[];
		};
		this.senderPackageB64 = bytesToB64(result.senderPackage);
	}

	private failAll(err: Error): void {
		for (const [, call] of this.pending) {
			clearTimeout(call.timer);
			call.reject(err);
		}
		this.pending.clear();
	}

	private callOn(worker: Worker, op: DaveOp): Promise<unknown> {
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`DAVE worker call '${op.op}' timed out`));
			}, CALL_TIMEOUT_MS);
			this.pending.set(id, {resolve, reject, timer});
			worker.postMessage({id, ...op});
		});
	}

	private async call(op: DaveOp): Promise<unknown> {
		await this.ensureStarted();
		const worker = this.worker;
		if (worker === null) {
			throw new Error('DAVE worker unavailable');
		}
		return this.callOn(worker, op);
	}

	async getExternalSenderPackageB64(): Promise<string> {
		await this.ensureStarted();
		if (this.senderPackageB64 === null) {
			throw new Error('DAVE sender package unavailable');
		}
		return this.senderPackageB64;
	}

	async validateKeyPackage(keyPackageB64: string, userId: string): Promise<{valid: boolean; reason: string}> {
		const result = (await this.call({
			op: 'validate_key_package',
			keyPackageBytes: b64ToBytes(keyPackageB64),
			userId,
		})) as {valid: boolean; reason: string};
		return {valid: result.valid === true, reason: String(result.reason ?? '')};
	}

	async createProposals(params: {
		groupId: string;
		epoch: number;
		addKeyPackagesB64: string[];
		removeLeafIndices: number[];
	}): Promise<string> {
		const result = (await this.call({
			op: 'proposals',
			groupId: params.groupId,
			epoch: params.epoch,
			addKeyPackages: params.addKeyPackagesB64.map(b64ToBytes),
			removeLeafIndices: params.removeLeafIndices,
		})) as {proposals: number[]};
		return bytesToB64(result.proposals);
	}

	async parseCommit(params: {
		groupId: string;
		expectedEpoch: number;
		committerUserId: string;
		commitWelcomeB64: string;
		pendingProposalsB64: string;
		knownRoster: DaveRosterEntry[];
	}): Promise<DaveParseCommitResult> {
		const result = (await this.call({
			op: 'parse_commit',
			groupId: params.groupId,
			expectedEpoch: params.expectedEpoch,
			committerUserId: params.committerUserId,
			commitWelcomeBytes: b64ToBytes(params.commitWelcomeB64),
			pendingProposalsBytes: b64ToBytes(params.pendingProposalsB64),
			knownRoster: params.knownRoster,
		})) as DaveParseCommitResult & {commit?: number[]; welcome?: number[] | null};
		const out: DaveParseCommitResult = {
			ok: result.ok === true,
			reason: result.reason !== undefined ? String(result.reason) : undefined,
			newEpoch: result.newEpoch,
			committerUserId: result.committerUserId,
			roster: result.roster,
		};
		if (result.commit !== undefined) {
			out.commitB64 = bytesToB64(result.commit);
		}
		if (result.welcome !== undefined && result.welcome !== null) {
			out.welcomeB64 = bytesToB64(result.welcome);
		}
		return out;
	}

	dispose(): void {
		if (this.worker !== null) {
			void this.worker.terminate();
			this.worker = null;
		}
		this.failAll(new Error('DAVE service disposed'));
	}
}
