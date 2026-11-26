import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	installCommunityTheme,
	OFFICIAL_THEME_CATALOG_URL,
	readThemeCatalog,
	syncThemeCatalog,
	uninstallCommunityTheme,
	validateThemeCss,
} from "../../server/theme-catalog.js";

const tempDirs: string[] = [];
function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-theme-catalog-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("社区主题目录与安装卸载 (server/theme-catalog.ts)", () => {
	it("validateThemeCss 允许正常主题 CSS（含 overscroll-behavior）并拦截危险脚本/远程 import", () => {
		expect(validateThemeCss(":root { --bg: #000; overscroll-behavior: contain; }").ok).toBe(true);
		expect(validateThemeCss("").ok).toBe(false);
		expect(validateThemeCss("<script>alert(1)</script>").ok).toBe(false);
		expect(validateThemeCss("body { background: url(javascript:alert(1)); }").ok).toBe(false);
		expect(validateThemeCss("body { width: expression(1+1); }").ok).toBe(false);
		expect(validateThemeCss("body { behavior: url(x.htc); }").ok).toBe(false);
		expect(validateThemeCss('@import "https://evil.example/x.css";').ok).toBe(false);
	});

	it("syncThemeCatalog 拉取并解析相对 cssUrl，readThemeCatalog 可读回快照", async () => {
		const dir = makeTempDir();
		const catalogPath = join(dir, "theme-catalog.json");
		const mockEntries = [
			{
				id: "tokyo-night",
				name: "东京夜色",
				nameEn: "Tokyo Night",
				author: "pi-web-ui",
				scheme: "dark",
				description: "经典暗蓝主题",
				palette: { bg: "#1a1b26", accent: "#7aa2f7", text: "#c0caf5" },
				cssUrl: "themes/tokyo-night/theme.css",
			},
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(mockEntries), { status: 200 })),
		);

		const res = await syncThemeCatalog(OFFICIAL_THEME_CATALOG_URL, catalogPath);
		expect(res.ok).toBe(true);
		expect(res.entries).toHaveLength(1);
		expect(res.entries![0]!.resolvedCssUrl).toBe(
			"https://xing-shuyin.github.io/pi-web-ui-plugins/themes/tokyo-night/theme.css",
		);

		const snap = readThemeCatalog(catalogPath);
		expect(snap.entries).toHaveLength(1);
		expect(snap.entries[0]!.id).toBe("tokyo-night");
	});

	it("installCommunityTheme 下载校验并落盘到用户主题目录，uninstallCommunityTheme 可卸载", async () => {
		const dir = makeTempDir();
		const catalogPath = join(dir, "theme-catalog.json");
		const userThemesDir = join(dir, "themes");
		writeFileSync(
			catalogPath,
			JSON.stringify({
				sourceUrl: OFFICIAL_THEME_CATALOG_URL,
				entries: [
					{
						id: "tokyo-night",
						name: "Tokyo Night",
						author: "pi-web-ui",
						scheme: "dark",
						description: "Tokyo Night",
						palette: { bg: "#1a1b26", accent: "#7aa2f7", text: "#c0caf5" },
						cssUrl: "themes/tokyo-night/theme.css",
					},
				],
			}),
			"utf8",
		);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(":root { color-scheme: dark; --bg: #1a1b26; }\n", { status: 200 })),
		);

		const inst = await installCommunityTheme("tokyo-night", userThemesDir, catalogPath);
		expect(inst.ok).toBe(true);
		const cssFile = join(userThemesDir, "tokyo-night.css");
		expect(existsSync(cssFile)).toBe(true);
		expect(readFileSync(cssFile, "utf8")).toContain("--bg: #1a1b26;");

		expect(uninstallCommunityTheme("tokyo-night", userThemesDir)).toBe(true);
		expect(existsSync(cssFile)).toBe(false);
		expect(uninstallCommunityTheme("tokyo-night", userThemesDir)).toBe(false);
	});
});
