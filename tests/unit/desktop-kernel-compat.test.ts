import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { describe, expect, it } from "vitest";

import { compareKernelCompat, describeKernelCompat, expectedKernelMinShell } from "../../desktop/kernel-compat.js";
import { DESKTOP_EXPECTED_PROTOCOL } from "../../desktop/protocol-expectation.js";

/**
 * 壳 ↔ 全局包（内核）的兼容判定。纯壳包把两者变成**两个独立安装物**，
 * 版本不匹配是常态，必须就地说清"该升级哪一边"（docs/architecture-kernel.md §9.1.2）。
 */
describe("compareKernelCompat", () => {
	it("协议一致且壳能力够 → ok", () => {
		// 用生成常量推导，别写死数字：协议每 bump 一次就手改一遍只会让这条断言变成噪音。
		expect(
			compareKernelCompat({
				kernelProtocol: DESKTOP_EXPECTED_PROTOCOL,
				kernelMinShell: 1,
				shellCapability: 1,
			}),
		).toEqual({ kind: "ok" });
	});

	it("内核协议与壳不一致（两个方向）→ 升级全局包", () => {
		// 壳新、内核旧
		const older = DESKTOP_EXPECTED_PROTOCOL - 1;
		expect(compareKernelCompat({ kernelProtocol: older, kernelMinShell: 1, shellCapability: 1 })).toMatchObject({
			kind: "upgrade-kernel",
			kernelProtocol: older,
			shellProtocol: DESKTOP_EXPECTED_PROTOCOL,
		});
		// 内核比壳新（壳读不懂新协议，也只能升内核/升壳，而壳不可热更 → 归到升全局包）
		expect(
			compareKernelCompat({ kernelProtocol: DESKTOP_EXPECTED_PROTOCOL + 1, kernelMinShell: 1, shellCapability: 1 }),
		).toMatchObject({
			kind: "upgrade-kernel",
		});
	});

	it("内核要求更高的壳能力 → 只能升级壳（优先级最高，压过协议不符）", () => {
		expect(compareKernelCompat({ kernelProtocol: 99, kernelMinShell: 7, shellCapability: 1 })).toEqual({
			kind: "upgrade-shell",
			kernelMinShell: 7,
			shellCapability: 1,
		});
	});

	it("老内核没报协议 → 按升级全局包处理（不能白屏）", () => {
		expect(compareKernelCompat({ kernelProtocol: undefined, kernelMinShell: 1, shellCapability: 1 })).toMatchObject({
			kind: "unknown-kernel",
		});
		expect(compareKernelCompat({ kernelProtocol: Number.NaN, kernelMinShell: 1, shellCapability: 1 })).toMatchObject({
			kind: "unknown-kernel",
		});
	});

	it("判定顺序：minShell 闸门先于协议（壳升不了内核就别劝人升内核）", () => {
		const verdict = compareKernelCompat({ kernelProtocol: undefined, kernelMinShell: 5, shellCapability: 1 });
		expect(verdict.kind).toBe("upgrade-shell");
	});
});

describe("describeKernelCompat", () => {
	it("ok 不说话，其余都给可执行的下一步", () => {
		expect(describeKernelCompat({ kind: "ok" })).toBe("");
		expect(describeKernelCompat({ kind: "upgrade-kernel", kernelProtocol: 59, shellProtocol: 60 })).toContain(
			"npm i -g pi-web-ui@latest",
		);
		expect(describeKernelCompat({ kind: "upgrade-shell", kernelMinShell: 3, shellCapability: 1 })).toContain(
			"更新桌面应用",
		);
		expect(describeKernelCompat({ kind: "unknown-kernel", detail: "x" })).toContain("升级全局包");
	});
});

describe("构建期烘进来的协议常量", () => {
	const root = cwd();
	const generated = readFileSync(join(root, "desktop/protocol-expectation.ts"), "utf8");
	const source = readFileSync(join(root, "server/protocol-version.ts"), "utf8");

	it("与 server/protocol-version.ts 一致（忘了跑 gen-desktop-protocol 就红）", () => {
		const fromSource = Number(source.match(/export const PROTOCOL_VERSION = (\d+);/)![1]);
		expect(DESKTOP_EXPECTED_PROTOCOL).toBe(fromSource);
		expect(generated).toContain(`DESKTOP_EXPECTED_PROTOCOL = ${fromSource};`);
	});

	it("纯壳包读不到 server 源码：壳侧只能靠生成常量，不能 import 服务端", () => {
		expect(generated).not.toContain('from "../server/');
		expect(expectedKernelMinShell()).toBe(1);
	});
});
