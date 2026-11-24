import { describe, expect, it } from "vitest";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import { UiDialogTable } from "../../packages/keel/src/domains/ui-bridge/dialogs.js";
import { UiOverlayTable } from "../../packages/keel/src/domains/ui-bridge/overlays.js";
import type { ServerMessage } from "../../packages/keel/src/protocol.js";
import { bridgeHarness, frames } from "../helpers/ui-bridge.js";

describe("UI 桥：dialog 挂起表", () => {
	it("开一条出 dialog 帧，回包兑现一次并出 dialog_closed", async () => {
		const emitted: ServerMessage[] = [];
		const table = new UiDialogTable({ emit: (msg) => void emitted.push(msg) });

		const promise = table.open("select", "选分支", [["main", "dev"]], {
			code: { content: "rm -rf /", hasRisk: true },
		});
		expect(emitted).toHaveLength(1);
		const [dialog] = frames(emitted, "dialog");
		expect(dialog).toMatchObject({
			kind: "select",
			title: "选分支",
			args: [["main", "dev"]],
			code: { content: "rm -rf /", hasRisk: true },
		});
		expect(table.pending()).toEqual([{ id: dialog.id, kind: "select" }]);

		table.resolve(dialog.id, "dev");
		await expect(promise).resolves.toBe("dev");
		expect(frames(emitted, "dialog_closed").map((m) => m.id)).toEqual([dialog.id]);
		// 重复回包是空操作：不会二次兑现，也不会再出帧。
		table.resolve(dialog.id, "main");
		expect(emitted).toHaveLength(2);
		expect(table.pending()).toEqual([]);
	});

	it("取消 / 断开：每条挂起的 dialog 都兑现成 null，不留 Promise", async () => {
		const emitted: ServerMessage[] = [];
		const table = new UiDialogTable({ emit: (msg) => void emitted.push(msg) });

		const a = table.open("confirm", "删掉？", ["确定"]);
		const b = table.open("input", "名字", [""]);
		expect(table.size()).toBe(2);

		expect(table.cancelAll()).toBe(2);
		await expect(a).resolves.toBeNull();
		await expect(b).resolves.toBeNull();
		expect(table.size()).toBe(0);
		expect(frames(emitted, "dialog_closed")).toHaveLength(2);
	});

	it("headless（子代理 / 后台会话）不挂起、不出帧、立刻 null", async () => {
		const emitted: ServerMessage[] = [];
		const table = new UiDialogTable({ emit: (msg) => void emitted.push(msg), headless: true });
		await expect(table.open("input", "名字", [""])).resolves.toBeNull();
		expect(emitted).toEqual([]);
		expect(table.pending()).toEqual([]);
	});
});

describe("UI 桥：overlay 路由表", () => {
	function sink() {
		const calls: string[] = [];
		return {
			calls,
			feedInput: (data: string) => void calls.push(`input:${data}`),
			resize: (cols: number, rows: number) => void calls.push(`resize:${cols}x${rows}`),
			cancel: () => void calls.push("cancel"),
		};
	}

	it("按 id 把输入 / 尺寸 / 取消路由到登记的回路上", () => {
		const table = new UiOverlayTable();
		const first = sink();
		const second = sink();
		const id1 = table.register(first);
		const id2 = table.register(second);
		expect(id1).not.toBe(id2);

		table.input(id1, "\u001b[A");
		table.resize(id2, 120, 40);
		table.cancel(id1);
		expect(first.calls).toEqual(["input:\u001b[A", "cancel"]);
		expect(second.calls).toEqual(["resize:120x40"]);
		// 取消过的 id 再也喂不进键（先摘表再 cancel 的闸）
		table.input(id1, "x");
		expect(first.calls).toEqual(["input:\u001b[A", "cancel"]);
		expect(table.has(id1)).toBe(false);
	});

	it("取消已关闭的 overlay 是空操作（宿主 onClose 会再 remove 一次）", () => {
		const table = new UiOverlayTable();
		const target = sink();
		const id = table.register(target);
		table.cancel(id);
		table.cancel(id);
		expect(target.calls).toEqual(["cancel"]);
	});

	it("会话结束 / 断开：cancelAll 把每条都停掉", () => {
		const table = new UiOverlayTable();
		const a = sink();
		const b = sink();
		table.register(a);
		table.register(b);
		expect(table.cancelAll()).toBe(2);
		expect(a.calls).toEqual(["cancel"]);
		expect(b.calls).toEqual(["cancel"]);
		expect(table.size()).toBe(0);
	});
});

describe("UI 桥：4 个 dialog/overlay handler 打到宿主那份表上", () => {
	it("resolveDialog / overlay 三连：只在注入端口时可用", () => {
		const harness = bridgeHarness();
		// 宿主表里挂一条 dialog：内核的 resolveDialog 必须兑现在**同一份表**上（扩展开出来的那条）。
		const opened = harness.dialogs.open("select", "选", [["a"]]);
		const [dialog] = frames(harness.transport.sent, "dialog");
		harness.handlers.resolveDialog(dialog.id, "a");
		return expect(opened).resolves.toBe("a");
	});

	it("overlay 输入 / 尺寸 / 取消：按 id 路由到宿主登记的回路", () => {
		const harness = bridgeHarness();
		const calls: string[] = [];
		const id = harness.overlays.register({
			feedInput: (data) => void calls.push(`input:${data}`),
			resize: (cols, rows) => void calls.push(`resize:${cols}x${rows}`),
			cancel: () => void calls.push("cancel"),
		});
		harness.handlers.handleTuiOverlayInput(id, "q");
		harness.handlers.handleTuiOverlayResize(id, 100, 30);
		harness.handlers.handleTuiOverlayCancel(id);
		expect(calls).toEqual(["input:q", "resize:100x30", "cancel"]);
	});

	it("协议端口没注入：四个 handler 与 installPiAgent 一律同步抛 CoreEngineNotReadyError", () => {
		const harness = bridgeHarness({ withPort: false });
		for (const member of [
			"resolveDialog",
			"handleTuiOverlayInput",
			"handleTuiOverlayResize",
			"handleTuiOverlayCancel",
		] as const) {
			const call = () =>
				member === "resolveDialog"
					? harness.handlers.resolveDialog(1, null)
					: member === "handleTuiOverlayInput"
						? harness.handlers.handleTuiOverlayInput(1, "a")
						: member === "handleTuiOverlayResize"
							? harness.handlers.handleTuiOverlayResize(1, 80, 24)
							: harness.handlers.handleTuiOverlayCancel(1);
			expect(call).toThrow(CoreEngineNotReadyError);
		}
		// installPiAgent 是 async：未注入也要**同步**抛（端口在第一个 await 之前解析）
		expect(() => harness.handlers.installPiAgent()).toThrow(CoreEngineNotReadyError);
	});
});
