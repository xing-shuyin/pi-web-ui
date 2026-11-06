import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { spawnMock, killMock, launchMock, probeMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	killMock: vi.fn(async () => {}),
	launchMock: vi.fn(),
	probeMock: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: spawnMock, execFile: vi.fn() }));
vi.mock("../../server/process-utils.js", () => ({ killPidTree: killMock }));
vi.mock("../../server/engine-cli.js", () => ({
	resolveEngineCliLaunch: launchMock,
	probeEngineCliVersion: probeMock,
}));
import { CodexDriver, probeCodex } from "../../server/universal/drivers/codex.js";
import type { AgentEventSink } from "../../server/universal/driver-base.js";
function setup() {
	const child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		pid: 123,
		kill: vi.fn(),
	});
	spawnMock.mockReturnValue(child);
	const driver = new CodexDriver(process.cwd(), { executablePath: "codex-test" });
	const sink: AgentEventSink = {
		onSessionStarted: vi.fn(),
		onTextDelta: vi.fn(),
		onThinkingDelta: vi.fn(),
		onToolStart: vi.fn(),
		onToolEnd: vi.fn(),
		onTurnComplete: vi.fn(),
		onError: vi.fn(),
	};
	const emit = (event: unknown) => child.stdout.write(JSON.stringify(event) + "\n");
	return { child, driver, sink, emit };
}
beforeEach(() => {
	launchMock.mockReset().mockReturnValue({ file: "shared-node", args: ["/cli path/codex.js", "--launcher-flag"] });
	probeMock.mockReset();
});
afterEach(() => vi.clearAllMocks());
describe("Codex CLI driver", () => {
	it.each([undefined, "/custom path/codex.cmd"])(
		"delegates launch resolution with explicit path %s",
		async (executablePath) => {
			const { child, sink, emit } = setup();
			const driver = new CodexDriver(process.cwd(), { executablePath });
			expect(launchMock).not.toHaveBeenCalled();
			const done = driver.sendPrompt("hello", undefined, sink);
			expect(launchMock).toHaveBeenCalledExactlyOnceWith("codex", { executablePath, cwd: process.cwd() });
			const [file, args, options] = spawnMock.mock.calls[0];
			expect(file).toBe("shared-node");
			expect(args.slice(0, 4)).toEqual(["/cli path/codex.js", "--launcher-flag", "--ask-for-approval", "never"]);
			expect(options.shell).toBeUndefined();
			expect(options.env.NO_COLOR).toBe("1");
			emit({ type: "turn.completed" });
			child.emit("close", 0);
			await done;
		},
	);
	it("defers resolution errors until sendPrompt and permits a retry", async () => {
		const { driver, child, sink, emit } = setup();
		launchMock.mockImplementationOnce(() => {
			throw new Error("Codex CLI executable not found");
		});
		await expect(driver.sendPrompt("hello", undefined, sink)).rejects.toThrow("Codex CLI executable not found");
		expect(spawnMock).not.toHaveBeenCalled();
		const done = driver.sendPrompt("retry", undefined, sink);
		emit({ type: "turn.completed" });
		child.emit("close", 0);
		await done;
		expect(sink.onTurnComplete).toHaveBeenCalledOnce();
	});
	it.each(["codex 1.2.3", "codex-cli 1.2.3"])(
		"uses the common version probe and preserves version formatting for %s",
		async (version) => {
			probeMock.mockResolvedValue({ available: true, version });
			await expect(probeCodex("/custom path/codex.cmd")).resolves.toEqual({ available: true, version: "1.2.3" });
			expect(probeMock).toHaveBeenCalledExactlyOnceWith("codex", "/custom path/codex.cmd");
		},
	);
	it("returns common probe failures without launching a process", async () => {
		probeMock.mockResolvedValue({ available: false, error: "not installed" });
		await expect(probeCodex()).resolves.toEqual({ available: false, error: "not installed" });
		expect(probeMock).toHaveBeenCalledExactlyOnceWith("codex", undefined);
		expect(spawnMock).not.toHaveBeenCalled();
	});
	it("maps JSONL output, tools, thread allocation and cached usage", async () => {
		const { child, driver, sink, emit } = setup();
		await driver.createSession();
		const done = driver.sendPrompt("hello", undefined, sink);
		emit({ type: "thread.started", thread_id: "thread-1" });
		emit({ type: "item.completed", item: { id: "r", type: "reasoning", text: "thinking" } });
		emit({ type: "item.updated", item: { id: "a", type: "agent_message", text: "hel" } });
		emit({ type: "item.completed", item: { id: "a", type: "agent_message", text: "hello" } });
		emit({ type: "item.started", item: { id: "c", type: "command_execution", command: "pwd" } });
		emit({
			type: "item.completed",
			item: { id: "c", type: "command_execution", command: "pwd", aggregated_output: "workspace", exit_code: 0 },
		});
		emit({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } });
		child.emit("close", 0);
		await done;
		expect(sink.onSessionStarted).toHaveBeenCalledWith("thread-1");
		expect(sink.onTextDelta).toHaveBeenNthCalledWith(1, "hel");
		expect(sink.onTextDelta).toHaveBeenNthCalledWith(2, "lo");
		expect(sink.onThinkingDelta).toHaveBeenCalledWith("thinking");
		expect(sink.onToolStart).toHaveBeenCalledOnce();
		expect(sink.onToolEnd).toHaveBeenCalledWith("c", { output: "workspace" });
		expect(sink.onTurnComplete).toHaveBeenCalledWith({
			usage: { inputTokens: 60, cacheReadTokens: 40, outputTokens: 10 },
		});
		expect(driver.getActiveSessionId()).toBe("thread-1");
		expect(spawnMock.mock.calls[0][1]).toEqual(
			expect.arrayContaining(["--sandbox", "workspace-write", "--ask-for-approval", "never"]),
		);
	});
	it("resumes the allocated thread and passes the chosen model and effort", async () => {
		const { driver, child, sink, emit } = setup();
		await driver.resumeSession("thread-1");
		await driver.setModel("codex/custom-model");
		driver.setThinkingLevel("high");
		const done = driver.sendPrompt("continue", undefined, sink);
		const args = spawnMock.mock.calls[0][1];
		expect(args).toEqual(
			expect.arrayContaining(["resume", "thread-1", "--model", "custom-model", 'model_reasoning_effort="high"']),
		);
		emit({ type: "turn.completed" });
		child.emit("close", 0);
		await done;
	});
	it("reports failed turns and premature exits", async () => {
		const { driver, child, sink, emit } = setup();
		const done = driver.sendPrompt("fail", undefined, sink);
		emit({ type: "turn.failed", error: { message: "authentication required" } });
		child.emit("close", 1);
		await done;
		expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "authentication required" }));
		expect(sink.onTurnComplete).not.toHaveBeenCalled();
	});
	it("cancels only its process tree and permits the next turn after close", async () => {
		const { driver, child, sink } = setup();
		const done = driver.sendPrompt("wait", undefined, sink);
		const stop = driver.abort();
		child.emit("close", null);
		await stop;
		await done;
		expect(killMock).toHaveBeenCalledWith(123);
		expect(sink.onTurnComplete).not.toHaveBeenCalled();
		expect(sink.onError).not.toHaveBeenCalled();
		await driver.dispose();
		await expect(driver.sendPrompt("later", undefined, sink)).rejects.toThrow("disposed");
	});
});
