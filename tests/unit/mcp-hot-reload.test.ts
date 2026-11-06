import { describe, expect, it, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpHotReload } from "../../server/mcp-hot-reload.js";
import { McpBridge, type McpReloadSummary } from "../../server/mcp-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../fixtures/mcp-echo-server.mjs");
const SPEC = { command: process.execPath, args: [FIXTURE] };

const SUMMARY: McpReloadSummary = { kept: 1, started: 0, stopped: 0, failed: 0, servers: 1, tools: 10 };

const dirs: string[] = [];
const disposables: Array<() => void> = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "piweb-mcp-hot-"));
	dirs.push(dir);
	return dir;
}

function writeConfig(dir: string, servers: Record<string, unknown>, pretty = true): void {
	writeFileSync(
		join(dir, "mcp.json"),
		pretty ? JSON.stringify({ servers }, null, 2) + "\n" : JSON.stringify({ servers }),
	);
}

function harness(dir: string, debounceMs = 40, pollIntervalMs = 60) {
	const state = { reloads: 0, toolsChanged: 0, notices: [] as Array<{ level: string; text: string }> };
	const hot = createMcpHotReload({
		dataDir: dir,
		reload: async () => {
			state.reloads++;
			return SUMMARY;
		},
		onToolsChanged: () => state.toolsChanged++,
		onNotice: (level, text) => state.notices.push({ level, text }),
		log: () => {},
		debounceMs,
		pollIntervalMs,
	});
	disposables.push(() => hot.dispose());
	return { hot, state };
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("等待超时");
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

afterEach(() => {
	for (const d of disposables) d();
	disposables.length = 0;
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

describe("mcp.json 热加载：什么时候该动、什么时候不该动", () => {
	it("reports partial application failure as a warning rather than success", async () => {
		const dir = tempDir();
		writeConfig(dir, { srv: SPEC });
		const notices: Array<{ level: string; text: string }> = [];
		const hot = createMcpHotReload({
			dataDir: dir,
			reload: async () => ({ ...SUMMARY, failed: 1 }),
			onNotice: (level, _text, textEn) => notices.push({ level, text: textEn }),
		});
		disposables.push(() => hot.dispose());
		expect(await hot.apply()).toBe("reloaded");
		expect(notices).toEqual([{ level: "warning", text: expect.stringContaining("failed for 1") }]);
	});

	it("内容真的变了 → 应用一次，并刷新已有会话的工具列表", async () => {
		const dir = tempDir();
		writeConfig(dir, { srv: SPEC });
		const { hot, state } = harness(dir);

		expect(await hot.apply()).toBe("reloaded");
		expect(state.reloads).toBe(1);
		expect(state.toolsChanged).toBe(1);
		expect(state.notices.at(-1)).toMatchObject({ level: "info" });

		writeConfig(dir, { srv: SPEC, second: SPEC });
		expect(await hot.apply()).toBe("reloaded");
		expect(state.reloads).toBe(2);
	});

	it("内容没变（重排服务器顺序、改缩进、env 键序）→ 一个子进程都不动", async () => {
		const dir = tempDir();
		writeConfig(dir, { b: { ...SPEC, env: { B: "2", A: "1" } }, a: SPEC });
		const { hot, state } = harness(dir);
		expect(await hot.apply()).toBe("reloaded");
		expect(state.reloads).toBe(1);

		writeFileSync(
			join(dir, "mcp.json"),
			JSON.stringify({
				servers: { a: SPEC, b: { env: { A: "1", B: "2" }, args: [FIXTURE], command: process.execPath } },
			}),
		);
		expect(await hot.apply()).toBe("unchanged");
		expect(state.reloads).toBe(1);
	});

	it("坏 JSON → 保留在跑的服务器，只提示一次（同一个坏文件不刷屏）", async () => {
		const dir = tempDir();
		writeConfig(dir, { srv: SPEC });
		const { hot, state } = harness(dir);
		expect(await hot.apply()).toBe("reloaded");

		writeFileSync(join(dir, "mcp.json"), '{ "servers": { "srv": ');
		expect(await hot.apply()).toBe("invalid");
		expect(await hot.apply()).toBe("unchanged");
		expect(state.reloads).toBe(1);
		expect(state.notices.filter((n) => n.level === "warning")).toHaveLength(1);

		writeConfig(dir, { srv: SPEC });
		expect(await hot.apply()).toBe("reloaded");
		expect(state.reloads).toBe(2);
	});

	it("删掉 mcp.json = 清空配置（与「坏配置」区分开）", async () => {
		const dir = tempDir();
		writeConfig(dir, { srv: SPEC });
		const { hot, state } = harness(dir);
		expect(await hot.apply()).toBe("reloaded");

		rmSync(join(dir, "mcp.json"));
		expect(await hot.apply()).toBe("reloaded");
		expect(state.reloads).toBe(2);
	});
});

describe("mcp.json 热加载：文件监视", () => {
	it("start 播种后不改文件不触发；保存文件后自动应用", async () => {
		const dir = tempDir();
		writeConfig(dir, { srv: SPEC });
		const { hot, state } = harness(dir);
		hot.start();

		await sleep(250);
		expect(state.reloads).toBe(0);

		writeConfig(dir, { srv: SPEC, added: SPEC });
		await waitFor(() => state.reloads === 1);
		expect(state.toolsChanged).toBe(1);
	});

	it("目录还不存在（fs.watch 不可用）→ 回落到轮询，文件出现后照样生效", async () => {
		const dir = join(tempDir(), "not-created-yet");
		const { hot, state } = harness(dir, 20, 60);
		hot.start();

		mkdirSync(dir, { recursive: true });
		writeConfig(dir, { srv: SPEC });
		await waitFor(() => state.reloads === 1);
	});

	it("dispose 之后不再响应文件变化", async () => {
		const dir = tempDir();
		writeConfig(dir, { srv: SPEC });
		const { hot, state } = harness(dir);
		hot.start();
		await sleep(250);

		hot.dispose();
		writeConfig(dir, { srv: SPEC, added: SPEC });
		await sleep(400);
		expect(state.reloads).toBe(0);
	});
});

describe("mcp.json 热加载：端到端（真桥 + 真文件）", () => {
	it("改完 mcp.json 工具表跟着变，不用重启服务", async () => {
		const dir = tempDir();
		writeConfig(dir, { srv: SPEC });
		const bridge = new McpBridge(dir, () => {});
		disposables.push(() => bridge.dispose());
		await bridge.load();
		expect(bridge.getTools().map((t) => t.name)).toContain("pid");

		const hot = createMcpHotReload({ dataDir: dir, reload: () => bridge.reload(), debounceMs: 40 });
		disposables.push(() => hot.dispose());
		hot.start();

		writeConfig(dir, {});
		await waitFor(() => bridge.getTools().length === 0);
		expect(bridge.getTools()).toEqual([]);
	});
});
