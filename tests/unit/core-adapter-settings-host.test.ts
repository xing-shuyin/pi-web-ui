import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";
import type { ServerMessage, UiSettingsState } from "../../server/protocol.js";
import {
	createSettingsHost,
	createSettingsHost as createSettingsHostFromBarrel,
	type SettingsHostInput,
} from "../../packages/keel/src/adapters/settings/index.js";
import {
	createSettingsPusher,
	createSettingsPusher as createSettingsPusherFromBarrel,
} from "../../packages/keel/src/domains/settings/index.js";
import type { TransportPort } from "../../packages/keel/src/contracts/ports.js";

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

describe("设置适配器（adapters/settings + domains/settings/push）", () => {
	let dir: string;
	let store: ClientStateStore;
	let emitted: ServerMessage[];
	let closed: boolean;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "core-adapter-settings-host-"));
		store = new ClientStateStore(join(dir, "client-state.json"));
		emitted = [];
		closed = false;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const emitFrame = (msg: ServerMessage): void => void emitted.push(msg);

	function transport(): TransportPort {
		return { send: emitFrame, isClosed: () => closed };
	}

	function makeHost(overrides: Partial<SettingsHostInput> = {}): SettingsHost {
		return createSettingsHost({
			clientId: CLIENT_ID,
			stateStore: store,
			emit: emitFrame,
			cwd: dir,
			agentDir: join(dir, "agent"),
			isDisposed: false,
			isStreaming: false,
			getSession: fakeSession,
			...overrides,
		});
	}

	function settingsFrames(): UiSettingsState[] {
		return emitted.flatMap((msg) => (msg.type === "settings_state" ? [msg.settings] : []));
	}

	it("host 如实投影输入的 clientId / stateStore / emit / cwd / agentDir", () => {
		const host = makeHost();
		expect(host.clientId).toBe(CLIENT_ID);
		expect(host.stateStore).toBe(store);
		expect(host.emit).toBe(emitFrame);
		expect(host.cwd()).toBe(dir);
		expect(host.agentDir()).toBe(join(dir, "agent"));
	});

	it("host 的 isDisposed / isStreaming / getSession 回注入值，不是写死的常量", () => {
		const session = fakeSession();
		const host = makeHost({ isDisposed: true, isStreaming: true, getSession: () => session });
		expect(host.isDisposed()).toBe(true);
		expect(host.isStreaming()).toBe(true);
		expect(host.getSession()).toBe(session);
	});

	it("host 的每个必需成员都被赋值且类型正确", () => {
		const host = makeHost();
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
		expect(host.promptSnapshot()).toEqual({ full: "", texts: {}, toolsSchema: "" });
		expect(host.getMcpServers?.()).toEqual({ servers: [], globalPath: "", projectPath: "" });
	});

	it("flushSnapshot 只转发注入的回调，没注入时是空实现", () => {
		let flushes = 0;
		const host = makeHost({ flushSnapshot: () => void (flushes += 1) });
		expect(() => host.flushSnapshot()).not.toThrow();
		expect(flushes).toBe(1);
		expect(() => makeHost().flushSnapshot()).not.toThrow();
		expect(flushes).toBe(1);
	});

	it("apply* / onX 空实现与 reloadSession 都不抛（否则 push() 会被连带炸掉）", async () => {
		const host = makeHost();
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
		const pusher = createSettingsPusher({ host: makeHost(), transport: transport() });
		pusher.push();
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
		// 空实现只能给空值：提示词快照域还没接（W5），帧里不许出现编造的系统提示词。
		expect(settings.effectiveSystemPrompt).toBe("");
		expect(settings.toolsSchema).toBe("");
	});

	it("重复 push() 不抛异常，每次都重算一帧", () => {
		const pusher = createSettingsPusher({ host: makeHost(), transport: transport() });
		expect(() => {
			pusher.push();
			pusher.push();
		}).not.toThrow();
		expect(settingsFrames()).toHaveLength(2);
	});

	it("push() 读的是状态存储的当前值，不是构造时的快照", () => {
		store.saveSettings(CLIENT_ID, { promptMode: "replace", keepRecentMessages: 42 });
		const pusher = createSettingsPusher({ host: makeHost(), transport: transport() });
		pusher.push();
		expect(settingsFrames()[0].promptMode).toBe("replace");
		expect(settingsFrames()[0].keepRecentMessages).toBe(42);
	});

	it("isDisposed 为 true 时不出帧也不抛（与 SettingsService 的现状一致）", () => {
		const pusher = createSettingsPusher({ host: makeHost({ isDisposed: true }), transport: transport() });
		expect(() => pusher.push()).not.toThrow();
		expect(() => pusher.service.push()).not.toThrow();
		expect(emitted).toHaveLength(0);
	});

	it("getSession 抛错时 push() 不把异常传给调用方（SettingsService 内部已 try/catch）", () => {
		const pusher = createSettingsPusher({
			host: makeHost({
				getSession: () => {
					throw new Error("session boom");
				},
			}),
			transport: transport(),
		});
		expect(() => pusher.push()).not.toThrow();
		const frames = settingsFrames();
		expect(frames).toHaveLength(1);
		expect(frames[0].skills).toEqual([]);
		expect(frames[0].visionModels).toEqual([]);
	});

	it("通道关闭后不再出帧，重新打开后恢复", () => {
		const pusher = createSettingsPusher({ host: makeHost(), transport: transport() });
		closed = true;
		expect(() => pusher.push()).not.toThrow();
		expect(emitted).toHaveLength(0);
		closed = false;
		pusher.push();
		expect(settingsFrames()).toHaveLength(1);
	});

	it("pusher 暴露的就是老叶子 SettingsService，模板存储走 dataDir 默认路径", () => {
		const pusher = createSettingsPusher({ host: makeHost(), transport: transport() });
		expect(pusher.service).toBeInstanceOf(SettingsService);
		expect(pusher.service.current).toMatchObject({ promptMode: store.getSettings(CLIENT_ID).promptMode });
		// 默认模板存储 = stateStore.dataDir/subagent-templates.json：list() 能读到内置模板，帧里因此非空。
		pusher.push();
		expect(settingsFrames()[0].subagentTemplates.length).toBeGreaterThan(0);
	});

	it("两个目录的 barrel 导出的是同一份实现", () => {
		expect(createSettingsHostFromBarrel).toBe(createSettingsHost);
		expect(createSettingsPusherFromBarrel).toBe(createSettingsPusher);
	});
});
