import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { DEVICE_COLLAB_TOOL_NAME } from "../../server/tool-manager.js";
import { deviceTaskToolFace } from "../../server/device-center/bot-tool-face.js";
import { registerBotExecution } from "../../server/device-center/bot-execution.js";
import type { LocalBot } from "../../server/device-center/bots.js";

/** 设备任务执行的工具面：老实现 `agent-service.ts` 的 `botExecution` 那一支。 */
const releases: (() => void)[] = [];
afterEach(() => {
	for (const release of releases.splice(0)) release();
});

function bot(overrides: Partial<LocalBot> = {}): LocalBot {
	return {
		id: "project-bot",
		name: "Project bot",
		description: "fixture",
		systemPrompt: "system",
		cwd: resolve(tmpdir()),
		revision: 1,
		enabled: true,
		tools: ["read", "bash", DEVICE_COLLAB_TOOL_NAME],
		skills: [],
		mcpServers: [],
		...overrides,
	};
}

function binding(overrides: Partial<LocalBot> = {}) {
	const execution = registerBotExecution(bot(overrides), undefined, {
		executionCwd: resolve(tmpdir()),
		executionMode: "chat",
	});
	releases.push(execution.release);
	return execution;
}

describe("device-center · bot-tool-face", () => {
	it("普通 UI 客户端（不是设备任务）没有工具面", () => {
		expect(deviceTaskToolFace({ clientId: "ui-3f2a" })).toBeUndefined();
	});

	it("未注册的 device-task 客户端（已撤销）也返回 undefined，不抛", () => {
		expect(deviceTaskToolFace({ clientId: "device-task-0b9c1d0e-0000-4000-8000-000000000000" })).toBeUndefined();
	});

	it("设备任务执行交出白名单与专属工具 device_collab", () => {
		const execution = binding();
		const face = deviceTaskToolFace({ clientId: execution.clientId });
		expect(face).toBeDefined();
		expect(face!.allows("read")).toBe(true);
		expect(face!.allows("bash")).toBe(true);
		expect(face!.allows(DEVICE_COLLAB_TOOL_NAME)).toBe(true);
		// Bot 没授权的工具不在白名单里（老实现同口径：白名单是最终口径）。
		expect(face!.allows("edit")).toBe(false);
		expect(face!.allows("write")).toBe(false);
		const names = face!.tools().map((tool) => (tool as { name?: string }).name);
		expect(names).toEqual([DEVICE_COLLAB_TOOL_NAME]);
	});

	it("衰减过的工具即便在 Bot 工具表里也不放行", () => {
		const execution = binding({ tools: ["read", "bash", DEVICE_COLLAB_TOOL_NAME] });
		// 重新注册一次带衰减的执行，证明端口转调的是 capability 的判定而不是自己另写一套。
		const attenuated = registerBotExecution(bot({ tools: ["read", "bash", DEVICE_COLLAB_TOOL_NAME] }), undefined, {
			executionCwd: resolve(tmpdir()),
			executionMode: "chat",
			attenuatedTools: ["bash"],
			sourceBotId: "low-privilege-bot",
		});
		releases.push(attenuated.release);
		const face = deviceTaskToolFace({ clientId: attenuated.clientId });
		expect(face!.allows("bash")).toBe(false);
		expect(face!.allows("read")).toBe(true);
		expect(deviceTaskToolFace({ clientId: execution.clientId })!.allows("bash")).toBe(true);
	});

	it("能力撤销之后一律拒绝（fail-closed，不抛给门禁）", () => {
		const execution = binding();
		const face = deviceTaskToolFace({ clientId: execution.clientId })!;
		expect(face.allows("read")).toBe(true);
		execution.release();
		const revoked = deviceTaskToolFace({ clientId: execution.clientId });
		expect(revoked).toBeUndefined();
		expect(() => face.allows("read")).not.toThrow();
		expect(face.allows("read")).toBe(false);
	});
});
