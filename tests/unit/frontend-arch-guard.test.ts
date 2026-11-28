/**
 * 前端架构守卫：棘轮上限（只许变小，不许变大）。
 * 防止上帝组件 / 巨型样式继续膨胀，推动按功能域垂直切片。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** 存量巨型文件的行数棘轮上限（只许随拆分下调，禁止上调）。 */
const FILE_LINE_RATCHET: Record<string, number> = {
	"web/src/styles.css": 41590,
	"web/src/components/SettingsModal.tsx": 5027,
	"web/src/App.tsx": 3980,
	"web/src/components/LeftPanel.tsx": 3846,
	"web/src/use-chat.ts": 3555,
	"web/src/components/ChatInput.tsx": 2325,
	"web/src/components/Message.tsx": 2291,
	"web/src/components/ModelConfigModal.tsx": 2163,
	"web/src/components/SCMPanel.tsx": 2104,
};

function countLines(relPath: string): number {
	return readFileSync(join(ROOT, relPath), "utf8").split(/\r?\n/).length;
}

describe("前端架构体积棘轮守卫", () => {
	for (const [relPath, maxLines] of Object.entries(FILE_LINE_RATCHET)) {
		it(`${relPath} 行数不超过 ${maxLines}`, () => {
			expect(countLines(relPath)).toBeLessThanOrEqual(maxLines);
		});
	}
});
