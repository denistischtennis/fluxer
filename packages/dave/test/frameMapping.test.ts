// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, test} from 'vitest';
import {fnv1a32, syntheticSsrc, codecForTrack, DAVE_CODEC, kOpusSilencePacket} from '../src/frameMapping.js';

describe('frameMapping', () => {
	test('fnv1a32 matches known FNV-1a 32-bit vectors', () => {
		// Canonical FNV-1a 32 test vectors.
		expect(fnv1a32('')).toBe(0x811c9dc5);
		expect(fnv1a32('a')).toBe(0xe40c292c);
		expect(fnv1a32('foobar')).toBe(0xbf9cf968);
	});

	test('syntheticSsrc is deterministic and identity+track bound', () => {
		const s1 = syntheticSsrc('alice', 'TR1');
		const s2 = syntheticSsrc('alice', 'TR1');
		const s3 = syntheticSsrc('bob', 'TR1');
		expect(s1).toBe(s2);
		expect(s1).not.toBe(s3);
		expect(s1).toBeGreaterThan(0);
		expect(s1).toBeLessThanOrEqual(0xffffffff);
	});

	test('codecForTrack maps audio to Opus and video by name', () => {
		expect(codecForTrack('audio', undefined)).toBe(DAVE_CODEC.Opus);
		expect(codecForTrack('audio', 'anything')).toBe(DAVE_CODEC.Opus);
		expect(codecForTrack('video', 'VP8')).toBe(DAVE_CODEC.VP8);
		expect(codecForTrack('video', 'av1')).toBe(DAVE_CODEC.AV1);
		expect(codecForTrack('video', 'h264')).toBe(DAVE_CODEC.H264);
		expect(codecForTrack('video', 'unknown-codec')).toBe(DAVE_CODEC.Unknown);
	});

	test('silence packet shape', () => {
		expect(Array.from(kOpusSilencePacket)).toEqual([0xf8, 0xff, 0xfe]);
	});
});
