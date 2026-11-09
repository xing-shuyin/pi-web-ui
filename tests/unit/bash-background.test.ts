import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { makeAdaptiveBashTool, makeKillableBashTool } from "../../server/bash-tool.js";
import { JobRegistry } from "../../server/job-runner.js";

const dirs: string[] = [];
const node = JSON.stringify(process.execPath);

function makeRegistry(): JobRegistry {
	const dir = mkdtempSync(join(tmpdir(), "bash-bg-"));
	dirs.push(dir);
	return new JobRegistry({ logDir: () => dir });
}

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("bash({ background: true })，走进程内 job registry", () => {
	it("立即返回 job 信息，进程继续跑，可在面板/registry 里停掉", async () => {
		const registry = makeRegistry();
		const tool = makeKillableBashTool(process.cwd(), new Set<AbortController>(), () => "en", registry);
		const startedAt = Date.now();
		const res = (await tool.execute?.(
			"call-bg",
			{ command: `${node} -e "setInterval(()=>{},1000)"`, background: true } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: Array<{ text?: string }>; details: Record<string, unknown> };
		// 关键契约：调用不阻塞（命令本身永不退出）。
		expect(Date.now() - startedAt).toBeLessThan(5000);
		expect(res.details.background).toBe(true);
		expect(typeof res.details.jobId).toBe("string");
		expect(String(res.details.logPath)).toMatch(/\.log$/);
		expect(res.content[0]?.text ?? "").toContain(String(res.details.jobId));
		expect(registry.list()).toHaveLength(1);

		registry.kill(String(res.details.jobId));
		registry.dispose();
	});

	it("timeout 缺省时不会带上 120s 的默认值（后台默认不限时）", async () => {
		const registry = makeRegistry();
		const tool = makeKillableBashTool(process.cwd(), new Set<AbortController>(), () => "en", registry);
		const res = (await tool.execute?.(
			"call-bg-2",
			{ command: `${node} -e "setInterval(()=>{},1000)"`, background: true } as never,
			undefined,
			undefined,
			{} as never,
		)) as { details: Record<string, unknown> };
		expect(res.details.timeoutSec).toBe(0);
		registry.dispose();
	});

	it("没有 registry 时明确报错，不静默退化成前台", async () => {
		const tool = makeKillableBashTool(process.cwd(), new Set<AbortController>(), () => "en");
		await expect(
			tool.execute?.("call-bg-3", { command: "echo hi", background: true } as never, undefined, undefined, {} as never),
		).rejects.toThrow(/background=true is unavailable/);
	});

	it("终端接管开着时 background 仍然走 job registry（PTY 没有后台契约）", async () => {
		const registry = makeRegistry();
		const killableExec = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "killable" }] });
		const terminalExec = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "terminal" }] });
		const killable: ToolDefinition = {
			name: "bash",
			label: "Bash",
			description: "k",
			promptSnippet: "bash",
			parameters: {} as never,
			execute: killableExec,
		};
		const terminalBacked: ToolDefinition = { ...killable, execute: terminalExec };
		const tool = makeAdaptiveBashTool(killable, terminalBacked, () => true);
		if (process.platform !== "win32") {
			await tool.execute(
				"call-bg-4",
				{ command: "echo hi", background: true } as never,
				undefined,
				undefined,
				{} as never,
			);
			expect(killableExec).toHaveBeenCalledTimes(1);
			expect(terminalExec).not.toHaveBeenCalled();
		}
		registry.dispose();
	});
});
