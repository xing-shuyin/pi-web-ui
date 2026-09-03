/**
 * MUTATION PIN — measured-height placeholder cache.
 *
 * The scroll-stick E2E cannot catch a regression that replaces the cached
 * placeholder height with the bare role estimate: in its seeded geometry the
 * bottom-adjacent window is always real content, and hidden→real swaps of
 * messages fully above the viewport are scrollTop-compensated (height-neutral
 * regardless of the placeholder height). Verified honestly on 52189b5:
 * reverting the cache to estimates kept all 21 E2E checks green.
 *
 * This pin closes that gap at the unit level: the LazyMount placeholder height
 * MUST flow through getPlaceholderHeight (measured height + content
 * fingerprint, estimate only as fallback). If someone reverts to a bare
 * estimate — or deletes the fingerprint check — this goes red.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../web/src/components/MessageList.tsx", import.meta.url), "utf8");

describe("placeholder measured-height cache (mutation pin)", () => {
	it("placeholder height flows through getPlaceholderHeight, not a bare estimate", () => {
		expect(src).toMatch(/height=\{\s*getPlaceholderHeight\(/);
		// The bare estimate may only appear as getPlaceholderHeight's fallback.
		const bare = /height=\{\s*estimateMessageHeight\(/;
		expect(bare.test(src)).toBe(false);
	});

	it("cache entry writes are fingerprint-stamped (edited messages invalidate)", () => {
		expect(src).toMatch(/contentFingerprint/);
		expect(src).toMatch(/heightMetaRef\.current\.set\(id, \{ h, len/);
	});
});
