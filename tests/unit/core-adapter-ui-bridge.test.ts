import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoreUiBridges, createCoreUiBridge } from "../../server/core-ui-bridge-adapter.js";
import { UiDialogTable } from "../../packages/keel/src/domains/ui-bridge/dialogs.js";
import { UiOverlayTable } from "../../packages/keel/src/domains/ui-bridge/overlays.js";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ui-bridge-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tables() {
	return { dialogs: new UiDialogTable({ emit: () => {} }), overlays: new UiOverlayTable() };
}

describe("宿主 UI 桥适配器（core-ui-bridge-adapter）", () => {
	it("dialogs / overlays 直通宿主那份表（内核 handler 与宿主 UI 上下文同一实例）", async () => {
		const webUi = tables();
		const port = createCoreUiBridge({ webUi, agentDir: tempDir() });
		expect(port.dialogs).toBe(webUi.dialogs);
		expect(port.overlays).toBe(webUi.overlays);

		const opened = port.dialogs.open("input", "名字", [""]);
		const [pending] = port.dialogs.pending();
		port.dialogs.resolve(pending.id, "pi");
		await expect(opened).resolves.toBe("pi");
	});

	it("installCli：走宿主注入的进程口，装完把探针缓存清掉（不再返回旧的 false）", async () => {
		const webUi = tables();
		let installed = false;
		let runs = 0;
		let invalidated = 0;
		const port = createCoreUiBridge({
			webUi,
			agentDir: tempDir(),
			isCliInstalled: () => installed,
			runInstall: async () => {
				runs += 1;
				installed = true;
				return { ok: true, code: 0, output: "added 1 package" };
			},
			invalidateProbe: () => {
				invalidated += 1;
			},
		});

		expect(port.probe().piAgentInstalled).toBe(false);
		const result = await port.installCli();
		expect(result).toEqual({ ok: true, code: 0, output: "added 1 package" });
		expect(runs).toBe(1);
		expect(invalidated).toBe(1);
		// 缓存已失效 → 立刻能读到真值
		expect(port.probe().piAgentInstalled).toBe(true);
	});

	it("probe：已配置 = 有可用模型 或 auth.json / models.json 有内容", () => {
		const agentDir = tempDir();
		const webUi = tables();
		const bare = createCoreUiBridge({ webUi, agentDir });
		expect(bare.probe().piConfigured).toBe(false);

		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { key: "k" } }));
		expect(createCoreUiBridge({ webUi, agentDir }).probe().piConfigured).toBe(true);

		const modelsDir = tempDir();
		writeFileSync(join(modelsDir, "models.json"), JSON.stringify({ providers: { local: {} } }));
		expect(createCoreUiBridge({ webUi, agentDir: modelsDir }).probe().piConfigured).toBe(true);

		// 模型运行时手里有可用模型也算已配置（宿主注入的判定优先）
		expect(createCoreUiBridge({ webUi, agentDir, hasAvailableModels: () => true }).probe().piConfigured).toBe(true);
	});

	it("probe：`pi` 在 PATH 上 = 已安装（便携版恒真），每条桥各自 10s 缓存", () => {
		const webUi = tables();
		const binDir = tempDir();
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(binDir, process.platform === "win32" ? "pi.cmd" : "pi"), "");

		const previousPath = process.env.PATH;
		const previousPortable = process.env.PI_PORTABLE;
		try {
			process.env.PATH = binDir;
			delete process.env.PI_PORTABLE;
			const port = createCoreUiBridge({ webUi });
			expect(port.probe().piAgentInstalled).toBe(true);

			// 缓存命中：PATH 变了也不会立刻翻（10s TTL 是老口径）
			process.env.PATH = tempDir();
			expect(port.probe().piAgentInstalled).toBe(true);
			// 新实例没有缓存 → 读到新 PATH
			expect(createCoreUiBridge({ webUi }).probe().piAgentInstalled).toBe(false);

			process.env.PI_PORTABLE = "1";
			expect(createCoreUiBridge({ webUi }).probe().piAgentInstalled).toBe(true);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousPortable === undefined) delete process.env.PI_PORTABLE;
			else process.env.PI_PORTABLE = previousPortable;
		}
	});

	it("CoreUiBridges：一个客户端一份（同一个 clientId 复用，断开后可丢弃）", () => {
		const bridges = new CoreUiBridges({ agentDir: tempDir() });
		const first = bridges.portOf("client-1", tables());
		expect(bridges.portOf("client-1", tables())).toBe(first);
		const second = bridges.portOf("client-2", tables());
		expect(second).not.toBe(first);
		expect(bridges.size()).toBe(2);

		bridges.forget("client-1");
		expect(bridges.size()).toBe(1);
		expect(bridges.portOf("client-1", tables())).not.toBe(first);
	});
});
