// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {EventEmitter} from 'events';
import type TypedEventEmitter from 'typed-emitter';
import log from '../logger.ts';
import {KEY_PROVIDER_DEFAULTS} from './constants.ts';
import {type KeyProviderCallbacks, KeyProviderEvent} from './events.ts';
import type {KeyInfo, KeyProviderOptions, RatchetResult} from './types.ts';

export class BaseKeyProvider extends (EventEmitter as new () => TypedEventEmitter<KeyProviderCallbacks>) {
	private keyInfoMap: Map<string, KeyInfo>;

	private readonly options: KeyProviderOptions;

	private latestManuallySetKeyIndex = 0;

	constructor(options: Partial<KeyProviderOptions> = {}) {
		super();
		this.keyInfoMap = new Map();
		this.options = {...KEY_PROVIDER_DEFAULTS, ...options};
		this.on(KeyProviderEvent.KeyRatcheted, this.onKeyRatcheted);
	}

	protected onSetEncryptionKey(key: CryptoKey, participantIdentity?: string, keyIndex?: number) {
		const keyInfo: KeyInfo = {key, participantIdentity, keyIndex};
		if (!participantIdentity) {
			throw new Error('participant identity is required');
		}
		this.keyInfoMap.set(`${participantIdentity}-${keyIndex ?? 0}`, keyInfo);
		if (keyIndex !== undefined) {
			this.latestManuallySetKeyIndex = keyIndex;
		}
		this.emit(KeyProviderEvent.SetKey, keyInfo, keyIndex !== undefined);
	}

	protected onKeyRatcheted = (ratchetResult: RatchetResult, participantId?: string, keyIndex?: number) => {
		log.debug('key ratcheted event received', {ratchetResult, participantId, keyIndex});
	};

	getKeys() {
		return Array.from(this.keyInfoMap.values());
	}

	getLatestManuallySetKeyIndex() {
		return this.latestManuallySetKeyIndex;
	}

	getOptions() {
		return this.options;
	}

	ratchetKey(participantIdentity?: string, keyIndex?: number) {
		this.emit(KeyProviderEvent.RatchetRequest, participantIdentity, keyIndex);
	}
}

