import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
	compareVersions,
	fetchLatestVersion,
	globalPackageManifestPath,
	isLegacyGlobalBinConflict,
	nodeInstallLaunch,
	parsePackageVersion,
	planUpgrade,
	readGlobalPackageVersion,
	runCommand,
} from "../../desktop/kernel-upgrade.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeKernelEnvironment, kernelEnvironmentActions } from "../../browser/kernel-view.js";
import type { KernelEnvironmentView } from "../../browser/contracts.js";

describe("compareVersions", () => {
	it("数字段逐位比较，预发布算更低", () => {
		expect(compareVersions("0.121.3", "0.121.3")).toBe(0);
		expect(compareVersions("0.121.4", "0.121.3")).toBe(1);
		expect(compareVersions("0.121.3", "0.121.4")).toBe(-1);
		expect(compareVersions("0.122.0", "0.121.9")).toBe(1);
		expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe(1);
		expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
	});

	it("垃圾输入当 0，不抛", () => {
		expect(compareVersions("", "")).toBe(0);
		expect(compareVersions("x.y.z", "0.0.0")).toBe(0);
	});
});

describe("parsePackageVersion / readGlobalPackageVersion", () => {
	it("只认 pi-web-ui 自己的 package.json", () => {
		expect(parsePackageVersion(JSON.stringify({ name: "pi-web-ui", version: "0.121.3" }))).toBe("0.121.3");
		expect(parsePackageVersion(JSON.stringify({ name: "other", version: "1.0.0" }))).toBeNull();
		expect(parsePackageVersion("not-json")).toBeNull();
		expect(parsePackageVersion(null)).toBeNull();
		expect(parsePackageVersion(JSON.stringify({ name: "pi-web-ui", version: "  " }))).toBeNull();
	});

	it("从盘上读版本，缺文件返回 null", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-global-pkg-"));
		writeFileSync(globalPackageManifestPath(root), JSON.stringify({ name: "pi-web-ui", version: "0.120.0" }));
		expect(readGlobalPackageVersion(root)).toBe("0.120.0");
		expect(readGlobalPackageVersion(join(root, "missing"))).toBeNull();
	});
});

describe("planUpgrade", () => {
	it("有新版才给升级，且命令固定", () => {
		expect(planUpgrade({ current: "0.121.3", latest: "0.121.4" })).toEqual({
			kind: "upgrade",
			current: "0.121.3",
			latest: "0.121.4",
			command: "npm i -g keel-agent@latest",
		});
	});

	it("同版/更高（已是最新或本地更新）→ up-to-date；缺数据 → unknown", () => {
		expect(planUpgrade({ current: "0.121.3", latest: "0.121.3" }).kind).toBe("up-to-date");
		expect(planUpgrade({ current: "0.122.0", latest: "0.121.3" }).kind).toBe("up-to-date");
		expect(planUpgrade({ current: null, latest: "1.0.0" })).toEqual({ kind: "unknown", reason: "no-current" });
		expect(planUpgrade({ current: "1.0.0", latest: null })).toEqual({ kind: "unknown", reason: "no-latest" });
	});
});

describe("fetchLatestVersion", () => {
	it("正常拿版本", async () => {
		const value = await fetchLatestVersion({
			fetchImpl: (async () => ({ ok: true, json: async () => ({ version: "1.2.3" }) })) as unknown as typeof fetch,
		});
		expect(value).toBe("1.2.3");
	});

	it("离线/坏响应/超时一律 null，不抛", async () => {
		const boom = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		expect(await fetchLatestVersion({ fetchImpl: boom })).toBeNull();
		const notOk = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
		expect(await fetchLatestVersion({ fetchImpl: notOk })).toBeNull();
		const garbage = (async () => ({ ok: true, json: async () => ({ version: 42 }) })) as unknown as typeof fetch;
		expect(await fetchLatestVersion({ fetchImpl: garbage })).toBeNull();
	});
});

function fakeSpawn(script: { code?: number | null; stdout?: string; stderr?: string; error?: Error }) {
	return ((_cmd: string, _args: string[]) => {
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => child.emit("close", null);
		setTimeout(() => {
			if (script.stdout) child.stdout.emit("data", Buffer.from(script.stdout));
			if (script.stderr) child.stderr.emit("data", Buffer.from(script.stderr));
			if (script.error) child.emit("error", script.error);
			else child.emit("close", script.code ?? 0);
		}, 0);
		return child;
	}) as unknown as typeof import("node:child_process").spawn;
}

describe("runCommand", () => {
	it("成功带 stdout / 失败带 stderr", async () => {
		expect(await runCommand("npm", ["i"], { spawnImpl: fakeSpawn({ code: 0, stdout: "added 1" }) })).toMatchObject({
			code: 0,
			stdout: "added 1",
			timedOut: false,
		});
		const failed = await runCommand("npm", ["i"], { spawnImpl: fakeSpawn({ code: 3, stderr: "EACCES" }) });
		expect(failed.code).toBe(3);
		expect(failed.stderr).toContain("EACCES");
	});

	it("跑不起来（ENOENT）折算成失败回执", async () => {
		const result = await runCommand("npm", ["i"], { spawnImpl: fakeSpawn({ error: new Error("ENOENT") }) });
		expect(result.code).toBe(-1);
		expect(result.stderr).toContain("ENOENT");
	});

	it("超时杀进程并标记", async () => {
		const result = await runCommand("npm", ["i"], {
			timeoutMs: 5,
			spawnImpl: (() => {
				const child = new EventEmitter() as EventEmitter & {
					stdout: EventEmitter;
					stderr: EventEmitter;
					kill: () => void;
				};
				child.stdout = new EventEmitter();
				child.stderr = new EventEmitter();
				child.kill = () => child.emit("close", null);
				return child;
			}) as unknown as typeof import("node:child_process").spawn,
		});
		expect(result.timedOut).toBe(true);
	});
});

describe("nodeInstallLaunch", () => {
	it("Win 用 winget、mac 用 brew；Linux 不给可执行 argv（要 sudo+TTY）", () => {
		expect(nodeInstallLaunch("win32")).toMatchObject({ command: "winget" });
		expect(nodeInstallLaunch("win32")?.args).toContain("OpenJS.NodeJS.LTS");
		expect(nodeInstallLaunch("darwin")).toMatchObject({ command: "brew" });
		expect(nodeInstallLaunch("linux")).toBeNull();
	});
});

const baseEnv: KernelEnvironmentView = {
	node: { ok: true, version: "26.13.1" },
	global: {
		installed: true,
		version: "0.121.3",
		latest: "0.121.4",
		upgradeCommand: "npm i -g keel-agent@latest",
		canUpgrade: true,
	},
	service: { state: "absent" },
	nodeInstall: { command: "winget install --id OpenJS.NodeJS.LTS -e", url: "https://nodejs.org", canRun: true },
};

describe("环境摘要与按钮", () => {
	it("摘要含 node / 全局包升级 / 服务状态", () => {
		expect(describeKernelEnvironment(baseEnv)).toBe("node v26.13.1 · 全局包 v0.121.3 → v0.121.4 · 服务配置：未安装");
		expect(describeKernelEnvironment(null)).toBe("");
	});

	it("缺 node → 摘要说清楚；服务状态三态都有词", () => {
		const noNode: KernelEnvironmentView = {
			...baseEnv,
			node: { ok: false, version: "18.20.0" },
			service: { state: "unknown" },
		};
		expect(describeKernelEnvironment(noNode)).toContain("未检测到可用 node");
		expect(describeKernelEnvironment(noNode)).toContain("服务配置：未知");
	});

	it("按钮只在真能改善时出现", () => {
		expect(kernelEnvironmentActions(baseEnv)).toEqual({ upgrade: true, installNode: false });
		const noNode = { ...baseEnv, node: { ok: false, version: "" } };
		expect(kernelEnvironmentActions(noNode)).toEqual({ upgrade: true, installNode: true });
		const linux = { ...noNode, nodeInstall: { ...baseEnv.nodeInstall, canRun: false } };
		expect(kernelEnvironmentActions(linux).installNode).toBe(false);
		expect(kernelEnvironmentActions(null)).toEqual({ upgrade: false, installNode: false });
	});
});

describe("isLegacyGlobalBinConflict", () => {
	it("识别旧包 pi-web-ui 同名 bin 导致的 EEXIST 冲突", () => {
		expect(
			isLegacyGlobalBinConflict(
				"npm error code EEXIST\nnpm error path /Users/c/.local/share/fnm/node-versions/v26.12.1/installation/bin/pwu",
			),
		).toBe(true);
		expect(isLegacyGlobalBinConflict("npm error EEXIST File exists: C:\\npm\\pi-web-ui.cmd")).toBe(true);
		expect(isLegacyGlobalBinConflict("npm error EACCES permission denied")).toBe(false);
		expect(isLegacyGlobalBinConflict("npm error EEXIST File exists: /usr/local/bin/other-cli")).toBe(false);
	});
});
