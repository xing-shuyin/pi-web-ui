import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compareVersions } from "../../server/plugin-updater.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PLUGINS_DIR = join(ROOT, "plugins");

const EXEMPT_DOC_PATTERNS = [/\/README\.md$/i, /\/rules\.md$/i, /\.md$/i, /\/\.gitignore$/i, /\/docs\//i];

export function isDocExempt(fileRelPath: string): boolean {
	const norm = fileRelPath.replace(/\\/g, "/");
	return EXEMPT_DOC_PATTERNS.some((p) => p.test(norm));
}

export interface Violation {
	pluginId: string;
	reason: string;
	codeFiles: string[];
	oldVersion?: string | null;
	newVersion?: string | null;
}

export function detectPluginVersionViolations(opts: {
	changedFiles: string[];
	getOldVersion: (id: string) => string | null;
	getNewVersion: (id: string) => string | null;
	isPluginDeleted?: (id: string) => boolean;
}): Violation[] {
	const violations: Violation[] = [];

	const pluginChanges = new Map<string, string[]>();

	for (const f of opts.changedFiles) {
		const norm = f.replace(/\\/g, "/");
		const match = norm.match(/^plugins\/([^/]+)\/(.+)$/);
		if (!match) continue;

		const pluginId = match[1]!;
		const subPath = match[2]!;

		if (subPath === "manifest.json" || subPath === "extension/manifest.json") {
			continue;
		}

		if (isDocExempt(norm)) {
			continue;
		}

		const list = pluginChanges.get(pluginId) ?? [];
		list.push(norm);
		pluginChanges.set(pluginId, list);
	}

	for (const [pluginId, codeFiles] of pluginChanges.entries()) {
		const oldVer = opts.getOldVersion(pluginId);
		const newVer = opts.getNewVersion(pluginId);

		if (!newVer) {
			if (opts.isPluginDeleted?.(pluginId)) {
				continue;
			}
			violations.push({
				pluginId,
				reason: `插件 ${pluginId} 修改了代码文件，但未声明有效的 version`,
				codeFiles,
				oldVersion: oldVer,
				newVersion: newVer,
			});
			continue;
		}

		if (!oldVer) {
			continue;
		}

		if (compareVersions(newVer, oldVer) <= 0) {
			violations.push({
				pluginId,
				reason: `插件 ${pluginId} 修改了代码文件，但 manifest.json 版本未递增（原版本: ${oldVer}，当前版本: ${newVer}）`,
				codeFiles,
				oldVersion: oldVer,
				newVersion: newVer,
			});
		}
	}

	return violations;
}

describe("插件版本规范与递增守卫", () => {
	it("所有内置官方插件必须声明符合 SemVer 格式的版本号", () => {
		const entries = readdirSync(PLUGINS_DIR);
		const semverRe = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

		for (const entry of entries) {
			const dir = join(PLUGINS_DIR, entry);
			if (!statSync(dir).isDirectory()) continue;

			const manifestPath =
				entry === "page-picker" ? join(dir, "extension", "manifest.json") : join(dir, "manifest.json");

			expect(existsSync(manifestPath), `插件 ${entry} 缺少 manifest.json`).toBe(true);

			const content = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
			expect(typeof content.version, `插件 ${entry} 的 manifest 缺少 version 字段`).toBe("string");
			expect(
				semverRe.test(String(content.version)),
				`插件 ${entry} 的版本号 "${content.version}" 不符合 SemVer 格式 (x.y.z)`,
			).toBe(true);

			const pkgPath = join(dir, "package.json");
			if (existsSync(pkgPath)) {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
				if (typeof pkg.version === "string") {
					expect(pkg.version, `插件 ${entry} 的 package.json 版本必须与 manifest.json 一致`).toBe(content.version);
				}
			}
		}
	});

	describe("detectPluginVersionViolations 判定逻辑单元测试", () => {
		it("仅修改 README.md 时无需递增版本号", () => {
			const res = detectPluginVersionViolations({
				changedFiles: ["plugins/sftp/README.md", "plugins/notes/docs/guide.md"],
				getOldVersion: () => "0.2.0",
				getNewVersion: () => "0.2.0",
			});
			expect(res).toEqual([]);
		});

		it("修改了代码但未递增版本号时报违规", () => {
			const res = detectPluginVersionViolations({
				changedFiles: ["plugins/sftp/index.mjs"],
				getOldVersion: () => "0.2.0",
				getNewVersion: () => "0.2.0",
			});
			expect(res.length).toBe(1);
			expect(res[0]?.pluginId).toBe("sftp");
			expect(res[0]?.reason).toContain("版本未递增");
		});

		it("版本号回退/降低时报违规", () => {
			const res = detectPluginVersionViolations({
				changedFiles: ["plugins/sftp/index.mjs"],
				getOldVersion: () => "0.3.0",
				getNewVersion: () => "0.2.0",
			});
			expect(res.length).toBe(1);
			expect(res[0]?.pluginId).toBe("sftp");
		});

		it("修改了代码且严格递增版本号时放行", () => {
			const res = detectPluginVersionViolations({
				changedFiles: ["plugins/sftp/index.mjs", "plugins/sftp/manifest.json"],
				getOldVersion: () => "0.2.0",
				getNewVersion: () => "0.3.0",
			});
			expect(res).toEqual([]);
		});

		it("多插件修改能够准确捕获漏改项", () => {
			const res = detectPluginVersionViolations({
				changedFiles: ["plugins/sftp/client/entry.mjs", "plugins/notes/client/entry.mjs"],
				getOldVersion: (id) => (id === "sftp" ? "0.2.0" : "0.2.0"),
				getNewVersion: (id) => (id === "sftp" ? "0.3.0" : "0.2.0"),
			});
			expect(res.length).toBe(1);
			expect(res[0]?.pluginId).toBe("notes");
		});
	});

	it("检查当前工作区（Working Tree / Staged）中修改的插件代码是否都已递增版本号", () => {
		let diffFiles: string[] = [];
		try {
			const out = execSync("git diff --name-only HEAD", { cwd: ROOT, encoding: "utf8" });
			diffFiles = out
				.trim()
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean);
		} catch {
			return;
		}

		if (diffFiles.length === 0) return;

		const violations = detectPluginVersionViolations({
			changedFiles: diffFiles,
			isPluginDeleted: (pluginId) => !existsSync(join(PLUGINS_DIR, pluginId)),
			getOldVersion: (pluginId) => {
				const manifestRel =
					pluginId === "page-picker"
						? `plugins/${pluginId}/extension/manifest.json`
						: `plugins/${pluginId}/manifest.json`;
				try {
					const oldRaw = execSync(`git show HEAD:${manifestRel}`, {
						cwd: ROOT,
						encoding: "utf8",
						stdio: ["pipe", "pipe", "ignore"],
					});
					const parsed = JSON.parse(oldRaw) as { version?: unknown };
					return typeof parsed.version === "string" ? parsed.version : null;
				} catch {
					return null;
				}
			},
			getNewVersion: (pluginId) => {
				const manifestPath =
					pluginId === "page-picker"
						? join(PLUGINS_DIR, pluginId, "extension", "manifest.json")
						: join(PLUGINS_DIR, pluginId, "manifest.json");
				if (!existsSync(manifestPath)) return null;
				try {
					const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
					return typeof parsed.version === "string" ? parsed.version : null;
				} catch {
					return null;
				}
			},
		});

		if (violations.length > 0) {
			const msg = violations.map((v) => `- [${v.pluginId}] ${v.reason} (修改了: ${v.codeFiles.join(", ")})`).join("\n");
			expect.fail(
				`检测到以下插件修改了代码但未递增版本号：\n${msg}\n请在对应 manifest.json 中递增版本号以确保随宿主热同步正常生效！`,
			);
		}
	});
});
