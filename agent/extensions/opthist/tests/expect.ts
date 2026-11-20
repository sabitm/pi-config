// The small part of the bun:test expect API that these tests use, on node:assert. Bun has no node:sqlite.
import assert from "node:assert/strict";

export function expect(actual: unknown) {
	const text = () => actual as string | unknown[];
	return {
		toBe: (expected: unknown) => assert.equal(actual, expected),
		toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
		toBeUndefined: () => assert.equal(actual, undefined),
		toBeNull: () => assert.equal(actual, null),
		toContain: (part: unknown) => assert.ok(text().includes(part as never), `expected to contain ${String(part)}`),
		toThrow: (message?: string) =>
			assert.throws(actual as () => unknown, (error: Error) => message === undefined || error.message.includes(message)),
		not: {
			toContain: (part: unknown) => assert.ok(!text().includes(part as never), `expected not to contain ${String(part)}`),
		},
	};
}
