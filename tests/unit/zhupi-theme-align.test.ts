import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const zhupiCss = readFileSync(join(ROOT, "themes/zhupi.css"), "utf8");
const zhupiDarkCss = readFileSync(join(ROOT, "themes/zhupi-dark.css"), "utf8");

describe("朱批与朱批·夜主题消息区左右对齐守卫", () => {
	it("zhupi.css 消息区移除墨线活动脊与内缩偏移，左右边缘与输入框对齐", () => {
		expect(zhupiCss).not.toMatch(/\.messages\s*\{[^}]*background-image/);
		expect(zhupiCss).not.toMatch(/\.messages\s*\{[^}]*padding-inline/);
		expect(zhupiCss).not.toMatch(/\.messages\s*\{[^}]*padding-left/);
	});

	it("zhupi-dark.css 消息区移除墨线活动脊与内缩偏移，左右边缘与输入框对齐", () => {
		expect(zhupiDarkCss).not.toMatch(/\.messages\s*\{[^}]*background-image/);
		expect(zhupiDarkCss).not.toMatch(/\.messages\s*\{[^}]*padding-inline/);
		expect(zhupiDarkCss).not.toMatch(/\.messages\s*\{[^}]*padding-left/);
	});
});
