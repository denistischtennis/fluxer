// SPDX-License-Identifier: AGPL-3.0-or-later

// Media-frame mapping helpers for DAVE. Both peers can independently compute the
// synthetic SSRC for a given (participantIdentity, trackSid) pair, so the value
// survives MLS group churn and never needs to be negotiated out-of-band. The DAVE
// frame header itself carries the codec, so a receiver does not need the codec
// pre-registered — only the sender maps it.

/** libdave `MediaType` enum values (Audio = 0, Video = 1). */
export const MEDIA_TYPE_AUDIO = 0 as const;
export const MEDIA_TYPE_VIDEO = 1 as const;

/** libdave `Codec` enum values. */
export const DAVE_CODEC = {
	Unknown: 0,
	Opus: 1,
	VP8: 2,
	VP9: 3,
	H264: 4,
	H265: 5,
	AV1: 6,
} as const;

export type DaveCodec = (typeof DAVE_CODEC)[keyof typeof DAVE_CODEC];

/** RFC-style Opus silence frame used when an outbound sender has no ratchet yet. */
export const kOpusSilencePacket: readonly number[] = [0xf8, 0xff, 0xfe];

/**
 * FNV-1a, 32-bit. Deterministic across runtimes for the same input string.
 */
export function fnv1a32(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i) & 0xff;
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Synthetic SSRC for a participant's track. Both sides derive the same value from
 * `participantIdentity + ":" + trackSid`.
 */
export function syntheticSsrc(participantIdentity: string, trackSid: string): number {
	return fnv1a32(`${participantIdentity}:${trackSid}`);
}

const VIDEO_CODEC_BY_NAME: Record<string, DaveCodec> = {
	vp8: DAVE_CODEC.VP8,
	vp9: DAVE_CODEC.VP9,
	h264: DAVE_CODEC.H264,
	av1: DAVE_CODEC.AV1,
};

/**
 * Map a track kind plus its publish codec name to a DAVE `Codec`. Audio is always
 * Opus; video resolves by codec name (case-insensitive), falling back to Unknown.
 */
export function codecForTrack(kind: 'audio' | 'video', codecName: string | undefined): DaveCodec {
	if (kind === 'audio') {
		return DAVE_CODEC.Opus;
	}
	const normalized = (codecName ?? '').toLowerCase();
	return VIDEO_CODEC_BY_NAME[normalized] ?? DAVE_CODEC.Unknown;
}
