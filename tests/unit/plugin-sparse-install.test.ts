import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "..", "..");
const CLI_PATH = join(PKG_ROOT, "bin", "pi-web-ui.mjs");

let testDataDir: string;

beforeEach(() => {
	testDataDir = mkdtempSync(join(tmpdir(), "pi-sparse-test-"));
});

afterEach(() => {
	try {
		rmSync(testDataDir, { recursive: true, force: true });
	} catch {}
});

describe("plugin install fast path & sparse checkout", () => {
	it("短名称 (如 notes) 自动识别为官方插件，并优先命中本地随包", () => {
		const res = spawnSync(process.execPath, [CLI_PATH, "install", "notes", "--data-dir", testDataDir], {
			encoding: "utf8",
			env: { ...process.env, LANG: "zh_CN.UTF-8" },
		});
		expect(res.status).toBe(0);
		expect(res.stdout).toContain("优先使用本地随包内置插件: plugins/notes");
		expect(existsSync(join(testDataDir, "plugins", "notes", "manifest.json"))).toBe(true);
	});

	it("完整官方路径 (xing-shuyin/pi-web-ui/plugins/sftp) 全新安装优先命中本地随包", () => {
		const res = spawnSync(
			process.execPath,
			[CLI_PATH, "install", "xing-shuyin/pi-web-ui/plugins/sftp", "--data-dir", testDataDir],
			{
				encoding: "utf8",
				env: { ...process.env, LANG: "zh_CN.UTF-8" },
			},
		);
		expect(res.status).toBe(0);
		expect(res.stdout).toContain("优先使用本地随包内置插件: plugins/sftp");
		expect(existsSync(join(testDataDir, "plugins", "sftp", "manifest.json"))).toBe(true);
	});

	it("当本地随包版本高于已安装版本时，--force 升级优先命中本地随包", () => {
		const targetDir = join(testDataDir, "plugins", "notes");
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(
			join(targetDir, "manifest.json"),
			JSON.stringify({ id: "notes", name: "笔记", version: "0.0.1" }, null, 2),
		);

		const res = spawnSync(process.execPath, [CLI_PATH, "install", "notes", "--force", "--data-dir", testDataDir], {
			encoding: "utf8",
			env: { ...process.env, LANG: "zh_CN.UTF-8" },
		});
		expect(res.status).toBe(0);
		expect(res.stdout).toContain("优先使用本地随包内置插件: plugins/notes");
		const manifest = JSON.parse(readFileSync(join(targetDir, "manifest.json"), "utf8"));
		expect(manifest.version).not.toBe("0.0.1");
	});

	it("本地 Git 仓库子目录安装：支持稀疏检出与多子目录增量复用", () => {
		let hasGit = false;
		try {
			execFileSync("git", ["--version"], { stdio: "ignore" });
			hasGit = true;
		} catch {}
		if (!hasGit) return;

		const repoDir = join(testDataDir, "test-monorepo");
		mkdirSync(join(repoDir, "plugins", "plugin-a"), { recursive: true });
		mkdirSync(join(repoDir, "plugins", "plugin-b"), { recursive: true });
		writeFileSync(
			join(repoDir, "plugins", "plugin-a", "manifest.json"),
			JSON.stringify({ id: "plugin-a", name: "Plugin A", version: "1.0.0" }),
		);
		writeFileSync(join(repoDir, "plugins", "plugin-a", "index.mjs"), "// A\n");
		writeFileSync(
			join(repoDir, "plugins", "plugin-b", "manifest.json"),
			JSON.stringify({ id: "plugin-b", name: "Plugin B", version: "1.0.0" }),
		);
		writeFileSync(join(repoDir, "plugins", "plugin-b", "index.mjs"), "// B\n");

		execFileSync("git", ["init", "-q", repoDir]);
		execFileSync("git", ["-C", repoDir, "config", "user.email", "test@test.local"]);
		execFileSync("git", ["-C", repoDir, "config", "user.name", "Test"]);
		execFileSync("git", ["-C", repoDir, "add", "-A"]);
		execFileSync("git", ["-C", repoDir, "commit", "-qm", "initial"]);

		const catalogFile = join(testDataDir, "test-catalog.json");
		const repoUrl = "file:///" + repoDir.replace(/\\/g, "/");
		writeFileSync(
			catalogFile,
			JSON.stringify({
				entries: [
					{ id: "plugin-a", source: `${repoUrl}/plugins/plugin-a` },
					{ id: "plugin-b", source: `${repoUrl}/plugins/plugin-b` },
				],
			}),
		);

		const res = spawnSync(
			process.execPath,
			[CLI_PATH, "install", "--catalog", catalogFile, "--data-dir", testDataDir],
			{
				encoding: "utf8",
				env: { ...process.env, LANG: "zh_CN.UTF-8" },
			},
		);
		expect(res.status).toBe(0);
		expect(existsSync(join(testDataDir, "plugins", "plugin-a", "manifest.json"))).toBe(true);
		expect(existsSync(join(testDataDir, "plugins", "plugin-b", "manifest.json"))).toBe(true);
	});

	it("短名称不存在于官方 catalog 时，正确报错退出", () => {
		const res = spawnSync(
			process.execPath,
			[CLI_PATH, "install", "nonexistent-fake-plugin-12345", "--data-dir", testDataDir],
			{
				encoding: "utf8",
				env: { ...process.env, LANG: "zh_CN.UTF-8" },
			},
		);
		expect(res.status).not.toBe(0);
		const combined = res.stdout + res.stderr;
		expect(combined).toContain("无法识别的插件源");
	});
});
