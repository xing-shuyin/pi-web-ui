import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UniversalSessionStore, UniversalSession, MockAgentDriver } from "../../server/universal/index.js";
import type { ServerMessage } from "../../server/protocol.js";
import type { Component } from "@earendil-works/pi-tui";

describe("通用底座（Universal Base）TUI 终端交互桥接体系单测", () => {
	let tempDir: string;
	let store: UniversalSessionStore;
	let session: UniversalSession;
	let outbox: ServerMessage[];

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-universal-tui-test-"));
		store = new UniversalSessionStore(tempDir);
		outbox = [];

		const driverFactory = (cwd: string) => new MockAgentDriver(cwd);
		const initialDriver = driverFactory(tempDir);

		session = new UniversalSession({
			clientId: "test-tui-client",
			cwd: tempDir,
			dataDir: tempDir,
			agentDir: tempDir,
			send: (msg) => outbox.push(msg),
			store,
			driver: initialDriver,
			driverFactory,
			lang: "zh",
			pluginCommandsProvider: () => [
				{
					name: "test-tui-cmd",
					description: "测试用 TUI 命令",
					run: async (_args, ctx) => {
						if ((ctx as any).uiContext?.confirm) {
							return await (ctx as any).uiContext.confirm("插件确认", "是否继续？");
						}
						return "no-ui";
					},
				},
			],
		});

		await session.newChat();
		outbox.length = 0;
	});

	afterEach(() => {
		session.dispose();
		if (existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
			} catch {}
		}
	});

	it("1. WebUIContext 实例化正常", () => {
		expect(session.webUi).toBeDefined();
		expect(typeof session.webUi.select).toBe("function");
		expect(typeof session.webUi.confirm).toBe("function");
		expect(typeof session.webUi.input).toBe("function");
		expect(typeof session.webUi.custom).toBe("function");
	});

	it("2. resolveDialog：能够正常桥接 select / confirm / input 弹窗交互", async () => {
		const selectPromise = session.webUi.select("请选择模式", ["模式 A", "模式 B"]);

		const selectMsg = outbox.find((m) => m.type === "dialog" && m.kind === "select") as any;
		expect(selectMsg).toBeDefined();
		expect(selectMsg.title).toBe("请选择模式");

		session.resolveDialog(selectMsg.id, "模式 A");
		const selected = await selectPromise;
		expect(selected).toBe("模式 A");

		outbox.length = 0;
		const confirmPromise = session.webUi.confirm("危险操作", "确定删除该分支吗？");
		const confirmMsg = outbox.find((m) => m.type === "dialog" && m.kind === "confirm") as any;
		expect(confirmMsg).toBeDefined();

		session.resolveDialog(confirmMsg.id, true);
		const confirmed = await confirmPromise;
		expect(confirmed).toBe(true);

		outbox.length = 0;
		const inputPromise = session.webUi.input("请输入新名称", "默认名");
		const inputMsg = outbox.find((m) => m.type === "dialog" && m.kind === "input") as any;
		expect(inputMsg).toBeDefined();

		session.resolveDialog(inputMsg.id, "my-feature-branch");
		const inputVal = await inputPromise;
		expect(inputVal).toBe("my-feature-branch");
	});

	it("3. custom TUI 浮层桥接：能成功打开并下发 tui_overlay_open 消息", async () => {
		let componentRendered = false;

		const dummyComponent: Component = {
			render: (_width: number) => {
				componentRendered = true;
				return ["┌──────────────────────┐", "│ TUI 交互组件运行中... │", "└──────────────────────┘"];
			},
			invalidate: () => {},
		};

		const customPromise = session.webUi.custom((_tui, _theme, _keybindings, done) => {
			setTimeout(() => done("TUI_DONE"), 50);
			return dummyComponent;
		});

		const openMsg = outbox.find((m) => m.type === "tui_overlay_open") as any;
		expect(openMsg).toBeDefined();
		expect(openMsg.cols).toBeGreaterThan(0);
		expect(openMsg.rows).toBeGreaterThan(0);
		expect(openMsg.initialAnsi).toContain("TUI 交互组件运行中");
		expect(componentRendered).toBe(true);

		const result = await customPromise;
		expect(result).toBe("TUI_DONE");

		const closeMsg = outbox.find((m) => m.type === "tui_overlay_close") as any;
		expect(closeMsg).toBeDefined();
	});

	it("4. handleTuiOverlayInput：能将 Web 前端按键实时传给 TUI 组件并触发重新渲染", async () => {
		let receivedInput = "";

		const dummyComponent: Component = {
			render: (_width: number) => {
				return [`Current input: ${receivedInput}`];
			},
			invalidate: () => {},
			handleInput: (data: string) => {
				receivedInput += data;
			},
		};

		session.webUi.custom((_tui, _theme, _keybindings, _done) => {
			return dummyComponent;
		});

		const openMsg = outbox.find((m) => m.type === "tui_overlay_open") as any;
		expect(openMsg).toBeDefined();
		const overlayId = openMsg.id;

		outbox.length = 0;
		session.handleTuiOverlayInput(overlayId, "hello-key");
		expect(receivedInput).toBe("hello-key");

		await new Promise((r) => setTimeout(r, 20));
		const renderMsg = outbox.find((m) => m.type === "tui_overlay_render" && m.id === overlayId) as any;
		expect(renderMsg).toBeDefined();
		expect(renderMsg.ansi).toContain("hello-key");
	});

	it("5. handleTuiOverlayResize & handleTuiOverlayCancel：支持窗口尺寸调整与取消", async () => {
		let cancelled = false;

		const dummyComponent = {
			render: (_width: number) => ["Resizable Content"],
			invalidate: () => {},
			dispose: () => {
				cancelled = true;
			},
		} as any;

		const customPromise = session.webUi.custom((_tui, _theme, _keybindings, _done) => {
			return dummyComponent;
		});

		const openMsg = outbox.find((m) => m.type === "tui_overlay_open") as any;
		const overlayId = openMsg.id;

		session.handleTuiOverlayResize(overlayId, 120, 40);

		session.handleTuiOverlayCancel(overlayId);

		const result = await customPromise;
		expect(result).toBeUndefined();
		expect(cancelled).toBe(true);

		const closeMsg = outbox.find((m) => m.type === "tui_overlay_close" && m.id === overlayId);
		expect(closeMsg).toBeDefined();
	});

	it("6. pluginCommands 上下文注入：插件命令可以调用 TUI 交互并收到应答", async () => {
		outbox.length = 0;

		const cmdPromise = (session as any).slash.exec("test-tui-cmd", "");
		await new Promise((r) => setTimeout(r, 20));

		const confirmMsg = outbox.find((m) => m.type === "dialog" && m.kind === "confirm") as any;
		expect(confirmMsg).toBeDefined();
		expect(confirmMsg.title).toBe("插件确认");

		session.resolveDialog(confirmMsg.id, true);
		await cmdPromise;

		expect(outbox.some((m) => m.type === "dialog_closed" && (m as any).id === confirmMsg.id)).toBe(true);
	});
});
