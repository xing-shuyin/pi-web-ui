import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { makeKillableBashTool } from "../../server/bash-tool.js";

const dirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/** 造一个临时 agent 目录，settings.json 里写给定的 shellPath —— 与 pi CLI 读的是同一份配置。 */
function agentDirWithShellPath(shellPath: string): string {
	const agentDir = tempDir("bash-shell-agent-");
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath }, null, 2));
	return agentDir;
}

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function runBash(cwd: string, command: string): Promise<{ content?: Array<{ type: string; text?: string }> }> {
	const tool = makeKillableBashTool(cwd, new Set<AbortController>(), () => "en");
	return tool.execute("shell-path", { command, timeout: 30 } as never, undefined, undefined, {
		sessionManager: {
			getSessionId: () => "bash-shell-path",
			getSessionDir: () => cwd,
			getSessionFile: () => join(cwd, "session.jsonl"),
		},
		cwd,
	} as never) as Promise<{ content?: Array<{ type: string; text?: string }> }>;
}

describe("bash 工具尊重 settings.json 的 shellPath（issue #866）", () => {
	// 回归：以前 makeKillableBashTool 直接 `createLocalBashOperations()`，SDK 拿不到 shellPath，
	// 只会去 %ProgramFiles%\Git 和 PATH 找 bash。Windows 上 Git 装在别处的用户因此全盘失败。
	// 这里用「配置了一个不存在的 shellPath」做探针：CLI 会明确报 Custom shell path not found，
	// 若仍然偷偷用默认 shell 跑通，就说明配置被吞了。
	it("配置的 shellPath 缺失时按 CLI 语义报错，而不是静默回落到默认 shell", async () => {
		const missing = join(tempDir("bash-shell-missing-"), "bash");
		const agentDir = agentDirWithShellPath(missing);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const cwd = tempDir("bash-shell-cwd-");

		await expect(runBash(cwd, "echo hi")).rejects.toThrow(/Custom shell path not found/);
	});

	// 正向验证：命令确实是从配置的那个解释器跑出来的（走的不是默认 bash）。
	it.skipIf(process.platform === "win32")("命令经由 shellPath 指定的解释器执行", async () => {
		const dir = tempDir("bash-shell-fake-");
		const fakeBash = join(dir, "fake-bash");
		writeFileSync(fakeBash, "#!/bin/sh\necho FAKE_SHELL_OK\n");
		chmodSync(fakeBash, 0o755);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDirWithShellPath(fakeBash));
		const cwd = tempDir("bash-shell-cwd-");

		const result = await runBash(cwd, "echo hi");
		expect(result.content?.[0]?.text ?? "").toContain("FAKE_SHELL_OK");
	});

	it("没配 shellPath 时行为不变：照常跑命令", async () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", tempDir("bash-shell-empty-agent-"));
		const cwd = tempDir("bash-shell-cwd-");

		const result = await runBash(cwd, "echo PLAIN_OK");
		expect(result.content?.[0]?.text ?? "").toContain("PLAIN_OK");
	});
});
