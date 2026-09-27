// SPDX-License-Identifier: AGPL-3.0-or-later

// DaveFrameCryptor: the frame-level crypto primitive the patched livekit e2ee
// worker delegates to. Wraps libdave's `Encryptor` (send) and per-sender
// `Decryptor` (receive), handling the WASM heap dance and the no-ratchet
// fallbacks the plan mandates:
//   - Send with no ratchet: audio -> Opus silence packet, video -> passthrough.
//   - Receive with decrypt failure and passthrough active -> return original.
//
// The class is transport-agnostic and holds no timers; transition expiry windows
// are managed by the caller (worker) which flips `passthrough` at the right time.

import type {DaveModule} from '@fluxer/libdave/wasm';
import type {DaveKeyRatchet} from './ratchetWire.js';
import {MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO, kOpusSilencePacket, type DaveCodec} from './frameMapping.js';

export interface EncryptedFrame {
	/** Ciphertext bytes, or the original frame when passthrough is active. */
	bytes: Uint8Array;
	/** True if the frame was actually encrypted this call. */
	encrypted: boolean;
}

export interface DecryptedFrame {
	bytes: Uint8Array;
	ok: boolean;
}

function toU8(x: number[] | Uint8Array): Uint8Array {
	return x instanceof Uint8Array ? x : Uint8Array.from(x);
}

/**
 * Send-side cryptor. One instance per outbound track. Call {@link setRatchet}
 * whenever the local user's ratchet changes (new epoch), and {@link encrypt}
 * per media frame.
 */
export class DaveSendCryptor {
	private readonly encryptor: InstanceType<DaveModule['Encryptor']>;
	private ratchet: DaveKeyRatchet | null = null;
	private ssrc = 0;

	constructor(private readonly mod: DaveModule) {
		this.encryptor = new mod.Encryptor();
	}

	public setRatchet(ratchet: DaveKeyRatchet | null): void {
		this.ratchet = ratchet;
		this.encryptor.SetKeyRatchet(ratchet as unknown as never);
	}

	public setPassthrough(enabled: boolean): void {
		this.encryptor.SetPassthroughMode(enabled);
	}

	public assignSsrc(ssrc: number, codec: DaveCodec): void {
		this.ssrc = ssrc >>> 0;
		this.encryptor.AssignSsrcToCodec(this.ssrc, codec as never);
	}

	/**
	 * Encrypt a frame in place semantics. Returns ciphertext, or a fallback when
	 * no ratchet is available.
	 */
	public encrypt(mediaType: number, plaintext: Uint8Array): EncryptedFrame {
		if (this.ratchet === null) {
			if (mediaType === MEDIA_TYPE_AUDIO) {
				return {bytes: Uint8Array.from(kOpusSilencePacket), encrypted: false};
			}
			// Video without a ratchet: passthrough unchanged.
			return {bytes: plaintext, encrypted: false};
		}

		const maxCap = this.encryptor.GetMaxCiphertextByteSize(
			(mediaType === MEDIA_TYPE_VIDEO ? MEDIA_TYPE_VIDEO : MEDIA_TYPE_AUDIO) as never,
			plaintext.length,
		);
		const ptr = this.mod._malloc(maxCap);
		try {
			this.mod.HEAPU8.set(plaintext, ptr);
			const written = this.encryptor.Encrypt(
				(mediaType === MEDIA_TYPE_VIDEO ? MEDIA_TYPE_VIDEO : MEDIA_TYPE_AUDIO) as never,
				this.ssrc,
				ptr,
				plaintext.length,
				maxCap,
			);
			if (written === 0) {
				return {bytes: plaintext, encrypted: false};
			}
			return {bytes: toU8(this.mod.HEAPU8.slice(ptr, ptr + written)), encrypted: true};
		} finally {
			this.mod._free(ptr);
		}
	}

	public dispose(): void {
		try {
			this.encryptor.delete();
		} catch {
			/* already deleted */
		}
	}
}

/**
 * Receive-side cryptor. One instance per remote sender identity (the ratchet is
 * per-sender, not per-track).
 */
export class DaveReceiveCryptor {
	private readonly decryptor: InstanceType<DaveModule['Decryptor']>;
	private passthrough = false;

	constructor(private readonly mod: DaveModule) {
		this.decryptor = new mod.Decryptor();
	}

	public transitionTo(ratchet: DaveKeyRatchet): void {
		this.decryptor.TransitionToKeyRatchet(ratchet as unknown as never);
	}

	public setPassthrough(enabled: boolean): void {
		this.passthrough = enabled;
		this.decryptor.TransitionToPassthroughMode(enabled);
	}

	/**
	 * Decrypt a received ciphertext frame. On failure, returns the original bytes
	 * when passthrough is active, otherwise an empty failed result so the caller
	 * drops the frame.
	 */
	public decrypt(mediaType: number, ciphertext: Uint8Array): DecryptedFrame {
		const maxCap = this.decryptor.GetMaxPlaintextByteSize(
			(mediaType === MEDIA_TYPE_VIDEO ? MEDIA_TYPE_VIDEO : MEDIA_TYPE_AUDIO) as never,
			ciphertext.length,
		);
		const ptr = this.mod._malloc(maxCap);
		try {
			this.mod.HEAPU8.set(ciphertext, ptr);
			const written = this.decryptor.Decrypt(
				(mediaType === MEDIA_TYPE_VIDEO ? MEDIA_TYPE_VIDEO : MEDIA_TYPE_AUDIO) as never,
				ptr,
				ciphertext.length,
				maxCap,
			);
			if (written === 0) {
				if (this.passthrough) {
					return {bytes: ciphertext, ok: true};
				}
				return {bytes: new Uint8Array(), ok: false};
			}
			return {bytes: toU8(this.mod.HEAPU8.slice(ptr, ptr + written)), ok: true};
		} finally {
			this.mod._free(ptr);
		}
	}

	public dispose(): void {
		try {
			this.decryptor.delete();
		} catch {
			/* already deleted */
		}
	}
}
