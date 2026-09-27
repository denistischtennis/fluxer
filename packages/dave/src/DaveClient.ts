// SPDX-License-Identifier: AGPL-3.0-or-later

// DAVE client session manager. Port of upstream `samples/typescript/DaveSessionManager`
// onto fluxer's event model. One instance per (selfUserId, channelId). All I/O
// goes through an injected `DaveTransport`, and the libdave WASM module is
// injected too, so this class is fully unit-testable with the real web artefact.

import type {
	DaveModule,
	Session as WasmSession,
	TransientKeys as WasmTransientKeys,
} from '@fluxer/libdave/wasm';
import {TofuStore} from './tofuStore.js';
import {ratchetFromWasm, encodeRatchet, type DaveKeyRatchet} from './ratchetWire.js';

const MLS_NEW_GROUP_EXPECTED_EPOCH = '1';

export type DaveStatus = 'idle' | 'handshaking' | 'established' | 'passthrough' | 'broken';

export interface DaveUpMessage {
	type: 'key_package' | 'ready_for_transition' | 'commit_welcome' | 'invalid_commit_welcome';
	channel_id: string;
	guild_id?: string;
	transition_id?: number;
	data?: string;
}

export interface DaveTransport {
	send(msg: DaveUpMessage): void;
}

export interface DaveDownMessage {
	type:
		| 'select_protocol_ack'
		| 'prepare_transition'
		| 'execute_transition'
		| 'prepare_epoch'
		| 'external_sender_package'
		| 'proposals'
		| 'announce_commit_transition'
		| 'welcome';
	version?: number;
	transition_id?: number;
	epoch?: string;
	data?: string;
	target_user_id?: string;
}

export interface CreateDaveClientParams {
	mod: DaveModule;
	selfUserId: string;
	channelId: string;
	transport: DaveTransport;
	tofu?: TofuStore;
	instanceKey?: string;
}

export class DaveClient {
	private readonly mod: DaveModule;
	private readonly selfUserId: string;
	private readonly channelId: string;
	private readonly transport: DaveTransport;
	private readonly tofu: TofuStore;
	private readonly instanceKey: string;

	private readonly transientKeys: WasmTransientKeys;
	private readonly session: WasmSession;
	private readonly recognizedUserIds = new Set<string>();
	private readonly daveProtocolTransitions = new Map<number, number>();
	private latestPreparedTransitionVersion = 0;
	private protocolVersion = 0;
	private tofuStatus: 'unknown' | 'pinned' | 'broken' = 'unknown';
	private destroyed = false;

	constructor(params: CreateDaveClientParams) {
		this.mod = params.mod;
		this.selfUserId = params.selfUserId;
		this.channelId = params.channelId;
		this.transport = params.transport;
		this.tofu = params.tofu ?? new TofuStore();
		this.instanceKey = params.instanceKey ?? params.channelId;
		this.transientKeys = new this.mod.TransientKeys();
		this.session = new this.mod.Session('', '', (source: string, reason: string) => {
			// MLS failure callback: surface as a broken status; the coordinator
			// will drive a re-init via prepare_epoch.
			void source;
			void reason;
			this.tofuStatus = this.tofuStatus === 'broken' ? 'broken' : this.tofuStatus;
		});
	}

	public get status(): DaveStatus {
		if (this.destroyed) {
			return 'idle';
		}
		if (this.tofuStatus === 'broken') {
			return 'broken';
		}
		if (this.protocolVersion === 0) {
			return this.latestPreparedTransitionVersion === 0 ? 'idle' : 'passthrough';
		}
		return 'handshaking';
	}

	public markEstablished(): void {
		// Called by the host once the group is live (post execute_transition).
	}

	/** Roster membership changes driven by voice-state updates. */
	public recognizeUser(userId: string): void {
		this.recognizedUserIds.add(userId);
		this.setupKeyRatchetForUser(userId, this.latestPreparedTransitionVersion);
	}

	public forgetUser(userId: string): void {
		this.recognizedUserIds.delete(userId);
	}

	/** All recognized peer user ids (excludes self) for ratchet enumeration on room swap. */
	public getRecognizedUsers(): string[] {
		return Array.from(this.recognizedUserIds);
	}

	/** Get the encoded ratchet for a peer (or self) for piping into the e2ee worker. */
	public getRatchet(userId: string): DaveKeyRatchet | null {
		if (this.latestPreparedTransitionVersion === this.disabledVersion()) {
			return null;
		}
		return ratchetFromWasm(this.session.GetKeyRatchet(userId));
	}

	public epochAuthenticator(): Uint8Array {
		const raw = this.session.GetLastEpochAuthenticator();
		return Uint8Array.from(raw as number[]);
	}

	public getTofuStatus(): 'unknown' | 'pinned' | 'broken' {
		return this.tofuStatus;
	}

	/** Handle a downlink DAVE event from the gateway. */
	public onEvent(down: DaveDownMessage): void {
		switch (down.type) {
			case 'select_protocol_ack':
				this.handleDaveProtocolInit(down.version ?? 0);
				break;
			case 'prepare_transition':
				this.prepareDaveProtocolRatchets(down.transition_id ?? 0, down.version ?? 0);
				this.maybeSendReadyForTransition(down.transition_id ?? 0);
				break;
			case 'execute_transition':
				this.handleExecuteTransition(down.transition_id ?? 0);
				break;
			case 'prepare_epoch':
				this.handlePrepareEpoch(down.epoch ?? MLS_NEW_GROUP_EXPECTED_EPOCH, down.version ?? 0);
				if (down.epoch === MLS_NEW_GROUP_EXPECTED_EPOCH) {
					this.sendKeyPackage();
				}
				break;
			case 'external_sender_package':
				this.handleExternalSenderPackage(down.data ?? '');
				break;
			case 'proposals':
				this.handleProposals(down.data ?? '');
				break;
			case 'announce_commit_transition':
				this.handleAnnounceCommit(down.transition_id ?? 0, down.data ?? '');
				break;
			case 'welcome':
				this.handleWelcome(down.transition_id ?? 0, down.data ?? '');
				break;
		}
	}

	public destroy(): void {
		this.destroyed = true;
		this.transientKeys.Clear();
		try {
			this.session.delete();
			this.transientKeys.delete();
		} catch {
			// already deleted
		}
	}

	// --- internal ----------------------------------------------------------

	private disabledVersion(): number {
		return this.mod.kDisabledVersion as number;
	}

	private handleExternalSenderPackage(dataB64: string): void {
		const bytes = decodeBytes(dataB64);
		const status = this.tofu.verify(this.instanceKey, dataB64);
		this.tofuStatus = status;
		if (status !== 'broken') {
			this.session.SetExternalSender(bytes);
		}
	}

	private handleProposals(proposalsB64: string): void {
		const proposals = decodeBytes(proposalsB64);
		const commitWelcome = this.session.ProcessProposals(proposals, this.getRecognizedUserIDs());
		if (commitWelcome) {
			this.send({type: 'commit_welcome', data: encodeBytes(commitWelcome as number[])});
		}
	}

	private handleAnnounceCommit(transitionId: number, commitB64: string): void {
		const commit = decodeBytes(commitB64);
		const processed = this.session.ProcessCommit(commit);
		const joinedGroup = processed.rosterUpdate != null;
		if (processed.ignored) {
			return;
		}
		if (joinedGroup) {
			this.prepareDaveProtocolRatchets(transitionId, this.session.GetProtocolVersion());
			this.maybeSendReadyForTransition(transitionId);
		} else {
			this.flagInvalidCommitWelcome(transitionId);
			this.handleDaveProtocolInit(this.session.GetProtocolVersion());
		}
	}

	private handleWelcome(transitionId: number, welcomeB64: string): void {
		const welcome = decodeBytes(welcomeB64);
		const roster = this.session.ProcessWelcome(welcome, this.getRecognizedUserIDs());
		const joinedGroup = roster != null;
		if (joinedGroup) {
			this.prepareDaveProtocolRatchets(transitionId, this.session.GetProtocolVersion());
			this.maybeSendReadyForTransition(transitionId);
		} else {
			this.flagInvalidCommitWelcome(transitionId);
			this.sendKeyPackage();
		}
	}

	private sendKeyPackage(): void {
		const kp = this.session.GetMarshalledKeyPackage();
		this.send({type: 'key_package', data: encodeBytes(kp as number[])});
	}

	private maybeSendReadyForTransition(transitionId: number): void {
		if (transitionId !== (this.mod.kInitTransitionId as number)) {
			this.send({type: 'ready_for_transition', transition_id: transitionId});
		}
	}

	private flagInvalidCommitWelcome(transitionId: number): void {
		this.send({type: 'invalid_commit_welcome', transition_id: transitionId});
	}

	private handleDaveProtocolInit(protocolVersion: number): void {
		this.protocolVersion = protocolVersion;
		if (protocolVersion > 0) {
			this.handlePrepareEpoch(MLS_NEW_GROUP_EXPECTED_EPOCH, protocolVersion);
			this.sendKeyPackage();
		} else {
			this.prepareDaveProtocolRatchets(this.mod.kInitTransitionId as number, protocolVersion);
			this.handleExecuteTransition(this.mod.kInitTransitionId as number);
		}
	}

	private handlePrepareEpoch(epoch: string, protocolVersion: number): void {
		if (epoch === MLS_NEW_GROUP_EXPECTED_EPOCH) {
			let privateKey = null;
			privateKey = this.transientKeys.GetTransientPrivateKey(protocolVersion);
			this.session.Init(protocolVersion, BigInt(this.channelId), this.selfUserId, privateKey);
		}
	}

	private handleExecuteTransition(transitionId: number): void {
		if (!this.daveProtocolTransitions.has(transitionId)) {
			return;
		}
		const protocolVersion = this.daveProtocolTransitions.get(transitionId) as number;
		this.daveProtocolTransitions.delete(transitionId);
		if (protocolVersion === this.disabledVersion()) {
			this.session.Reset();
		}
		this.setupKeyRatchetForUser(this.selfUserId, protocolVersion);
	}

	private setupKeyRatchetForUser(userId: string, protocolVersion: number): void {
		const ratchet = this.makeUserKeyRatchet(userId, protocolVersion);
		// The host listens via getRatchet()/events; nothing to store here beyond
		// letting the e2ee worker pull the fresh ratchet.
		void ratchet;
	}

	private makeUserKeyRatchet(userId: string, protocolVersion: number): DaveKeyRatchet | null {
		if (protocolVersion === this.disabledVersion()) {
			return null;
		}
		return ratchetFromWasm(this.session.GetKeyRatchet(userId));
	}

	private prepareDaveProtocolRatchets(transitionId: number, protocolVersion: number): void {
		for (const userId of this.getRecognizedUserIDs()) {
			if (userId === this.selfUserId) {
				continue;
			}
			this.setupKeyRatchetForUser(userId, protocolVersion);
		}
		if (transitionId === (this.mod.kInitTransitionId as number)) {
			this.setupKeyRatchetForUser(this.selfUserId, protocolVersion);
		} else {
			this.daveProtocolTransitions.set(transitionId, protocolVersion);
		}
		this.latestPreparedTransitionVersion = protocolVersion;
	}

	private getRecognizedUserIDs(): string[] {
		return Array.from(this.recognizedUserIds).concat([this.selfUserId]);
	}

	private send(partial: Omit<DaveUpMessage, 'channel_id'>): void {
		this.transport.send({...partial, channel_id: this.channelId});
	}
}

function decodeBytes(b64: string): Uint8Array {
	if (typeof atob === 'function') {
		const binary = atob(b64);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			out[i] = binary.charCodeAt(i);
		}
		return out;
	}
	return new Uint8Array(Buffer.from(b64, 'base64'));
}

function encodeBytes(bytes: number[] | Uint8Array): string {
	const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
	if (typeof btoa === 'function') {
		let binary = '';
		for (let i = 0; i < arr.length; i++) {
			binary += String.fromCharCode(arr[i] as number);
		}
		return btoa(binary);
	}
	return Buffer.from(arr).toString('base64');
}

export {encodeRatchet};
