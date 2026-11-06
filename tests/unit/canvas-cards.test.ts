import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addCustomCard,
	deleteCustomCard,
	listCustomCards,
	updateCustomCard,
} from "../../server/canvas/canvas-cards.js";

const isValidRole = (r: string): boolean => ["coder", "loop", "custom", "condition"].includes(r);

describe("Custom Cards Store", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-cards-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("starts empty and adds a card with generated id", () => {
		expect(listCustomCards(tempDir)).toEqual([]);
		const card = addCustomCard(
			tempDir,
			{ title: "循环重试", role: "loop", instruction: "重试", config: { loopCount: 5 } },
			isValidRole,
		);
		expect(card.id).toMatch(/^card_/);
		expect(card.config).toEqual({ loopCount: 5 });
		expect(listCustomCards(tempDir)).toHaveLength(1);
	});

	it("rejects empty title, bad role, bad engine and non-scalar config", () => {
		expect(() => addCustomCard(tempDir, { title: "", role: "coder" }, isValidRole)).toThrow();
		expect(() => addCustomCard(tempDir, { title: "x", role: "nope" }, isValidRole)).toThrow();
		expect(() => addCustomCard(tempDir, { title: "x", role: "coder", engine: "nope" }, isValidRole)).toThrow();
		expect(() =>
			addCustomCard(tempDir, { title: "x", role: "coder", config: { nested: { a: 1 } } }, isValidRole),
		).toThrow();
		expect(() => addCustomCard(tempDir, { title: "x", role: "coder", config: [] }, isValidRole)).toThrow();
	});

	it("updates fields and clears emptied optionals", () => {
		const card = addCustomCard(
			tempDir,
			{ title: "旧", role: "coder", instruction: "做事", model: "m/old" },
			isValidRole,
		);
		const updated = updateCustomCard(tempDir, card.id, { title: "新", instruction: "", model: "" }, isValidRole);
		expect(updated.title).toBe("新");
		expect(updated.instruction).toBeUndefined();
		expect(updated.model).toBeUndefined();
		expect(updated.role).toBe("coder");
	});

	it("deletes by id and reports missing", () => {
		const card = addCustomCard(tempDir, { title: "删我", role: "custom" }, isValidRole);
		expect(deleteCustomCard(tempDir, card.id)).toBe(true);
		expect(deleteCustomCard(tempDir, card.id)).toBe(false);
		expect(listCustomCards(tempDir)).toEqual([]);
	});

	it("rejects path traversal ids", () => {
		expect(() => updateCustomCard(tempDir, "../evil", { title: "x" }, isValidRole)).toThrow();
		expect(() => deleteCustomCard(tempDir, "../../evil")).toThrow();
	});
});
