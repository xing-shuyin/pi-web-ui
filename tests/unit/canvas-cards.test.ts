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

	it("starts empty and adds a card with generated id", async () => {
		expect(listCustomCards(tempDir)).toEqual([]);
		const card = await addCustomCard(
			tempDir,
			{ title: "循环重试", role: "loop", instruction: "重试", config: { loopCount: 5 } },
			isValidRole,
		);
		expect(card.id).toMatch(/^card_/);
		expect(card.config).toEqual({ loopCount: 5 });
		// 落盘已 await：新读一定要看到这张卡。
		expect(listCustomCards(tempDir)).toHaveLength(1);
	});

	it("rejects empty title, bad role, bad engine and non-scalar config", async () => {
		await expect(addCustomCard(tempDir, { title: "", role: "coder" }, isValidRole)).rejects.toThrow();
		await expect(addCustomCard(tempDir, { title: "x", role: "nope" }, isValidRole)).rejects.toThrow();
		await expect(addCustomCard(tempDir, { title: "x", role: "coder", engine: "nope" }, isValidRole)).rejects.toThrow();
		await expect(
			addCustomCard(tempDir, { title: "x", role: "coder", config: { nested: { a: 1 } } }, isValidRole),
		).rejects.toThrow();
		await expect(addCustomCard(tempDir, { title: "x", role: "coder", config: [] }, isValidRole)).rejects.toThrow();
	});

	it("updates fields and clears emptied optionals", async () => {
		const card = await addCustomCard(
			tempDir,
			{ title: "旧", role: "coder", instruction: "做事", model: "m/old" },
			isValidRole,
		);
		const updated = await updateCustomCard(tempDir, card.id, { title: "新", instruction: "", model: "" }, isValidRole);
		expect(updated.title).toBe("新");
		expect(updated.instruction).toBeUndefined();
		expect(updated.model).toBeUndefined();
		expect(updated.role).toBe("coder");
		expect(listCustomCards(tempDir).find((c) => c.id === card.id)?.title).toBe("新");
	});

	it("deletes by id and reports missing", async () => {
		const card = await addCustomCard(tempDir, { title: "删我", role: "custom" }, isValidRole);
		expect(await deleteCustomCard(tempDir, card.id)).toBe(true);
		expect(await deleteCustomCard(tempDir, card.id)).toBe(false);
		expect(listCustomCards(tempDir)).toEqual([]);
	});

	it("rejects path traversal ids", async () => {
		await expect(updateCustomCard(tempDir, "../evil", { title: "x" }, isValidRole)).rejects.toThrow();
		await expect(deleteCustomCard(tempDir, "../../evil")).rejects.toThrow();
	});
});
