import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DeviceTaskState } from "../../server/protocol.js";
import { createLocalBotRegistry } from "../../server/device-center/bots.js";
import { createDeviceRuntime } from "../../server/device-center/runtime.js";
import { getBotExecutionInstructions } from "../../server/device-center/execution-instructions.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function snapshot(taskId: string, revision = 1): DeviceTaskState {
	return {
		revision,
		objective: "Keep the original objective",
		currentTaskId: taskId,
		phase: "queued",
		decisions: [],
		artifacts: [],
	};
}

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "device-task-state-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const cwd = join(dir, "workspace");
	await mkdir(cwd);
	const dataDir = join(dir, "data");
	const bots = await createLocalBotRegistry(dataDir);
	const bot = await bots.upsert({
		name: "Worker",
		description: "",
		systemPrompt: "",
		cwd,
		tools: ["device_collab"],
		skills: [],
		mcpServers: [],
		enabled: true,
	});
	return {
		cwd,
		path: join(dir, "transcript.jsonl"),
		options: {
			config: { hubUrl: "http://127.0.0.1:8999", deviceId: "device", credential: "secret", allowExecution: true },
			localOrigin: "http://127.0.0.1:8989",
			dataDir,
			bots,
		},
		task: (id: string) => ({
			id,
			attemptId: `attempt-${id}`,
			botId: bot.id,
			botRevision: bot.revision,
			deviceId: "device",
			roomId: "room",
			text: `Current request ${id}`,
			leaseToken: "test-lease-token",
		}),
	};
}

describe("device task state context", () => {
	it("binds the delivery snapshot only to the executing session and omits absent state", async () => {
		const f = await fixture();
		const state = snapshot("first");
		let runtime!: ReturnType<typeof createDeviceRuntime>;
		runtime = createDeviceRuntime({
			...f.options,
			executorFactory(options) {
				return {
					async run(task) {
						options.onSession?.(task.id, "bound-session");
						const context = { cwd: f.cwd, sessionId: "bound-session" };
						const result = await runtime.collabService.execute("current_task", {}, undefined, context);
						expect(result).toMatchObject({ taskId: task.id });
						if (task.taskState) {
							expect(result).toHaveProperty("taskState", state);
							expect((result as { taskState: DeviceTaskState }).taskState).not.toBe(state);
						} else expect(result).not.toHaveProperty("taskState");
						for (const wrong of [
							{ cwd: f.cwd, sessionId: "other" },
							{ cwd: join(f.cwd, "other"), sessionId: "bound-session" },
						]) {
							await expect(runtime.collabService.execute("current_task", {}, undefined, wrong)).rejects.toThrow();
						}
						expect(task.text).toBe(`Current request ${task.id}`);
						return "done";
					},
					close() {},
				};
			},
		});
		cleanups.push(() => runtime.close());
		await runtime.onTask({ ...f.task("first"), taskState: state });
		await expect(
			runtime.collabService.execute("current_task", {}, undefined, { cwd: f.cwd, sessionId: "bound-session" }),
		).rejects.toThrow();
		await runtime.onTask(f.task("legacy"));
	});

	it("uses the latest delivered snapshot when continuing the same persistent conversation", async () => {
		const f = await fixture();
		const conversationId = "11111111-1111-4111-8111-111111111111";
		const observed: unknown[] = [];
		let runtime!: ReturnType<typeof createDeviceRuntime>;
		runtime = createDeviceRuntime({
			...f.options,
			executorFactory(options) {
				return {
					async run(task) {
						options.onSession?.(task.id, "same-session");
						options.onSessionPath?.(task.id, f.path);
						await writeFile(f.path, "transcript");
						const result = await runtime.collabService.execute("current_task", {}, undefined, {
							cwd: f.cwd,
							sessionId: "same-session",
						});
						observed.push((result as { taskState?: DeviceTaskState }).taskState);
						expect(options.resumePath).toBe(task.resume ? f.path : undefined);
						expect(task.text).toBe(`Current request ${task.id}`);
						return "done";
					},
					close() {},
				};
			},
		});
		cleanups.push(() => runtime.close());
		const first = snapshot("first");
		const latest = { ...snapshot("follow-up", 4), phase: "waiting" as const };
		await runtime.onTask({ ...f.task("first"), conversationId, taskState: first });
		await runtime.onTask({ ...f.task("follow-up"), conversationId, resume: true, taskState: latest });
		expect(observed).toEqual([first, latest]);
	});

	it("keeps snapshot authority and Bot-reported constraints explicit in both roles", () => {
		for (const primary of [false, true]) {
			const instructions = getBotExecutionInstructions(primary);
			expect(instructions).toContain("snapshot observed at delivery");
			expect(instructions).toContain("queued before execution starts");
			expect(instructions).toContain("task_state for authoritative current state");
			expect(instructions).toContain("task_update");
			expect(instructions).toContain("must never be presented as human-approved");
			expect(instructions).toContain("preserve and follow the current task text");
		}
	});
});
