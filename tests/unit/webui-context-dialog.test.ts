import { describe, expect, it } from "vitest";
import { WebUIContext } from "../../server/webui-context.js";
import type { ServerMessage } from "../../server/protocol.js";

describe("WebUIContext dialog responses contract (issue #747)", () => {
	it("select: resolves selected string when user picks an option", async () => {
		const emitted: ServerMessage[] = [];
		const ctx = new WebUIContext((msg) => emitted.push(msg));

		const selectPromise = ctx.select("Choose branch", ["main", "dev"]);
		expect(emitted).toHaveLength(1);
		const dialogMsg = emitted[0];
		expect(dialogMsg.type).toBe("dialog");
		if (dialogMsg.type !== "dialog") return;
		expect(dialogMsg.kind).toBe("select");
		expect(dialogMsg.title).toBe("Choose branch");
		expect(dialogMsg.args).toEqual([["main", "dev"]]);

		ctx.resolveDialog(dialogMsg.id, "main");
		const result = await selectPromise;
		expect(result).toBe("main");
	});

	it("select: resolves null on cancellation or null", async () => {
		const emitted: ServerMessage[] = [];
		const ctx = new WebUIContext((msg) => emitted.push(msg));

		const selectPromise = ctx.select("Dangerous operation", ["Yes", "No"]);
		const dialogMsg = emitted[0];
		expect(dialogMsg.type).toBe("dialog");
		if (dialogMsg.type !== "dialog") return;

		ctx.resolveDialog(dialogMsg.id, null);
		const result = await selectPromise;
		expect(result).toBeNull();
	});

	it("confirm: resolves true on OK and false / null on Cancel / Dismiss", async () => {
		const emitted: ServerMessage[] = [];
		const ctx = new WebUIContext((msg) => emitted.push(msg));

		// OK case
		const p1 = ctx.confirm("Delete", "Are you sure?");
		const msg1 = emitted.find((m) => m.type === "dialog");
		if (msg1 && msg1.type === "dialog") ctx.resolveDialog(msg1.id, true);
		expect(await p1).toBe(true);

		// Cancel case (false)
		const p2 = ctx.confirm("Delete", "Are you sure?");
		const msg2 = emitted.filter((m) => m.type === "dialog")[1];
		if (msg2 && msg2.type === "dialog") ctx.resolveDialog(msg2.id, false);
		expect(await p2).toBe(false);

		// Dismiss case (null)
		const p3 = ctx.confirm("Delete", "Are you sure?");
		const msg3 = emitted.filter((m) => m.type === "dialog")[2];
		if (msg3 && msg3.type === "dialog") ctx.resolveDialog(msg3.id, null);
		expect(await p3).toBeNull();
	});

	it("input: resolves string on OK and null on Cancel/null", async () => {
		const emitted: ServerMessage[] = [];
		const ctx = new WebUIContext((msg) => emitted.push(msg));

		const p1 = ctx.input("Your name");
		const msg1 = emitted.find((m) => m.type === "dialog");
		if (msg1 && msg1.type === "dialog") ctx.resolveDialog(msg1.id, "Alice");
		expect(await p1).toBe("Alice");

		const p2 = ctx.input("Your name");
		const msg2 = emitted.filter((m) => m.type === "dialog")[1];
		if (msg2 && msg2.type === "dialog") ctx.resolveDialog(msg2.id, null);
		expect(await p2).toBeNull();
	});

	it("cancelPendingDialogs resolves all pending dialogs with null", async () => {
		const emitted: ServerMessage[] = [];
		const ctx = new WebUIContext((msg) => emitted.push(msg));

		const selectPromise = ctx.select("Select", ["A", "B"]);
		const confirmPromise = ctx.confirm("Confirm", "Msg");
		const inputPromise = ctx.input("Input");

		ctx.cancelPendingDialogs();

		expect(await selectPromise).toBeNull();
		expect(await confirmPromise).toBeNull();
		expect(await inputPromise).toBeNull();
	});

	it("headless context immediately resolves with null", async () => {
		const ctx = WebUIContext.headless();

		expect(await ctx.select("Select", ["A"])).toBeNull();
		expect(await ctx.confirm("Confirm", "Msg")).toBeNull();
		expect(await ctx.input("Input")).toBeNull();
	});
});
