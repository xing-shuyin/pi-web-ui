import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/**
 * Opening a disclosure inside the transcript must not yank the viewport to the
 * end of the conversation. The scroll hook only knows this through the
 * `data-disclosure` marker, so the marker is a contract: dropping it silently
 * brings the jump back.
 */
describe("disclosure marker contract", () => {
	it("CollapsibleHead marks itself, which covers tool calls, thinking blocks and the compaction card", () => {
		const source = read("web/src/components/CollapsibleHead.tsx");
		expect(source).toContain('data-disclosure=""');
	});

	it("the compacted-history toggle is marked too (it grows again when history loads)", () => {
		const source = read("web/src/components/Message.tsx");
		const block = /className="compacted-history-toggle-btn"([\s\S]{0,120})/.exec(source)?.[1] ?? "";
		expect(block).toContain('data-disclosure=""');
	});

	it("the scroll hook consults the marker on pointer and keyboard activation", () => {
		const source = read("web/src/components/use-chat-scroll.ts");
		expect(source).toContain('closest("[data-disclosure]")');
		expect(source).toContain("suppressAutoPin()");
	});
});
