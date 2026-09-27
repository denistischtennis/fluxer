// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, test} from 'vitest';
import {TofuStore} from '../src/tofuStore.js';

class MemStorage {
	private map = new Map<string, string>();
	getItem(k: string): string | null {
		return this.map.has(k) ? (this.map.get(k) as string) : null;
	}
	setItem(k: string, v: string): void {
		this.map.set(k, v);
	}
	removeItem(k: string): void {
		this.map.delete(k);
	}
}

describe('TofuStore', () => {
	test('first presentation pins the sender', () => {
		const store = new TofuStore(new MemStorage());
		expect(store.verify('ch1', 'AAA')).toBe('pinned');
		expect(store.getPinned('ch1')).toBe('AAA');
	});

	test('matching re-presentation stays pinned', () => {
		const store = new TofuStore(new MemStorage());
		store.verify('ch1', 'AAA');
		expect(store.verify('ch1', 'AAA')).toBe('pinned');
	});

	test('changed sender is broken and does not overwrite the pin', () => {
		const store = new TofuStore(new MemStorage());
		store.verify('ch1', 'AAA');
		expect(store.verify('ch1', 'BBB')).toBe('broken');
		expect(store.getPinned('ch1')).toBe('AAA');
	});

	test('pins are scoped per instance key', () => {
		const store = new TofuStore(new MemStorage());
		store.verify('ch1', 'AAA');
		expect(store.verify('ch2', 'ZZZ')).toBe('pinned');
		expect(store.getPinned('ch1')).toBe('AAA');
		expect(store.getPinned('ch2')).toBe('ZZZ');
	});

	test('clear removes the pin', () => {
		const store = new TofuStore(new MemStorage());
		store.verify('ch1', 'AAA');
		store.clear('ch1');
		expect(store.getPinned('ch1')).toBeNull();
	});
});
