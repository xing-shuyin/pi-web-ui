import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, launchMock, probeMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	launchMock: vi.fn(),
	probeMock: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: spawnMock,
}));
vi.mock("../../server/engine-cli.js", () => ({
	resolveEngineCliLaunch: launchMock,
	probeEngineCliVersion: probeMock,
}));
import { ClaudeCodeDriver, probeClaudeCode } from "../../server/universal/drivers/claude-code.js";

function setup(executablePath?: string) {
	const child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
	});
	spawnMock.mockReturnValue(child);
	const sink = {
		onTextDelta: vi.fn(),
		onThinkingDelta: vi.fn(),
		onToolStart: vi.fn(),
		onToolEnd: vi.fn(),
		onTurnComplete: vi.fn(),
		onError: vi.fn(),
	};
	const driver = new ClaudeCodeDriver(process.cwd(), { executablePath });
	return { child, sink, driver };
}

beforeEach(() => {
	spawnMock.mockReset();
	launchMock.mockReset().mockReturnValue({ file: "shared-node", args: ["/cli path/claude.js", "--launcher-flag"] });
	probeMock.mockReset();
});

describe("Claude Code CLI launch", () => {
	it.each([undefined, "/custom path/claude.cmd"])(
		"uses the shared launch without a shell for explicit path %s",
		async (executablePath) => {
			const { child, sink, driver } = setup(executablePath);
			expect(launchMock).not.toHaveBeenCalled();
			let input = "";
			child.stdin.on("data", (chunk) => {
				input += chunk.toString();
			});
			const prompt = 'first line\n"quoted" & $(literal)';
			const done = driver.sendPrompt(prompt, undefined, sink);
			expect(launchMock).toHaveBeenCalledExactlyOnceWith("claude", { executablePath, cwd: process.cwd() });
			const [file, args, options] = spawnMock.mock.calls[0];
			expect(file).toBe("shared-node");
			expect(args).toEqual([
				"/cli path/claude.js",
				"--launcher-flag",
				"-p",
				"--output-format",
				"stream-json",
				"--verbose",
				"--dangerously-skip-permissions",
				"--model",
				"claude-3-7-sonnet-20250219",
				"--effort",
				"medium",
			]);
			expect(options.shell).toBeUndefined();
			expect(options.cwd).toBe(process.cwd());
			expect(options.detached).toBe(process.platform !== "win32");
			expect(input).toBe(prompt);
			child.emit("close", 0);
			await done;
			expect(sink.onError).not.toHaveBeenCalled();
			expect(sink.onTurnComplete).toHaveBeenCalledOnce();
		},
	);

	it("reports resolution errors through the existing sendPrompt error path and allows retry", async () => {
		launchMock.mockImplementationOnce(() => {
			throw new Error("Claude CLI executable not found");
		});
		const { child, sink, driver } = setup();
		expect(launchMock).not.toHaveBeenCalled();
		await driver.sendPrompt("hello", undefined, sink);
		expect(spawnMock).not.toHaveBeenCalled();
		expect(sink.onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Claude CLI executable not found"));
		const done = driver.sendPrompt("retry", undefined, sink);
		child.emit("close", 0);
		await done;
		expect(sink.onTurnComplete).toHaveBeenCalledOnce();
	});

	it.each([undefined, "/custom path/claude.cmd"])(
		"maps the shared version probe to installed with explicit path %s",
		async (executablePath) => {
			probeMock.mockResolvedValue({ available: true, version: "2.0.0 (Claude Code)" });
			await expect(probeClaudeCode(executablePath)).resolves.toEqual({
				installed: true,
				version: "2.0.0 (Claude Code)",
			});
			expect(probeMock).toHaveBeenCalledExactlyOnceWith("claude", executablePath);
			expect(spawnMock).not.toHaveBeenCalled();
		},
	);

	it("maps common probe failures without losing their error", async () => {
		probeMock.mockResolvedValue({ available: false, error: "not installed" });
		await expect(probeClaudeCode()).resolves.toEqual({ installed: false, error: "not installed" });
	});
});
