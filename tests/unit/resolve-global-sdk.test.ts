/**
 * resolve-global-sdk 单测（issue #260；#321 起默认反转）：
 * 「优先用全局/祖先那份 pi SDK」的选择逻辑 —— 缺省即启用，且绝不降级
 * （祖先那份必须**严格**比自带的新才采用，多份取版本最高的），否则自带副本兜底；
 * 只有显式 PI_WEB_SDK=bundled（或 0/off/false/no）才强制自带。
 */
import { describe, expect, it } from "vitest";
import { isSdkCopyUsable, pickGlobalSdk } from "../../server/resolve-global-sdk.js";
import type { SdkCopy } from "../../server/sdk-origin.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bundled: SdkCopy = { path: "/app/node_modules/pi-coding-agent/package.json", version: "0.85.1" };
const globalNewer: SdkCopy = { path: "/global/node_modules/pi-coding-agent/package.json", version: "0.86.1" };
const globalOlder: SdkCopy = { path: "/global/node_modules/pi-coding-agent/package.json", version: "0.84.0" };
const globalSame: SdkCopy = { path: "/global/node_modules/pi-coding-agent/package.json", version: "0.85.1" };

describe("pickGlobalSdk：缺省即跟随（issue #321 默认反转）", () => {
	it("祖先那份更新 → 用它（缺省 / global / auto / 其它值都一样）", () => {
		expect(pickGlobalSdk([bundled, globalNewer], undefined)).toBe(globalNewer);
		expect(pickGlobalSdk([bundled, globalNewer], "global")).toBe(globalNewer);
		expect(pickGlobalSdk([bundled, globalNewer], "auto")).toBe(globalNewer);
		expect(pickGlobalSdk([bundled, globalNewer], "")).toBe(globalNewer);
		expect(pickGlobalSdk([bundled, globalNewer], "whatsoever")).toBe(globalNewer);
	});

	it("显式 bundled（或 0/off/false/no）→ 强制自带副本（可复现、CI 覆盖的那份）", () => {
		expect(pickGlobalSdk([bundled, globalNewer], "bundled")).toBeNull();
		expect(pickGlobalSdk([bundled, globalNewer], "BUNDLED")).toBeNull();
		expect(pickGlobalSdk([bundled, globalNewer], "0")).toBeNull();
		expect(pickGlobalSdk([bundled, globalNewer], "off")).toBeNull();
		expect(pickGlobalSdk([bundled, globalNewer], "false")).toBeNull();
		expect(pickGlobalSdk([bundled, globalNewer], "no")).toBeNull();
		expect(pickGlobalSdk([bundled, globalNewer], " OFF ")).toBeNull();
	});

	it("大小写与空白不敏感", () => {
		expect(pickGlobalSdk([bundled, globalNewer], " GLOBAL ")).toBe(globalNewer);
	});
});

describe("pickGlobalSdk：绝不降级（祖先必须严格更新）", () => {
	it("祖先那份更旧或同版本 → 自带兜底", () => {
		expect(pickGlobalSdk([bundled, globalOlder], undefined)).toBeNull();
		expect(pickGlobalSdk([bundled, globalSame], undefined)).toBeNull();
	});

	it("没有祖先副本（独立安装 / 桌面版 / 没装全局 pi CLI）→ 回落自带", () => {
		expect(pickGlobalSdk([bundled], undefined)).toBeNull();
		expect(pickGlobalSdk([], undefined)).toBeNull();
	});

	it("多份祖先副本 → 取版本最高的那份（不是解析顺序上最近的）", () => {
		const near: SdkCopy = { path: "/near/package.json", version: "0.86.0" };
		const far: SdkCopy = { path: "/far/package.json", version: "0.86.1" };
		expect(pickGlobalSdk([bundled, near, far], undefined)).toBe(far);
		expect(pickGlobalSdk([bundled, far, near], undefined)).toBe(far);
	});

	it("多份合格者同版本 → 保持先到的那份（稳定）", () => {
		const near: SdkCopy = { path: "/near/package.json", version: "0.86.1" };
		const far: SdkCopy = { path: "/far/package.json", version: "0.86.1" };
		expect(pickGlobalSdk([bundled, near, far], undefined)).toBe(near);
	});

	it("最近的那份不合格（更旧）时继续往外找", () => {
		const nearOlder: SdkCopy = { path: "/near/package.json", version: "0.80.0" };
		expect(pickGlobalSdk([bundled, nearOlder, globalNewer], undefined)).toBe(globalNewer);
	});

	it("一份副本都没有（copies 为空）时不抛错", () => {
		expect(pickGlobalSdk([], undefined)).toBeNull();
	});
});

describe("pickGlobalSdk：缺少自带副本时选用可用全局副本（issue #562）", () => {
	it("无自带副本（pnpm 隔离安装 / 裁剪部署）且有全局副本 → 选用最高版本全局副本", () => {
		expect(pickGlobalSdk([globalNewer], undefined, null)).toBe(globalNewer);
		expect(pickGlobalSdk([globalOlder, globalNewer], undefined, null)).toBe(globalNewer);
		expect(pickGlobalSdk([globalNewer, globalOlder], undefined, null)).toBe(globalNewer);
	});

	it("无自带副本且显式指定 bundled → 遵从指令返回 null", () => {
		expect(pickGlobalSdk([globalNewer], "bundled", null)).toBeNull();
	});

	it("无自带副本且无任何全局副本 → 返回 null", () => {
		expect(pickGlobalSdk([], undefined, null)).toBeNull();
	});
});

describe("pickGlobalSdk：损坏/截断副本健全性防护", () => {
	it("跳过损坏的全局高版本副本，安全回退到自带副本", () => {
		const damagedGlobal: SdkCopy = { path: "/global/node_modules/pi-coding-agent/package.json", version: "0.89.0" };
		const isUsable = (c: SdkCopy) => c.path !== damagedGlobal.path;
		expect(pickGlobalSdk([bundled, damagedGlobal], undefined, bundled, isUsable)).toBeNull();
	});

	it("无自带副本时，跳过损坏副本选用次优健康副本", () => {
		const damagedGlobal: SdkCopy = { path: "/global2/node_modules/pi-coding-agent/package.json", version: "0.89.0" };
		const isUsable = (c: SdkCopy) => c.path !== damagedGlobal.path;
		expect(pickGlobalSdk([globalOlder, damagedGlobal], undefined, null, isUsable)).toBe(globalOlder);
	});

	it("isSdkCopyUsable：准确识别截断或损坏的 SDK 目录", () => {
		const testDir = join(tmpdir(), `pi-sdk-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
		try {
			mkdirSync(join(testDir, "dist", "core"), { recursive: true });
			const pkgJson = join(testDir, "package.json");
			writeFileSync(pkgJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.5.0" }));
			writeFileSync(join(testDir, "dist", "index.js"), "export const VERSION = '1.5.0';");

			// 损坏且截断在非闭合代码行（如 'tr'）
			const sessionFile = join(testDir, "dist", "core", "agent-session.js");
			writeFileSync(
				sessionFile,
				"class Session {\n  async run() {\n    let ok = false;\n    tr".padEnd(12000, " ") + "\n    tr",
			);
			expect(isSdkCopyUsable({ path: pkgJson, version: "1.5.0" })).toBe(false);

			// 修复为带有 sourceMappingURL 的正常结尾（且大小正常）
			writeFileSync(
				sessionFile,
				"class Session {\n  async run() {\n    return true;\n  }\n}\n".padEnd(12000, " ") +
					"\n//# sourceMappingURL=agent-session.js.map",
			);
			expect(isSdkCopyUsable({ path: pkgJson, version: "1.5.0" })).toBe(true);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});
