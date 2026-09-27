// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {workerLogger} from '../../logger.ts';
import type {VideoCodec} from '../../room/track/options.ts';
import type {NonSharedUint8Array} from '../../type-polyfills/non-shared-typed-arrays.ts';
import {AsyncQueue} from '../../utils/AsyncQueue.ts';
import {KEY_PROVIDER_DEFAULTS} from '../constants.ts';
import {CryptorErrorReason} from '../errors.ts';
import {CryptorEvent, KeyHandlerEvent} from '../events.ts';
import type {
	DecryptDataResponseMessage,
	E2EEWorkerMessage,
	EncryptDataResponseMessage,
	ErrorMessage,
	InitAck,
	KeyProviderOptions,
	RatchetMessage,
	RatchetRequestMessage,
	RatchetResult,
	ScriptTransformOptions,
} from '../types.ts';
import {DataCryptor} from './DataCryptor.ts';
import {createDaveDecodeTransform, createDaveEncodeTransform} from './DaveTransform.ts';
import {ErrorRateLimiter} from './ErrorRateLimiter.ts';
import {encryptionEnabledMap, FrameCryptor} from './FrameCryptor.ts';
import {ParticipantKeyHandler} from './ParticipantKeyHandler.ts';

const participantCryptors: Array<FrameCryptor> = [];
const participantKeys: Map<string, ParticipantKeyHandler> = new Map();
const messageQueue = new AsyncQueue();

const isEncryptionEnabled: boolean = false;

// --- DAVE-mode crypto state -------------------------------------------------
import type {DaveCodec, DaveKeyRatchet, DaveReceiveCryptor, DaveSendCryptor} from '@fluxer/dave';

// Send cryptors are keyed `<identity>:<trackId>` so every outbound track keeps
// its own synthetic-SSRC/codec binding; receive cryptors are keyed by remote
// participant identity (the ratchet is per-sender). Ratchets, passthrough
// windows and codec assignments are remembered per key so cryptors created
// later (transform set up before the protocol material arrived, or vice versa)
// pick everything up at construction.
const daveSendCryptors: Map<string, DaveSendCryptor> = new Map();
const daveReceiveCryptors: Map<string, DaveReceiveCryptor> = new Map();
const daveKnownRatchets: Map<string, DaveKeyRatchet> = new Map();
const davePassthroughState: Map<string, boolean> = new Map();
const davePendingCodecs: Map<string, {ssrc: number; codec: number}> = new Map();
// Remote receive cryptors stay alive while at least one of the sender's tracks
// still has a registered decode transform.
const daveRecvTrackIds: Map<string, Set<string>> = new Map();
// Cryptors with a live frame pipeline; disposal is deferred until the pipe ends
// so in-flight frames never touch freed WASM objects.
const davePipedCryptors = new WeakSet<DaveSendCryptor | DaveReceiveCryptor>();
const davePendingDisposal = new Set<DaveSendCryptor | DaveReceiveCryptor>();
let daveMode = false;

async function ensureDaveModule() {
	const {DaveModuleFactory} = await import('@fluxer/libdave/wasm');
	return DaveModuleFactory();
}

function daveSendKey(identity: string, trackId: string): string {
	return `${identity}:${trackId}`;
}

async function getDaveSendCryptor(identity: string, trackId: string): Promise<DaveSendCryptor> {
	const key = daveSendKey(identity, trackId);
	let c = daveSendCryptors.get(key);
	if (!c) {
		const {DaveSendCryptor: SendCtor} = await import('@fluxer/dave');
		const mod = await ensureDaveModule();
		c = new SendCtor(mod);
		const ratchet = daveKnownRatchets.get(identity);
		if (ratchet) {
			c.setRatchet(ratchet);
		}
		const pending = davePendingCodecs.get(key);
		if (pending) {
			c.assignSsrc(pending.ssrc, pending.codec as DaveCodec);
		}
		daveSendCryptors.set(key, c);
	}
	return c;
}

async function getDaveReceiveCryptor(identity: string): Promise<DaveReceiveCryptor> {
	let c = daveReceiveCryptors.get(identity);
	if (!c) {
		const {DaveReceiveCryptor: RecvCtor} = await import('@fluxer/dave');
		const mod = await ensureDaveModule();
		c = new RecvCtor(mod);
		const ratchet = daveKnownRatchets.get(identity);
		if (ratchet) {
			c.transitionTo(ratchet);
		}
		if (davePassthroughState.get(identity)) {
			c.setPassthrough(true);
		}
		daveReceiveCryptors.set(identity, c);
	}
	return c;
}

function registerDaveRecvTrack(identity: string, trackId: string): void {
	let tracks = daveRecvTrackIds.get(identity);
	if (!tracks) {
		tracks = new Set();
		daveRecvTrackIds.set(identity, tracks);
	}
	tracks.add(trackId);
}

function releaseDaveCryptor(cryptor: DaveSendCryptor | DaveReceiveCryptor): void {
	if (davePipedCryptors.has(cryptor)) {
		davePendingDisposal.add(cryptor);
	} else {
		cryptor.dispose();
	}
}

function finishDavePipe(cryptor: DaveSendCryptor | DaveReceiveCryptor): void {
	davePipedCryptors.delete(cryptor);
	if (davePendingDisposal.delete(cryptor)) {
		cryptor.dispose();
	}
}

function pipeDaveSend(cryptor: DaveSendCryptor, readable: ReadableStream, writable: WritableStream): void {
	davePipedCryptors.add(cryptor);
	readable
		.pipeThrough(createDaveEncodeTransform(cryptor))
		.pipeTo(writable)
		.catch((e) => workerLogger.warn('dave encode transform error', {error: e}))
		.finally(() => finishDavePipe(cryptor));
}

function pipeDaveRecv(cryptor: DaveReceiveCryptor, readable: ReadableStream, writable: WritableStream): void {
	davePipedCryptors.add(cryptor);
	readable
		.pipeThrough(createDaveDecodeTransform(cryptor))
		.pipeTo(writable)
		.catch((e) => workerLogger.warn('dave decode transform error', {error: e}))
		.finally(() => finishDavePipe(cryptor));
}


let sifTrailer: NonSharedUint8Array | undefined;

let keyProviderOptions: KeyProviderOptions = KEY_PROVIDER_DEFAULTS;

let rtpMap: Map<number, VideoCodec> = new Map();

const dataDecryptErrorLimiter = new ErrorRateLimiter();

workerLogger.setDefaultLevel('info');
workerLogger.methodFactory = (methodName) => (msg, context) => {
	postMessage({
		kind: 'log',
		data: {level: methodName, msg, context},
	});
};
workerLogger.setLevel(workerLogger.getLevel());

self.addEventListener('message', (ev) => {
	messageQueue.run(async () => {
		const {kind, data}: E2EEWorkerMessage = ev.data;

		switch (kind) {
			case 'init': {
				workerLogger.setLevel(data.loglevel);
				workerLogger.info('e2ee worker initialized');
				keyProviderOptions = data.keyProviderOptions;
				daveMode = (data as {mode?: string}).mode === 'dave';
				if (daveMode) {
					await ensureDaveModule();
				}
				const ackMsg: InitAck = {
					kind: 'initAck',
					data: {enabled: isEncryptionEnabled || daveMode},
				};
				postMessage(ackMsg);
				break;
			}
			case 'setLogLevel':
				workerLogger.setLevel(data.level);
				break;
			case 'enable':
				setEncryptionEnabled(data.enabled, data.participantIdentity);
				workerLogger.info(`updated e2ee enabled status for ${data.participantIdentity} to ${data.enabled}`);
				postMessage(ev.data);
				break;
			case 'decode': {
				if (daveMode) {
					const recv = await getDaveReceiveCryptor(data.participantIdentity);
					registerDaveRecvTrack(data.participantIdentity, data.trackId);
					pipeDaveRecv(recv, data.readableStream, data.writableStream);
					break;
				}
				const cryptor = getTrackCryptor(data.participantIdentity, data.trackId);
				cryptor.setHasFrameMetadata(data.hasPacketTrailer);
				cryptor.setupTransform(kind, data.readableStream, data.writableStream, data.trackId, data.codec);
				break;
			}
			case 'encode': {
				if (daveMode) {
					const send = await getDaveSendCryptor(data.participantIdentity, data.trackId);
					pipeDaveSend(send, data.readableStream, data.writableStream);
					break;
				}
				const pubCryptor = getTrackCryptor(data.participantIdentity, data.trackId);
				pubCryptor.setHasFrameMetadata(data.hasPacketTrailer);
				pubCryptor.setupTransform(
					kind,
					data.readableStream,
					data.writableStream,
					data.trackId,
					data.codec,
					data.packetTrailer,
				);
				break;
			}

			case 'encryptDataRequest': {
				const {
					payload: encryptedPayload,
					iv,
					keyIndex,
				} = await DataCryptor.encrypt(data.payload, getParticipantKeyHandler(data.participantIdentity));
				postMessage({
					kind: 'encryptDataResponse',
					data: {
						payload: encryptedPayload,
						iv,
						keyIndex,
						uuid: data.uuid,
					},
				} satisfies EncryptDataResponseMessage);
				break;
			}

			case 'decryptDataRequest':
				try {
					const {payload: decryptedPayload} = await DataCryptor.decrypt(
						data.payload,
						data.iv,
						getParticipantKeyHandler(data.participantIdentity),
						data.keyIndex,
					);
					postMessage({
						kind: 'decryptDataResponse',
						data: {payload: decryptedPayload, uuid: data.uuid},
					} satisfies DecryptDataResponseMessage);
				} catch (error) {
					const errorKey = `${data.participantIdentity}-datadecrypt`;
					const shouldLog = dataDecryptErrorLimiter.shouldEmit(errorKey, () => {
						workerLogger.warn(`Suppressing further data decryption errors for ${data.participantIdentity}`, {errorKey});
					});
					if (shouldLog) {
						workerLogger.error('DataCryptor decryption failed', {
							error,
							participantIdentity: data.participantIdentity,
							uuid: data.uuid,
						});
					}
					postMessage({
						kind: 'error',
						data: {
							error: error instanceof Error ? error : new Error(String(error)),
							uuid: data.uuid,
						},
					} satisfies ErrorMessage);
				}
				break;

			case 'setKey':
				if (data.participantIdentity) {
					workerLogger.info(`set participant sender key ${data.participantIdentity} index ${data.keyIndex}`);
					await getParticipantKeyHandler(data.participantIdentity).setKey(
						data.key,
						data.keyIndex,
						data.updateCurrentKeyIndex,
					);
				} else {
					workerLogger.error('no participant Id was provided for setKey');
				}
				break;
			case 'removeTransform':
				if (daveMode) {
					const sendKey = daveSendKey(data.participantIdentity, data.trackId);
					const send = daveSendCryptors.get(sendKey);
					if (send) {
						daveSendCryptors.delete(sendKey);
						davePendingCodecs.delete(sendKey);
						releaseDaveCryptor(send);
					}
					const tracks = daveRecvTrackIds.get(data.participantIdentity);
					if (tracks) {
						tracks.delete(data.trackId);
						if (tracks.size === 0) {
							daveRecvTrackIds.delete(data.participantIdentity);
							const recv = daveReceiveCryptors.get(data.participantIdentity);
							if (recv) {
								daveReceiveCryptors.delete(data.participantIdentity);
								davePassthroughState.delete(data.participantIdentity);
								releaseDaveCryptor(recv);
							}
						}
					}
				} else {
					unsetCryptorParticipant(data.trackId, data.participantIdentity);
				}
				break;
			case 'updateCodec': {
				if (daveMode) {
					// DAVE codec/SSRC binding flows through daveAssignCodec; never
					// spin up a legacy FrameCryptor for a reused sender/receiver.
					workerLogger.debug('ignoring updateCodec in dave mode', {
						participantIdentity: data.participantIdentity,
						trackId: data.trackId,
					});
					break;
				}
				const trackCryptor = getTrackCryptor(data.participantIdentity, data.trackId, data.previousTrackId);
				if (data.codec) {
					trackCryptor.setVideoCodec(data.codec);
				}
				trackCryptor.setHasFrameMetadata(data.hasPacketTrailer);
				workerLogger.info('updated codec', {
					participantIdentity: data.participantIdentity,
					trackId: data.trackId,
					previousTrackId: data.previousTrackId,
					codec: data.codec,
					hasPacketTrailer: data.hasPacketTrailer,
				});
				if (data.previousTrackId !== undefined && !trackCryptor.ensureTransform()) {
					workerLogger.error('could not re-establish transform for reused sender or receiver', {
						participantIdentity: data.participantIdentity,
						trackId: data.trackId,
						previousTrackId: data.previousTrackId,
					});
				}
				break;
			}
			case 'setRTPMap':
				rtpMap = data.map;
				participantCryptors.forEach((cr) => {
					if (cr.getParticipantIdentity() === data.participantIdentity) {
						cr.setRtpMap(data.map);
					}
				});
				break;
			case 'ratchetRequest':
				handleRatchetRequest(data);
				break;
			case 'setSifTrailer':
				handleSifTrailer(data.trailer);
				break;
			case 'daveSetRatchet': {
				const {participantIdentity, isLocal, ratchet} = data;
				if (ratchet === null) {
					daveKnownRatchets.delete(participantIdentity);
				} else {
					daveKnownRatchets.set(participantIdentity, ratchet);
				}
				if (isLocal) {
					// Only the local participant ever owns send cryptors; fan the
					// fresh ratchet out to every live outbound track cryptor.
					const prefix = `${participantIdentity}:`;
					for (const [key, cryptor] of daveSendCryptors) {
						if (key.startsWith(prefix)) {
							cryptor.setRatchet(ratchet);
						}
					}
				} else if (ratchet !== null) {
					const existing = daveReceiveCryptors.get(participantIdentity);
					if (existing) {
						existing.transitionTo(ratchet);
					} else {
						// Creation applies the just-stored ratchet exactly once.
						await getDaveReceiveCryptor(participantIdentity);
					}
				} else {
					// Peer forgotten: tear down its receive-side state entirely.
					davePassthroughState.delete(participantIdentity);
					daveRecvTrackIds.delete(participantIdentity);
					const recv = daveReceiveCryptors.get(participantIdentity);
					if (recv) {
						daveReceiveCryptors.delete(participantIdentity);
						releaseDaveCryptor(recv);
					}
				}
				break;
			}
			case 'davePassthrough': {
				davePassthroughState.set(data.participantIdentity, data.enabled);
				const recv = daveReceiveCryptors.get(data.participantIdentity);
				if (recv) {
					recv.setPassthrough(data.enabled);
				}
				break;
			}
			case 'daveAssignCodec': {
				const key = daveSendKey(data.participantIdentity, data.trackId);
				davePendingCodecs.set(key, {ssrc: data.ssrc, codec: data.codec});
				const send = daveSendCryptors.get(key);
				if (send) {
					send.assignSsrc(data.ssrc, data.codec as DaveCodec);
				}
				break;
			}
			default:
				break;
		}
	});
});

async function handleRatchetRequest(data: RatchetRequestMessage['data']) {
	if (data.participantIdentity) {
		const keyHandler = getParticipantKeyHandler(data.participantIdentity);
		await keyHandler.ratchetKey(data.keyIndex);
		keyHandler.resetKeyStatus();
	} else {
		workerLogger.error('no participant Id was provided for ratchet request');
	}
}

function getTrackCryptor(participantIdentity: string, trackId: string, previousTrackId?: string) {
	let cryptors = participantCryptors.filter((c) => c.getTrackId() === trackId);

	if (cryptors.length === 0 && previousTrackId !== undefined && previousTrackId !== trackId) {
		const previous = participantCryptors.filter((c) => c.getTrackId() === previousTrackId);
		if (previous.length > 0) {
			workerLogger.info('reusing cryptor from previous trackId', {
				participantIdentity,
				trackId,
				previousTrackId,
			});
			previous[0].setTrackId(trackId);
			cryptors = previous;
		}
	}

	if (cryptors.length > 1) {
		const debugInfo = cryptors
			.map((c) => {
				return {participant: c.getParticipantIdentity()};
			})
			.join(',');
		workerLogger.error(
			`Found multiple cryptors for the same trackID ${trackId}. target participant: ${participantIdentity} `,
			{participants: debugInfo},
		);
	}
	let cryptor = cryptors[0];
	if (!cryptor) {
		workerLogger.info('creating new cryptor for', {participantIdentity, trackId});
		if (!keyProviderOptions) {
			throw Error('Missing keyProvider options');
		}
		cryptor = new FrameCryptor({
			participantIdentity,
			keys: getParticipantKeyHandler(participantIdentity),
			keyProviderOptions,
			sifTrailer,
		});
		cryptor.setRtpMap(rtpMap);
		setupCryptorErrorEvents(cryptor);
		participantCryptors.push(cryptor);
	} else if (participantIdentity !== cryptor.getParticipantIdentity()) {
		cryptor.setParticipant(participantIdentity, getParticipantKeyHandler(participantIdentity));
	}

	return cryptor;
}

function getParticipantKeyHandler(participantIdentity: string) {
	let keys = participantKeys.get(participantIdentity);
	if (!keys) {
		keys = new ParticipantKeyHandler(participantIdentity, keyProviderOptions);
		keys.on(KeyHandlerEvent.KeyRatcheted, emitRatchetedKeys);
		participantKeys.set(participantIdentity, keys);
	}
	return keys;
}


function unsetCryptorParticipant(trackId: string, participantIdentity: string) {
	const cryptors = participantCryptors.filter(
		(c) => c.getParticipantIdentity() === participantIdentity && c.getTrackId() === trackId,
	);
	if (cryptors.length > 1) {
		workerLogger.error('Found multiple cryptors for the same participant and trackID combination', {
			trackId,
			participantIdentity,
		});
	}
	const cryptor = cryptors[0];
	if (!cryptor) {
		workerLogger.warn('Could not unset participant on cryptor', {trackId, participantIdentity});
	} else {
		cryptor.unsetParticipant();
	}
}

function setEncryptionEnabled(enable: boolean, participantIdentity: string) {
	workerLogger.debug(`setting encryption enabled for all tracks of ${participantIdentity}`, {
		enable,
	});
	encryptionEnabledMap.set(participantIdentity, enable);
}


function setupCryptorErrorEvents(cryptor: FrameCryptor) {
	cryptor.on(CryptorEvent.Error, (error) => {
		const msg: ErrorMessage = {
			kind: 'error',
			data: {
				error: new Error(`${CryptorErrorReason[error.reason]}: ${error.message}`),
				participantIdentity: error.participantIdentity,
			},
		};
		postMessage(msg);
	});
}

function emitRatchetedKeys(ratchetResult: RatchetResult, participantIdentity: string, keyIndex?: number) {
	const msg: RatchetMessage = {
		kind: `ratchetKey`,
		data: {
			participantIdentity,
			keyIndex,
			ratchetResult,
		},
	};
	postMessage(msg);
}

function handleSifTrailer(trailer: NonSharedUint8Array) {
	sifTrailer = trailer;
	participantCryptors.forEach((c) => {
		c.setSifTrailer(trailer);
	});
}
if (self.RTCTransformEvent) {
	self.onrtctransform = (event: RTCTransformEvent) => {
		const transformer = event.transformer;
		const options = transformer.options as ScriptTransformOptions;
		const {kind, participantIdentity, trackId, codec, hasPacketTrailer} = options;
		messageQueue.run(async () => {
			if (daveMode) {
				workerLogger.debug('onrtctransform dave setup', {participantIdentity, trackId, kind});
				if (kind === 'encode') {
					const send = await getDaveSendCryptor(participantIdentity, trackId);
					pipeDaveSend(send, transformer.readable, transformer.writable);
				} else {
					const recv = await getDaveReceiveCryptor(participantIdentity);
					registerDaveRecvTrack(participantIdentity, trackId);
					pipeDaveRecv(recv, transformer.readable, transformer.writable);
				}
				return;
			}
			const cryptor = getTrackCryptor(participantIdentity, trackId);
			cryptor.setHasFrameMetadata(hasPacketTrailer);
			workerLogger.debug('onrtctransform setup', {participantIdentity, trackId, codec});
			cryptor.setupTransform(
				kind,
				transformer.readable,
				transformer.writable,
				trackId,
				codec,
				kind === 'encode' ? options.packetTrailer : undefined,
			);
		});
	};
}
