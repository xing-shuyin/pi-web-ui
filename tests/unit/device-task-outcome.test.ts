import { describe, expect, it } from "vitest";
import { computeLegacyOutcomeFingerprint, computeOutcomeFingerprint } from "../../server/device-center/task-outcome.js";

describe("task outcome fingerprints", () => {
	it("keeps report and error field boundaries unambiguous", () => {
		expect(computeLegacyOutcomeFingerprint("task", "attempt", "failed", "a:b", "c")).toBe(
			computeLegacyOutcomeFingerprint("task", "attempt", "failed", "a", "b:c"),
		);
		expect(computeOutcomeFingerprint("task", "attempt", "failed", "a:b", "c")).not.toBe(
			computeOutcomeFingerprint("task", "attempt", "failed", "a", "b:c"),
		);
	});

	it("uses the same digest when metadata property order changes in transit", () => {
		const metadata = { totalBytes: 0, missing: true, rejected: false, uploadPending: false };
		const reordered = { uploadPending: false, rejected: false, missing: true, totalBytes: 0 };
		expect(computeOutcomeFingerprint("task", "attempt", "completed", "result", undefined, metadata)).toBe(
			computeOutcomeFingerprint("task", "attempt", "completed", "result", undefined, reordered),
		);
	});
});
