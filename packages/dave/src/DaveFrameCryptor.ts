// SPDX-License-Identifier: AGPL-3.0-or-later

// DaveFrameCryptor: the frame-level crypto primitive the patched livekit e2ee
// worker delegates to. Wraps libdave's `Encryptor` (send) and per-sender
// `Decryptor` (receive), handling the WASM heap dance and the no-ratchet
// worker fallbacks the plan mandates (all FAIL-CLOSED: plaintext media must
// never reach the wire in a DAVE room):
//   - Send with no ratchet: audio -> Opus silence packet, video -> drop.
//   - Send where Encrypt() wrote nothing (missing codec mapping, nonce issues):
//     drop the frame.
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
			// Video without a ratchet: drop. Forwarding the original buffer would
			// leak cleartext into a room the app has marked DAVE-encrypted.
			return {bytes: new Uint8Array(), encrypted: false};
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
				// Encryption failed (e.g. unknown SSRC/codec mapping); drop the
				// frame rather than leaking plaintext.
				return {bytes: new Uint8Array(), encrypted: false};
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
	// Most-recent ratchet's decryptor first. A rejoin re-adds the same user at a
	// fresh generation-0 key; libdave's Decryptor ignores a second
	// TransitionToKeyRatchet whose key domain is already installed ("Ignoring key
	// ratchet for already installed key domain"), which would strand the receiver
	// on a stale key and reject every subsequent frame. Installing each distinct
	// ratchet on its OWN fresh Decryptor sidesteps that guard, while keeping the
	// previous decryptor(s) for the transition overlap window so in-flight frames
	// encrypted under the outgoing key still decrypt. GCM authentication means a
	// wrong-key attempt simply fails over to the next candidate — never wrong audio.
	private readonly decryptors: InstanceType<DaveModule['Decryptor']>[] = [];
	private installedKey: string | null = null;
	private passthrough = false;

	constructor(private readonly mod: DaveModule) {}

	public transitionTo(ratchet: DaveKeyRatchet): void {
		const key = ratchet.baseSecret.join(',');
		if (key === this.installedKey) {
			return;
		}
		const decryptor = new this.mod.Decryptor();
		decryptor.TransitionToKeyRatchet(ratchet as unknown as never);
		if (this.passthrough) {
			decryptor.TransitionToPassthroughMode(true);
		}
		this.decryptors.unshift(decryptor);
		// Bound the stack: keep the current key plus a couple of prior ones for
		// the overlap window; dispose anything older.
		while (this.decryptors.length > 3) {
			const stale = this.decryptors.pop();
			try {
				stale?.dispose();
			} catch {
				/* already released */
			}
		}
		this.installedKey = key;
	}

	public setPassthrough(enabled: boolean): void {
		this.passthrough = enabled;
		for (const decryptor of this.decryptors) {
			decryptor.TransitionToPassthroughMode(enabled);
		}
	}

	/**
	 * Decrypt a received ciphertext frame, trying the most recent ratchet first
	 * and falling back through prior ones. On failure, returns the original bytes
	 * when passthrough is active, otherwise an empty failed result so the caller
	 * drops the frame.
	 */
	public decrypt(mediaType: number, ciphertext: Uint8Array): DecryptedFrame {
		const type = (mediaType === MEDIA_TYPE_VIDEO ? MEDIA_TYPE_VIDEO : MEDIA_TYPE_AUDIO) as never;
		let maxCap = 0;
		for (const decryptor of this.decryptors) {
			maxCap = Math.max(
				maxCap,
				decryptor.GetMaxPlaintextByteSize(type, ciphertext.length),
			);
		}
		if (maxCap === 0) {
			return this.passthrough
				? {bytes: ciphertext, ok: true}
				: {bytes: new Uint8Array(), ok: false};
		}
		const ptr = this.mod._malloc(maxCap);
		try {
			for (const decryptor of this.decryptors) {
				this.mod.HEAPU8.set(ciphertext, ptr);
				const written = decryptor.Decrypt(
					type,
					ptr,
					ciphertext.length,
					maxCap,
				);
				if (written !== 0) {
					return {bytes: toU8(this.mod.HEAPU8.slice(ptr, ptr + written)), ok: true};
				}
			}
			if (this.passthrough) {
				return {bytes: ciphertext, ok: true};
			}
			return {bytes: new Uint8Array(), ok: false};
		} finally {
			this.mod._free(ptr);
		}
	}

	public dispose(): void {
		for (const decryptor of this.decryptors) {
			try {
				decryptor.dispose();
			} catch {
				/* already deleted */
			}
		}
		this.decryptors.length = 0;
		this.installedKey = null;
	}
}
