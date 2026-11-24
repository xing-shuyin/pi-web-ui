import { describe, expect, it } from "vitest";
import type {
	NativeCliLaunch,
	NativeCliLaunched,
	NativeCliPort,
	NativeCliTarget,
} from "../../packages/keel/src/contracts/native-cli.js";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { TransportPort } from "../../packages/keel/src/contracts/ports.js";
import { Conversation, ConversationRegistry } from "../../packages/keel/src/kernel/conversation/index.js";
import type { ServerMessage } from "../../packages/keel/src/protocol.js";
import type { DispatchSession } from "../../packages/keel/src/engine-service.js";
import {
	createNativeCliHandlersFor,
	type NativeCliHandlers,
	type NativeCliRuntime,
} from "../../packages/keel/src/app/native-cli-handlers.js";

type Call = [name: string, ...args: unknown[]];

/** 端口桩与帧出口共用一个调用账：断言「宿主被怎么调」和「出了哪些帧」用同一份顺序。 */
function fakePort(calls: Call[], overrides: Partial<NativeCliPort> = {}): NativeCliPort {
	return {
		launch: async (input: NativeCliLaunch): Promise<NativeCliLaunched> => {
			calls.push(["launch", input]);
			return { terminalId: `cli-${input.conversationId}`, cwd: input.cwd };
		},
		statusOf: (target: NativeCliTarget) => {
			calls.push(["statusOf", target.conversationId, target.terminalId]);
			return undefined;
		},
		detach: (target: NativeCliTarget) => {
			calls.push(["detach", target.conversationId, target.terminalId]);
		},
		reconnect: async (target: NativeCliTarget) => {
			calls.push(["reconnect", target.conversationId, target.terminalId]);
		},
		stop: async (target: NativeCliTarget) => {
			calls.push(["stop", target.conversationId, target.terminalId]);
		},
		applyTitle: (target: NativeCliTarget) => {
			calls.push(["applyTitle", target.conversationId, target.title]);
		},
		...overrides,
	};
}

interface Harness {
	runtime: NativeCliRuntime;
	registry: ConversationRegistry<Conversation>;
	calls: Call[];
	notices: ServerMessage[];
	handlers(): NativeCliHandlers;
}

/** `withPort = false` 模拟宿主还没接线：四个成员都应同步抛。 */
function harness(overrides: Partial<NativeCliPort> = {}, withPort = true): Harness {
	const registry = new ConversationRegistry<Conversation>();
	const calls: Call[] = [];
	const notices: ServerMessage[] = [];
	const transport: TransportPort = {
		send: (msg: ServerMessage) => void notices.push(msg),
		isClosed: () => false,
	};
	const port = fakePort(calls, overrides);
	const runtime: NativeCliRuntime = {
		options: { transport, ...(withPort ? { nativeCli: () => port } : {}) },
		registry,
		publisher: { request: () => void calls.push(["flushSnapshot"]) },
		cwd: "/work",
		pushConversations: () => void calls.push(["conversations"]),
		activeConversationId: () => registry.activeId() || undefined,
		createConversation: (init) => {
			const conv = new Conversation({
				id: init?.id ?? `c-${registry.nextSeq()}`,
				clientId: "client-1",
				cwd: init?.cwd ?? "/work",
				kind: init?.kind ?? "user",
				createdAt: 1,
				...(init?.title ? { title: init.title } : {}),
			});
			registry.add(conv);
			// 真运行时同口径：`createConversation` 顺手激活（快照基线也跟着换）。
			registry.activate(conv.id);
			return conv;
		},
	};
	return { runtime, registry, calls, notices, handlers: () => createNativeCliHandlersFor(runtime) };
}

describe("原生 CLI 会话面（B5）· 4 个 handler 从抛变真", () => {
	it("newCliChat：起 CLI → 建会话实体 → 记归属 → 出帧 → onReady", async () => {
		const h = harness();
		const ids: string[] = [];
		const handlers = h.handlers();
		await expect(
			handlers.newCliChat({ preset: "claude", args: ["--verbose"] }, "/work/sub", (id) => ids.push(id), "修一下登录页"),
		).resolves.toBe(true);

		const conv = h.registry.require("c-1");
		expect(h.calls.slice(0, 3)).toEqual([
			[
				"launch",
				{
					conversationId: "c-1",
					config: { preset: "claude", args: ["--verbose"] },
					cwd: "/work/sub",
					title: "修一下登录页",
				},
			],
			["conversations"],
			["flushSnapshot"],
		]);
		expect(conv.meta.kind).toBe("cli");
		expect(conv.meta.title).toBe("修一下登录页");
		expect(conv.meta.cwd).toBe("/work/sub");
		expect(ids).toEqual(["c-1"]);
		// 归属记在内核这份账上：`getNativeCliConversation`（不给 id = 活跃对话）立刻能答。
		expect(handlers.getNativeCliConversation()).toEqual({
			config: { preset: "claude", args: ["--verbose"] },
			terminalId: "cli-c-1",
		});
	});

	it("newCliChat：没给标题用自动名（`<preset> CLI` / custom 用可执行文件名），cwd 缺省取当前工作区", async () => {
		const first = harness();
		await first.handlers().newCliChat({ preset: "codex" });
		expect(first.calls[0]).toEqual([
			"launch",
			{ conversationId: "c-1", config: { preset: "codex" }, cwd: "/work", title: "codex CLI" },
		]);

		const second = harness();
		await second.handlers().newCliChat({ preset: "custom", executable: "/usr/local/bin/agy-next" });
		expect(second.calls[0]).toEqual([
			"launch",
			{
				conversationId: "c-1",
				config: { preset: "custom", executable: "/usr/local/bin/agy-next" },
				cwd: "/work",
				title: "agy-next",
			},
		]);
	});

	it("newCliChat：配置校验失败 → error notice + false，且不留半死对话", async () => {
		const h = harness();
		await expect(h.handlers().newCliChat({ preset: "nope" as never })).resolves.toBe(false);
		expect(h.registry.list()).toHaveLength(0);
		expect(h.notices).toHaveLength(1);
		expect(h.notices[0]).toMatchObject({ type: "notice", level: "error" });
		expect((h.notices[0] as { text: string }).text).toMatch(/^新建 CLI 对话失败：/);
	});

	it("newCliChat：宿主起不来 → error notice + false，对话没被注册（失败不吞也不留半死）", async () => {
		const h = harness({ launch: () => Promise.reject(new Error("SSH service is unavailable")) });
		await expect(h.handlers().newCliChat({ preset: "claude" })).resolves.toBe(false);
		expect(h.registry.list()).toHaveLength(0);
		expect((h.notices[0] as { text: string }).text).toBe("新建 CLI 对话失败：SSH service is unavailable");
	});

	it("updateNativeCliTitleFromInput：首行派生（去引用标记），并让宿主把标题写回会话文件", async () => {
		const h = harness();
		const handlers = h.handlers();
		await handlers.newCliChat({ preset: "claude" });
		h.calls.length = 0;
		handlers.updateNativeCliTitleFromInput("c-1", "@@@ 修复登录页的样式错位问题并补上回归用例\n第二行不该用");
		expect(h.registry.get("c-1")?.meta.title).toBe("修复登录页的样式错位问题并补上回归用例");
		expect(h.calls).toEqual([
			["applyTitle", "c-1", "修复登录页的样式错位问题并补上回归用例"],
			["conversations"],
			["flushSnapshot"],
		]);
	});

	it("updateNativeCliTitleFromInput：开头的附件/引用标记（@ 📎 #）先剥掉再取名", async () => {
		const h = harness();
		const handlers = h.handlers();
		await handlers.newCliChat({ preset: "claude" });
		handlers.updateNativeCliTitleFromInput("c-1", "📎 把构建脚本的缓存目录挪到 workspace 下");
		expect(h.registry.get("c-1")?.meta.title).toBe("把构建脚本的缓存目录挪到 workspace 下");
	});

	it("updateNativeCliTitleFromInput：超 30 字截断加省略号（换一条新对话才验证，改名闸不参与）", async () => {
		const h = harness();
		const handlers = h.handlers();
		await handlers.newCliChat({ preset: "claude" });
		await handlers.newCliChat({ preset: "claude" });
		handlers.updateNativeCliTitleFromInput("c-2", "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三");
		expect(h.registry.get("c-2")?.meta.title).toBe("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十…");
		// 老对话没被这次输入碰到。
		expect(h.registry.get("c-1")?.meta.title).toBe("claude CLI");
	});

	it("updateNativeCliTitleFromInput：用户改过名就再也不自动覆盖（用户改名优先）", async () => {
		const h = harness();
		const handlers = h.handlers();
		await handlers.newCliChat({ preset: "claude" });
		// 用户手动改名（走同一个聚合根的 `rename`，与 `renameConversation` handler 完全一致）。
		h.registry.get("c-1")?.rename("我的排障会话");
		h.calls.length = 0;
		handlers.updateNativeCliTitleFromInput("c-1", "再给一段完全不同的话");
		expect(h.registry.get("c-1")?.meta.title).toBe("我的排障会话");
		// 一个字都不许动：既不调宿主的标题写回，也不出帧。
		expect(h.calls).toEqual([]);
	});

	it("updateNativeCliTitleFromInput：不是 CLI 对话 / 派生不出非自动名 → 什么都不做", async () => {
		const h = harness();
		const handlers = h.handlers();
		handlers.updateNativeCliTitleFromInput("c-404", "随便一句");
		await handlers.newCliChat({ preset: "claude" });
		h.calls.length = 0;
		handlers.updateNativeCliTitleFromInput("c-1", "claude CLI");
		expect(h.registry.get("c-1")?.meta.title).toBe("claude CLI");
		expect(h.calls).toEqual([]);
	});

	it("controlNativeCli：detach / reconnect / stop 三个动作各自真调 + 出快照", async () => {
		const h = harness();
		const handlers = h.handlers();
		await handlers.newCliChat({ preset: "claude" });
		h.calls.length = 0;
		await handlers.controlNativeCli("c-1", "cli-c-1", "detach");
		await handlers.controlNativeCli("c-1", "cli-c-1", "reconnect");
		await handlers.controlNativeCli("c-1", "cli-c-1", "stop");
		expect(h.calls).toEqual([
			["detach", "c-1", "cli-c-1"],
			["flushSnapshot"],
			["reconnect", "c-1", "cli-c-1"],
			["flushSnapshot"],
			["stop", "c-1", "cli-c-1"],
			["flushSnapshot"],
		]);
	});

	it("controlNativeCli：终端不属于这条对话 → reject（老文案），宿主一次都不被调", async () => {
		const h = harness();
		const handlers = h.handlers();
		await handlers.newCliChat({ preset: "claude" });
		h.calls.length = 0;
		await expect(handlers.controlNativeCli("c-1", "cli-other", "stop")).rejects.toThrow(
			"CLI terminal does not belong to this conversation",
		);
		await expect(handlers.controlNativeCli("c-404", "cli-c-1", "detach")).rejects.toThrow(
			"CLI terminal does not belong to this conversation",
		);
		expect(h.calls).toEqual([]);
	});

	it("controlNativeCli：宿主 reject 原样冒泡（停不掉不静默成功，也不补快照）", async () => {
		const h = harness({ stop: () => Promise.reject(new Error("remote stop could not be confirmed")) });
		const handlers = h.handlers();
		await handlers.newCliChat({ preset: "claude", keepAlive: true });
		h.calls.length = 0;
		await expect(handlers.controlNativeCli("c-1", "cli-c-1", "stop")).rejects.toThrow(
			"remote stop could not be confirmed",
		);
		expect(h.calls).toEqual([]);
	});

	it("getNativeCliConversation：如实投影（宿主有状态才带 status），没有就是 undefined", async () => {
		const h = harness({
			statusOf: () => ({ phase: "running", updatedAt: 7, sessionId: "s-1", persistent: true }),
		});
		const handlers = h.handlers();
		await handlers.newCliChat({ preset: "claude", keepAlive: true });
		expect(handlers.getNativeCliConversation("c-1")).toEqual({
			config: { preset: "claude", keepAlive: true },
			terminalId: "cli-c-1",
			status: { phase: "running", updatedAt: 7, sessionId: "s-1", persistent: true },
		});
		// 不 invent：别的对话没有 CLI 账，就是 undefined。
		expect(handlers.getNativeCliConversation("c-404")).toBeUndefined();
		expect(handlers.getNativeCliConversation()).toMatchObject({ terminalId: "cli-c-1" });
	});

	it("getNativeCliConversation：宿主没有状态时不补 status 键", async () => {
		const h = harness();
		const handlers = h.handlers();
		await handlers.newCliChat({ preset: "pi" });
		const projected = handlers.getNativeCliConversation();
		expect(projected).toEqual({ config: { preset: "pi" }, terminalId: "cli-c-1" });
		expect(projected && "status" in projected).toBe(false);
	});

	it("签名与冻结的 DispatchSession 同名成员逐字一致（漂移在这里红，不在 wire 层）", () => {
		const surface: Pick<
			DispatchSession,
			"newCliChat" | "updateNativeCliTitleFromInput" | "controlNativeCli" | "getNativeCliConversation"
		> = harness().handlers();
		expect(typeof surface.newCliChat).toBe("function");
		expect(typeof surface.getNativeCliConversation).toBe("function");
	});

	it("端口未注入：四个成员都同步抛 CoreEngineNotReadyError（不能变 rejected promise）", () => {
		const handlers = harness({}, false).handlers();
		const silent: string[] = [];
		const attempt = (member: string, run: () => unknown): void => {
			try {
				run();
				silent.push(`${member}（没抛）`);
			} catch (error) {
				if (!(error instanceof CoreEngineNotReadyError)) silent.push(`${member}（抛错类型不对）`);
			}
		};
		attempt("newCliChat", () => handlers.newCliChat({ preset: "claude" }));
		attempt("updateNativeCliTitleFromInput", () => handlers.updateNativeCliTitleFromInput("c-1", "hi"));
		attempt("controlNativeCli", () => handlers.controlNativeCli("c-1", "cli-c-1", "stop"));
		attempt("getNativeCliConversation", () => handlers.getNativeCliConversation());
		expect(silent).toEqual([]);
	});
});
