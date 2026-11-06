import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service";
import { DshClientSession } from "../../server/dsh/dsh-agent-service";
import { UniversalSession } from "../../server/universal/universal-session";

describe("引擎接口一致性门禁 (DispatchSession Interface Conformance)", () => {
	const CORE_PLATFORM_METHODS = [
		"setModel",
		"setDefaultModel",
		"clearDefaultModel",
		"setThinking",

		"saveDraft",
		"newChat",
		"switchSession",
		"switchConversation",
		"deleteSession",
		"renameSession",
		"renameConversation",
		"pinSession",
		"setConversationPinned",
		"searchSessions",
		"refreshSessions",

		"getToolInfo",
		"getToolPrompt",
		"getCompactedMessages",

		"setCwd",
		"setWorkspaceRoots",

		"flushSnapshot",
		"pushSettings",
	] as const;

	it("Pi 引擎 (ClientSession) 完整实现核心平台契约", () => {
		const proto = ClientSession.prototype as unknown as Record<string, unknown>;
		for (const method of CORE_PLATFORM_METHODS) {
			expect(typeof proto[method], `ClientSession 必须实现 ${method}`).toBe("function");
		}
	});

	it("DSH 引擎 (DshClientSession) 完整实现核心平台契约", () => {
		const proto = DshClientSession.prototype as unknown as Record<string, unknown>;
		for (const method of CORE_PLATFORM_METHODS) {
			expect(typeof proto[method], `DshClientSession 必须实现 ${method}`).toBe("function");
		}
	});

	it("Universal / Claude 引擎 (UniversalSession) 完整实现核心平台契约", () => {
		const proto = UniversalSession.prototype as unknown as Record<string, unknown>;
		for (const method of CORE_PLATFORM_METHODS) {
			expect(typeof proto[method], `UniversalSession 必须实现 ${method}`).toBe("function");
		}
	});

	it("沙盒全套生命周期在 UniversalSession 上具备统一实现", () => {
		const proto = UniversalSession.prototype as unknown as Record<string, unknown>;
		const sandboxMethods = [
			"createSandbox",
			"resetSandbox",
			"persistSandbox",
			"promoteSandbox",
			"diffSandbox",
			"applySandboxToSource",
			"destroySandbox",
		];
		for (const m of sandboxMethods) {
			expect(typeof proto[m], `UniversalSession 必须实现沙盒方法 ${m}`).toBe("function");
		}
	});

	it("Git 工作树管理在 UniversalSession 上具备统一实现", () => {
		const proto = UniversalSession.prototype as unknown as Record<string, unknown>;
		expect(typeof proto.switchWorktree, "UniversalSession 必须实现 switchWorktree").toBe("function");
		expect(typeof proto.removeWorktree, "UniversalSession 必须实现 removeWorktree").toBe("function");
	});

	it("会话回滚与分叉在 UniversalSession 上具备统一实现", () => {
		const proto = UniversalSession.prototype as unknown as Record<string, unknown>;
		expect(typeof proto.forkSession, "UniversalSession 必须实现 forkSession").toBe("function");
		expect(typeof proto.rollbackSession, "UniversalSession 必须实现 rollbackSession").toBe("function");
	});

	it("DSH 与 Universal 引擎均提供定制的会话展示名解析回调 (resolveSessionDisplayName)", () => {
		const dshProto = DshClientSession.prototype as any;
		expect(typeof dshProto.resolveSessionDisplayName, "DSH 必须提供 resolveSessionDisplayName 回调").toBe("function");

		const dshMockSession = {
			defaultTitle: () => "新对话",
		};
		const dshName1 = dshProto.resolveSessionDisplayName.call(
			dshMockSession,
			"chat-1",
			"Dockerfile 解析",
			"@Dockerfile 这是啥",
		);
		expect(dshName1).toBe("Dockerfile 解析");

		const dshName2 = dshProto.resolveSessionDisplayName.call(dshMockSession, "chat-2", undefined, "@Dockerfile 这是啥");
		expect(dshName2).toBe("@Dockerfile 这是啥");

		const dshName3 = dshProto.resolveSessionDisplayName.call(dshMockSession, "chat-3", undefined, undefined);
		expect(dshName3).toBe("新对话");

		const universalProto = UniversalSession.prototype as any;
		expect(typeof universalProto.resolveSessionDisplayName, "Universal 必须提供 resolveSessionDisplayName 回调").toBe(
			"function",
		);

		const uniMockSession = { lang: "zh" };
		const uniName1 = universalProto.resolveSessionDisplayName.call(
			uniMockSession,
			{ title: "自定义标题" },
			"首条消息内容",
		);
		expect(uniName1).toBe("自定义标题");

		const uniName2 = universalProto.resolveSessionDisplayName.call(
			uniMockSession,
			{ title: "新对话" },
			"首条长文本内容这是一段非常长的主题描述超过三十个字符的内容测试超长文本",
		);
		expect(uniName2).toBe("首条长文本内容这是一段非常长的主题描述超过三十个字符的内容测…");
	});

	it("DSH 引擎重命名回调能同步内存标题、持久化至 stateStore 并触发刷新", async () => {
		const dshProto = DshClientSession.prototype as any;
		let savedCwd = "";
		let savedKey = "";
		let savedTitle = "";
		const conv = {
			id: "c-rename-1",
			sessionId: "web-test-sid-1",
			sessionFile: "C:/fake/path/session.jsonl",
			title: "旧标题",
		};
		const mockSession = {
			cwd: "E:/my-project",
			convs: new Map([["c-rename-1", conv]]),
			stateStore: {
				saveSessionTitle: vi.fn((cwd, key, title) => {
					savedCwd = cwd;
					savedKey = key;
					savedTitle = title;
				}),
				getSessionTitle: vi.fn((cwd, key) => (key === savedKey ? savedTitle : undefined)),
			},
			emitConversations: vi.fn(),
			flushSnapshot: vi.fn(),
			pushSessions: vi.fn(async () => {}),
		};

		await dshProto.renameConversation.call(mockSession, "c-rename-1", "新的项目分析标题");

		expect(conv.title).toBe("新的项目分析标题");
		expect(mockSession.stateStore.saveSessionTitle).toHaveBeenCalled();
		expect(savedTitle).toBe("新的项目分析标题");
		expect(savedCwd).toBe("E:/my-project");
		expect(mockSession.emitConversations).toHaveBeenCalled();
		expect(mockSession.flushSnapshot).toHaveBeenCalled();
		expect(mockSession.pushSessions).toHaveBeenCalled();
	});

	it("Universal 引擎接入 MarkerService 并支持模型 [[conv:rename:...]] 内联重命名生效", async () => {
		const uniProto = UniversalSession.prototype as any;
		let savedStoreTitle = "";
		const conv = {
			id: "uconv-test-1",
			title: "未命名对话",
			messages: [],
			isEphemeral: false,
			updatedAt: 0,
		};
		const mockSession = {
			cwd: "E:/test-cwd",
			activeConvId: "uconv-test-1",
			conversations: new Map([["uconv-test-1", conv]]),
			store: {
				saveConversation: vi.fn((_cwd, c) => {
					savedStoreTitle = c.title;
				}),
			},
			stateStore: {
				saveSessionTitle: vi.fn(),
			},
			flushSnapshot: vi.fn(),
			refreshSessions: vi.fn(),
		};

		await uniProto.renameConversation.call(mockSession, "uconv-test-1", "通过Marker重命名的标题");

		expect(conv.title).toBe("通过Marker重命名的标题");
		expect(savedStoreTitle).toBe("通过Marker重命名的标题");
		expect(mockSession.flushSnapshot).toHaveBeenCalled();
		expect(mockSession.refreshSessions).toHaveBeenCalled();
	});

	it("Universal 引擎完整实现高级扩展能力契约（命令、预设、技能与 SCM）", () => {
		const uniProto = UniversalSession.prototype as unknown as Record<string, unknown>;
		const UNIVERSAL_EXTENDED_METHODS = [
			"pushSlashCommands",
			"installSkill",
			"uninstallSkill",
			"fetchSkillMarket",
			"fetchSkillContent",
			"fetchMcpMarket",

			"savePreset",
			"applyPreset",
			"deletePreset",
			"exportPreset",
			"importPreset",
			"importPresetFromUrl",
			"pushPresetCatalog",
			"sharePreset",

			"saveSubagentTemplate",
			"deleteSubagentTemplate",

			"scmGenCommitMessage",
		];

		for (const m of UNIVERSAL_EXTENDED_METHODS) {
			expect(typeof uniProto[m], `UniversalSession 必须实现高级方法 ${m}`).toBe("function");
		}
	});
});
