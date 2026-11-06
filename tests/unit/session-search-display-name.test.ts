import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../server/protocol";
import { UniversalSession } from "../../server/universal/universal-session";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function resolveDisplayTitle(s: Partial<SessionSummary> & { path: string }): string {
	return (
		s.displayName ||
		s.name ||
		s.firstMessage?.trim() ||
		(s.path.split(/[\\/]/).pop() || s.path).replace(/\.jsonl$/i, "")
	);
}

describe("会话标题回退规则（issue #644）", () => {
	it("优先使用权威 displayName", () => {
		const session = {
			path: "/path/to/2026-03-12-abc.jsonl",
			displayName: "权威计算的标题",
			name: "手动设置的名字",
			firstMessage: "用户的第一句话",
		};
		expect(resolveDisplayTitle(session)).toBe("权威计算的标题");
	});

	it("无 displayName 时优先使用显式 name", () => {
		const session = {
			path: "/path/to/2026-03-12-abc.jsonl",
			name: "手动设置的名字",
			firstMessage: "用户的第一句话",
		};
		expect(resolveDisplayTitle(session)).toBe("手动设置的名字");
	});

	it("绝大多数未手动重命名的历史会话，优先展示 firstMessage，而非裸文件名", () => {
		const session = {
			path: "/path/to/2026-03-12-abc.jsonl",
			firstMessage: "帮我实现一个快速排序",
		};
		expect(resolveDisplayTitle(session)).toBe("帮我实现一个快速排序");
	});

	it("全部为空时，回退到去除 .jsonl 的文件名", () => {
		const session = {
			path: "/path/to/2026-03-12-abc.jsonl",
		};
		expect(resolveDisplayTitle(session)).toBe("2026-03-12-abc");
	});

	it("Windows 路径分隔符也能正确处理文件名回退", () => {
		const session = {
			path: "C:\\Users\\user\\.pi\\sessions\\2026-03-12-xyz.jsonl",
		};
		expect(resolveDisplayTitle(session)).toBe("2026-03-12-xyz");
	});
});

describe("Universal 引擎 resolveSessionDisplayName", () => {
	it("用户显式命名优先", () => {
		const session = Object.assign(Object.create(UniversalSession.prototype), {
			lang: "zh",
		});
		const conv: any = { title: "自定义分析方案", messages: [] };
		expect(session.resolveSessionDisplayName(conv, "第一句话")).toBe("自定义分析方案");
	});

	it("未重命名时取 firstMessage 并截断", () => {
		const session = Object.assign(Object.create(UniversalSession.prototype), {
			lang: "zh",
		});
		const conv: any = { title: "新对话", messages: [] };
		const longMsg = "这是一条非常长非常长非常长非常长非常长非常长非常长非常长的用户提问消息内容";
		const res = session.resolveSessionDisplayName(conv, longMsg);
		expect(res.endsWith("…")).toBe(true);
		expect(res.length).toBeLessThanOrEqual(32);
	});
});

describe("品牌徽标固定样式与全主题/纯图标模式守护", () => {
	it("styles.css 中的 .brand-logo 与 .bar-item-brand-logo 固定使用紫色渐变与 #fff 白色字体", () => {
		const css = readFileSync(join(ROOT, "web/src/styles.css"), "utf8");
		const logoMatch = /\.brand-logo\s*\{([^}]+)\}/.exec(css);
		expect(logoMatch).not.toBeNull();
		const logoBlock = logoMatch![1];
		expect(logoBlock).toContain("#8b5cf6");
		expect(logoBlock).toContain("#6366f1");
		expect(logoBlock).toContain("color: #fff");

		const barLogoMatch = /\.bar-item-brand-logo\s*\{([^}]+)\}/.exec(css);
		expect(barLogoMatch).not.toBeNull();
		const barLogoBlock = barLogoMatch![1];
		expect(barLogoBlock).toContain("#8b5cf6");
		expect(barLogoBlock).toContain("#6366f1");
		expect(barLogoBlock).toContain("color: #fff");
	});

	it("纯图标模式（.topbar.no-labels）下品牌徽标保持展示且不被塑形为 28px 圆形", () => {
		const css = readFileSync(join(ROOT, "web/src/styles.css"), "utf8").replace(/^\t/gm, "");
		expect(css).toContain(".topbar.no-labels .bar-item.brand");
		expect(css).toContain(".topbar.no-labels .bar-item-brand");
		expect(css).toContain(
			".topbar.no-labels .bar-item-brand > .brand-logo,\n.topbar.no-labels .bar-item-brand > .bar-item-brand-logo {\n\tdisplay: inline-flex;\n}",
		);
	});

	it("themes/*.css 中不得覆盖 .brand-logo，保证品牌徽标不受主题影响", () => {
		const { readdirSync } = require("node:fs");
		const themesDir = join(ROOT, "themes");
		const themeFiles = readdirSync(themesDir).filter((f: string) => f.endsWith(".css"));
		for (const file of themeFiles) {
			const content = readFileSync(join(themesDir, file), "utf8");
			expect(content).not.toMatch(/\.brand-logo\s*\{/);
			expect(content).not.toMatch(/\.brand-logo\s*,/);
		}
	});
});
