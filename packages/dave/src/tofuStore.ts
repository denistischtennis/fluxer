// SPDX-License-Identifier: AGPL-3.0-or-later

// Trust-on-first-use store for the DAVE external-sender identity. Discord's TLS
// transparency log is not published, so we pin the delivery service's external
// sender package per instance and surface a "broken" status if it ever changes.

export type TofuStatus = 'unknown' | 'pinned' | 'broken';

const STORAGE_PREFIX = 'fluxer.dave.sender.';

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

function globalStorage(): StorageLike | null {
	if (typeof localStorage !== 'undefined') {
		return localStorage;
	}
	return null;
}

export class TofuStore {
	constructor(private readonly storage: StorageLike | null = globalStorage()) {}

	private key(instanceKey: string): string {
		return STORAGE_PREFIX + instanceKey;
	}

	/**
	 * Check a presented sender package against the pinned one.
	 * - No pin yet -> record it, return 'pinned'.
	 * - Matches   -> 'pinned'.
	 * - Differs   -> 'broken' (caller must warn; the pin is NOT overwritten).
	 */
	public verify(instanceKey: string, senderPackageB64: string): TofuStatus {
		if (this.storage === null) {
			// No persistent storage: cannot pin, treat as unknown-but-presented.
			return senderPackageB64.length > 0 ? 'pinned' : 'unknown';
		}
		const existing = this.storage.getItem(this.key(instanceKey));
		if (existing === null) {
			this.storage.setItem(this.key(instanceKey), senderPackageB64);
			return 'pinned';
		}
		return existing === senderPackageB64 ? 'pinned' : 'broken';
	}

	public getPinned(instanceKey: string): string | null {
		return this.storage?.getItem(this.key(instanceKey)) ?? null;
	}

	public clear(instanceKey: string): void {
		this.storage?.removeItem(this.key(instanceKey));
	}
}
