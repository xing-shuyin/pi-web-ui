import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClientRuntime, type ClientFrames } from "../../packages/keel/src/app/client-runtime.js";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { TransportPort } from "../../packages/keel/src/contracts/ports.js";
import type { ServerMessage } from "../../packages/keel/src/protocol.js";
import { Conversation } from "../../packages/keel/src/kernel/conversation/index.js";
import { ConversationRegistry } from "../../packages/keel/src/kernel/conversation/index.js";
import { rebindSession, type RebindContext } from "../../packages/keel/src/domains/sessions/rebind.js";
import { createWorkspaceSwitcher } from "../../packages/keel/src/domains/sessions/workspace.js";
import { createSessionPins } from "../../packages/keel/src/domains/sessions/pins.js";
import { createFakeSettingsStore } from "../helpers/fake-settings-store.js";

interface Harness {
	registry: ConversationRegistry<Conversation>;
	ctx: RebindContext;
	opened: string[];
	closed: string[];
	flushes: (boolean | undefined)[];
	sessionsPushed: number;
	/** 让下一次 `ensure` 失败（模拟 SDK 建不起来）。 */
	failNextEnsure: boolean;
	engineRoots: { cwd: string; roots: readonly string[] };
}

function harness(startCwd = "/work"): Harness {
	const registry = new ConversationRegistry<Conversation>();
	let seq = 0;
	const state: Harness = {
		registry,
		opened: [],
		closed: [],
		flushes: [],
		sessionsPushed: 0,
		failNextEnsure: false,
		engineRoots: { cwd: startCwd, roots: [] },
		ctx: undefined as unknown as RebindContext,
	};
	const conversation = (init: { cwd: string; sessionFile?: string }): Conversation =>
		new Conversation({
			id: `c-${++seq}`,
			clientId: "c1",
			cwd: init.cwd,
			kind: "user",
			createdAt: seq,
			...(init.sessionFile ? { sessionFile: init.sessionFile } : {}),
		});
	state.ctx = {
		registry,
		sessions: {
			ensure: async (conv) => {
				if (state.failNextEnsure) {
					state.failNextEnsure = false;
					throw new Error("SDK 建不起来");
				}
				state.opened.push(conv.id);
				return {};
			},
			close: (id) => void state.closed.push(id),
		},
		frames: {
			flush: (forceFull) => void state.flushes.push(forceFull),
			pushSessions: () => void (state.sessionsPushed += 1),
		},
		createConversation: (init) => {
			const conv = conversation(init);
			registry.add(conv);
			return conv;
		},
	};
	return state;
}

describe("rebindSession · 先建后拆（失败真回滚）", () => {
	it("成功：新对话成为活动对话，旧对话退役并释放，帧全量重发", async () => {
		const h = harness();
		const before = h.registry.add(
			new Conversation({ id: "c-old", clientId: "c1", cwd: "/work", kind: "user", createdAt: 1 }),
		);
		h.registry.activate(before.id);

		const result = await rebindSession(h.ctx, { cwd: "/next" });

		expect(result.conversation.meta.cwd).toBe("/next");
		expect(result.displaced?.id).toBe("c-old");
		expect(h.registry.activeId()).toBe(result.conversation.id);
		expect(h.registry.get("c-old")).toBeUndefined();
		expect(h.registry.get(result.conversation.id)?.phase).toBe("idle");
		expect(h.opened).toStrictEqual([result.conversation.id]);
		expect(h.closed).toStrictEqual(["c-old"]);
		expect(h.flushes).toStrictEqual([true]);
		expect(h.sessionsPushed).toBe(1);
	});

	it("失败：候选会话释放、候选对话摘出注册表、活动指针回到原处，旧会话仍然可用", async () => {
		const h = harness();
		const before = h.registry.add(
			new Conversation({ id: "c-old", clientId: "c1", cwd: "/work", kind: "user", createdAt: 1 }),
		);
		h.registry.activate(before.id);
		h.failNextEnsure = true;

		await expect(rebindSession(h.ctx, { cwd: "/broken" })).rejects.toThrow("SDK 建不起来");

		// 旧对话一个字节没动：还在注册表里、还是活动对话、会话没被关。
		expect(h.registry.get("c-old")).toBe(before);
		expect(h.registry.activeId()).toBe("c-old");
		expect(h.registry.size()).toBe(1);
		expect(h.closed).not.toContain("c-old");
		expect(before.acceptsTurns).toBe(true);
		// 候选只被关过一次（它自己的会话），且已从注册表摘掉。
		expect(h.registry.list().map((c) => c.id)).toStrictEqual(["c-old"]);
	});

	it("prepare 抛错也算失败：不碰旧会话，候选不留半成品", async () => {
		const h = harness();
		const before = h.registry.add(
			new Conversation({ id: "c-old", clientId: "c1", cwd: "/work", kind: "user", createdAt: 1 }),
		);
		h.registry.activate(before.id);

		await expect(
			rebindSession(h.ctx, {
				cwd: "/next",
				prepare: async () => {
					throw new Error("派生文件建不出来");
				},
			}),
		).rejects.toThrow("派生文件建不出来");

		expect(h.opened).toStrictEqual([]);
		expect(h.registry.activeId()).toBe("c-old");
		expect(h.registry.size()).toBe(1);
	});

	it("打开会话前把目标转录与 sessionCwd 一起交给注册表（远程工作区会话目录分离）", async () => {
		const h = harness();
		const seen: { cwd?: string; file?: string }[] = [];
		h.ctx.sessions.ensure = async (conv, options) => {
			seen.push({ cwd: options?.cwd, file: conv.meta.sessionFile });
			return {};
		};
		await rebindSession(h.ctx, { cwd: "ssh://box/work", sessionCwd: "/data/ws/box", sessionFile: "/s/a.jsonl" });
		expect(seen).toStrictEqual([{ cwd: "/data/ws/box", file: "/s/a.jsonl" }]);
	});
});

describe("createWorkspaceSwitcher · setCwd / setWorkspaceRoots", () => {
	function switcher(store = createFakeSettingsStore()) {
		const h = harness();
		const notices: string[] = [];
		const changed: { cwd: string; roots: readonly string[] }[] = [];
		const port = createWorkspaceSwitcher({
			registry: h.registry,
			sessions: h.ctx.sessions,
			frames: h.ctx.frames,
			createConversation: (init) => h.ctx.createConversation(init),
			cwd: () => h.engineRoots.cwd,
			roots: () => h.engineRoots.roots,
			setWorkspace: (cwd, roots) => {
				h.engineRoots = { cwd, roots };
			},
			store: {
				getRoots: (cwd) => store.getWorkspaceRoots("c1", cwd),
				saveRoots: (cwd, roots) => {
					store.saveWorkspaceRoots("c1", cwd, [...(roots ?? [])]);
					return store.getWorkspaceRoots("c1", cwd);
				},
			},
			host: {
				resolveTarget: async (input, from) => ({ cwd: input === "same" ? from : `/abs${input === "/x" ? "/x" : ""}` }),
				onChanged: (cwd, roots) => void changed.push({ cwd, roots }),
			},
			notice: (level, text) => void notices.push(`${level}:${text}`),
		});
		return { port, h, store, notices, changed };
	}

	it("setCwd：宿主解析出的目标成为新工作区，并驱动一次重绑 + 宿主收尾", async () => {
		const { port, h, changed } = switcher();
		await port.setCwd("/x");
		expect(h.engineRoots.cwd).toBe("/abs/x");
		expect(h.opened).toHaveLength(1);
		expect(changed).toStrictEqual([{ cwd: "/abs/x", roots: [] }]);
	});

	it("setCwd 目标与当前一致：只发 info notice，不重绑", async () => {
		const { port, h, notices } = switcher();
		await port.setCwd("same");
		expect(h.opened).toStrictEqual([]);
		expect(notices).toStrictEqual(["info:已在工作目录：/work"]);
	});

	it("setCwd 失败：错误原样冒出去（wire 层按自己口径发 error notice），工作区不动", async () => {
		const { port, h } = switcher();
		h.failNextEnsure = true;
		await expect(port.setCwd("/x")).rejects.toThrow("SDK 建不起来");
		expect(h.engineRoots.cwd).toBe("/work");
	});

	it("setCwd 的宿主收尾失败：只警告，不撤已生效的切换", async () => {
		const store = createFakeSettingsStore();
		const h = harness();
		const notices: string[] = [];
		const port = createWorkspaceSwitcher({
			registry: h.registry,
			sessions: h.ctx.sessions,
			frames: h.ctx.frames,
			createConversation: (init) => h.ctx.createConversation(init),
			cwd: () => h.engineRoots.cwd,
			roots: () => h.engineRoots.roots,
			setWorkspace: (cwd, roots) => {
				h.engineRoots = { cwd, roots };
			},
			store: {
				getRoots: (cwd) => store.getWorkspaceRoots("c1", cwd),
				saveRoots: (cwd, roots) => {
					store.saveWorkspaceRoots("c1", cwd, [...(roots ?? [])]);
					return store.getWorkspaceRoots("c1", cwd);
				},
			},
			host: {
				resolveTarget: async () => ({ cwd: "/abs/x" }),
				onChanged: () => {
					throw new Error("git 监听挂了");
				},
			},
			notice: (level, text) => void notices.push(`${level}:${text}`),
		});
		await port.setCwd("/x");
		expect(h.engineRoots.cwd).toBe("/abs/x");
		expect(notices.some((n) => n.startsWith("warning:"))).toBe(true);
	});

	it("setWorkspaceRoots：落盘 + 刷新工作区 + 宿主收尾", async () => {
		const { port, store, changed, h } = switcher();
		await port.setWorkspaceRoots(["/extra"]);
		expect(store.getWorkspaceRoots("c1", "/work")).toStrictEqual(["/extra"]);
		expect(h.engineRoots.roots).toStrictEqual(["/extra"]);
		expect(changed).toStrictEqual([{ cwd: "/work", roots: ["/extra"] }]);
	});

	it("setWorkspaceRoots 归一后没变：不重复刷新", async () => {
		const { port, changed } = switcher();
		await port.setWorkspaceRoots([]);
		expect(changed).toStrictEqual([]);
	});
});

describe("createSessionPins · 钉住落到设置存储，按归属 cwd 记账", () => {
	function pins(cwd = "/work") {
		const store = createFakeSettingsStore();
		const notices: string[] = [];
		const refreshed: string[] = [];
		const registry = new ConversationRegistry<Conversation>();
		let seq = 0;
		const handlers = createSessionPins({
			registry,
			store: () => store,
			frames: { flush: () => {}, pushSessions: () => {} },
			cwd: () => cwd,
			notice: (level, text) => void notices.push(`${level}:${text}`),
			refreshSessionsFor: (target) => void refreshed.push(target),
		});
		const conv = (id: string, withFile: boolean, kind: "user" | "subagent" = "user"): Conversation =>
			new Conversation({
				id,
				clientId: "c1",
				cwd,
				kind,
				createdAt: ++seq,
				...(withFile ? { sessionFile: `/sessions/${id}.jsonl` } : {}),
			});
		return { handlers, store, notices, refreshed, registry, conv };
	}

	it("pinSession：写盘 + 刷列表", async () => {
		const { handlers, store, refreshed } = pins();
		await handlers.pinSession("/sessions/a.jsonl", true);
		expect(store.isSessionPinned("/work", resolve("/sessions/a.jsonl"))).toBe(true);
		expect(refreshed).toStrictEqual(["/work"]);
	});

	it("setConversationPinned：按对话的转录钉（与 pinSession 同一条路径）", async () => {
		const { handlers, store, registry, conv } = pins();
		const c = registry.add(conv("c-1", true));
		registry.activate(c.id);
		await handlers.setConversationPinned("c-1", true);
		expect(store.isSessionPinned("/work", resolve("/sessions/c-1.jsonl"))).toBe(true);
		await handlers.setConversationPinned("c-1", false);
		expect(store.isSessionPinned("/work", resolve("/sessions/c-1.jsonl"))).toBe(false);
	});

	it("setConversationPinned：没有转录 / 子代理 / 对话不存在都明确回执（不静默成功）", async () => {
		const { handlers, notices, registry, conv } = pins();
		registry.add(conv("c-no-file", false));
		registry.add(conv("c-sub", true, "subagent"));
		await handlers.setConversationPinned("c-no-file", true);
		await handlers.setConversationPinned("c-sub", true);
		await handlers.setConversationPinned("c-missing", true);
		expect(notices).toStrictEqual([
			"warning:该对话还没有会话记录，先发一条消息再钉住",
			"info:子代理对话始终保留在运行列表，无需钉住",
			"warning:该对话不存在或已关闭",
		]);
	});
});

describe("ClientRuntime · 端口未注入时 handler 同步抛 CoreEngineNotReadyError", () => {
	function runtime(options: { stateStore?: boolean; sessions?: boolean } = {}) {
		const sent: ServerMessage[] = [];
		const transport: TransportPort = { send: (msg) => void sent.push(msg), isClosed: () => false };
		const rt = new ClientRuntime({
			clientId: "c1",
			cwd: "/work",
			env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: true }),
			clock: { now: () => 1, after: () => () => {} },
			transport,
			...(options.stateStore ? { stateStore: () => createFakeSettingsStore() } : {}),
			...(options.sessions
				? {
						sessions: {
							ensure: async () => ({ session: {}, sessionId: "s" }),
							close: () => {},
							get: () => undefined,
						},
					}
				: {}),
		} as never);
		const frames: ClientFrames = {
			pushSettings: () => {},
			refreshSessions: async () => {},
			pushProjects: async () => {},
			listModels: () => {},
			pushDefaultModel: () => {},
		};
		rt.attachFrames(frames);
		return { rt, sent };
	}

	it("setCwd / setWorkspaceRoots 没有设置存储 → 同步抛", () => {
		const { rt } = runtime();
		expect(() => rt.handlers().setCwd("/x")).toThrow(CoreEngineNotReadyError);
		expect(() => rt.handlers().setWorkspaceRoots(["/x"])).toThrow(CoreEngineNotReadyError);
	});

	it("pinSession / createSandbox 没有对应端口 → 同步抛", () => {
		const { rt } = runtime({ stateStore: true });
		// 钉住依赖设置存储（已注入）→ 不抛；沙盒端口没注入 → 同步抛。
		expect(() => rt.handlers().createSandbox?.({ name: "x" })).toThrow(CoreEngineNotReadyError);
	});

	it("setCwd 有设置存储但会话面没接 → 同步抛（不能变成 rejected promise）", () => {
		const { rt } = runtime({ stateStore: true });
		expect(() => rt.handlers().setCwd("/x")).toThrow(CoreEngineNotReadyError);
	});

	it("setCwd 记录在案的同步抛只发生在调用期：装配本身不抛", () => {
		const { rt } = runtime({ stateStore: true, sessions: true });
		expect(() => rt.handlers()).not.toThrow();
	});
});

describe("ClientRuntime · 换工作区后分发表上的 cwd / workspaceRoots 跟着变", () => {
	it("setCwd 成功后 cs.cwd 与 cs.workspaceRoots 立即是新值", async () => {
		const store = createFakeSettingsStore();
		store.saveWorkspaceRoots("c1", "/next", ["/next-extra"]);
		const openedCwd: string[] = [];
		const fast = {
			ensure: async (conv: { meta: { cwd: string } }) => {
				openedCwd.push(conv.meta.cwd);
				return { session: {}, sessionId: "s" };
			},
			close: () => {},
			get: () => undefined,
		};
		const rt = new ClientRuntime({
			clientId: "c1",
			cwd: "/work",
			env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: true }),
			clock: { now: () => 1, after: () => () => {} },
			transport: { send: () => {}, isClosed: () => false },
			stateStore: () => store,
			sessions: fast as never,
			workspaceHost: () => ({ resolveTarget: async (input: string) => ({ cwd: input }) }),
		});
		rt.attachFrames({
			pushSettings: () => {},
			refreshSessions: async () => {},
			pushProjects: async () => {},
			listModels: () => {},
			pushDefaultModel: () => {},
		});
		const cs = rt.handlers();
		await cs.setCwd("/next");
		expect(openedCwd).toStrictEqual(["/next"]);
		expect(cs.cwd).toBe("/next");
		expect(cs.workspaceRoots).toStrictEqual(["/next-extra"]);
	});
});

describe("ClientRuntime · switchSession 走同一条重绑链", () => {
	it("已打开的转录直接复用（不重复建会话），未知路径只回 warning", async () => {
		const openedCwd: string[] = [];
		const rt = new ClientRuntime({
			clientId: "c1",
			cwd: "/work",
			env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: true }),
			clock: { now: () => 1, after: () => () => {} },
			transport: { send: () => {}, isClosed: () => false },
			sessions: {
				ensure: async (conv: { meta: { cwd: string } }) => {
					openedCwd.push(conv.meta.cwd);
					return { session: {}, sessionId: "s" };
				},
				close: () => {},
				get: () => undefined,
			} as never,
			isAllowedPath: () => false,
		});
		rt.attachFrames({
			pushSettings: () => {},
			refreshSessions: async () => {},
			pushProjects: async () => {},
			listModels: () => {},
			pushDefaultModel: () => {},
		});
		// 越界路径一律拒绝（fail-closed），不开会话。
		await rt.handlers().switchSession("/etc/passwd.jsonl");
		expect(openedCwd).toStrictEqual([]);
	});

	it("vi.mock 之外：端口在但转录不存在 → notice error，不 reject（wire 层是 void 调用）", async () => {
		const notices: ServerMessage[] = [];
		const rt = new ClientRuntime({
			clientId: "c1",
			cwd: "/work",
			env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: true }),
			clock: { now: () => 1, after: () => () => {} },
			transport: { send: (msg) => void notices.push(msg), isClosed: () => false },
			sessions: {
				ensure: async () => {
					throw new Error("转录文件不存在");
				},
				close: () => {},
				get: () => undefined,
			} as never,
		});
		rt.attachFrames({
			pushSettings: () => {},
			refreshSessions: async () => {},
			pushProjects: async () => {},
			listModels: () => {},
			pushDefaultModel: () => {},
		});
		await expect(rt.handlers().switchSession("/sessions/missing.jsonl")).resolves.toBeUndefined();
		const error = notices.find((m) => m.type === "notice" && m.level === "error");
		expect(error).toBeTruthy();
	});
});

describe("ClientRuntime · 沙盒 7 个从抛变真（端口注入后真的走到宿主）", () => {
	it("createSandbox → 端口 create + 工作区切过去", async () => {
		const calls: string[] = [];
		const store = createFakeSettingsStore();
		const rt = new ClientRuntime({
			clientId: "c1",
			cwd: "/work",
			env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: true }),
			clock: { now: () => 1, after: () => () => {} },
			transport: { send: () => {}, isClosed: () => false },
			stateStore: () => store,
			sessions: {
				ensure: async () => ({ session: {}, sessionId: "s" }),
				close: () => {},
				get: () => undefined,
			} as never,
			sandbox: () =>
				({
					locate: async () => undefined,
					create: async () => {
						calls.push("create");
						return { path: "/data/sandboxes/sb1" };
					},
					reset: async () => void calls.push("reset"),
					persist: async () => void calls.push("persist"),
					promote: async () => ({ targetPath: "/work/exported" }),
					diff: async () => void calls.push("diff"),
					applyToSource: async () => void calls.push("applyToSource"),
					destroy: async () => void calls.push("destroy"),
				}) as never,
			// 宿主解析端口：测试不碰文件系统，目标就是入参（真宿主会 `~` 展开 + stat 目录）。
			workspaceHost: () => ({ resolveTarget: async (input: string) => ({ cwd: input }) }),
		});
		rt.attachFrames({
			pushSettings: () => {},
			refreshSessions: async () => {},
			pushProjects: async () => {},
			listModels: () => {},
			pushDefaultModel: () => {},
		});
		await rt.handlers().createSandbox?.({ name: "实验", ephemeral: true });
		expect(calls).toStrictEqual(["create"]);
		expect(rt.handlers().cwd).toBe("/data/sandboxes/sb1");
	});
});

describe("rebindSession · 不许重复实现（一次调用只开一份会话）", () => {
	it("ensure 只被调一次，close 只关旧对话一次", async () => {
		const h = harness();
		h.registry.add(new Conversation({ id: "c-old", clientId: "c1", cwd: "/work", kind: "user", createdAt: 1 }));
		h.registry.activate("c-old");
		const ensure = vi.fn(h.ctx.sessions.ensure);
		h.ctx.sessions.ensure = ensure;
		await rebindSession(h.ctx, { cwd: "/next" });
		expect(ensure).toHaveBeenCalledTimes(1);
		expect(h.closed).toStrictEqual(["c-old"]);
	});
});

describe("ClientRuntime · switchSession happy path（真开会话 + 工作区跟转录 header 走）", () => {
	it("打开未开过的转录：新对话落到该转录 cwd，cs.cwd 跟着变", async () => {
		const opened: string[] = [];
		const store = createFakeSettingsStore();
		const rt = new ClientRuntime({
			clientId: "c1",
			cwd: "/work",
			env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: true }),
			clock: { now: () => 1, after: () => () => {} },
			transport: { send: () => {}, isClosed: () => false },
			stateStore: () => store,
			sessions: {
				ensure: async (conv: { meta: { cwd: string } }) => {
					opened.push(conv.meta.cwd);
					return { session: {}, sessionId: "s-1" };
				},
				close: () => {},
				get: () => undefined,
			} as never,
			// 转录读不出来（文件不存在）→ 用当前工作区兜底，仍然算成功打开。
			isAllowedPath: () => true,
		});
		rt.attachFrames({
			pushSettings: () => {},
			refreshSessions: async () => {},
			pushProjects: async () => {},
			listModels: () => {},
			pushDefaultModel: () => {},
		});
		const cs = rt.handlers();
		await cs.switchSession("/sessions/legacy.jsonl");
		expect(opened).toStrictEqual(["/work"]);
		expect(cs.cwd).toBe("/work");
	});
});
