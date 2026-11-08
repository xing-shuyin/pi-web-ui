import { describe, expect, it } from "vitest";
import { SessionIdentityIndex, sessionIdentityKeys, sessionLookupKeys } from "../../web/src/session-identity.js";

/**
 * 左栏会话身份单源守卫。
 *
 * 引擎下发的会话身份形式不统一：
 * - pi：`{ sessionFile: "…/<ts>_<uuid>.jsonl", sessionId: "<uuid>" }`
 * - universal 底座（claude / codex）：`{ path|id: "<conversation id>" }`，没有文件
 * 左栏靠这组键把「运行中对话」和「历史会话」认成同一条；键的语义一旦漂移，
 * 同一条会话就会在左栏出现两行（见 left-panel-universal-dedupe.test.ts）。
 */

const FILE = "E:\\pi-web-ui\\.sessions\\2026-11-05T07-06-40-090Z_01a1aa87-f85a-73f5-895d-f444ccb37fb1.jsonl";
const UUID = "01a1aa87-f85a-73f5-895d-f444ccb37fb1";

describe("sessionIdentityKeys", () => {
	it("文件型会话的文件身份与 id 身份互相覆盖", () => {
		const fileKeys = sessionIdentityKeys({ path: FILE });
		const idKeys = sessionIdentityKeys({ id: UUID, sessionId: UUID });
		expect(fileKeys.some((k) => idKeys.includes(k))).toBe(true);
	});

	it("路径大小写 / 反斜杠归一化后等价", () => {
		const a = sessionIdentityKeys({ sessionFile: FILE });
		const b = sessionIdentityKeys({ sessionFile: FILE.toLowerCase().replace(/\\/g, "/") });
		expect(a).toEqual(b);
	});

	it("会话 id 直接当 path 用时能自洽对齐", () => {
		const convKeys = sessionIdentityKeys({ id: "conv-1", sessionId: "conv-1" });
		const sessionKeys = sessionIdentityKeys({ path: "conv-1", sessionId: "conv-1" });
		expect(convKeys.filter((k) => sessionKeys.includes(k)).length).toBeGreaterThan(0);
	});

	it("不同会话不会互相误判（同目录不同文件 / 同名文件不同目录）", () => {
		const a = sessionIdentityKeys({ path: "E:/w/.sessions/a.jsonl", sessionId: "sid-a" });
		const b = sessionIdentityKeys({ path: "E:/w/.sessions/b.jsonl", sessionId: "sid-b" });
		expect(a.filter((k) => b.includes(k))).toEqual([]);
		// 同名文件不同目录：裸文件名只出现在弱键里，强键不复用
		const c = sessionIdentityKeys({ path: "E:/w2/.sessions/a.jsonl" });
		expect(a.filter((k) => c.includes(k))).toEqual([]);
	});

	it("空输入不产生身份键", () => {
		expect(sessionIdentityKeys({})).toEqual([]);
		expect(sessionIdentityKeys({ id: "  ", sessionId: "", path: null })).toEqual([]);
	});
});

describe("sessionLookupKeys", () => {
	it("额外提供裸文件名，供运行态关联兜底", () => {
		const keys = sessionLookupKeys({ path: FILE });
		expect(keys.some((k) => k.startsWith("fn:"))).toBe(true);
		expect(sessionIdentityKeys({ path: FILE }).some((k) => k.startsWith("fn:"))).toBe(false);
	});
});

describe("SessionIdentityIndex", () => {
	it("任一键命中即视为同一条会话", () => {
		const index = new SessionIdentityIndex<string>();
		index.add({ id: "conv-1", sessionId: "conv-1" }, "open");
		expect(index.get({ path: "conv-1" })).toBe("open");
		expect(index.get({ path: "conv-2" })).toBeUndefined();
	});

	it("先到先得：已占位的历史行不会被后来的重复行覆盖", () => {
		const index = new SessionIdentityIndex<string>();
		index.add({ sessionId: "sid-1" }, "first");
		index.add({ sessionId: "sid-1" }, "second");
		expect(index.get({ sessionId: "sid-1" })).toBe("second");
		expect(index.size).toBe(1);
	});
});
