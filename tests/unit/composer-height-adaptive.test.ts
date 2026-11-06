import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHAT_INPUT_SRC = readFileSync(join(ROOT, "web/src/components/ChatInput.tsx"), "utf8");

describe("输入框高度自适应与手动拉高交互规则", () => {
	it("COMPOSER_MAX_H 必须是有安全保护的紧凑值（<=360px），绝不能是 720px 遮挡正文", () => {
		const match = /const\s+COMPOSER_MAX_H\s*=\s*(\d+);/.exec(CHAT_INPUT_SRC);
		expect(match, "ChatInput.tsx 中必须定义 COMPOSER_MAX_H").not.toBeNull();
		const maxH = Number(match![1]);
		expect(maxH).toBeLessThanOrEqual(360);
		expect(maxH).toBeGreaterThanOrEqual(240);
	});

	it("必须定义安全视口截断函数 getComposerSafeMaxH() 防止在大屏或小屏上遮蔽正文", () => {
		expect(CHAT_INPUT_SRC).toContain("function getComposerSafeMaxH()");
		expect(CHAT_INPUT_SRC).toContain("window.innerHeight");
	});

	it("手动拖拽拉高后必须固定高度（不自适应），最低高度开始写才自适应", () => {
		expect(CHAT_INPUT_SRC).toContain("isManualFixed");
		expect(CHAT_INPUT_SRC).toMatch(/if\s*\(isManualFixed\)\s*\{\s*h\s*=\s*Math\.min\(composerH,\s*maxCap\);/);
		expect(CHAT_INPUT_SRC).toMatch(/h\s*=\s*Math\.min\(Math\.max\(naturalH,\s*COMPOSER_MIN_H\),\s*maxCap\);/);
	});

	it("拖拽回最低高度时必须自动解除固定，恢复最低高度自适应并清除持久化", () => {
		expect(CHAT_INPUT_SRC).toContain("next <= COMPOSER_MIN_H + 4");
		expect(CHAT_INPUT_SRC).toContain("localStorage.removeItem(COMPOSER_H_KEY)");
	});

	it("手柄必须具备悬浮提示（.composer-resize-tip），提示双击复位自适应与状态区分", () => {
		expect(CHAT_INPUT_SRC).toContain('className="composer-resize-tip"');
		expect(CHAT_INPUT_SRC).toContain('t("composerResizeFixed")');
		expect(CHAT_INPUT_SRC).toContain('t("composerResize")');
	});
});
