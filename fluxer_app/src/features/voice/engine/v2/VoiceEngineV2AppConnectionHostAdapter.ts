// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {Store} from '@app/features/voice/engine/Store';
import {sendVoiceStateDisconnect} from '@app/features/voice/engine/VoiceChannelConnector';
import {
	createVoiceConnectionSnapshot,
	getVoiceConnectionFailedTarget,
	getVoiceConnectionFailureReason,
	isLatestVoiceConnectionAttempt,
	isVoiceConnectionFailed,
	selectVoiceConnectionServerUpdateDecision,
	transitionVoiceConnectionSnapshot,
	type VoiceConnectionEvent,
	type VoiceConnectionFailureReason,
	type VoiceConnectionLocalDisconnectReason,
	type VoiceConnectionSnapshot,
} from '@app/features/voice/engine/VoiceConnectionStateMachine';
import {VoiceConnectionThrottle} from '@app/features/voice/engine/VoiceConnectionThrottle';
import {createE2EEWorker, ownE2EEWorker, releaseE2EEWorker} from '@app/features/voice/engine/VoiceE2EEKeyProvider';
import {getSharedVoiceAudioContext} from '@app/features/voice/engine/VoiceSharedAudioContext';
import {selectLocalMediaPublicationsForConnectionRepublish} from '@app/features/voice/engine/VoiceTrackPublicationUtils';
import {
	assertDisconnectReason,
	assertNonEmptyString,
	assertObjectLike,
	assertOptionalNonEmptyString,
	assertVoiceServerUpdateShape,
	hasAnyTerminalTransport,
	isReadyToRepublishTrack,
} from '@app/features/voice/engine/v2/VoiceEngineV2AppAdapterAssertions';
import {VoiceEngineV2AppReconnectPolicy} from '@app/features/voice/engine/v2/VoiceEngineV2AppReconnectPolicy';
import VoiceRegionTeleport from '@app/features/voice/state/VoiceRegionTeleport';
import {
	findVideoPublishCodecPolicyViolation,
	getRoomVideoPublishDefaults,
} from '@app/features/voice/utils/CodecCapabilityDetector';
import {getH264HardwareProfilesSync} from '@app/features/voice/utils/GpuEncoderCapabilities';
import {setNoiseSuppressionScopeGuildId} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionSelection';
import {SCREEN_SHARE_MAX_VIDEO_BITRATE_BPS} from '@app/features/voice/utils/ScreenShareOptions';
import {
	clearScreenShareDecodeFailures,
	getVideoDecoderExclusionsSync,
	loadVideoDecoderExclusions,
} from '@app/features/voice/utils/VideoDecoderCapabilities';
import type {
	LocalTrack,
	Room,
	RoomConnectOptions,
	RoomOptions,
	TrackPublication,
	TrackPublishOptions,
} from 'livekit-client';
import {ParticipantEvent, Room as LiveKitRoom, RoomEvent, Track} from 'livekit-client';
import {makeObservable, observableRef} from 'mobx';
import type {Subscription} from 'rxjs';
import {timer} from 'rxjs';
import {codecForTrack, DaveClient, syntheticSsrc, type DaveTransport, type DaveKeyRatchet, type DaveDownMessage} from '@fluxer/dave';
import GatewayConnection from '@app/features/gateway/transport/GatewayConnection';

const logger = new Logger('VoiceEngineV2AppConnectionHostAdapter');
const VOICE_SERVER_TIMEOUT_MS = 5000;
const VIDEO_DECODER_EXCLUSION_TIMEOUT_MS = 500;

export interface VoiceServerUpdateData {
	token: string;
	endpoint: string;
	connection_id: string;
	guild_id?: string;
	channel_id?: string;
	/** DAVE protocol version selected by the gateway coordinator (>=1 = encrypted). */
	dave_version?: number | null;
}

export interface VoiceConnectionState {
	room: Room | null;
	guildId: string | null;
	channelId: string | null;
	connecting: boolean;
	connected: boolean;
	reconnecting: boolean;
	voiceServerEndpoint: string | null;
	connectionId: string | null;
}

export interface RegionHotSwapState {
	pendingRoom: Room | null;
	previousRoom: Room | null;
	inProgress: boolean;
}

export type HotSwapQueuedOperation = () => void | Promise<void>;
export type VoiceConnectFailureHandler = (
	guildId: string | null,
	channelId: string,
	connectionId: string | null,
	attemptId: number,
	error: unknown,
) => void | Promise<void>;

const initialConnectionState: VoiceConnectionState = {
	room: null,
	guildId: null,
	channelId: null,
	connecting: false,
	connected: false,
	reconnecting: false,
	voiceServerEndpoint: null,
	connectionId: null,
};
const initialHotSwapState: RegionHotSwapState = {
	pendingRoom: null,
	previousRoom: null,
	inProgress: false,
};
const REGION_HOT_SWAP_TIMEOUT_MS = 10000;

/** Pushes DAVE key material into the currently active room's E2EE worker. */
interface DaveKeyMaterialSink {
	setRatchet(identity: string, ratchet: DaveKeyRatchet | null): void;
	setPassthrough(identity: string, enabled: boolean): void;
}

/**
 * LiveKit identities are `user_<snowflake>_<connection_id>`; the DAVE/MLS
 * domain (leaf credentials via std::stoull, DS proposals and welcomes) speaks
 * raw snowflake strings. Convert once here; the E2EE worker keeps LiveKit ids.
 */
function daveUserIdFromIdentity(identity: string | null | undefined): string | null {
	const m = identity ? /^user_(\d+)(?:_|$)/.exec(identity) : null;
	return m ? m[1] : null;
}

function createRoomKeySink(room: Room): DaveKeyMaterialSink {
	return {
		setRatchet: (identity, ratchet) => room.setParticipantRatchet(identity, ratchet),
		setPassthrough: (identity, enabled) => room.setParticipantPassthrough(identity, enabled),
	};
}

async function getRoomVideoDecoderExclusions(): Promise<RoomOptions['subscriberVideoCodecExclusions']> {
	let timeoutId: NodeJS.Timeout | undefined;
	const timeout = new Promise<null>((resolve) => {
		timeoutId = setTimeout(() => resolve(null), VIDEO_DECODER_EXCLUSION_TIMEOUT_MS);
	});
	try {
		await Promise.race([loadVideoDecoderExclusions(), timeout]);
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
	}
	const exclusions = getVideoDecoderExclusionsSync();
	return exclusions && exclusions.length > 0 ? exclusions : undefined;
}

function createWebAudioMixOption(): RoomOptions['webAudioMix'] {
	const audioContext = getSharedVoiceAudioContext();
	if (audioContext) {
		assert.notEqual(audioContext.state, 'closed', 'shared voice AudioContext handed to LiveKit must not be closed');
		return {audioContext};
	}
	return true;
}

function createRoomPublishDefaults(): RoomOptions['publishDefaults'] {
	return {
		screenShareEncoding: {
			maxBitrate: SCREEN_SHARE_MAX_VIDEO_BITRATE_BPS,
			maxFramerate: 30,
			priority: 'high',
		},
		...getRoomVideoPublishDefaults(),
	};
}

function createRoomOptions(
	daveVersion: number | null,
	subscriberVideoCodecExclusions: RoomOptions['subscriberVideoCodecExclusions'],
): {
	roomOptions: RoomOptions;
	e2eeWorker: Worker | null;
} {
	const roomOptions: RoomOptions = {
		adaptiveStream: false,
		dynacast: true,
		webAudioMix: createWebAudioMixOption(),
		publishDefaults: createRoomPublishDefaults(),
		subscriberVideoCodecExclusions,
		h264HardwareProfiles: getH264HardwareProfilesSync()?.profiles,
	};
	let e2eeWorker: Worker | null = null;
	const daveEnabled = typeof daveVersion === 'number' && daveVersion >= 1;
	if (daveEnabled) {
		try {
			e2eeWorker = createE2EEWorker();
			roomOptions.e2ee = {worker: e2eeWorker, mode: 'dave'} as RoomOptions['e2ee'];
		} catch (error) {
			logger.error('Failed to construct DAVE E2EE worker', error);
			e2eeWorker?.terminate();
			e2eeWorker = null;
		}
	}
	return {roomOptions, e2eeWorker};
}

function createRoomConnectOptions(): RoomConnectOptions {
	const connectOptions: RoomConnectOptions = {
		autoSubscribe: false,
	};
	assert.equal(connectOptions.autoSubscribe, false, 'LiveKit connect options must not auto-subscribe');
	return connectOptions;
}

export class VoiceEngineV2AppConnectionHostAdapter extends Store {
	connectionState: VoiceConnectionState = initialConnectionState;
	hotSwapState: RegionHotSwapState = initialHotSwapState;
	private connectionSnapshot: VoiceConnectionSnapshot = createVoiceConnectionSnapshot();
	private throttle = new VoiceConnectionThrottle();
	private reconnect = new VoiceEngineV2AppReconnectPolicy();
	private voiceServerTimeoutSub: Subscription | null = null;
	private hotSwapTimeoutSub: Subscription | null = null;
	private isLocalDisconnecting = false;
	private hotSwapOperationQueue: Array<HotSwapQueuedOperation> = [];
	private daveClient: DaveClient | null = null;
	/**
	 * DAVE downlink events that arrived before the DaveClient existed. The join
	 * cascade (select_protocol_ack + external_sender_package) fires while the
	 * LiveKit room is still connecting; without this buffer they are lost and the
	 * MLS handshake never starts. Replayed in bindDaveSession, cleared in
	 * teardownDave. Capped FIFO.
	 */
	private earlyDaveEvents: DaveDownMessage[] = [];
	/** MLS-domain (snowflake) user id of the local participant. */
	private daveSelfUserId: string | null = null;
	/** MLS user id -> LiveKit identity, for pushing ratchets into the room sink. */
	private readonly daveUserToIdentity = new Map<string, string>();
	// Sink installed by the join path to push ratchets and passthrough windows
	// into the E2EE worker of the currently active room.
	private daveKeySink: DaveKeyMaterialSink | null = null;
	// DAVE protocol version negotiated for the current connection (null = not DAVE).
	private activeDaveVersion: number | null = null;
	// One-shot guard: TOFU storage unavailable means key-change detection is off.
	private tofuUnavailableLogged = false;

	constructor() {
		super();
		makeObservable(this, {
			connectionState: observableRef,
			hotSwapState: observableRef,
		});
		this.throttle.subscribe(() => this.emitChange());
		this.reconnect.subscribe(() => this.emitChange());
	}

	get room(): Room | null {
		return this.connectionState.room;
	}

	get guildId(): string | null {
		return this.connectionState.guildId;
	}

	get channelId(): string | null {
		return this.connectionState.channelId;
	}

	get connected(): boolean {
		return this.connectionState.connected;
	}

	/** Register the active DAVE session client and its key-material sink. */
	registerDaveClient(client: DaveClient | null, sink: DaveKeyMaterialSink | null): void {
		this.daveClient = client;
		this.daveKeySink = sink;
	}

	/** Forward a gateway DAVE event to the active DaveClient and sync key material. */
	routeDaveProtocolEvent(down: DaveDownMessage): void {
		const client = this.daveClient;
		if (client === null) {
			const targetChannelId = this.connectionState.channelId;
			if (targetChannelId !== null && down.channel_id === targetChannelId) {
				if (this.earlyDaveEvents.length >= 64) {
					this.earlyDaveEvents.shift();
					logger.warn('DAVE early-event buffer overflow; dropped oldest event', {type: down.type});
				}
				this.earlyDaveEvents.push(down);
				logger.debug('Buffered DAVE event before client ready', {type: down.type});
			} else {
				logger.debug('Dropping DAVE event for non-target channel', {type: down.type});
			}
			return;
		}
		client.onEvent(down);
		this.syncDaveKeyMaterial();
	}

	/**
	 * Mirror the DAVE session into the worker: self ratchet always (a null
	 * self-ratchet must fall back to silence/drop), recognized-peer ratchets
	 * when present, and the version-0 passthrough window for every peer.
	 */
	private syncDaveKeyMaterial(): void {
		const client = this.daveClient;
		const sink = this.daveKeySink;
		if (client === null || sink === null) {
			return;
		}
		const selfLkId = this.selfUserId();
		const selfUid = this.daveSelfUserId;
		if (selfLkId && selfUid) {
			sink.setRatchet(selfLkId, client.getRatchet(selfUid));
		}
		const passthrough = client.status === 'passthrough';
		for (const uid of client.getRecognizedUsers()) {
			const lkId = this.daveUserToIdentity.get(uid);
			if (!lkId) {
				continue;
			}
			const ratchet = client.getRatchet(uid);
			if (ratchet !== null) {
				sink.setRatchet(lkId, ratchet);
			}
			sink.setPassthrough(lkId, passthrough);
		}
	}

	private handleDavePeerJoined(peerIdentity: string): void {
		const client = this.daveClient;
		if (client === null || !peerIdentity) {
			return;
		}
		const uid = daveUserIdFromIdentity(peerIdentity);
		if (uid === null) {
			logger.warn('DAVE ignoring peer with unparseable identity', {peerIdentity});
			return;
		}
		this.daveUserToIdentity.set(uid, peerIdentity);
		client.recognizeUser(uid);
		this.syncDaveKeyMaterial();
	}

	private handleDavePeerLeft(peerIdentity: string): void {
		const client = this.daveClient;
		if (client === null || !peerIdentity) {
			return;
		}
		const uid = daveUserIdFromIdentity(peerIdentity);
		if (uid !== null) {
			client.forgetUser(uid);
			this.daveUserToIdentity.delete(uid);
		}
		// An explicit null ratchet release also tears the peer's receive cryptor
		// down in the worker (distinct from "not established yet", which is
		// simply not pushed).
		this.daveKeySink?.setRatchet(peerIdentity, null);
		this.syncDaveKeyMaterial();
	}

	/**
	 * Bind the DAVE client to a LiveKit room: point the key sink at it, seed
	 * the roster with participants already present, then track joins/leaves
	 * and outbound track codecs. Used on first connect and on region hot-swap.
	 */
	private bindDaveSession(room: Room, client: DaveClient): void {
		this.registerDaveClient(client, createRoomKeySink(room));
		for (const peer of room.remoteParticipants.values()) {
			this.handleDavePeerJoined(peer.identity);
		}
		room.on(RoomEvent.ParticipantConnected, (peer) => this.handleDavePeerJoined(peer.identity));
		room.on(RoomEvent.ParticipantDisconnected, (peer) => this.handleDavePeerLeft(peer.identity));
		this.bindDaveTrackCodecs(room);
		this.syncDaveKeyMaterial();
		// Replay downlink events that raced ahead of the connection.
		const pending = this.earlyDaveEvents;
		this.earlyDaveEvents = [];
		for (const down of pending) {
			logger.debug('Replaying buffered DAVE event', {type: down.type});
			this.routeDaveProtocolEvent(down);
		}
	}

	/**
	 * Map each local track's synthetic SSRC (deterministically derived from
	 * identity + trackSid, as both peers compute it) to its DAVE codec, so
	 * libdave's Encryptor knows the codec per SSRC instead of Unknown.
	 */
	private bindDaveTrackCodecs(room: Room): void {
		const selfId = this.selfUserId();
		if (!selfId) {
			return;
		}
		const assign = (pub: TrackPublication): void => {
			const msid = pub.track?.mediaStreamID;
			if (!msid || !pub.trackSid) {
				return;
			}
			let kind: 'audio' | 'video';
			if (pub.kind === Track.Kind.Audio) {
				kind = 'audio';
			} else if (pub.kind === Track.Kind.Video) {
				kind = 'video';
			} else {
				return;
			}
			const codecName = pub.trackInfo?.codecs?.[0]?.mimeType?.split('/')[1];
			room.assignTrackCodec(selfId, msid, syntheticSsrc(selfId, pub.trackSid), codecForTrack(kind, codecName));
		};
		room.localParticipant.trackPublications.forEach(assign);
		room.localParticipant.on(ParticipantEvent.LocalTrackPublished, assign);
	}

	private selfUserId(): string | null {
		return this.connectionState.room?.localParticipant?.identity ?? null;
	}

	/** True when the current connection negotiated DAVE (version >= 1). */
	private isDaveEnabled(): boolean {
		return this.activeDaveVersion !== null && this.activeDaveVersion >= 1;
	}

	/**
	 * DAVE-derived inputs for computeChannelE2EEStatus. Empty when there is no
	 * active DAVE session, so non-DAVE rooms keep their legacy capability-only
	 * computation.
	 */
	getDaveStatusInputs(): {localDaveEstablished?: boolean; tofuOk?: boolean} {
		const client = this.daveClient;
		if (client === null || !this.isDaveEnabled()) {
			return {};
		}
		const tofu = client.getTofuStatus();
		if (tofu === 'unavailable' && !this.tofuUnavailableLogged) {
			this.tofuUnavailableLogged = true;
			logger.warn('DAVE TOFU store unavailable: key-change detection is inactive for this session');
		}
		return {localDaveEstablished: client.status === 'established', tofuOk: tofu !== 'broken'};
	}

	get connecting(): boolean {
		return this.connectionState.connecting;
	}

	get reconnecting(): boolean {
		return this.connectionState.reconnecting;
	}

	get connectionId(): string | null {
		return this.connectionState.connectionId;
	}

	get voiceServerEndpoint(): string | null {
		return this.connectionState.voiceServerEndpoint;
	}

	get shouldAutoReconnect(): boolean {
		return this.reconnect.shouldAutoReconnect;
	}

	get reconnectAttempts(): number {
		return this.reconnect.reconnectAttempts;
	}

	get disconnecting(): boolean {
		return this.isLocalDisconnecting;
	}

	get localDisconnectReason(): VoiceConnectionLocalDisconnectReason {
		return this.connectionSnapshot.context.localDisconnectReason;
	}

	get connectFailed(): boolean {
		return isVoiceConnectionFailed(this.connectionSnapshot);
	}

	get connectFailureReason(): VoiceConnectionFailureReason {
		return getVoiceConnectionFailureReason(this.connectionSnapshot);
	}

	get connectFailedTarget(): {guildId: string | null; channelId: string} | null {
		return getVoiceConnectionFailedTarget(this.connectionSnapshot);
	}

	get regionHotSwapInProgress(): boolean {
		return this.hotSwapState.inProgress;
	}

	enqueueOrRun(operation: HotSwapQueuedOperation): void {
		assert.equal(typeof operation, 'function', 'enqueueOrRun.operation must be a function');
		assert.ok(this.hotSwapOperationQueue.length <= 4096, 'enqueueOrRun pre-condition: queue under cap');
		if (!this.hotSwapState.inProgress) {
			try {
				const result = operation();
				if (result && typeof (result as Promise<void>).catch === 'function') {
					void (result as Promise<void>).catch((error) => {
						logger.error('Immediate operation failed', {error});
					});
				}
			} catch (error) {
				logger.error('Immediate operation failed', {error});
			}
			return;
		}
		logger.debug('Queueing operation during hot-swap', {queueLength: this.hotSwapOperationQueue.length + 1});
		this.update(() => {
			this.transitionConnection({type: 'hotSwap.queueOperation'});
		});
		this.hotSwapOperationQueue.push(operation);
	}

	private async drainHotSwapQueue(): Promise<void> {
		const ops = this.hotSwapOperationQueue.splice(0);
		if (ops.length === 0) return;
		this.update(() => {
			this.transitionConnection({type: 'hotSwap.drainQueue'});
		});
		logger.info('Draining hot-swap operation queue', {count: ops.length});
		for (const op of ops) {
			try {
				await op();
			} catch (error) {
				logger.warn('Queued hot-swap operation failed during drain', {error});
			}
		}
	}

	private clearHotSwapQueue(): void {
		if (this.hotSwapOperationQueue.length > 0) {
			logger.info('Clearing hot-swap operation queue', {discarded: this.hotSwapOperationQueue.length});
		}
		this.hotSwapOperationQueue.length = 0;
		this.update(() => {
			this.transitionConnection({type: 'hotSwap.clearQueue'});
		});
	}

	get lastConnectedChannel(): {
		guildId: string;
		channelId: string;
	} | null {
		return this.reconnect.lastConnectedChannel;
	}

	private transitionConnection(event: VoiceConnectionEvent): void {
		const wasTeleporting = this.hotSwapState.inProgress;
		this.connectionSnapshot = transitionVoiceConnectionSnapshot(this.connectionSnapshot, event);
		const {context} = this.connectionSnapshot;
		this.connectionState = {
			room: context.room as Room | null,
			guildId: context.guildId,
			channelId: context.channelId,
			connecting: context.connecting,
			connected: context.connected,
			reconnecting: context.reconnecting,
			voiceServerEndpoint: context.voiceServerEndpoint,
			connectionId: context.connectionId,
		};
		setNoiseSuppressionScopeGuildId(context.guildId);
		this.hotSwapState = {
			pendingRoom: context.hotSwap.pendingRoom as Room | null,
			previousRoom: context.hotSwap.previousRoom as Room | null,
			inProgress: context.hotSwap.inProgress,
		};
		const isTeleporting = this.hotSwapState.inProgress;
		if (isTeleporting && !wasTeleporting) {
			VoiceRegionTeleport.beginTeleport();
		}
		if (!isTeleporting && wasTeleporting) {
			VoiceRegionTeleport.endTeleport();
		}
	}

	private isLatestConnectionAttempt(attemptId: number): boolean {
		return (
			isLatestVoiceConnectionAttempt(this.connectionSnapshot, attemptId) && this.throttle.isLatestAttempt(attemptId)
		);
	}

	private syncThrottleToCurrentAttempt(): void {
		this.throttle.setLatestAttemptId(this.connectionSnapshot.context.connectionAttemptId);
	}

	private invalidateThrottleAttempt(): void {
		this.throttle.setLatestAttemptId(this.connectionSnapshot.context.connectionAttemptId + 1);
	}

	startConnection(guildId: string | null, channelId: string): boolean {
		assertOptionalNonEmptyString(guildId, 'startConnection.guildId');
		assertNonEmptyString(channelId, 'startConnection.channelId');
		if (this.throttle.shouldThrottle()) {
			logger.warn('Connection throttled');
			return false;
		}
		this.throttle.recordConnectRequest();
		this.update(() => {
			this.transitionConnection({type: 'connection.start', guildId, channelId});
		});
		this.syncThrottleToCurrentAttempt();
		this.throttle.setInFlightConnect(true);
		this.scheduleVoiceServerTimeout(guildId, channelId);
		logger.info('Connection started', {guildId, channelId});
		return true;
	}

	recoverConnectionExpectation(guildId: string | null, channelId: string): void {
		assertOptionalNonEmptyString(guildId, 'recoverConnectionExpectation.guildId');
		assertNonEmptyString(channelId, 'recoverConnectionExpectation.channelId');
		this.throttle.recordConnectRequest();
		this.update(() => {
			this.transitionConnection({type: 'connection.recoverExpectation', guildId, channelId});
		});
		this.syncThrottleToCurrentAttempt();
		this.throttle.setInFlightConnect(true);
		this.scheduleVoiceServerTimeout(guildId, channelId);
		logger.info('Connection expectation recovered', {guildId, channelId});
	}

	handleVoiceServerUpdate(
		raw: VoiceServerUpdateData,
		onRoomCreated: (room: Room, attemptId: number, guildId: string | null, channelId: string) => void,
		onBeforeReconnect?: (isChannelMove: boolean, previousRoom: Room) => boolean | undefined,
		onRoomClosed?: (room: Room, attemptId: number) => void,
		onHotSwapComplete?: (newRoom: Room, attemptId: number, guildId: string | null, channelId: string) => void,
		onConnectFailed?: VoiceConnectFailureHandler,
	): void {
		assertVoiceServerUpdateShape(raw, 'handleVoiceServerUpdate.raw');
		assert.equal(typeof onRoomCreated, 'function', 'handleVoiceServerUpdate.onRoomCreated must be a function');
		void this.handleVoiceServerUpdateAsync(
			raw,
			onRoomCreated,
			onBeforeReconnect,
			onRoomClosed,
			onHotSwapComplete,
			onConnectFailed,
		);
	}

	private async handleVoiceServerUpdateAsync(
		raw: VoiceServerUpdateData,
		onRoomCreated: (room: Room, attemptId: number, guildId: string | null, channelId: string) => void,
		onBeforeReconnect?: (isChannelMove: boolean, previousRoom: Room) => boolean | undefined,
		onRoomClosed?: (room: Room, attemptId: number) => void,
		onHotSwapComplete?: (newRoom: Room, attemptId: number, guildId: string | null, channelId: string) => void,
		onConnectFailed?: VoiceConnectFailureHandler,
	): Promise<void> {
		const decision = selectVoiceConnectionServerUpdateDecision(this.connectionSnapshot, raw);
		const {
			guildId: expectedGuildId,
			channelId: expectedChannelId,
			connected,
			room: existingRoom,
			voiceServerEndpoint: currentEndpoint,
		} = this.connectionState;
		const guildId = raw.guild_id ?? null;
		const endpoint = raw.endpoint ?? null;
		const token = raw.token ?? null;
		const connectionId = raw.connection_id ?? null;
		const incomingChannelId = raw.channel_id ?? null;
		const attemptId = decision.attemptId;
		logger.debug('handleVoiceServerUpdate called', {
			incomingGuildId: guildId,
			expectedGuildId,
			incomingChannelId,
			expectedChannelId,
			endpoint,
			hasToken: !!token,
			connectionId,
			attemptId,
		});
		if (decision.type === 'ignore' && decision.reason === 'guild-or-channel-mismatch') {
			logger.warn('Ignoring VOICE_SERVER_UPDATE: guild or channel mismatch', {
				expectedGuildId: decision.expectedGuildId,
				incomingGuildId: decision.incomingGuildId,
				expectedChannelId: decision.expectedChannelId,
				incomingChannelId: decision.incomingChannelId,
			});
			return;
		}
		if (decision.type === 'ignore' && decision.reason === 'stale-channel-update') {
			logger.warn('Ignoring VOICE_SERVER_UPDATE: stale channel update', {
				expectedChannelId: decision.expectedChannelId,
				incomingChannelId: decision.incomingChannelId,
				connectionId,
			});
			return;
		}
		if (decision.type === 'ignore' && decision.reason === 'stale-attempt') {
			logger.warn('Ignoring VOICE_SERVER_UPDATE: not latest attempt', {attemptId});
			return;
		}
		if (decision.type !== 'accept') return;
		const isChannelMove = decision.isChannelMove;
		if (isChannelMove) {
			if (connected) {
				logger.info('VOICE_SERVER_UPDATE: server-initiated channel move', {
					expectedChannelId,
					incomingChannelId,
					connectionId,
				});
			}
		}
		if (decision.isRegionChange) {
			logger.info('VOICE_SERVER_UPDATE: region change detected, attempting hot-swap', {
				previousEndpoint: currentEndpoint,
				newEndpoint: endpoint,
				guildId,
				channelId: decision.resolvedChannelId,
			});
			await this.handleRegionHotSwap(
				raw,
				decision.currentRoom as Room,
				attemptId,
				decision.guildId,
				decision.resolvedChannelId,
				onRoomCreated,
				onRoomClosed,
				onHotSwapComplete,
			);
			return;
		}
		const resolvedChannelId = decision.resolvedChannelId;
		this.clearVoiceServerTimeout();
		let previousRoom = connected && existingRoom ? existingRoom : null;
		let shouldStopPreviousRoomTracks = true;
		if (previousRoom) {
			shouldStopPreviousRoomTracks = isChannelMove || onBeforeReconnect?.(isChannelMove, previousRoom) !== true;
			previousRoom.removeAllListeners();
			if (isChannelMove) {
				this.disconnectPreviousRoom(previousRoom);
				previousRoom = null;
			}
		}
		this.update(() => {
			this.transitionConnection({
				type: 'voiceServer.accepted',
				guildId,
				channelId: resolvedChannelId,
				endpoint,
				connectionId,
				isChannelMove,
			});
		});
		this.throttle.setInFlightConnect(true);
		const daveVersion = raw.dave_version ?? null;
		this.activeDaveVersion = daveVersion;
		clearScreenShareDecodeFailures();
		const subscriberVideoCodecExclusions = await getRoomVideoDecoderExclusions();
		if (
			!this.isLatestConnectionAttempt(attemptId) ||
			this.connectionState.guildId !== guildId ||
			this.connectionState.channelId !== resolvedChannelId
		) {
			logger.warn('Aborting LiveKit room creation after codec probing because attempt is stale', {attemptId});
			return;
		}
		const {roomOptions, e2eeWorker} = createRoomOptions(daveVersion, subscriberVideoCodecExclusions);
		const room = new LiveKitRoom(roomOptions);
		ownE2EEWorker(room, e2eeWorker);
		let roomClosed = false;
		const closeRoom = () => {
			if (roomClosed) return;
			roomClosed = true;
			releaseE2EEWorker(room);
			onRoomClosed?.(room, attemptId);
		};
		const failConnectBeforeRoomConnect = (message: string, error?: unknown) => {
			logger.error(message, error);
			closeRoom();
			this.disconnectPreviousRoom(previousRoom);
			if (!this.isLatestConnectionAttempt(attemptId)) return;
			this.update(() => {
				this.transitionConnection({type: 'connection.failed', reason: 'error'});
			});
			this.throttle.setInFlightConnect(false);
			this.reconnect.setReconnectState('error');
			void onConnectFailed?.(guildId, resolvedChannelId, connectionId, attemptId, error ?? new Error(message));
		};
		const connectRoom = () => {
			if (!this.isLatestConnectionAttempt(attemptId)) {
				closeRoom();
				return;
			}
			onRoomCreated(room, attemptId, guildId, resolvedChannelId);
			if (!endpoint || !token) {
				failConnectBeforeRoomConnect('Missing endpoint or token', {endpoint, hasToken: !!token});
				return;
			}
			logger.info('Attempting to connect to LiveKit', {endpoint, guildId, channelId: resolvedChannelId});
			const connectOptions = createRoomConnectOptions();
			room
				.connect(endpoint, token, connectOptions)
				.then(async () => {
					this.disconnectPreviousRoom(previousRoom, shouldStopPreviousRoomTracks);
					logger.info('LiveKit connection succeeded');
					const connectionState = this.connectionState;
					const connectedEventAlreadyApplied = connectionState.connected && connectionState.room == null;
					if (
						!this.isLatestConnectionAttempt(attemptId) ||
						connectionState.guildId !== guildId ||
						connectionState.channelId !== resolvedChannelId ||
						(!connectionState.connecting && !connectedEventAlreadyApplied)
					) {
						logger.warn('Connection succeeded but attempt is stale, disconnecting');
						closeRoom();
						try {
							room.removeAllListeners();
							room.disconnect();
						} catch (error) {
							logger.warn('Failed to disconnect stale room', error);
						}
						return;
					}
					logger.info('Initializing voice connection');
					this.update(() => {
						this.transitionConnection({type: 'connection.roomReady', room, attemptId});
					});
					if (this.isDaveEnabled()) {
						await this.setupDaveForRoom(room, resolvedChannelId);
					}
				})
				.catch((error) => {
					closeRoom();
					this.disconnectPreviousRoom(previousRoom);
					logger.error('LiveKit connection failed', {error, endpoint});
					if (this.isLatestConnectionAttempt(attemptId)) {
						this.update(() => {
							this.transitionConnection({type: 'connection.failed', reason: 'error'});
						});
						this.throttle.setInFlightConnect(false);
						this.reconnect.setReconnectState('error');
						void onConnectFailed?.(guildId, resolvedChannelId, connectionId, attemptId, error);
					}
				});
		};
		if (daveVersion !== null && daveVersion >= 1) {
			if (!e2eeWorker) {
				failConnectBeforeRoomConnect('Cannot join DAVE voice channel because E2EE worker setup failed');
				return;
			}
			void room
				.setE2EEEnabled(true)
				.then(() => {
					connectRoom();
				})
				.catch((error) => {
					failConnectBeforeRoomConnect(
						'Cannot join DAVE voice channel because E2EE enable failed',
						error,
					);
				});
			return;
		}
		connectRoom();
	}

	private handleRegionHotSwap(
		raw: VoiceServerUpdateData,
		existingRoom: Room,
		attemptId: number,
		guildId: string | null,
		channelId: string,
		onRoomCreated: (room: Room, attemptId: number, guildId: string | null, channelId: string) => void,
		onRoomClosed?: (room: Room, attemptId: number) => void,
		onHotSwapComplete?: (newRoom: Room, attemptId: number, guildId: string | null, channelId: string) => void,
	): Promise<void> {
		return this.handleRegionHotSwapAsync(
			raw,
			existingRoom,
			attemptId,
			guildId,
			channelId,
			onRoomCreated,
			onRoomClosed,
			onHotSwapComplete,
		);
	}

	private async handleRegionHotSwapAsync(
		raw: VoiceServerUpdateData,
		existingRoom: Room,
		attemptId: number,
		guildId: string | null,
		channelId: string,
		onRoomCreated: (room: Room, attemptId: number, guildId: string | null, channelId: string) => void,
		onRoomClosed?: (room: Room, attemptId: number) => void,
		onHotSwapComplete?: (newRoom: Room, attemptId: number, guildId: string | null, channelId: string) => void,
	): Promise<void> {
		const endpoint = raw.endpoint!;
		const token = raw.token!;
		const connectionId = raw.connection_id ?? null;
		this.abortHotSwap();
		const cachedExclusions = getVideoDecoderExclusionsSync();
		const {roomOptions, e2eeWorker} = createRoomOptions(
			this.activeDaveVersion,
			cachedExclusions && cachedExclusions.length > 0 ? cachedExclusions : undefined,
		);
		if (!this.isLatestConnectionAttempt(attemptId) || this.connectionState.room !== existingRoom) {
			logger.warn('Region hot-swap: aborted before room creation because attempt is stale', {attemptId});
			e2eeWorker?.terminate();
			return;
		}
		const newRoom = new LiveKitRoom(roomOptions);
		ownE2EEWorker(newRoom, e2eeWorker);
		this.update(() => {
			this.transitionConnection({type: 'hotSwap.start', pendingRoom: newRoom, previousRoom: existingRoom});
		});
		this.clearHotSwapTimeout();
		this.hotSwapTimeoutSub = timer(REGION_HOT_SWAP_TIMEOUT_MS).subscribe(() => {
			if (this.hotSwapState.inProgress && this.hotSwapState.pendingRoom === newRoom) {
				logger.warn('Region hot-swap timed out, aborting', {endpoint});
				this.abortHotSwap();
			}
		});
		const connectOptions = createRoomConnectOptions();
		logger.info('Region hot-swap: connecting to new endpoint', {endpoint, guildId, channelId});
		newRoom
			.connect(endpoint, token, connectOptions)
			.then(async () => {
				if (
					!this.hotSwapState.inProgress ||
					this.hotSwapState.pendingRoom !== newRoom ||
					!this.isLatestConnectionAttempt(attemptId)
				) {
					logger.warn('Region hot-swap: new room connected but hot-swap was cancelled');
					try {
						newRoom.removeAllListeners();
						newRoom.disconnect(false);
					} catch (error) {
						logger.warn('Region hot-swap: cancelled cleanup disconnect failed', {error});
					}
					return;
				}
				logger.info('Region hot-swap: new room connected, republishing tracks');
				if (this.isDaveEnabled()) {
					await this.migrateDaveToRoom(newRoom);
				}
				try {
					await this.republishLocalTracks(existingRoom, newRoom);
				} catch (error) {
					logger.warn('Region hot-swap: failed to republish tracks, aborting', {error});
					if (
						!this.hotSwapState.inProgress ||
						this.hotSwapState.pendingRoom !== newRoom ||
						!this.isLatestConnectionAttempt(attemptId)
					) {
						return;
					}
					this.abortHotSwap();
					return;
				}
				if (
					!this.hotSwapState.inProgress ||
					this.hotSwapState.pendingRoom !== newRoom ||
					!this.isLatestConnectionAttempt(attemptId)
				) {
					logger.warn('Region hot-swap: cancelled during track republishing');
					try {
						newRoom.removeAllListeners();
						newRoom.disconnect(false);
					} catch (error) {
						logger.warn('Region hot-swap: cancelled-during-republish disconnect failed', {error});
					}
					return;
				}
				logger.info('Region hot-swap: swapping room pointer');
				const previousRoom = existingRoom;
				onRoomCreated(newRoom, attemptId, guildId, channelId);
				previousRoom.removeAllListeners();
				this.update(() => {
					this.transitionConnection({type: 'hotSwap.complete', room: newRoom, endpoint, connectionId});
				});
				this.clearHotSwapTimeout();
				onHotSwapComplete?.(newRoom, attemptId, guildId, channelId);
				await this.drainHotSwapQueue();
				try {
					previousRoom.disconnect(false);
				} catch (error) {
					logger.warn('Region hot-swap: failed to disconnect old room', {error});
				}
				releaseE2EEWorker(previousRoom);
				logger.info('Region hot-swap: complete', {
					previousEndpoint: this.connectionState.voiceServerEndpoint,
					newEndpoint: endpoint,
				});
			})
			.catch((error) => {
				logger.error('Region hot-swap: failed to connect to new endpoint', {error, endpoint});
				onRoomClosed?.(newRoom, attemptId);
				try {
					newRoom.removeAllListeners();
					newRoom.disconnect();
				} catch (cleanupError) {
					logger.warn('Region hot-swap: failed disconnect after connect failure', {cleanupError});
				}
				if (
					!this.hotSwapState.inProgress ||
					this.hotSwapState.pendingRoom !== newRoom ||
					!this.isLatestConnectionAttempt(attemptId)
				) {
					return;
				}
				this.update(() => {
					this.transitionConnection({type: 'hotSwap.reset'});
				});
				this.clearHotSwapTimeout();
				this.clearHotSwapQueue();
				logger.info('Region hot-swap: keeping old room on previous endpoint');
			});
	}

	private async republishLocalTracks(oldRoom: Room, newRoom: Room): Promise<void> {
		const oldParticipant = oldRoom.localParticipant;
		const newParticipant = newRoom.localParticipant;
		if (!oldParticipant || !newParticipant) {
			logger.warn('Region hot-swap: missing participant for track republishing');
			return;
		}
		const publications = selectLocalMediaPublicationsForConnectionRepublish(
			Array.from(oldParticipant.trackPublications.values()),
		);
		const errors: Array<{source: string; error: unknown}> = [];
		let codecPolicyFailure: Error | null = null;
		for (const publication of publications) {
			const track = publication.track as LocalTrack | undefined;
			if (!isReadyToRepublishTrack(track)) {
				logger.debug('Region hot-swap: skipping ended or missing track', {
					source: publication.source,
					trackSid: publication.trackSid,
				});
				continue;
			}
			try {
				logger.debug('Region hot-swap: republishing track', {
					source: publication.source,
					kind: track.kind,
				});
				const publishOptions = {
					...((publication as {options?: TrackPublishOptions}).options ?? {}),
					source: publication.source,
					name: publication.trackName,
				};
				const republished = await newParticipant.publishTrack(track.mediaStreamTrack, publishOptions);
				const violation = publishOptions.videoCodec
					? findVideoPublishCodecPolicyViolation(publishOptions.videoCodec, republished.options?.videoCodec)
					: null;
				if (violation) {
					codecPolicyFailure = new Error(
						`Region hot-swap: ${publication.source} negotiated ${violation.negotiated} after requesting ${violation.requested}`,
					);
					break;
				}
			} catch (error) {
				errors.push({source: publication.source ?? 'unknown', error});
				logger.warn('Region hot-swap: failed to republish track', {
					source: publication.source,
					error,
				});
			}
		}
		if (codecPolicyFailure) throw codecPolicyFailure;
		const screenShareFailure = errors.find(
			(error) => error.source === Track.Source.ScreenShare || error.source === Track.Source.ScreenShareAudio,
		);
		if (screenShareFailure) {
			throw new Error(`Screen share track republish failed for ${screenShareFailure.source}`);
		}
		if (errors.length > 0 && errors.length === publications.length) {
			throw new Error(`All ${errors.length} track republications failed`);
		}
		if (errors.length > 0) {
			logger.warn('Region hot-swap: some tracks failed to republish', {
				total: publications.length,
				failed: errors.length,
			});
		}
	}

	abortHotSwap(): void {
		assert.ok(this.hotSwapOperationQueue.length <= 4096, 'abortHotSwap pre-condition: queue under cap');
		assert.ok(this.connectionSnapshot !== null, 'abortHotSwap pre-condition: connection snapshot present');
		if (!this.hotSwapState.inProgress) return;
		const {pendingRoom} = this.hotSwapState;
		logger.info('Aborting region hot-swap');
		if (pendingRoom) {
			try {
				pendingRoom.removeAllListeners();
				pendingRoom.disconnect(false);
			} catch (error) {
				logger.warn('Failed to disconnect pending hot-swap room', {error});
			}
		}
		this.update(() => {
			this.transitionConnection({type: 'hotSwap.abort'});
		});
		this.clearHotSwapTimeout();
		this.clearHotSwapQueue();
	}

	markConnected(): void {
		assert.ok(this.connectionSnapshot !== null, 'markConnected pre-condition: connection snapshot present');
		const {guildId, channelId} = this.connectionState;
		assertNonEmptyString(channelId, 'markConnected pre-condition: channelId present');
		this.update(() => {
			this.transitionConnection({type: 'connection.connected'});
		});
		this.reconnect.setLastConnectedChannel(guildId, channelId);
		this.throttle.setInFlightConnect(false);
		this.reconnect.resetOnConnection();
		assert.ok(this.connectionState.connected, 'markConnected post-condition: connection state reflects connected');
		logger.info('Connection established');
	}

	markDisconnected(reason: 'user' | 'error' | 'server' = 'user'): void {
		assertDisconnectReason(reason, 'markDisconnected.reason');
		this.update(() => {
			this.transitionConnection({type: 'connection.disconnected', reason});
		});
		this.invalidateThrottleAttempt();
		this.throttle.setInFlightConnect(false);
		this.reconnect.setReconnectState(reason);
		logger.info('Connection terminated', {reason});
	}

	markReconnecting(): void {
		assert.ok(this.connectionSnapshot !== null, 'markReconnecting pre-condition: connection snapshot present');
		this.update(() => {
			this.transitionConnection({type: 'connection.reconnecting'});
		});
		logger.info('Connection reconnecting');
	}

	markReconnected(): void {
		assert.ok(this.connectionSnapshot !== null, 'markReconnected pre-condition: connection snapshot present');
		this.update(() => {
			this.transitionConnection({type: 'connection.reconnected'});
		});
		this.reconnect.resetOnConnection();
		logger.info('Connection reconnected');
	}

	disconnectFromVoiceChannel(reason: 'user' | 'error' | 'server' = 'user'): void {
		assertDisconnectReason(reason, 'disconnectFromVoiceChannel.reason');
		const {room} = this.connectionState;
		this.update(() => {
			this.isLocalDisconnecting = reason === 'user';
		});
		this.clearVoiceServerTimeout();
		this.abortHotSwap();
		// The MLS session belongs to this connection only. Without tearing it
		// down here, the stale client stays registered and swallows the next
		// join's select_protocol_ack (resetting a freshly established group),
		// while the new client binds blind — the rejoin-corruption class the
		// channel-move path already guards against below.
		this.teardownDave();
		if (room) {
			room.removeAllListeners();
			room.disconnect();
			releaseE2EEWorker(room);
		}
		this.update(() => {
			this.transitionConnection({type: 'connection.disconnected', reason});
		});
		this.invalidateThrottleAttempt();
		this.reconnect.setReconnectState(reason);
		this.update(() => {
			this.isLocalDisconnecting = false;
		});
		logger.info('Disconnected from voice channel', {reason});
	}

	disconnectForChannelMove(): void {
		assert.ok(this.connectionSnapshot !== null, 'disconnectForChannelMove pre-condition: connection snapshot present');
		const {room} = this.connectionState;
		this.clearVoiceServerTimeout();
		this.abortHotSwap();
		// New channel means a new MLS group; the old session must not linger
		// (same rejoin-corruption class as disconnectFromVoiceChannel).
		this.teardownDave();
		if (room) {
			room.removeAllListeners();
			room.disconnect();
			releaseE2EEWorker(room);
		}
		this.update(() => {
			this.transitionConnection({type: 'connection.disconnectForChannelMove'});
		});
		this.invalidateThrottleAttempt();
		logger.info('Disconnected for channel move (preserving connectionId)');
	}

	private disconnectRoomForTerminalUnload(room: Room | null, label: string): void {
		if (!room) return;
		try {
			room.removeAllListeners();
			room.disconnect();
			logger.debug('Terminal unload LiveKit room disconnect requested', {label});
		} catch (error) {
			logger.warn('Terminal unload LiveKit room disconnect failed', {label, error});
		}
		releaseE2EEWorker(room);
	}

	hasTerminalUnloadTransports(): boolean {
		assert.ok(this.connectionSnapshot !== null, 'hasTerminalUnloadTransports pre-condition: snapshot present');
		return hasAnyTerminalTransport({current: this.connectionState, hotSwap: this.hotSwapState});
	}

	disconnectTransportsForTerminalUnload(): void {
		assert.ok(
			this.connectionSnapshot !== null,
			'disconnectTransportsForTerminalUnload pre-condition: snapshot present',
		);
		const {room} = this.connectionState;
		const {pendingRoom, previousRoom} = this.hotSwapState;
		this.clearVoiceServerTimeout();
		this.clearHotSwapTimeout();
		this.clearHotSwapQueue();
		this.teardownDave();
		this.disconnectRoomForTerminalUnload(pendingRoom, 'pending-hot-swap');
		if (previousRoom && previousRoom !== room && previousRoom !== pendingRoom) {
			this.disconnectRoomForTerminalUnload(previousRoom, 'previous-hot-swap');
		}
		this.disconnectRoomForTerminalUnload(room, 'current');
		this.throttle.setInFlightConnect(false);
		this.update(() => {
			this.isLocalDisconnecting = false;
			this.transitionConnection({type: 'connection.cleanup'});
		});
		this.invalidateThrottleAttempt();
	}

	scheduleReconnect(callback: () => void): boolean {
		assert.equal(typeof callback, 'function', 'scheduleReconnect.callback must be a function');
		return this.reconnect.scheduleReconnect(callback);
	}

	markReconnectionAttempted(): void {
		assert.ok(this.reconnect !== null, 'markReconnectionAttempted pre-condition: reconnect policy present');
		this.reconnect.markAttempted();
	}

	resetReconnectState(): void {
		assert.ok(this.reconnect !== null, 'resetReconnectState pre-condition: reconnect policy present');
		this.reconnect.reset();
	}

	forgetReconnectChannel(channelId: string): void {
		assertNonEmptyString(channelId, 'forgetReconnectChannel.channelId');
		this.reconnect.forgetChannel(channelId);
	}

	updateChannelId(channelId: string): void {
		assertNonEmptyString(channelId, 'updateChannelId.channelId');
		this.update(() => {
			this.transitionConnection({type: 'connection.updateChannel', channelId});
		});
		logger.info('Channel updated', {channelId});
	}

	acceptServerChannelChange(channelId: string): void {
		assertNonEmptyString(channelId, 'acceptServerChannelChange.channelId');
		const previousChannelId = this.connectionState.channelId;
		this.update(() => {
			this.transitionConnection({type: 'connection.acceptServerChannelChange', channelId});
		});
		this.reconnect.setLastConnectedChannel(this.connectionState.guildId, channelId);
		logger.info('Accepted server channel change', {previousChannelId, newChannelId: channelId});
	}

	createGuardedHandler<T extends ReadonlyArray<unknown>>(
		attemptId: number,
		handler: (...args: T) => void | Promise<void>,
	): (...args: T) => void {
		assert.equal(typeof attemptId, 'number', 'createGuardedHandler.attemptId must be a number');
		assert.ok(Number.isFinite(attemptId), 'createGuardedHandler.attemptId must be finite');
		assert.equal(typeof handler, 'function', 'createGuardedHandler.handler must be a function');
		return (...args: T) => {
			if (!this.isLatestConnectionAttempt(attemptId)) {
				return;
			}
			try {
				const result = handler(...args);
				if (result && typeof (result as Promise<void>).catch === 'function') {
					void (result as Promise<void>).catch((error) => {
						logger.error('Guarded voice handler failed', {attemptId, error});
					});
				}
			} catch (error) {
				logger.error('Guarded voice handler failed', {attemptId, error});
			}
		};
	}

	bindConnectionEvents(
		room: Room,
		attemptId: number,
		handlers: {
			onConnected: () => void;
			onDisconnected: (reason?: unknown) => void;
			onReconnecting: () => void;
			onReconnected: () => void;
		},
	): void {
		assertObjectLike<Room>(room, 'bindConnectionEvents.room');
		assert.equal(typeof attemptId, 'number', 'bindConnectionEvents.attemptId must be a number');
		assertObjectLike<typeof handlers>(handlers, 'bindConnectionEvents.handlers');
		assert.equal(
			typeof handlers.onConnected,
			'function',
			'bindConnectionEvents.handlers.onConnected must be a function',
		);
		assert.equal(
			typeof handlers.onDisconnected,
			'function',
			'bindConnectionEvents.handlers.onDisconnected must be a function',
		);
		assert.equal(
			typeof handlers.onReconnecting,
			'function',
			'bindConnectionEvents.handlers.onReconnecting must be a function',
		);
		assert.equal(
			typeof handlers.onReconnected,
			'function',
			'bindConnectionEvents.handlers.onReconnected must be a function',
		);
		room.on(RoomEvent.Connected, this.createGuardedHandler(attemptId, handlers.onConnected));
		room.on(RoomEvent.Disconnected, this.createGuardedHandler(attemptId, handlers.onDisconnected));
		room.on(RoomEvent.Reconnecting, this.createGuardedHandler(attemptId, handlers.onReconnecting));
		room.on(RoomEvent.Reconnected, this.createGuardedHandler(attemptId, handlers.onReconnected));
	}

	resetConnectionState(): void {
		assert.ok(this.connectionSnapshot !== null, 'resetConnectionState pre-condition: snapshot present');
		this.abortHotSwap();
		this.teardownDave();
		this.update(() => {
			this.isLocalDisconnecting = false;
			this.transitionConnection({type: 'connection.reset'});
		});
		this.invalidateThrottleAttempt();
		this.throttle.setInFlightConnect(false);
	}

	clearInFlightConnect(): void {
		assert.ok(this.throttle !== null, 'clearInFlightConnect pre-condition: throttle present');
		this.throttle.setInFlightConnect(false);
	}

	abortConnection(): void {
		assert.ok(this.connectionSnapshot !== null, 'abortConnection pre-condition: snapshot present');
		this.clearVoiceServerTimeout();
		this.abortHotSwap();
		this.teardownDave();
		this.update(() => {
			this.isLocalDisconnecting = false;
			this.transitionConnection({type: 'connection.abort'});
		});
		this.invalidateThrottleAttempt();
		this.throttle.setInFlightConnect(false);
		logger.info('Connection aborted due to gateway error');
	}

	private scheduleVoiceServerTimeout(guildId: string | null, channelId: string): void {
		this.clearVoiceServerTimeout();
		this.voiceServerTimeoutSub = timer(VOICE_SERVER_TIMEOUT_MS).subscribe(() => {
			let didTimeout = false;
			let abandonedConnectionId: string | null = null;
			this.update(() => {
				if (
					this.connectionState.guildId === guildId &&
					this.connectionState.channelId === channelId &&
					!this.connectionState.connected
				) {
					logger.warn('Voice server timeout', {guildId, channelId});
					didTimeout = true;
					abandonedConnectionId = this.connectionState.connectionId;
					this.transitionConnection({type: 'voiceServer.timeout', guildId, channelId});
					this.invalidateThrottleAttempt();
					this.throttle.setInFlightConnect(false);
					this.reconnect.setReconnectState('error');
				}
			});
			if (didTimeout) {
				logger.info('Sending voice state disconnect for abandoned voice connection after timeout', {
					guildId,
					channelId,
					connectionId: abandonedConnectionId,
				});
				sendVoiceStateDisconnect(guildId, abandonedConnectionId);
			}
		});
	}
	/**
	 * Instantiate a DaveClient for a freshly-connected room and wire its uplink
	 * transport to the gateway DAVE opcode plus a ratchet sink into the room's
	 * E2EE worker. No-op when the room has no local identity yet or DAVE is
	 * already bound to this room.
	 */
	private async setupDaveForRoom(room: Room, channelId: string): Promise<void> {
		const selfId = room.localParticipant?.identity;
		if (!selfId) {
			logger.warn('DAVE setup skipped: no local participant identity');
			return;
		}
		try {
			// Never stack clients: a previous incarnation (from an earlier join
			// that skipped teardown) would keep its transport wired to the same
			// channel uplink and race this session's handshake. Destroy it via a
			// full teardown — but PRESERVE the early-event buffer: this join's
			// select_protocol_ack / external_sender_package are pushed at
			// token-issue time and typically land ~1s before the LiveKit connect
			// resolves and this client exists. Dropping them here would leave the
			// fresh client un-initialised forever ("Cannot get key ratchet").
			const pendingEvents = this.earlyDaveEvents;
			this.teardownDave();
			this.earlyDaveEvents = pendingEvents;
			const {DaveModuleFactory} = await import('@fluxer/libdave/wasm');
			const mod = await DaveModuleFactory();
			const transport: DaveTransport = {
				send: (msg) => {
					GatewayConnection.sendDaveProtocolMessage({
						channel_id: msg.channel_id,
						guild_id: this.connectionState.guildId ?? undefined,
						type: msg.type,
						transition_id: msg.transition_id,
						data: msg.data,
					});
				},
			};
			const selfUid = daveUserIdFromIdentity(selfId);
			if (selfUid === null) {
				logger.error('DAVE setup aborted: local identity is not a fluxer user identity', {selfId});
				return;
			}
			const client = new DaveClient({mod, selfUserId: selfUid, channelId, transport});
			this.daveSelfUserId = selfUid;
			this.daveUserToIdentity.set(selfUid, selfId);
			this.tofuUnavailableLogged = false;
			this.bindDaveSession(room, client);
			logger.info('DAVE client bound to room', {selfId, channelId});
		} catch (error) {
			logger.error('Failed to initialize DAVE client', error);
		}
	}
	/**
	 * Region hot-swap: the DAVE session persists (same gateway channel), but the
	 * LiveKit room and its E2EE worker are new. Re-point the ratchet sink at the
	 * new room, enable E2EE there, and re-push every known ratchet so media keeps
	 * flowing encrypted through the fresh worker.
	 */
	private async migrateDaveToRoom(newRoom: Room): Promise<void> {
		const client = this.daveClient;
		if (client === null) {
			logger.warn('DAVE migration skipped: no active client');
			return;
		}
		try {
			await newRoom.setE2EEEnabled(true);
		} catch (error) {
			logger.error('DAVE migration: failed to enable E2EE on new room', error);
			return;
		}
		this.bindDaveSession(newRoom, client);
		logger.info('DAVE session migrated to new room', {
			selfId: this.selfUserId(),
			peers: client.getRecognizedUsers().length,
		});
	}

	private teardownDave(): void {
		const client = this.daveClient;
		if (client !== null) {
			try {
				client.destroy();
			} catch (error) {
				logger.warn('DAVE client destroy failed', error);
			}
		}
		this.daveClient = null;
		this.daveKeySink = null;
		this.tofuUnavailableLogged = false;
		this.earlyDaveEvents = [];
		this.daveSelfUserId = null;
		this.daveUserToIdentity.clear();
	}

	private disconnectPreviousRoom(previousRoom: Room | null, stopTracks = true): void {
		if (!previousRoom) return;
		this.teardownDave();
		try {
			if (previousRoom.state === 'connected') {
				const tracksToStop = stopTracks ? [] : this.getPreviousRoomNonScreenShareTracks(previousRoom);
				previousRoom.disconnect(stopTracks);
				this.stopPreviousRoomTracks(tracksToStop);
				logger.debug('Previous room disconnected', {stopTracks});
			}
		} catch (error) {
			logger.warn('Failed to disconnect previous room', error);
		}
		releaseE2EEWorker(previousRoom);
	}

	private getPreviousRoomNonScreenShareTracks(previousRoom: Room): Array<LocalTrack> {
		const tracks: Array<LocalTrack> = [];
		previousRoom.localParticipant.trackPublications.forEach((publication) => {
			if (publication.source === Track.Source.ScreenShare || publication.source === Track.Source.ScreenShareAudio) {
				return;
			}
			if (publication.track) {
				tracks.push(publication.track);
			}
		});
		return tracks;
	}

	private stopPreviousRoomTracks(tracks: Array<LocalTrack>): void {
		for (const track of tracks) {
			try {
				track.stop();
			} catch (error) {
				logger.warn('Failed to stop previous room local track', {error});
			}
		}
	}

	private clearVoiceServerTimeout(): void {
		this.voiceServerTimeoutSub?.unsubscribe();
		this.voiceServerTimeoutSub = null;
	}

	private clearHotSwapTimeout(): void {
		this.hotSwapTimeoutSub?.unsubscribe();
		this.hotSwapTimeoutSub = null;
	}

	cleanup(): void {
		assert.ok(this.connectionSnapshot !== null, 'cleanup pre-condition: snapshot present');
		assert.ok(this.hotSwapOperationQueue.length <= 4096, 'cleanup pre-condition: queue under cap');
		const {room} = this.connectionState;
		this.clearVoiceServerTimeout();
		this.abortHotSwap();
		this.teardownDave();
		this.activeDaveVersion = null;
		if (room) {
			room.removeAllListeners();
			room.disconnect();
			releaseE2EEWorker(room);
		}
		this.update(() => {
			this.isLocalDisconnecting = false;
			this.transitionConnection({type: 'connection.cleanup'});
		});
		this.throttle.reset();
		this.invalidateThrottleAttempt();
		this.reconnect.cleanup();
		logger.info('Cleanup complete');
	}
}

export default new VoiceEngineV2AppConnectionHostAdapter();
