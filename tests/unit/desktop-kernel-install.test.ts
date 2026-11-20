import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildServiceInstallArgs,
	buildServiceLifecycleArgs,
	kernelCliPath,
	normalizeServiceName,
	runKernelCli,
} from "../../desktop/kernel-install.js";

describe("buildServiceInstallArgs", () => {
	it("端口/数据目录/工作目录原样焙进服务配置（装完看到同一批会话）", () => {
		expect(buildServiceInstallArgs({ port: 8787, dataDir: "C:/d", cwd: "C:/w" })).toEqual([
			"server",
			"install",
			"--port",
			"8787",
			"--data-dir",
			"C:/d",
			"--cwd",
			"C:/w",
		]);
	});

	it("只接受合法服务名与引擎名，非法值直接丢掉（不拼进命令行）", () => {
		expect(buildServiceInstallArgs({ port: 1, dataDir: "d", cwd: "w", name: "pi-2" })).toContain("pi-2");
		expect(buildServiceInstallArgs({ port: 1, dataDir: "d", cwd: "w", name: "-bad name" })).not.toContain("--name");
		expect(buildServiceInstallArgs({ port: 1, dataDir: "d", cwd: "w", engine: "dsh" })).toContain("dsh");
		// pi 是默认值，不必显式写；非法引擎名不落地
		expect(buildServiceInstallArgs({ port: 1, dataDir: "d", cwd: "w", engine: "pi" })).not.toContain("--engine");
		expect(buildServiceInstallArgs({ port: 1, dataDir: "d", cwd: "w", engine: "rm -rf /" })).not.toContain("--engine");
	});
});

describe("buildServiceLifecycleArgs", () => {
	it("status / restart / stop 三种动作，服务名可选", () => {
		expect(buildServiceLifecycleArgs("restart")).toEqual(["server", "restart"]);
		expect(buildServiceLifecycleArgs("status", "pi-web-ui")).toEqual(["server", "status", "--name", "pi-web-ui"]);
		expect(buildServiceLifecycleArgs("stop", "bad name")).toEqual(["server", "stop"]);
	});
});

describe("normalizeServiceName", () => {
	it("按 CLI 的规则校验", () => {
		expect(normalizeServiceName("pi-web-ui")).toBe("pi-web-ui");
		expect(normalizeServiceName("  ")).toBeNull();
		expect(normalizeServiceName(null)).toBeNull();
		expect(normalizeServiceName("_x")).toBeNull();
		expect(normalizeServiceName("a".repeat(65))).toBeNull();
	});
});

describe("kernelCliPath", () => {
	it("指向本包 CLI（与内核同一份代码）", () => {
		expect(kernelCliPath("C:/pkg").replace(/\\/g, "/")).toBe("C:/pkg/bin/pi-web-ui.mjs");
	});
});

function fakeSpawn(script: {
	code?: number | null;
	stdout?: string;
	stderr?: string;
	error?: Error;
	onSignal?: () => void;
}) {
	return ((_cmd: string, _args: string[]) => {
		const child = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter;
			stderr: EventEmitter;
			kill: (signal: string) => void;
		};
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => script.onSignal?.();
		setTimeout(() => {
			if (script.stdout) child.stdout.emit("data", Buffer.from(script.stdout));
			if (script.stderr) child.stderr.emit("data", Buffer.from(script.stderr));
			if (script.error) child.emit("error", script.error);
			else child.emit("close", script.code ?? 0);
		}, 0);
		return child;
	}) as unknown as typeof import("node:child_process").spawn;
}

function tempPkg(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-kernel-cli-"));
	mkdirSync(join(root, "bin"), { recursive: true });
	writeFileSync(join(root, "bin", "pi-web-ui.mjs"), "// stub\n");
	return root;
}

describe("runKernelCli", () => {
	it("找不到 CLI 就直接回执失败，不 spawn", async () => {
		const empty = mkdtempSync(join(tmpdir(), "pi-kernel-empty-"));
		const result = await runKernelCli(["server", "status"], { pkgRoot: empty });
		expect(result.code).toBe(-1);
		expect(result.stderr).toContain("找不到内核 CLI");
	});

	it("成功时回执 stdout 与退出码", async () => {
		const result = await runKernelCli(["server", "install"], {
			pkgRoot: tempPkg(),
			spawnImpl: fakeSpawn({ code: 0, stdout: "✅ 已安装" }),
		});
		expect(result).toMatchObject({ code: 0, stdout: "✅ 已安装", timedOut: false });
	});

	it("失败时把 stderr 带给上层（面板要能显示原因）", async () => {
		const result = await runKernelCli(["server", "install"], {
			pkgRoot: tempPkg(),
			spawnImpl: fakeSpawn({ code: 2, stderr: "缺少权限" }),
		});
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("缺少权限");
	});

	it("spawn 报错不抛，折算成失败回执", async () => {
		const result = await runKernelCli(["server", "status"], {
			pkgRoot: tempPkg(),
			spawnImpl: fakeSpawn({ error: new Error("ENOENT") }),
		});
		expect(result.code).toBe(-1);
		expect(result.stderr).toContain("ENOENT");
	});

	it("超时 → 杀子进程并标记 timedOut（不允许无限挂起）", async () => {
		const result = await runKernelCli(["server", "install"], {
			pkgRoot: tempPkg(),
			timeoutMs: 10,
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
		expect(result.code).toBe(-1);
	});
});
