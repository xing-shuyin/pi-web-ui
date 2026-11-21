/**
 * 协议版本单源守卫（细则见 `docs/agent-rules.md` §一「通信协议与数据安全」）。
 *
 * 判据三条：
 *   1. 版本号只写在 `server/protocol-version.ts`（前端 / 桌面壳都从这里取）。
 *   2. 前端视图 `web/src/protocol-version.ts` 只做 re-export，不许再写一个数字字面量——
 *      两侧各写一份时，谁后改谁生效，另一端会静默拿到旧值：要么误报 `protocolMismatch`，
 *      要么该拦的不兼容组合放过去。
 *   3. 两端取到的值必须相等。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION as SERVER_VERSION } from "../../server/protocol-version.js";
import { PROTOCOL_VERSION as WEB_VERSION } from "../../web/src/protocol-version.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("协议版本单源", () => {
	it("版本号是正整数，且两端一致", () => {
		expect(Number.isInteger(SERVER_VERSION)).toBe(true);
		expect(SERVER_VERSION).toBeGreaterThan(0);
		expect(WEB_VERSION).toBe(SERVER_VERSION);
	});

	it("前端只 re-export，不再写死数字", () => {
		const source = read("web/src/protocol-version.ts");
		expect(source).toContain("server/protocol-version.js");
		expect(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toMatch(/=\s*\d+/);
	});

	it("服务端是唯一写死数字的地方", () => {
		const source = read("server/protocol-version.ts");
		expect(source).toMatch(new RegExp(`export const PROTOCOL_VERSION = ${SERVER_VERSION};`));
	});

	it("桌面壳按 `export const PROTOCOL_VERSION = <数字>` 解析，格式不能被改坏", () => {
		expect(read("server/protocol-version.ts")).toMatch(/export const PROTOCOL_VERSION\s*=\s*\d+\s*;/);
	});
});
