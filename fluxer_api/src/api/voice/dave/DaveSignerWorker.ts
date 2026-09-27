// SPDX-License-Identifier: AGPL-3.0-or-later

// Worker-thread entry for the DAVE delivery crypto. All libdave WASM work runs
// here so the API event loop never blocks on MLS operations. The worker holds
// exactly one DaveDelivery instance with the deployment-wide external sender
// loaded; every request is a stateless crypto call.
//
// Protocol: JSON messages over worker_threads.
//   -> {id: number, ...DaveOp}
//   <- {id: number, ok: true, value: unknown} | {id: number, ok: false, error: string}

import {parentPort} from 'node:worker_threads';
import {DaveNodeModuleFactory} from '@fluxer/libdave/delivery';
import type {DaveNodeModule} from '@fluxer/libdave/delivery';

export type DaveOp =
	| {op: 'init'; seedBytes: number[]}
	| {op: 'sender_package'}
	| {op: 'validate_key_package'; keyPackageBytes: number[]; userId: string}
	| {
			op: 'proposals';
			groupId: string;
			epoch: number;
			addKeyPackages: number[][];
			removeLeafIndices: number[];
	  }
	| {
			op: 'parse_commit';
			groupId: string;
			expectedEpoch: number;
			committerUserId: string;
			commitWelcomeBytes: number[];
			pendingProposalsBytes: number[];
			knownRoster: Array<{userId: string; leafIndex: number}>;
	  };

let mod: DaveNodeModule | null = null;
let delivery: InstanceType<DaveNodeModule['DaveDelivery']> | null = null;

async function ensureModule(): Promise<DaveNodeModule> {
	if (mod === null) {
		mod = await DaveNodeModuleFactory();
	}
	return mod;
}

function assertReady(): void {
	if (delivery === null) {
		throw new Error('dave worker not initialized (missing seed)');
	}
}

async function handle(op: DaveOp): Promise<unknown> {
	switch (op.op) {
		case 'init': {
			const m = await ensureModule();
			const d = new m.DaveDelivery();
			const gen = d.GenerateExternalSender(op.seedBytes);
			if (gen.error !== undefined) {
				throw new Error(`external sender generation failed: ${String(gen.error)}`);
			}
			delivery = d;
			return {
				keyState: gen.keyState,
				senderPackage: Array.from(gen.senderPackage as number[]),
			};
		}
		case 'sender_package': {
			assertReady();
			return {senderPackage: Array.from(delivery!.ExternalSenderPackage() as number[])};
		}
		case 'validate_key_package': {
			assertReady();
			return delivery!.ValidateKeyPackage(op.keyPackageBytes, op.userId);
		}
		case 'proposals': {
			assertReady();
			const out = delivery!.CreateProposals(
				op.groupId,
				op.epoch,
				op.addKeyPackages,
				op.removeLeafIndices,
			);
			if (out === null || out === undefined) {
				throw new Error('proposal creation failed');
			}
			return {proposals: Array.from(out as number[])};
		}
		case 'parse_commit': {
			assertReady();
			return delivery!.ParseCommitWelcome(
				op.groupId,
				op.expectedEpoch,
				op.committerUserId,
				op.commitWelcomeBytes,
				op.pendingProposalsBytes,
				op.knownRoster,
			);
		}
	}
}

const port = parentPort;
if (port === null) {
	throw new Error('DaveSignerWorker must run inside a worker_thread');
}

port.on('message', async (msg: {id: number} & DaveOp) => {
	const id = msg.id;
	try {
		const value = await handle(msg);
		port.postMessage({id, ok: true, value});
	} catch (err) {
		port.postMessage({id, ok: false, error: err instanceof Error ? err.message : String(err)});
	}
});
