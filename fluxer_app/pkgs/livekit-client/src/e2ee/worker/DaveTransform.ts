// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// DAVE-mode frame transform. This is a parallel path to the WebCrypto
// FrameCryptor used when the room is initialised with `mode: 'dave'`. It wraps
// a send-side or receive-side DAVE cryptor (from @fluxer/dave) into a
// TransformStream over RTCEncodedAudioFrame/RTCEncodedVideoFrame, replacing
// the frame payload with ciphertext (encode) or plaintext (decode).
//
// The cryptor dependency is expressed as a minimal structural interface so this
// module can be unit-tested with fakes and wired to the real libdave-backed
// DaveSendCryptor / DaveReceiveCryptor at runtime.

import {isVideoFrame} from '../utils.ts';

/** Structural contract satisfied by @fluxer/dave's DaveSendCryptor. */
export interface SendCryptorLike {
	encrypt(mediaType: number, plaintext: Uint8Array): {bytes: Uint8Array; encrypted: boolean};
}

/** Structural contract satisfied by @fluxer/dave's DaveReceiveCryptor. */
export interface ReceiveCryptorLike {
	decrypt(mediaType: number, ciphertext: Uint8Array): {bytes: Uint8Array; ok: boolean};
}

const MEDIA_TYPE_AUDIO = 0;
const MEDIA_TYPE_VIDEO = 1;

type EncodedFrame = RTCEncodedVideoFrame | RTCEncodedAudioFrame;

function mediaTypeOf(frame: EncodedFrame): number {
	return isVideoFrame(frame) ? MEDIA_TYPE_VIDEO : MEDIA_TYPE_AUDIO;
}

/**
 * Build an encode transform: each outbound frame's payload is replaced by its
 * DAVE ciphertext (or a fallback produced by the cryptor when no ratchet is
 * available yet).
 */
export function createDaveEncodeTransform(cryptor: SendCryptorLike): TransformStream<EncodedFrame, EncodedFrame> {
	return new TransformStream<EncodedFrame, EncodedFrame>({
		transform(encodedFrame, controller) {
			if (encodedFrame.data.byteLength === 0) {
				controller.enqueue(encodedFrame);
				return;
			}
			const result = cryptor.encrypt(mediaTypeOf(encodedFrame), new Uint8Array(encodedFrame.data));
			// Replace the frame payload with the cryptor output, preserving metadata.
			encodedFrame.data = toArrayBuffer(result.bytes);
			controller.enqueue(encodedFrame);
		},
	});
}

/**
 * Build a decode transform: each inbound frame's payload is decrypted. Frames
 * that fail to decrypt are dropped unless the cryptor is in passthrough mode,
 * in which case the original bytes flow through unchanged (DAVE whitepaper
 * "Protocol Frame Check").
 */
export function createDaveDecodeTransform(cryptor: ReceiveCryptorLike): TransformStream<EncodedFrame, EncodedFrame> {
	return new TransformStream<EncodedFrame, EncodedFrame>({
		transform(encodedFrame, controller) {
			if (encodedFrame.data.byteLength === 0) {
				controller.enqueue(encodedFrame);
				return;
			}
			const result = cryptor.decrypt(mediaTypeOf(encodedFrame), new Uint8Array(encodedFrame.data));
			if (!result.ok) {
				// Drop undecryptable frames (passthrough already returns ok=true
				// with the original bytes inside the cryptor).
				return;
			}
			encodedFrame.data = toArrayBuffer(result.bytes);
			controller.enqueue(encodedFrame);
		},
	});
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	// Copy into a standalone ArrayBuffer sized to the data so downstream code
	// sees exact byteLength (avoids the subarray offset pitfall).
	const out = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(out).set(bytes);
	return out;
}
