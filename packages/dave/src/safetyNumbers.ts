// SPDX-License-Identifier: AGPL-3.0-or-later

// Verification helpers for the DAVE safety-number / room-code UI. These wrap the
// vendored libdave JS primitives with the exact digit-grouping the app displays,
// so every member of a channel sees the SAME room code and the SAME pairwise
// safety number for a given counterpart. Matching codes across devices is what
// lets users detect a MITM on the external sender / MLS tree.

import {generateDisplayableCode, generatePairwiseFingerprint} from '@fluxer/libdave';
import type {DaveKeyRatchet} from './ratchetWire.js';

const ROOM_CODE_LENGTH = 20;
const ROOM_CODE_GROUP = 5;
const SAFETY_NUMBER_LENGTH = 60;
const SAFETY_NUMBER_GROUP = 5;
// libdave's fingerprint *encoding* format version. This is distinct from the
// DAVE protocol version negotiated in-band; the current KeyFingerprint scheme
// only defines format 0.
const FP_FORMAT_VERSION = 0;
/**
 * Short human-comparable room code derived from the MLS epoch authenticator.
 * Identical on every established member's client for the same epoch.
 */
export function roomDisplayCode(epochAuthenticator: Uint8Array): string {
	if (epochAuthenticator.byteLength < ROOM_CODE_LENGTH) {
		throw new Error('epoch authenticator too short for a room code');
	}
	return chunk(generateDisplayableCode(epochAuthenticator, ROOM_CODE_LENGTH, ROOM_CODE_GROUP), ROOM_CODE_GROUP);
}

/**
 * Pairwise safety number between two participants. Order-independent: the value
 * A computes for B equals the value B computes for A (the underlying fingerprint
 * set is sorted before hashing).
 */
export async function safetyNumber(
	myRatchet: DaveKeyRatchet,
	myUserId: string,
	peerRatchet: DaveKeyRatchet,
	peerUserId: string,
): Promise<string> {
	const fp = await generatePairwiseFingerprint(
		FP_FORMAT_VERSION,
		Uint8Array.from(myRatchet.baseSecret),
		myUserId,
		Uint8Array.from(peerRatchet.baseSecret),
		peerUserId,
	);
	return chunk(generateDisplayableCode(fp, SAFETY_NUMBER_LENGTH, SAFETY_NUMBER_GROUP), SAFETY_NUMBER_GROUP);
}

function chunk(digits: string, size: number): string {
	const parts: string[] = [];
	for (let i = 0; i < digits.length; i += size) {
		parts.push(digits.slice(i, i + size));
	}
	return parts.join(' ');
}
