import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findNativeCliExecutable } from "../../server/native-cli-discovery.js";

/**
 * 「用 fnm 装了 node，但壳说没装」的守卫。
 *
 * 现场（2026-11-21）：用户用 fnm 管 node，node 真实存在于
 * `%APPDATA%\fnm\node-versions\v26.13.1\installation\node.exe`；
 * 但 fnm 是按 shell 注入 PATH 的，**从资源管理器双击起来的桌面壳看不到那些注入项**。
 * 只扫 PATH 会「装了也当没装」，把用户推去重装 node。
 *
 * 正确口径是仓库单源 `server/native-cli-discovery.ts`（PATH → fnm/nvm/volta/scoop 真实落点）。
 * 注意它的版本管理器扫描默认开启（`autoDetect !== false`）——这个默认值踩过坑：
 * 调用方不传 autoDetect 时曾退化成只扫 PATH。
 */
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 造一个 fnm 目录树，返回 FNM_DIR 与「node 可执行文件」落点。 */
function fakeFnm(versions: string[]): { fnmDir: string; nodeOf: (version: string) => string } {
	const fnmDir = mkdtempSync(join(tmpdir(), "pi-fnm-"));
	roots.push(fnmDir);
	for (const version of versions) {
		const installation = join(fnmDir, "node-versions", version, "installation");
		mkdirSync(installation, { recursive: true });
		writeFileSync(join(installation, "node.exe"), "");
		writeFileSync(join(installation, "npm.cmd"), "");
	}
	return { fnmDir, nodeOf: (version) => join(fnmDir, "node-versions", version, "installation", "node.exe") };
}

/** 隔离环境：只给 FNM_DIR 与空 PATH，模拟「桌面壳看不到 fnm 注入项」。 */
function isolatedEnv(fnmDir: string): { env: NodeJS.ProcessEnv; homeDir: string; nodeExecutable: string } {
	const home = mkdtempSync(join(tmpdir(), "pi-home-"));
	roots.push(home);
	// nodeExecutable 也要指到沙箱：installDirectories 会把它所在目录当候选，
	// 不隔离就会扫到「测试运行器自己的 node」，把断言变成随机结果。
	return {
		env: { FNM_DIR: fnmDir, PATH: "" } as NodeJS.ProcessEnv,
		homeDir: home,
		nodeExecutable: join(home, "no-node-here", "node.exe"),
	};
}

describe("系统 node 发现（版本管理器）", () => {
	it("PATH 里没有 node 时，仍能从 fnm 的 node-versions 找到（桌面壳的真实处境）", () => {
		const { fnmDir, nodeOf } = fakeFnm(["v26.13.1"]);
		const { env, homeDir, nodeExecutable } = isolatedEnv(fnmDir);
		expect(findNativeCliExecutable("node", { platform: "win32", env, homeDir, nodeExecutable })).toBe(
			nodeOf("v26.13.1"),
		);
	});

	it("装了多个版本 → 取最高版本（numeric 排序，不是字典序）", () => {
		const { fnmDir, nodeOf } = fakeFnm(["v9.11.2", "v26.13.1"]);
		const { env, homeDir, nodeExecutable } = isolatedEnv(fnmDir);
		expect(findNativeCliExecutable("node", { platform: "win32", env, homeDir, nodeExecutable })).toBe(
			nodeOf("v26.13.1"),
		);
	});

	it("npm 也能在同一 fnm 安装目录找到（安装内核要跑 npm i -g）", () => {
		const { fnmDir } = fakeFnm(["v26.13.1"]);
		const { env, homeDir, nodeExecutable } = isolatedEnv(fnmDir);
		expect(
			findNativeCliExecutable("npm", { platform: "win32", env, homeDir, nodeExecutable })?.endsWith("npm.cmd"),
		).toBe(true);
	});

	it("PATH 里有 node 时优先用 PATH（尊重用户自己的优先级）", () => {
		const { fnmDir } = fakeFnm(["v26.13.1"]);
		const { env, homeDir, nodeExecutable } = isolatedEnv(fnmDir);
		const onPath = join(homeDir, "custom-bin");
		mkdirSync(onPath, { recursive: true });
		const nodePath = join(onPath, "node.exe");
		writeFileSync(nodePath, "");
		expect(
			findNativeCliExecutable("node", {
				platform: "win32",
				env: { ...env, PATH: onPath } as NodeJS.ProcessEnv,
				homeDir,
				nodeExecutable,
			}),
		).toBe(nodePath);
	});
});
