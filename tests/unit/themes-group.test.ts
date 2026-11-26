import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listThemes, resolveThemeFile } from "../../server/themes.js";

const BUILTIN_DIR = join(__dirname, "../../themes");
const NON_EXISTENT_USER_DIR = join(__dirname, "../../tests/fixtures/non-existent");

describe("主题分组与默认内置主题测试", () => {
	it("listThemes 能够扫描出默认内置主题 极简行文·苏黎世纯黑 (flow-zurich)", () => {
		const themes = listThemes(BUILTIN_DIR, NON_EXISTENT_USER_DIR);
		const byId = new Map(themes.map((t) => [t.id, t]));
		expect(byId.has("flow-zurich")).toBe(true);
		expect(byId.get("flow-zurich")?.builtin).toBe(true);
		expect(byId.get("flow-zurich")?.group).toBe("builtin");
		expect(byId.get("flow-zurich")?.scheme).toBe("dark");
		expect(byId.get("flow-zurich")?.name).toBe("极简行文 · 苏黎世纯黑");
	});

	it("resolveThemeFile 能解析 flow-zurich 以及用户目录安装的社区主题", () => {
		const zurich = resolveThemeFile(BUILTIN_DIR, NON_EXISTENT_USER_DIR, "flow-zurich");
		expect(zurich).toBeTruthy();
		expect(zurich).toContain("flow-zurich.css");

		const userDir = mkdtempSync(join(tmpdir(), "pi-user-themes-"));
		try {
			mkdirSync(userDir, { recursive: true });
			writeFileSync(
				join(userDir, "tokyo-night.css"),
				"/* theme-name: Tokyo Night */\n:root { color-scheme: dark; --bg: #1a1b26; }\n",
				"utf8",
			);
			const themes = listThemes(BUILTIN_DIR, userDir);
			const community = themes.find((t) => t.id === "tokyo-night");
			expect(community).toBeTruthy();
			expect(community?.builtin).toBe(false);
			expect(community?.scheme).toBe("dark");
			expect(resolveThemeFile(BUILTIN_DIR, userDir, "tokyo-night")).toBe(join(userDir, "tokyo-night.css"));
		} finally {
			rmSync(userDir, { recursive: true, force: true });
		}
	});
});
