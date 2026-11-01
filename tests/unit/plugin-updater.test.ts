/**
 * 插件更新辅助单测：备份/回滚/prune + 远端 sha 对比（注入 fake exec；
 * 本地 git 仓库路径用无网络的 git ls-remote 验证真实流程）。
 * 毫秒级（git 调用 < 1s）、零 token。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
	ensureBackup,
	listBackups,
	restoreBackup,
	resolveRemoteSha,
	checkPluginUpdates,
	isBuiltinPlugin,
	compareVersions,
	execGit,
	BACKUP_KEEP,
	type Exec,
} from "../../server/plugin-updater.js";

let dataDir: string;

function installPlugin(id: string, marker: string, source = "dummy-src") {
	const dir = join(dataDir, "plugins", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: id, version: marker }));
	writeFileSync(join(dir, "index.mjs"), `// ${marker}\n`);
	writeFileSync(join(dir, ".pi-source.json"), JSON.stringify({ source }));
	return dir;
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "plugin-updater-"));
});
afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

describe("备份 / 回滚", () => {
	it("ensureBackup 生成带时间戳备份 + .pi-backup.json；prune 保留最近 N 份", () => {
		const d = installPlugin("p1", "v1");
		writeFileSync(join(d, "config.json"), "secret");
		const ts1 = ensureBackup(dataDir, "p1", { source: "x" });
		expect(ts1).toBeTruthy();
		const backups = listBackups(dataDir, "p1");
		expect(backups.length).toBe(1);
		expect(existsSync(join(dataDir, "plugin-backups", backups[0], "config.json"))).toBe(true);
		// 再备 3 次 → 只留最近 3 份
		for (let i = 0; i < 3; i++) ensureBackup(dataDir, "p1", { source: "x" });
		expect(listBackups(dataDir, "p1").length).toBe(BACKUP_KEEP ?? 3);
	});

	it("备份不包含 node_modules/.git/whisper-cache；目标不存在返回 null", () => {
		const d = installPlugin("p1", "v1");
		mkdirSync(join(d, "node_modules"), { recursive: true });
		mkdirSync(join(d, ".git"), { recursive: true });
		mkdirSync(join(d, "whisper-cache"), { recursive: true });
		writeFileSync(join(d, "node_modules/x.js"), "x");
		writeFileSync(join(d, "whisper-cache/m.onnx"), "m");
		const ts = ensureBackup(dataDir, "p1");
		expect(ts).toBeTruthy();
		const dest = join(dataDir, "plugin-backups", listBackups(dataDir, "p1")[0]);
		expect(existsSync(join(dest, "node_modules"))).toBe(false);
		expect(existsSync(join(dest, ".git"))).toBe(false);
		expect(existsSync(join(dest, "whisper-cache"))).toBe(false);
		expect(ensureBackup(dataDir, "not-installed")).toBeNull();
	});

	it("restoreBackup 恢复并清理备份（原地保留 node_modules 与 whisper-cache）；无备份返回 null", () => {
		const d = installPlugin("p1", "v1");
		mkdirSync(join(d, "whisper-cache"), { recursive: true });
		writeFileSync(join(d, "whisper-cache/m.onnx"), "m");
		ensureBackup(dataDir, "p1", { source: "x" });
		// 当前目录变成 v2
		writeFileSync(join(dataDir, "plugins", "p1", "index.mjs"), "// v2\n");
		const ts = restoreBackup(dataDir, "p1");
		expect(ts).toBeTruthy();
		expect(readFileSync(join(dataDir, "plugins", "p1", "index.mjs"), "utf8")).toBe("// v1\n");
		expect(existsSync(join(dataDir, "plugins", "p1", "whisper-cache", "m.onnx"))).toBe(true);
		expect(listBackups(dataDir, "p1").length).toBe(0);
		expect(restoreBackup(dataDir, "p1")).toBeNull();
	});
});

/** fake exec：像 git ls-remote 一样按 remote 返回 sha。 */
function fakeExec(shaByRemote: Record<string, string>): Exec {
	return async (_cmd, args) => {
		const remote = args.find((a) => a && a !== "ls-remote" && a !== "HEAD" && !a.startsWith("-"));
		if (remote && shaByRemote[remote]) {
			return { ok: true, stdout: `${shaByRemote[remote]}\tHEAD\n`, stderr: "" };
		}
		return { ok: false, stdout: "", stderr: `fatal: not a git repository '${remote}'` };
	};
}

describe("resolveRemoteSha", () => {
	it("GitHub 源经注入 exec 取 sha", async () => {
		const exec = fakeExec({ "https://github.com/o/r.git": "abc123def456abc123def456abc123def456abc1" });
		const sha = await resolveRemoteSha("o/r", exec);
		expect(sha).toBe("abc123def456");
	});

	it("带 #分支 / /tree/ 子目录仍取 sha；失败 → null", async () => {
		const exec = fakeExec({ "https://github.com/o/r.git": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
		expect(await resolveRemoteSha("o/r#main", exec)).toBe("aaaaaaaaaaaa");
		expect(await resolveRemoteSha("o/r/tree/main/sub", exec)).toBe("aaaaaaaaaaaa");
		expect(await resolveRemoteSha("garbage!", exec)).toBeNull();
		expect(await resolveRemoteSha("o/missing", fakeExec({}))).toBeNull();
	});

	it("本地 git 仓库路径走真实 git ls-remote（离线）", async () => {
		const repo = mkdtempSync(join(tmpdir(), "plugin-updater-git-"));
		try {
			execFileSync("git", ["init", "-q", repo]);
			execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
			execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
			writeFileSync(join(repo, "f.txt"), "v1");
			execFileSync("git", ["-C", repo, "add", "-A"]);
			execFileSync("git", ["-C", repo, "commit", "-qm", "v1"]);
			const sha = await resolveRemoteSha(repo);
			expect(sha).toMatch(/^[0-9a-f]{12}$/);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("checkPluginUpdates", () => {
	it("sha 不同 → updatable；相同 → 最新；无 sha → 保守 updatable+error", async () => {
		installPlugin("a", "1", "x/a");
		writeFileSync(join(dataDir, "plugins", "a", ".pi-git-sha"), "111111111111");
		installPlugin("b", "1", "x/b");
		writeFileSync(join(dataDir, "plugins", "b", ".pi-git-sha"), "222222222222");
		// c：无本地 sha（手工装过的 GitHub 源）
		installPlugin("c", "1", "x/c");
		const exec = fakeExec({
			"https://github.com/x/a.git": "3333333333333333333333333333333333333333",
			"https://github.com/x/b.git": "2222222222222222222222222222222222222222",
			"https://github.com/x/c.git": "4444444444444444444444444444444444444444",
		});
		const dummyFetcher = async () => ({ ok: false, json: async () => ({}) });
		const res = await checkPluginUpdates(dataDir, exec, undefined, { fetcher: dummyFetcher });
		const upd = res
			.filter((r) => r.updatable)
			.map((r) => r.id)
			.sort();
		expect(upd).toEqual(["a", "c"]);
		expect(res.find((r) => r.id === "c")?.localSha).toBeNull();
		expect(res.find((r) => r.id === "a")?.version).toBe("1");
	});

	it("失败/无法识别的源 → updatable=false + error", async () => {
		installPlugin("d", "1");
		writeFileSync(join(dataDir, "plugins", "d", ".pi-git-sha"), "dddddddddddd");
		const res = await checkPluginUpdates(dataDir, fakeExec({}));
		const d = res.find((r) => r.id === "d");
		expect(d?.updatable).toBe(false);
		expect(d?.remoteSha).toBeNull();
	});

	it("真实 git 命令可用性（execGit 是函数）", () => {
		expect(typeof execGit).toBe("function");
	});

	it("内置插件判定（source 包含官方仓库或 catalog.json 存在条目）", () => {
		const catPath = join(dataDir, "catalog.json");
		writeFileSync(catPath, JSON.stringify([{ id: "webmail" }]));
		expect(isBuiltinPlugin("webmail", "x/webmail", catPath)).toBe(true);
		expect(isBuiltinPlugin("custom", "xing-shuyin/pi-web-ui/plugins/custom", catPath)).toBe(true);
		expect(isBuiltinPlugin("other", "someone/other", catPath)).toBe(false);
	});

	it("远端最新版本号高于本地版本时判为可更新 (updatable: true)", async () => {
		installPlugin("builtin-a", "0.1.0", "xing-shuyin/pi-web-ui/plugins/builtin-a");
		writeFileSync(join(dataDir, "plugins", "builtin-a", ".pi-git-sha"), "111111111111");
		const fakeFetcher = async (url: string) => {
			if (url.includes("builtin-a")) {
				return {
					ok: true,
					json: async () => ({ version: "0.2.0" }),
				};
			}
			return { ok: false, json: async () => ({}) };
		};
		const res = await checkPluginUpdates(
			dataDir,
			fakeExec({
				"https://github.com/xing-shuyin/pi-web-ui.git": "1111111111111111111111111111111111111111",
			}),
			undefined,
			{ fetcher: fakeFetcher },
		);
		const p = res.find((r) => r.id === "builtin-a");
		expect(p).toBeTruthy();
		expect(p?.builtin).toBe(true);
		expect(p?.version).toBe("0.1.0");
		expect(p?.latestVersion).toBe("0.2.0");
		expect(p?.updatable).toBe(true);
	});

	it("版本号相同时坚决不报更新（即使 repo commit sha 改变，避免 monorepo 假阳性）", async () => {
		installPlugin("builtin-same", "0.2.1", "xing-shuyin/pi-web-ui/plugins/builtin-same");
		writeFileSync(join(dataDir, "plugins", "builtin-same", ".pi-git-sha"), "111111111111");
		const fakeFetcher = async (url: string) => {
			if (url.includes("builtin-same")) {
				return {
					ok: true,
					json: async () => ({ version: "0.2.1" }),
				};
			}
			return { ok: false, json: async () => ({}) };
		};
		// 仓库 HEAD sha 变更为 999999999999，但插件版本仍为 0.2.1
		const res = await checkPluginUpdates(
			dataDir,
			fakeExec({
				"https://github.com/xing-shuyin/pi-web-ui.git": "9999999999999999999999999999999999999999",
			}),
			undefined,
			{ fetcher: fakeFetcher },
		);
		const p = res.find((r) => r.id === "builtin-same");
		expect(p).toBeTruthy();
		expect(p?.version).toBe("0.2.1");
		expect(p?.latestVersion).toBe("0.2.1");
		expect(p?.updatable).toBe(false); // 绝不误报！
	});

	it("子目录源（monorepo）未能获取清单时不以仓库根 SHA 误报更新", async () => {
		installPlugin("sub-plugin", "1.0.0", "xing-shuyin/pi-web-ui/plugins/sub-plugin");
		writeFileSync(join(dataDir, "plugins", "sub-plugin", ".pi-git-sha"), "111111111111");
		// 远端 fetch 失败（模拟断网或网络受限）
		const fakeFetcher = async () => ({ ok: false, json: async () => ({}) });
		const res = await checkPluginUpdates(
			dataDir,
			fakeExec({
				"https://github.com/xing-shuyin/pi-web-ui.git": "8888888888888888888888888888888888888888",
			}),
			() => "zh",
			{ fetcher: fakeFetcher },
		);
		const p = res.find((r) => r.id === "sub-plugin");
		expect(p).toBeTruthy();
		expect(p?.updatable).toBe(false);
		expect(p?.error).toContain("未能获取远端插件清单");
	});

	it("从随包 pkgRoot 读取最新插件版本（离线零网络支持）", async () => {
		installPlugin("offline-plugin", "0.1.0", "some-source");
		const fakePkgRoot = mkdtempSync(join(tmpdir(), "fake-pkg-root-"));
		try {
			const fakePlugDir = join(fakePkgRoot, "plugins", "offline-plugin");
			mkdirSync(fakePlugDir, { recursive: true });
			writeFileSync(join(fakePlugDir, "manifest.json"), JSON.stringify({ version: "0.3.0" }));

			const res = await checkPluginUpdates(dataDir, fakeExec({}), undefined, { pkgRoot: fakePkgRoot });
			const p = res.find((r) => r.id === "offline-plugin");
			expect(p).toBeTruthy();
			expect(p?.version).toBe("0.1.0");
			expect(p?.latestVersion).toBe("0.3.0");
			expect(p?.updatable).toBe(true);
		} finally {
			rmSync(fakePkgRoot, { recursive: true, force: true });
		}
	});

	it("从本地路径源的 manifest.json 中读取版本", async () => {
		const localSrcDir = mkdtempSync(join(tmpdir(), "local-src-plugin-"));
		try {
			writeFileSync(join(localSrcDir, "manifest.json"), JSON.stringify({ version: "1.5.0" }));
			installPlugin("local-src", "1.0.0", localSrcDir);

			const res = await checkPluginUpdates(dataDir, fakeExec({}));
			const p = res.find((r) => r.id === "local-src");
			expect(p).toBeTruthy();
			expect(p?.version).toBe("1.0.0");
			expect(p?.latestVersion).toBe("1.5.0");
			expect(p?.updatable).toBe(true);
		} finally {
			rmSync(localSrcDir, { recursive: true, force: true });
		}
	});
});

describe("compareVersions (SemVer 规范比较)", () => {
	it("兼容 v/V 前缀与空格清洗", () => {
		expect(compareVersions("v1.2.0", "1.1.0")).toBeGreaterThan(0);
		expect(compareVersions("V2.0.0", "1.0.0")).toBeGreaterThan(0);
		expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
		expect(compareVersions("1.0.0", "v1.0.0")).toBe(0);
		expect(compareVersions(" v1.0.1 ", "1.0.0")).toBeGreaterThan(0);
	});

	it("遵循正式版高于预发布版规则", () => {
		expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
		expect(compareVersions("0.2.0", "0.2.0-rc")).toBeGreaterThan(0);
	});

	it("预发布版本之间的比对", () => {
		expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.1")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
		expect(compareVersions("1.0.0-beta.1", "1.0.0-beta.2")).toBeLessThan(0);
	});

	it("忽略构建元数据 (+)", () => {
		expect(compareVersions("1.0.0+20230101", "1.0.0+20230202")).toBe(0);
		expect(compareVersions("1.0.1+build1", "1.0.0+build2")).toBeGreaterThan(0);
	});

	it("支持多段或短段数版本号", () => {
		expect(compareVersions("1.0.0.1", "1.0.0.0")).toBeGreaterThan(0);
		expect(compareVersions("1.0", "1.0.0")).toBe(0);
		expect(compareVersions("1.0.1", "1.0")).toBeGreaterThan(0);
	});
});
