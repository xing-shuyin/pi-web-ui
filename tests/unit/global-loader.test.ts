import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
// 测试级 tripwire：任何 `*Sync` 子进程调用都会抛错（#830 —— 服务端热路径禁止同步 spawn）
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(() => {
		throw new Error("sync child-process call is forbidden here");
	}),
	execSync: vi.fn(() => {
		throw new Error("sync child-process call is forbidden here");
	}),
	execFileSync: vi.fn(() => {
		throw new Error("sync child-process call is forbidden here");
	}),
}));
import {
	getCandidateNodeModulesRoots,
	getSystemNpmRootG,
	probeGlobalPackage,
	resolvePackageEntryFile,
	resolvePackageRoot,
	dynamicImportGlobalPackage,
} from "../../server/global-loader.js";

const hasDurable = !!resolvePackageRoot("@earendil-works/pi-durable");

describe("通用全局环境动态解析与穿透加载器（Universal Global Package Loader）", () => {
	it("getCandidateNodeModulesRoots 自动收集系统多环境候选目录", () => {
		const roots = getCandidateNodeModulesRoots();
		expect(Array.isArray(roots)).toBe(true);
		expect(roots.length).toBeGreaterThan(0);

		// 所有收集到的候选根都应是规范绝对路径且非空
		for (const r of roots) {
			expect(typeof r).toBe("string");
			expect(r.length).toBeGreaterThan(0);
		}
	});

	it.each(["node_modules", join("lib", "node_modules")])("发现没有 multishell 链接的 fnm 持久安装：%s", (suffix) => {
		const dir = mkdtempSync(join(tmpdir(), "engine-fnm-"));
		try {
			vi.stubEnv("FNM_DIR", dir);
			const root = join(dir, "node-versions", "v99.0.0", "installation", suffix);
			const pkg = join(root, "@engine-probe-fixture", "installed");
			mkdirSync(pkg, { recursive: true });
			writeFileSync(
				join(pkg, "package.json"),
				JSON.stringify({ name: "@engine-probe-fixture/installed", version: "1.2.3", main: "index.js" }),
			);
			writeFileSync(join(pkg, "index.js"), "module.exports = {};");
			expect(getCandidateNodeModulesRoots({ refresh: true })).toContain(root);
			expect(probeGlobalPackage("@engine-probe-fixture/installed", { refresh: true })).toEqual({
				installed: true,
				version: "1.2.3",
				packagePath: pkg,
			});
			expect(resolvePackageEntryFile("@engine-probe-fixture/installed")).toBe(join(pkg, "index.js"));
		} finally {
			vi.unstubAllEnvs();
			rmSync(dir, { recursive: true, force: true });
			getCandidateNodeModulesRoots({ refresh: true });
		}
	});

	it("安装新的 fnm Node 版本后，候选缓存到期会自动发现引擎", () => {
		const dir = mkdtempSync(join(tmpdir(), "engine-fnm-refresh-"));
		try {
			vi.stubEnv("FNM_DIR", dir);
			expect(probeGlobalPackage("@engine-probe-fixture/new-install", { refresh: true }).installed).toBe(false);
			const pkg = join(
				dir,
				"node-versions",
				"v99.1.0",
				"installation",
				"node_modules",
				"@engine-probe-fixture",
				"new-install",
			);
			mkdirSync(pkg, { recursive: true });
			writeFileSync(
				join(pkg, "package.json"),
				JSON.stringify({ name: "@engine-probe-fixture/new-install", version: "2.0.0" }),
			);
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
			expect(probeGlobalPackage("@engine-probe-fixture/new-install")).toEqual({
				installed: true,
				version: "2.0.0",
				packagePath: pkg,
			});
		} finally {
			vi.restoreAllMocks();
			vi.unstubAllEnvs();
			rmSync(dir, { recursive: true, force: true });
			getCandidateNodeModulesRoots({ refresh: true });
		}
	});

	it("resolvePackageRoot 精准定位本地与全局包根路径", () => {
		// 1. 定位本地存在的 SDK 包
		const piRoot = resolvePackageRoot("@earendil-works/pi-coding-agent");
		expect(piRoot).toBeTruthy();
		expect(existsSync(piRoot!)).toBe(true);

		// 2. 定位全局安装的 pi-durable 包（若当前系统已全局安装）
		if (hasDurable) {
			const durableRoot = resolvePackageRoot("@earendil-works/pi-durable");
			expect(durableRoot).toBeTruthy();
			expect(existsSync(durableRoot!)).toBe(true);
		}

		// 3. 不存在的包安全返回 null
		const nonExistent = resolvePackageRoot("@nonexistent/package-never-exists");
		expect(nonExistent).toBeNull();
	});

	it("probeGlobalPackage 准确探测安装状态与版本号", () => {
		// 1. 探测本地存在的 SDK 包
		const probePi = probeGlobalPackage("@earendil-works/pi-coding-agent");
		expect(probePi.installed).toBe(true);
		expect(typeof probePi.version).toBe("string");
		expect(probePi.packagePath).toBeDefined();

		// 2. 探测可选全局安装的 pi-durable 包
		if (hasDurable) {
			const probeDurable = probeGlobalPackage("@earendil-works/pi-durable");
			expect(probeDurable.installed).toBe(true);
			expect(typeof probeDurable.version).toBe("string");
			expect(probeDurable.packagePath).toBeDefined();
		}

		// 3. 探测不存在的包
		const probeFake = probeGlobalPackage("@nonexistent/package-never-exists");
		expect(probeFake.installed).toBe(false);
		expect(probeFake.version).toBeUndefined();
	});

	it("resolvePackageEntryFile 遵循 exports 条件导出规范解析物理入口文件", () => {
		// 1. 本地 SDK 主包入口解析
		const piMainEntry = resolvePackageEntryFile("@earendil-works/pi-coding-agent");
		expect(piMainEntry).toBeTruthy();
		expect(existsSync(piMainEntry!)).toBe(true);

		// 2. 本地 SDK 子路径 rpc-entry 解析
		const piRpcEntry = resolvePackageEntryFile("@earendil-works/pi-coding-agent", "rpc-entry");
		expect(piRpcEntry).toBeTruthy();
		expect(existsSync(piRpcEntry!)).toBe(true);

		// 3. 不存在的包安全返回 null
		const nonExistentEntry = resolvePackageEntryFile("@nonexistent/package-never-exists");
		expect(nonExistentEntry).toBeNull();
	});

	it("dynamicImportGlobalPackage 成功跨环境穿透动态导入 ESM 模块", async () => {
		// 动态加载本地 SDK 包（验证原生/穿透动态导入可用）
		const piMod = await dynamicImportGlobalPackage("@earendil-works/pi-coding-agent");
		expect(piMod).toBeDefined();

		// 加载不存在的包安全抛错
		await expect(dynamicImportGlobalPackage("@nonexistent/package-never-exists")).rejects.toThrow();
	}, 15_000);

	describe.skipIf(!hasDurable)("可选全局引擎 @earendil-works/pi-durable 穿透加载验证", () => {
		it("resolvePackageEntryFile 遵循 exports 条件导出规范解析物理入口文件", () => {
			// 1. 主包入口解析
			const mainEntry = resolvePackageEntryFile("@earendil-works/pi-durable");
			expect(mainEntry).toBeTruthy();
			expect(existsSync(mainEntry!)).toBe(true);
			expect(mainEntry!.endsWith(".js")).toBe(true);

			// 2. 子路径 tools 入口解析
			const toolsEntry = resolvePackageEntryFile("@earendil-works/pi-durable", "tools");
			expect(toolsEntry).toBeTruthy();
			expect(existsSync(toolsEntry!)).toBe(true);

			// 3. 子路径 storage/sqlite/node 入口解析
			const sqliteEntry = resolvePackageEntryFile("@earendil-works/pi-durable", "storage/sqlite/node");
			expect(sqliteEntry).toBeTruthy();
			expect(existsSync(sqliteEntry!)).toBe(true);
		});

		it("dynamicImportGlobalPackage 成功跨环境穿透动态导入 ESM 模块", async () => {
			// 动态加载主包
			const durableMod = await dynamicImportGlobalPackage("@earendil-works/pi-durable");
			expect(durableMod).toBeDefined();
			expect(typeof durableMod.Harness).toBe("object");

			// 动态加载子包 tools
			const toolsMod = await dynamicImportGlobalPackage("@earendil-works/pi-durable", "tools");
			expect(toolsMod).toBeDefined();
			expect(toolsMod.CodingTools).toBeDefined();

			// 动态加载子包 storage/sqlite/node
			const sqliteMod = await dynamicImportGlobalPackage("@earendil-works/pi-durable", "storage/sqlite/node");
			expect(sqliteMod).toBeDefined();
			expect(typeof sqliteMod.openNodeSqliteStorage).toBe("function");
		});
	});

	describe("npm 全局 root 的静态推导（不再 fork `npm root -g`）", () => {
		it("npm_config_prefix 生效，且无需 npm 可执行文件", () => {
			const prefix = mkdtempSync(join(tmpdir(), "engine-npm-prefix-"));
			const globalRoot = join(prefix, "lib", "node_modules");
			mkdirSync(globalRoot, { recursive: true });
			try {
				vi.stubEnv("npm_config_prefix", prefix);
				if (process.platform !== "win32") vi.stubEnv("NPM_CONFIG_PREFIX", "");
				getCandidateNodeModulesRoots({ refresh: true });
				expect(getSystemNpmRootG()).toBe(resolve(globalRoot));
				// 结果进缓存：第二次调用不再重新推导
				expect(getSystemNpmRootG()).toBe(resolve(globalRoot));
				// 推导出的目录确实作为候选根被收集
				expect(getCandidateNodeModulesRoots()).toContain(resolve(globalRoot));
			} finally {
				vi.unstubAllEnvs();
				rmSync(prefix, { recursive: true, force: true });
				getCandidateNodeModulesRoots({ refresh: true });
			}
		});

		it("有子进程 API 可用也绝不调用（spawn 禁令）", () => {
			const prefix = mkdtempSync(join(tmpdir(), "engine-npm-nospawn-"));
			mkdirSync(join(prefix, "lib", "node_modules"), { recursive: true });
			try {
				vi.stubEnv("npm_config_prefix", prefix);
				if (process.platform !== "win32") vi.stubEnv("NPM_CONFIG_PREFIX", "");
				getCandidateNodeModulesRoots({ refresh: true });
				// node:child_process 在本文件里被 mock 成「一调用就抛」：旧实现会吞掉异常返回 null
				expect(getSystemNpmRootG()).toBe(resolve(prefix, "lib", "node_modules"));
			} finally {
				vi.unstubAllEnvs();
				rmSync(prefix, { recursive: true, force: true });
				getCandidateNodeModulesRoots({ refresh: true });
			}
		});

		it("读取 ~/.npmrc 的 prefix=（引号、~ 展开、跳过注释与相对值）", () => {
			const home = mkdtempSync(join(tmpdir(), "engine-npm-rc-"));
			const target = join(home, "npm-global");
			mkdirSync(join(target, "lib", "node_modules"), { recursive: true });
			writeFileSync(
				join(home, ".npmrc"),
				[
					"# comment",
					"; another comment",
					`prefix="~/npm-global"`,
					"prefix=relative/ignored",
					"registry=https://registry.npmjs.org/",
				].join("\n"),
			);
			try {
				vi.stubEnv("HOME", home);
				vi.stubEnv("npm_config_prefix", "");
				if (process.platform !== "win32") vi.stubEnv("NPM_CONFIG_PREFIX", "");
				getCandidateNodeModulesRoots({ refresh: true });
				expect(getSystemNpmRootG()).toBe(resolve(target, "lib", "node_modules"));
			} finally {
				vi.unstubAllEnvs();
				rmSync(home, { recursive: true, force: true });
				getCandidateNodeModulesRoots({ refresh: true });
			}
		});

		it("没有任何候选时不会抛错（且不残留临时 HOME）", () => {
			const home = mkdtempSync(join(tmpdir(), "engine-npm-empty-"));
			try {
				vi.stubEnv("HOME", home);
				vi.stubEnv("npm_config_prefix", "");
				if (process.platform !== "win32") vi.stubEnv("NPM_CONFIG_PREFIX", "");
				getCandidateNodeModulesRoots({ refresh: true });
				const resolved = getSystemNpmRootG();
				// 有值的唯一合法来源是运行中 node 自带的安装前缀，且必须真实存在
				if (resolved !== null) expect(existsSync(resolved)).toBe(true);
			} finally {
				vi.unstubAllEnvs();
				rmSync(home, { recursive: true, force: true });
				getCandidateNodeModulesRoots({ refresh: true });
			}
		});
	});
});
