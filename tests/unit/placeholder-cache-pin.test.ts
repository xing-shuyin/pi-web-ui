import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../web/src/components/MessageList.tsx", import.meta.url), "utf8");

describe("placeholder measured-height cache (mutation pin)", () => {
	it("placeholder height flows through getPlaceholderHeight, not a bare estimate", () => {
		expect(src).toMatch(/height=\{\s*getPlaceholderHeight\(/);
		const bare = /height=\{\s*estimateMessageHeight\(/;
		expect(bare.test(src)).toBe(false);
	});

	it("cache entry writes are fingerprint-stamped (edited messages invalidate)", () => {
		expect(src).toMatch(/contentFingerprint/);
		expect(src).toMatch(/heightMetaRef\.current\.set\(id, \{ h, len/);
	});
});
