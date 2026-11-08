import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 守卫：每个下发 `conversations` 的引擎都必须在推送里裁定左栏行归属（`rowKind`）。
 *
 * 客户端只读 `rowKind`（缺失时才退回旧的启发式兼容分支）。新引擎漏了就只显示半张列表，
 * 或同一条会话出现两行——所以这里按源码结构盯住调用点，而不是等 UI 报错。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENGINES = [
	"server/agent-service.ts", // pi（ClientSession）
	"server/universal/universal-session.ts", // claude / codex 底座
	"server/dsh/dsh-agent-service.ts", // DSH
];

describe("左栏行归属由引擎裁定", () => {
	it.each(ENGINES)("%s 在 conversations 推送里带 rowKind", (file) => {
		const source = readFileSync(join(root, file), "utf8");
		expect(source.includes('type: "conversations"'), `${file} 没有 conversations 推送`).toBe(true);
		expect(source.includes("conversationRowKind("), `${file} 没有用 conversationRowKind 裁定 rowKind`).toBe(true);
		expect(source.includes("rowKind:"), `${file} 的对话摘要缺 rowKind`).toBe(true);
	});

	it("客户端只在兼容分支里保留启发式", () => {
		const panel = readFileSync(join(root, "web/src/components/LeftPanel.tsx"), "utf8");
		expect(panel.includes('c.rowKind !== "history"')).toBe(true);
		expect(panel.includes("legacyOwnsRow")).toBe(true);
		// 启发式只允许出现在 legacyOwnsRow 内部
		const legacyAt = panel.indexOf("const legacyOwnsRow");
		expect(legacyAt).toBeGreaterThan(0);
		const body = panel.slice(legacyAt, panel.indexOf("};", legacyAt));
		expect(body.includes("pinned || c.nativeCli")).toBe(true);
		const before = panel.slice(0, legacyAt);
		expect(before.includes("c.pinned || c.nativeCli")).toBe(false);
	});
});
