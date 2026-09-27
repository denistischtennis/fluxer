// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@app/features/guild/state/Guilds', () => ({
	default: {
		getGuild: (id: string) =>
			id === 'g1' ? {features: new Set(['VOICE_E2EE'])} : {features: new Set<string>()},
	},
}));

import {computeChannelE2EEStatus} from './ChannelE2EEStatus';

type Bucket = Record<string, Record<string, {channel_id?: string | null; e2ee_capable?: boolean | null}>>;

function setVoiceBucket(bucket: Bucket): void {
	(globalThis as unknown as {window: unknown}).window = {
		_mediaEngineFacade: {
			getAllVoiceStatesInGuild: () => bucket,
		},
	};
}

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	delete (globalThis as any).window;
});

describe('computeChannelE2EEStatus — legacy behaviour preserved', () => {
	it('returns none without a channel', () => {
		setVoiceBucket({});
		expect(computeChannelE2EEStatus('g1', null)).toBe('none');
	});

	it('returns none when guild lacks the VOICE_E2EE feature', () => {
		setVoiceBucket({c1: {conn1: {channel_id: 'c1', e2ee_capable: true}}});
		expect(computeChannelE2EEStatus('g2', 'c1')).toBe('none');
	});

	it('encrypted when all present are capable', () => {
		setVoiceBucket({c1: {a: {channel_id: 'c1', e2ee_capable: true}, b: {channel_id: 'c1', e2ee_capable: true}}});
		expect(computeChannelE2EEStatus('g1', 'c1')).toBe('encrypted');
	});

	it('broken on mixed capability', () => {
		setVoiceBucket({c1: {a: {channel_id: 'c1', e2ee_capable: true}, b: {channel_id: 'c1', e2ee_capable: false}}});
		expect(computeChannelE2EEStatus('g1', 'c1')).toBe('broken');
	});
});

describe('computeChannelE2EEStatus — DAVE + TOFU awareness', () => {
	it('tofu mismatch forces broken even when fully capable', () => {
		setVoiceBucket({c1: {a: {channel_id: 'c1', e2ee_capable: true}, b: {channel_id: 'c1', e2ee_capable: true}}});
		expect(computeChannelE2EEStatus('g1', 'c1', {tofuOk: false})).toBe('broken');
	});

	it('fully capable + local dave established + tofu ok -> encrypted', () => {
		setVoiceBucket({c1: {a: {channel_id: 'c1', e2ee_capable: true}, b: {channel_id: 'c1', e2ee_capable: true}}});
		expect(
			computeChannelE2EEStatus('g1', 'c1', {localDaveEstablished: true, tofuOk: true}),
		).toBe('encrypted');
	});

	it('fully capable but our session not yet established -> broken', () => {
		setVoiceBucket({c1: {a: {channel_id: 'c1', e2ee_capable: true}, b: {channel_id: 'c1', e2ee_capable: true}}});
		expect(
			computeChannelE2EEStatus('g1', 'c1', {localDaveEstablished: false, tofuOk: true}),
		).toBe('broken');
	});

	it('mixed capability under dave context -> broken', () => {
		setVoiceBucket({c1: {a: {channel_id: 'c1', e2ee_capable: true}, b: {channel_id: 'c1', e2ee_capable: false}}});
		expect(
			computeChannelE2EEStatus('g1', 'c1', {localDaveEstablished: true, tofuOk: true}),
		).toBe('broken');
	});

	it('no capable users -> none (even with dave flags)', () => {
		setVoiceBucket({c1: {a: {channel_id: 'c1', e2ee_capable: false}}});
		expect(
			computeChannelE2EEStatus('g1', 'c1', {localDaveEstablished: true, tofuOk: true}),
		).toBe('none');
	});
});
