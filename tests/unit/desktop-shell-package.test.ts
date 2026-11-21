import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { describe, expect, it } from "vitest";

/**
 * 纯壳包（shell-only）的守卫：安装包只放壳，内核由全局 npm 包 / userData 运行时提供；
 * 两者都没有时由界面提示「安装内核 / 安装 Node」（见 docs/architecture-kernel.md §纯壳包）。
 *
 * 三处必须同时成立，少一处就是坏包：
 * 1. `desktop/electron-builder.shell.yml` 不能把内核文件打进去（否则就退回 760 MB 完整包）；
 * 2. 壳运行时需要的四个 npm 包必须在清单里（漏一个 = 安装版 MODULE_NOT_FOUND）；
 * 3. `main.ts` 必须处理「权威链返回 null」，`browser-host` / 渲染层必须能展示修复入口。
 */
const root = cwd();
const shellYml = readFileSync(join(root, "desktop/electron-builder.shell.yml"), "utf8");

describe("electron-builder.shell.yml", () => {
	it("继承主配置（main/appId 等壳行为都在那边单源）", () => {
		// extends 以 **项目根** 为基准解析，不是配置文件所在目录（写 ./ 会报 Cannot find parent config file）
		expect(shellYml).toContain("extends: desktop/electron-builder.yml");
	});

	it("内核目录只以取反形式出现（不是被打进包）", () => {
		const filesAt = shellYml.indexOf("\nfiles:");
		expect(filesAt).toBeGreaterThan(-1);
		const block = shellYml.slice(filesAt, shellYml.indexOf("asarUnpack:", filesAt));
		// 逐行看：内核路径出现在包里 = 忘了写 `!`；写成 `- "!dist/server"` 才是正确的排除。
		const entries = block
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.startsWith("-") && !line.startsWith("#"))
			.map((line) => line.replace(/^-\s*/, "").replace(/^["']|["']$/g, ""));
		const forbidden = ["bin", "dist/server", "web/dist", "themes", "plugin-sdk", "plugins/catalog.json"];
		for (const entry of entries) {
			if (entry.startsWith("!")) continue;
			for (const path of forbidden) {
				expect(entry, `纯壳包不能打进 ${path}（写 !${path} 才是排除）`).not.toBe(path);
			}
		}
		// 反过来：每一个必须排掉的内核目录都确实有取反（防静默漏排）
		for (const path of forbidden) {
			expect(block, `缺少排除 !${path}`).toContain(`"!${path}"`);
		}
		// 只允许壳自己的代码（+ 三进程根共用的 dist/shared）
		expect(block).toContain("dist/desktop");
		expect(block).toContain("dist/shared");
		expect(block).toContain("dist/browser");
		expect(block).toContain("package.json");
	});

	it("壳自己的四个依赖一个都不能少（漏了就是安装版起不来）", () => {
		for (const pkg of [
			"node_modules/electron-chrome-extensions/**",
			"node_modules/debug/**",
			"node_modules/ms/**",
			"node_modules/jsqr/**",
		]) {
			expect(shellYml, `缺少 ${pkg}`).toContain(pkg);
		}
	});

	it("产物目录与发布通道独立，不覆盖完整包的 win-unpacked / latest.yml", () => {
		expect(shellYml).toContain("output: release-shell");
		expect(shellYml).toContain("artifactName: ${productName}-shell-${version}-setup.${ext}");
		expect(shellYml).toContain("publish: null");
	});
});

describe("壳侧的三处接线", () => {
	const mainSource = readFileSync(join(root, "desktop/main.ts"), "utf8");
	const hostSource = readFileSync(join(root, "desktop/browser-host.ts"), "utf8");
	const shellTs = readFileSync(join(root, "browser/renderer/shell.ts"), "utf8");

	it("main.ts 处理权威链返回 null：不 spawn 不存在的入口，转为可修复状态", () => {
		expect(mainSource).toContain("if (!picked)");
		expect(mainSource).toContain("markKernelUnavailable");
		// 关键：没有入口时必须在 spawn 之前就拦住
		const startIdx = mainSource.indexOf("async function startServerSidecar");
		const guardIdx = mainSource.indexOf("if (!entry)", startIdx);
		const spawnIdx = mainSource.indexOf("serverProc = spawn(", startIdx);
		expect(guardIdx).toBeGreaterThan(startIdx);
		expect(guardIdx).toBeLessThan(spawnIdx);
	});

	it("内核起来后必须把「没有内核」的覆盖层收回去", () => {
		expect(hostSource).toContain("setKernelMissing");
		expect(mainSource).toContain("setKernelMissing(null)");
	});

	it("修复入口复用已有内核通道，不另开一套 IPC", () => {
		for (const action of ["kernel.upgrade", "kernel.installNode", "kernel.restart"]) {
			expect(shellTs).toContain(action);
		}
	});

	it("contracts 里的 kernelMissing 是可选字段（旧壳/旧渲染层不炸）", () => {
		const contracts = readFileSync(join(root, "browser/contracts.ts"), "utf8");
		expect(contracts).toContain("kernelMissing?:");
	});

	it("npm 脚本存在，且不跑完整 build（纯壳包不需要 server/web）", () => {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};
		const script = pkg.scripts["desktop:nsis:shell"];
		expect(script, "缺 desktop:nsis:shell").toBeTruthy();
		expect(script).toContain("electron-builder.shell.yml");
		expect(script).not.toContain("npm run build &&");
	});

	it("纯壳包配置引用的 yml/nsh 真实存在（防悬空引用）", () => {
		expect(existsSync(join(root, "desktop/electron-builder.yml"))).toBe(true);
		expect(existsSync(join(root, "desktop/installer.nsh"))).toBe(true);
	});
});
