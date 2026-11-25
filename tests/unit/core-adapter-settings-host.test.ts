import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";
import { createCorePlugins } from "../../server/core-plugin-adapter.js";
import {
	createCoreSettingsAdapter,
	createCoreSettingsHost,
	createCoreSettingsService,
	type CoreSettingsAdapterOptions,
} from "../../server/core-settings-adapter.js";
import { SettingsService } from "../../server/settings-service.js";
import type { ServerMessage, UiSettingsState } from "../../server/protocol.js";

const CLIENT_ID = "core-settings-client";

/** `push()` 里三处 `host.getSession()` 都自带 try/catch，这里给一份最小可用会话让帧里带上技能。 */
function fakeSession(): unknown {
	return {
		resourceLoader: {
			getSkills: () => ({ skills: [{ name: "demo", description: "演示技能" }] }),
			getExtensions: () => ({ extensions: [] }),
		},
	};
}

describe("宿主设置适配器（core-settings-adapter）", () => {
	let dir: string;
	let store: ClientStateStore;
	let emitted: ServerMessage[];
	let closed: boolean;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "core-settings-adapter-"));
		store = new ClientStateStore(join(dir, "client-state.json"));
		emitted = [];
		closed = false;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const emitFrame = (msg: ServerMessage): void => void emitted.push(msg);

	function options(overrides: Partial<CoreSettingsAdapterOptions> = {}): CoreSettingsAdapterOptions {
		return {
			clientId: CLIENT_ID,
			stateStore: store,
			emit: emitFrame,
			isClosed: () => closed,
			cwd: dir,
			agentDir: join(dir, "agent"),
			isDisposed: () => false,
			isStreaming: () => false,
			getSession: fakeSession,
			getApprovalPolicy: () => ({ allowAll: false, categories: [] }),
			lang: { get: () => "en", set: () => {} },
			...overrides,
		};
	}

	function settingsFrames(): UiSettingsState[] {
		return emitted.flatMap((msg) => (msg.type === "settings_state" ? [msg.settings] : []));
	}

	/** 真的插件面（会写 mcp.json / 技能目录），并顺带登记设置帧要读的宿主句柄。 */
	function makePlugins(cwd: string, overrides: Partial<Parameters<typeof createCorePlugins>[0]> = {}) {
		return createCorePlugins({
			agentDir: join(dir, "agent"),
			dataDir: join(dir, "data"),
			version: "9.9.9",
			emit: emitFrame,
			isDisposed: () => false,
			getCwd: () => cwd,
			getLang: () => "en",
			reloadSession: async () => {},
			getDisabledPlugins: () => [],
			setDisabledPlugins: async () => {},
			...overrides,
		});
	}

	it("host 如实投影注入的 clientId / stateStore / emit / cwd / agentDir", () => {
		const host = createCoreSettingsHost(options());
		expect(host.clientId).toBe(CLIENT_ID);
		expect(host.stateStore).toBe(store);
		expect(host.emit).toBe(emitFrame);
		expect(host.cwd()).toBe(dir);
		expect(host.agentDir()).toBe(join(dir, "agent"));
	});

	it("host 的 isDisposed / isStreaming / getSession 回注入值，不是写死的常量", () => {
		const session = fakeSession();
		const host = createCoreSettingsHost(
			options({ isDisposed: () => true, isStreaming: () => true, getSession: () => session }),
		);
		expect(host.isDisposed()).toBe(true);
		expect(host.isStreaming()).toBe(true);
		expect(host.getSession()).toBe(session);
	});

	it("host 的每个必需成员都被赋值且类型正确", () => {
		const host = createCoreSettingsHost(options());
		const functions = [
			"emit",
			"flushSnapshot",
			"isDisposed",
			"getSession",
			"cwd",
			"agentDir",
			"isStreaming",
			"reloadSession",
			"applyRetryOverrides",
			"applyCompactionOverrides",
			"applyToolGating",
			"promptSnapshot",
		] as const;
		for (const name of functions) expect(typeof host[name]).toBe("function");
		expect(typeof host.clientId).toBe("string");
		expect(host.stateStore).toBeInstanceOf(ClientStateStore);
		const snap = host.promptSnapshot();
		expect(typeof snap.full).toBe("string");
		expect(snap.full).toContain("# Core Engineering Principles");
		expect(typeof snap.texts).toBe("object");
		expect(typeof snap.toolsSchema).toBe("string");
		expect(host.getMcpServers?.()).toEqual({ servers: [], globalPath: "", projectPath: "" });
	});

	it("flushSnapshot 只转发注入的回调，没注入时是空实现", () => {
		let flushes = 0;
		const host = createCoreSettingsHost(options({ flushSnapshot: () => void (flushes += 1) }));
		expect(() => host.flushSnapshot()).not.toThrow();
		expect(flushes).toBe(1);
		expect(() => createCoreSettingsHost(options()).flushSnapshot()).not.toThrow();
		expect(flushes).toBe(1);
	});

	it("apply* / onX 空实现与 reloadSession 都不抛（否则 push() 会被连带炸掉）", async () => {
		const host = createCoreSettingsHost(options());
		const noops = [
			"applyRetryOverrides",
			"applyQueueModes",
			"applyCompactionOverrides",
			"applyCodemodeOverrides",
			"applySessionOverrides",
			"applyToolGating",
			"onGoalModeDisabled",
			"onSessionsFilterChanged",
		] as const;
		for (const name of noops) expect(() => host[name]?.()).not.toThrow();
		await expect(host.reloadSession()).resolves.toBeUndefined();
	});

	it("push() 发出一帧 settings_state，settings 含关键键", () => {
		const frame = createCoreSettingsAdapter(options());
		frame.push();
		const frames = settingsFrames();
		expect(frames).toHaveLength(1);
		const settings = frames[0];
		for (const key of [
			"promptMode",
			"customSystemPrompt",
			"promptTemplate",
			"promptOverrides",
			"promptDisabled",
			"effectiveSystemPrompt",
			"toolsSchema",
			"skills",
			"presets",
			"subagentTemplates",
			"steeringMode",
			"keepRecentMessages",
			"mcpServers",
		]) {
			expect(settings).toHaveProperty(key);
		}
		expect(settings.skills.map((skill) => skill.name)).toEqual(["demo"]);
		expect(settings.mcpServers).toEqual([]);
		expect(settings.subagentDefaultTemplates.length).toBeGreaterThan(0);
		// promptSnapshot 已接上（P1）：帧里如实带上有效系统提示词。
		expect(settings.effectiveSystemPrompt).toContain("# Core Engineering Principles");
		expect(typeof settings.toolsSchema).toBe("string");
	});

	it("重复 push() 不抛异常，每次都重算一帧", () => {
		const frame = createCoreSettingsAdapter(options());
		expect(() => {
			frame.push();
			frame.push();
		}).not.toThrow();
		expect(settingsFrames()).toHaveLength(2);
	});

	it("push() 读的是状态存储的当前值，不是构造时的快照", () => {
		store.saveSettings(CLIENT_ID, { promptMode: "replace", keepRecentMessages: 42 });
		const frame = createCoreSettingsAdapter(options());
		frame.push();
		expect(settingsFrames()[0].promptMode).toBe("replace");
		expect(settingsFrames()[0].keepRecentMessages).toBe(42);
	});

	it("isDisposed 为 true 时不出帧也不抛（与 SettingsService 的现状一致）", () => {
		const frame = createCoreSettingsAdapter(options({ isDisposed: () => true }));
		expect(() => frame.push()).not.toThrow();
		expect(emitted).toHaveLength(0);
	});

	/**
	 * 会话没开时**不发帧**（老实现那帧永远带会话：`ClientSession.create` 先建会话再推设置）：
	 * 半成品帧的 `visionModels` / `effectiveSystemPrompt` / `toolsSchema` 都是空值，客户端会把它当基线。
	 * 现场触发点：连接期 MCP 项目发布会早于首条会话的 `ensure()`（`refreshMcpProject → pushSettings`）。
	 * 正式那一帧由连接期 `pushConnectFrames` 发出，不会丢。
	 */
	it("getSession 抛错时不发半成品帧（不把空模型目录当基线），也不把异常传给调用方", () => {
		const frame = createCoreSettingsAdapter(
			options({
				getSession: () => {
					throw new Error("session boom");
				},
			}),
		);
		expect(() => frame.push()).not.toThrow();
		expect(settingsFrames()).toHaveLength(0);
	});

	it("通道关闭后不再出帧，重新打开后恢复", () => {
		const frame = createCoreSettingsAdapter(options());
		closed = true;
		expect(() => frame.push()).not.toThrow();
		expect(emitted).toHaveLength(0);
		closed = false;
		frame.push();
		expect(settingsFrames()).toHaveLength(1);
	});

	it("会话从无到有时：先不发，就绪后一帧完整", () => {
		let ready = false;
		const frame = createCoreSettingsAdapter(
			options({
				getSession: () => {
					if (!ready) throw new Error("settings session");
					return fakeSession();
				},
			}),
		);
		expect(() => frame.push()).not.toThrow();
		expect(emitted).toHaveLength(0);
		ready = true;
		frame.push();
		expect(settingsFrames()).toHaveLength(1);
	});

	it("SettingsService 由宿主构造：current 与状态存储一致", () => {
		const { service } = createCoreSettingsService(options());
		expect(service).toBeInstanceOf(SettingsService);
		expect(service.current.promptMode).toBe(store.getSettings(CLIENT_ID).promptMode);
	});

	it("适配器背后就是老叶子 SettingsService，模板存储走 dataDir 默认路径", () => {
		const frame = createCoreSettingsAdapter(options());
		frame.push();
		// 默认模板存储 = stateStore.dataDir/subagent-templates.json：帧里因此非空。
		expect(settingsFrames()[0].subagentTemplates.length).toBeGreaterThan(0);
	});

	it("settings_state.mcpServers 投影插件面的真清单（不再恒空）", () => {
		const cwd = join(dir, "work");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "mcp-fs"] } } }),
			"utf8",
		);
		const plugins = makePlugins(cwd);
		try {
			const frame = createCoreSettingsAdapter(options({ cwd }));
			frame.push();
			expect(settingsFrames()[0].mcpServers?.map((s) => `${s.scope}:${s.name}`)).toEqual(["project:fs"]);
		} finally {
			plugins.dispose?.();
		}
	});

	it("reloadSession 接的是插件面那一份实现（装完技能走同一条重载）", async () => {
		const reload = vi.fn(async () => {});
		const plugins = makePlugins(dir, { reloadSession: reload });
		try {
			const host = createCoreSettingsHost(options());
			await host.reloadSession();
			expect(reload).toHaveBeenCalledTimes(1);
			// 端口自己的技能安装路径用的是同一个函数：两条入口不能各接一套。
			await plugins.installSkill("demo-skill", "project", "# demo");
			expect(reload).toHaveBeenCalledTimes(2);
		} finally {
			plugins.dispose?.();
		}
	});

	it("插件面未接时 reloadSession 与 MCP 清单都给安全空值", async () => {
		const host = createCoreSettingsHost(options());
		await expect(host.reloadSession()).resolves.toBeUndefined();
		expect(host.getMcpServers?.()).toEqual({ servers: [], globalPath: "", projectPath: "" });
	});
});
