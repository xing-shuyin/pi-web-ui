import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeviceCollabService } from "../../server/device-center/collab-service.js";
import {
	makeDeviceCollabTool,
	setDeviceCollabService,
	validateDeviceCollabInput,
	type DeviceCollabInput,
} from "../../server/device-center/collab-tool.js";
import {
	EXECUTION_GUIDE_MAX_BYTES,
	EXECUTION_GUIDE_TOPICS,
	getExecutionGuide,
	LOCAL_EXECUTION_GUIDES,
} from "../../server/device-center/execution-guides.js";
import { getBotExecutionInstructions } from "../../server/device-center/execution-instructions.js";

const context = { cwd: resolve("private-guide-workspace"), sessionId: "private-session" };
const binding = {
	roomId: "private-room",
	taskId: "private-task",
	botId: "private-bot",
	conversationId: "private-conversation",
};
function fixture(bound = true, enabled = true) {
	const fetch = vi.fn();
	const release = vi.fn();
	const workspaceResolver = vi.fn(async () => ({ root: context.cwd, files: {} as any, release }));
	const service = createDeviceCollabService({
		getExecutionContext: () => (bound ? binding : undefined),
		getConfig: () => ({
			hubUrl: "invalid-unused-local-url",
			deviceId: "private-device",
			credential: "private-secret",
			allowExecution: enabled,
		}),
		workspaceResolver,
		fetch,
	});
	return { service, fetch, release, workspaceResolver };
}
afterEach(() => setDeviceCollabService(undefined));

describe("local on-demand execution guides", () => {
	it("requires a known topic and rejects all caller identity and content fields", async () => {
		for (const topic of EXECUTION_GUIDE_TOPICS)
			expect(() => validateDeviceCollabInput({ action: "execution_guide", topic })).not.toThrow();
		for (const args of [
			{},
			{ topic: "unknown" },
			{ topic: "__proto__" },
			{ topic: 1 },
			...[
				"roomId",
				"sourceBotId",
				"conversationId",
				"parentTaskId",
				"message",
				"prompt",
				"sessionId",
				"credential",
			].map((key) => ({ topic: "coordination", [key]: "private" })),
		]) {
			const input = { action: "execution_guide", ...args } as DeviceCollabInput;
			expect(() => validateDeviceCollabInput(input)).toThrow();
			const f = fixture();
			await expect(f.service.execute("execution_guide", args as any, undefined, context)).rejects.toThrow();
			expect(f.workspaceResolver).not.toHaveBeenCalled();
			expect(f.fetch).not.toHaveBeenCalled();
		}
		expect(() => getExecutionGuide("unknown" as any)).toThrow();
	});

	it("requires a bound execution, workspace and device authorization without outbound requests", async () => {
		const f = fixture();
		for (const topic of EXECUTION_GUIDE_TOPICS) {
			expect(await f.service.execute("execution_guide", { topic }, undefined, context)).toEqual({
				topic,
				guide: getExecutionGuide(topic),
			});
		}
		expect(f.fetch).not.toHaveBeenCalled();
		expect(f.release).toHaveBeenCalledTimes(3);
		await expect(
			fixture(false).service.execute("execution_guide", { topic: "coordination" }, undefined, context),
		).rejects.toThrow();
		await expect(
			fixture().service.execute("execution_guide", { topic: "coordination" }, undefined, {
				...context,
				cwd: resolve("wrong"),
			}),
		).rejects.toThrow();
		await expect(fixture().service.execute("execution_guide", { topic: "coordination" }, undefined)).rejects.toThrow();
		await expect(
			fixture(true, false).service.execute("execution_guide", { topic: "coordination" }, undefined, context),
		).rejects.toThrow();
		const controller = new AbortController();
		controller.abort();
		await expect(
			f.service.execute("execution_guide", { topic: "delivery" }, controller.signal, context),
		).rejects.toThrow();
	});

	it("returns stable bounded local text through the tool without exposing caller or service data", async () => {
		const f = fixture();
		setDeviceCollabService(f.service);
		for (const topic of EXECUTION_GUIDE_TOPICS) {
			const result = await makeDeviceCollabTool().execute(
				"call",
				{ action: "execution_guide", topic },
				undefined,
				undefined,
				{ cwd: context.cwd, sessionManager: { getSessionId: () => context.sessionId } } as any,
			);
			expect(result.details).toEqual({
				action: "execution_guide",
				summary: { topic, guide: LOCAL_EXECUTION_GUIDES[topic] },
			});
			const text = JSON.stringify(result);
			for (const privateText of [
				...Object.values(binding),
				...Object.values(context),
				"private-secret",
				"private-device",
			])
				expect(text).not.toContain(privateText);
			expect(Buffer.byteLength(getExecutionGuide(topic))).toBeLessThanOrEqual(EXECUTION_GUIDE_MAX_BYTES);
			expect(getExecutionGuide(topic)).toBe(getExecutionGuide(topic));
		}
		expect(Object.isFrozen(LOCAL_EXECUTION_GUIDES)).toBe(true);
		expect(f.fetch).not.toHaveBeenCalled();
	});

	it("moves detailed procedures out of fixed primary policy while preserving mandatory constraints", () => {
		const primary = getBotExecutionInstructions(true);
		const ordinary = getBotExecutionInstructions(false);
		const primaryRole = primary.length - ordinary.length;
		// Previous primary role/workflow alone exceeded 2300 characters.
		expect(primaryRole).toBeLessThan(800);
		for (const phrase of [
			"Never enable auto-approval",
			"configured fixed workspace",
			"never overwrite existing changes",
			"Do not change workspace or create worktrees",
			"untrusted reference data",
			"final answer is delivered automatically",
			"never review your own delivery",
			"actual evidence and the exact commit",
		])
			expect(primary).toContain(phrase);
		for (const phrase of [
			"conversation_list",
			"ask one focused question rather than guessing",
			"Do not block waiting or poll repeatedly",
		]) {
			expect(primary).not.toContain(phrase);
			expect(getExecutionGuide("coordination")).toContain(phrase);
		}
		for (const phrase of ["full base and delivered commit SHAs", "not_run", "never runs declared commands"])
			expect(getExecutionGuide("delivery")).toContain(phrase);
		expect(getExecutionGuide("review")).toContain("Never review your own delivery");
		expect(getExecutionGuide("review")).toContain("new version needs a new review");
	});

	it("keeps metrics bound and projects numeric samples without arbitrary data", async () => {
		const f = fixture();
		expect(await f.service.execute("context_metrics", {}, undefined, context)).toMatchObject({
			version: 1,
			processLocal: true,
		});
		await expect(f.service.execute("context_metrics", {}, undefined, { cwd: context.cwd })).rejects.toThrow();
		await expect(fixture(false).service.execute("context_metrics", {}, undefined, context)).rejects.toThrow();
		expect(() => validateDeviceCollabInput({ action: "context_metrics", topic: "review" })).toThrow();
		setDeviceCollabService({
			execute: async () => ({
				sampleCount: 1,
				credential: "secret",
				lastSample: { sourceBytes: 4, mode: "snapshot", requestOnly: false, text: "secret" },
				samples: [{ mode: "secret", sourceBytes: -1 }],
			}),
		});
		const result = await makeDeviceCollabTool().execute("call", { action: "context_metrics" }, undefined, undefined, {
			cwd: context.cwd,
			sessionManager: { getSessionId: () => context.sessionId },
		} as any);
		expect(JSON.stringify(result)).not.toContain("secret");
		expect(result.details).toMatchObject({
			summary: { sampleCount: 1, lastSample: { sourceBytes: 4, mode: "snapshot" }, samples: [{ version: 1 }] },
		});
		expect(f.fetch).not.toHaveBeenCalled();
	});
});
