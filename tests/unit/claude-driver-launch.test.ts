import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

let workspace = "";
let agentDir = "";

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
	const driver = new ClaudeCodeDriver(workspace, { executablePath, agentDir });
	return { child, sink, driver };
}

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "pi-claude-ws-"));
	agentDir = mkdtempSync(join(tmpdir(), "pi-claude-agent-"));
	spawnMock.mockReset();
	launchMock.mockReset().mockReturnValue({ file: "shared-node", args: ["/cli path/claude.js", "--launcher-flag"] });
	probeMock.mockReset();
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

function userLine(input: string) {
	expect(input.endsWith("\n")).toBe(true);
	return JSON.parse(input);
}

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
			expect(launchMock).toHaveBeenCalledExactlyOnceWith("claude", { executablePath, cwd: workspace });
			const [file, args, options] = spawnMock.mock.calls[0];
			expect(file).toBe("shared-node");
			expect(args).toEqual([
				"/cli path/claude.js",
				"--launcher-flag",
				"-p",
				"--input-format",
				"stream-json",
				"--output-format",
				"stream-json",
				"--verbose",
				"--dangerously-skip-permissions",
				"--effort",
				"medium",
			]);
			expect(options.shell).toBeUndefined();
			expect(options.cwd).toBe(workspace);
			expect(options.detached).toBe(process.platform !== "win32");
			expect(userLine(input)).toEqual({
				type: "user",
				message: { role: "user", content: [{ type: "text", text: prompt }] },
			});
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

describe("Claude Code native input", () => {
	async function run(prompt: string, attachments?: any[]) {
		const { child, sink, driver } = setup();
		let input = "";
		child.stdin.on("data", (chunk) => {
			input += chunk.toString();
		});
		const done = driver.sendPrompt(prompt, attachments, sink);
		const args = spawnMock.mock.calls[0][1] as string[];
		const mcpIndex = args.indexOf("--mcp-config");
		const mcpFile = mcpIndex >= 0 ? args[mcpIndex + 1] : undefined;
		const mcp = mcpFile ? JSON.parse(readFileSync(mcpFile, "utf8")) : undefined;
		child.stdout.write(
			JSON.stringify({ type: "system", subtype: "init", session_id: "aaaaaaaa-0000-0000-0000-000000000001" }) + "\n",
		);
		child.stdout.write(JSON.stringify({ type: "result", result: "ok", usage: { input_tokens: 1 } }) + "\n");
		await new Promise((r) => setImmediate(r));
		child.emit("close", 0);
		await done;
		return { args, message: userLine(input).message, sink, driver, mcp, mcpFile };
	}

	it("sends inline images as native image blocks before the text", async () => {
		const png = Buffer.from("fake-png").toString("base64");
		const { message, sink } = await run("这张图是什么？", [
			{ path: "", name: "a.png", imageData: `data:image/png;base64,${png}` },
			{ path: "", name: "b.jpg", mimeType: "image/jpeg", imageData: png },
		]);
		expect(message.content).toEqual([
			{ type: "image", source: { type: "base64", media_type: "image/png", data: png } },
			{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: png } },
			{ type: "text", text: "这张图是什么？" },
		]);
		expect(sink.onError).not.toHaveBeenCalled();
	});

	it("points the CLI at uploads, file refs and full quotes instead of dropping them", async () => {
		const quote = "x".repeat(500);
		const { message } = await run("看看", [
			{ path: "", uploadPath: "/uploads/c1/123-report.pdf", name: "report.pdf" },
			{ path: "src/a.ts", mode: "lines", lines: { start: 3, end: 9 } },
			{ path: "", mode: "quote", quote: { text: quote, messageId: "m", role: "assistant" } },
		]);
		const text = message.content.at(-1).text as string;
		expect(text).toContain('Attached file: "/uploads/c1/123-report.pdf" (report.pdf)');
		expect(text).toContain('File reference: "src/a.ts" (lines 3-9)');
		expect(text).toContain(quote);
		expect(text.endsWith("看看")).toBe(true);
	});

	it("reports the real CLI session id and never resumes a placeholder", async () => {
		const { child, sink, driver } = setup();
		expect(await driver.createSession()).toBe("");
		const done = driver.sendPrompt("hi", undefined, sink as any);
		expect(spawnMock.mock.calls[0][1]).not.toContain("--resume");
		const sid = "aaaaaaaa-0000-0000-0000-000000000002";
		child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sid }) + "\n");
		await new Promise((r) => setImmediate(r));
		child.emit("close", 0);
		await done;
		expect(driver.getActiveSessionId()).toBe(sid);
	});

	it("omits --model for the CLI default and passes aliases through", async () => {
		const first = await run("hi");
		expect(first.args).not.toContain("--model");
		spawnMock.mockReset();
		const { child, sink, driver } = setup();
		await driver.setModel("claude-code/sonnet");
		const done = driver.sendPrompt("hi", undefined, sink);
		expect(spawnMock.mock.calls[0][1]).toEqual(expect.arrayContaining(["--model", "sonnet"]));
		child.emit("close", 0);
		await done;
		await driver.setModel("claude-code/claude-3-7-sonnet-20250219");
		expect((driver as any).currentModel).toBe("claude-code/default");
	});

	it("loads enabled pi MCP servers via a private --mcp-config file removed after the turn", async () => {
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					fs: { command: "npx", args: ["-y", "srv"], env: { TOKEN: "t" }, cwd: "/x", description: "d", timeout: 9 },
					web: { type: "streamable-http", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer k" } },
					off: { command: "nope", enabled: false },
				},
			}),
		);
		mkdirSync(join(workspace, ".pi"));
		writeFileSync(
			join(workspace, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { fs: { command: "node", args: ["local.js"] } } }),
		);
		const { mcp, mcpFile } = await run("hi");
		expect(mcp).toEqual({
			mcpServers: {
				fs: { type: "stdio", command: "node", args: ["local.js"] },
				web: { type: "http", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer k" } },
			},
		});
		expect(existsSync(mcpFile!)).toBe(false);
	});

	it("passes no --mcp-config when pi has no MCP servers", async () => {
		const { args } = await run("hi");
		expect(args).not.toContain("--mcp-config");
	});
});
