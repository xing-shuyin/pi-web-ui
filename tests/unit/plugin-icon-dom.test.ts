// @vitest-environment jsdom
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeIconSvg } from "../../server/icon-svg.js";
import { isAllowedIconAttr, isAllowedIconTag, sanitizeIconSvg } from "../../web/src/plugin-icon.js";

const ICON_24 =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>';

describe("sanitizeIconSvg（jsdom：DOM 分支）", () => {
	it("合法图标原样保留（含大小写敏感属性 viewBox）", () => {
		const out = sanitizeIconSvg(ICON_24);
		expect(out).toBeTruthy();
		expect(out).toContain('viewBox="0 0 24 24"');
		expect(out).toContain('stroke-width="2"');
		expect(out).toContain("<path");
	});

	it("大小写敏感标签与属性不被剥掉（clipPath / linearGradient / gradientUnits）", () => {
		const icon =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
			'<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="16" y2="0">' +
			'<stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
			'<clipPath id="c"><rect x="0" y="0" width="8" height="8"/></clipPath>' +
			'<rect x="0" y="0" width="16" height="16" clip-path="url(#c)" fill="url(#g)"/></svg>';
		const out = sanitizeIconSvg(icon) ?? "";
		expect(out).toContain("<clipPath");
		expect(out).toContain("<linearGradient");
		expect(out).toContain("gradientUnits");
		expect(out).toContain('clip-path="url(#c)"');
	});

	it("事件处理器 / script / foreignObject 仍然拦（安全口径不放松）", () => {
		const withHandler = ICON_24.replace("<path", '<path onclick="alert(1)"');
		expect(sanitizeIconSvg(withHandler)).not.toContain("onclick");

		const withScript = ICON_24.replace("</svg>", "<script>alert(1)</script></svg>");
		expect(sanitizeIconSvg(withScript)).not.toContain("<script");

		const withForeign = ICON_24.replace(
			"</svg>",
			'<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject></svg>',
		);
		const out = sanitizeIconSvg(withForeign) ?? "";
		expect(out).not.toContain("foreignObject");
		expect(out).not.toContain("<div");
	});

	it("javascript: 协议的值被剥掉", () => {
		const out = sanitizeIconSvg(ICON_24.replace("<path", '<path fill="javascript:alert(1)"')) ?? "";
		expect(out).not.toContain("javascript:");
	});

	it("vscode-editor 真实图标（manifest / catalog 同串）过 sanitize 后仍带 viewBox", () => {
		const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
		const manifest = JSON.parse(readFileSync(join(root, "plugins", "vscode-editor", "manifest.json"), "utf8")) as {
			iconSvg?: string;
		};
		const catalog = JSON.parse(readFileSync(join(root, "plugins", "catalog.json"), "utf8")) as {
			id: string;
			iconSvg?: string;
		}[];
		const entry = catalog.find((e) => e.id === "vscode-editor");
		expect(entry?.iconSvg).toBe(manifest.iconSvg);
		const out = sanitizeIconSvg(manifest.iconSvg) ?? "";
		expect(out).toMatch(/viewBox="0 0 24 24"/);
	});
});

const FILLED_ICON_EXEMPTIONS = new Set(["notes"]);
describe("内置插件统一线条图标", () => {
	const pluginsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins");
	const dirs = readdirSync(pluginsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(pluginsDir, d.name, "manifest.json")))
		.map((d) => d.name);
	const manifests = dirs.map((dir) => ({
		dir,
		manifest: JSON.parse(readFileSync(join(pluginsDir, dir, "manifest.json"), "utf8")) as {
			id?: string;
			icon?: string;
			iconSvg?: string;
		},
	}));
	const catalog = JSON.parse(readFileSync(join(pluginsDir, "catalog.json"), "utf8")) as {
		id: string;
		icon?: string;
		iconSvg?: string;
	}[];

	it("每个内置插件都声明了 iconSvg（不再只靠 emoji）", () => {
		expect(manifests.filter((m) => !m.manifest.iconSvg).map((m) => m.dir)).toEqual([]);
	});

	it("每个 iconSvg 都过服务端校验，且 sanitize 后带 viewBox + 是线条风格", () => {
		for (const { dir, manifest } of manifests) {
			const raw = manifest.iconSvg ?? "";
			expect(normalizeIconSvg(raw), `${dir}: 过 server 校验`).toBeTruthy();
			const out = sanitizeIconSvg(raw) ?? "";
			expect(out, `${dir}: viewBox 必须活下来`).toContain('viewBox="');
			if (FILLED_ICON_EXEMPTIONS.has(dir)) {
				expect(out, `${dir}: 填充跟文字色`).toContain('fill="currentColor"');
			} else {
				expect(out, `${dir}: 线条描边跟文字色`).toContain('stroke="currentColor"');
				expect(out, `${dir}: 无填充`).toContain('fill="none"');
			}
			expect(manifest.icon, `${dir}: emoji 回落`).toBeTruthy();
		}
	});

	it("catalog 条目与插件 manifest 的 iconSvg 完全一致（同一串）", () => {
		for (const entry of catalog) {
			const m = manifests.find((x) => x.dir === entry.id || x.manifest.id === entry.id);
			if (!m) continue;
			expect(entry.iconSvg, `catalog:${entry.id}`).toBe(m.manifest.iconSvg);
		}
	});

	it("catalog 里有 iconSvg 的条目也得是线条风格", () => {
		for (const entry of catalog) {
			if (!entry.iconSvg) continue;
			const out = sanitizeIconSvg(entry.iconSvg) ?? "";
			if (FILLED_ICON_EXEMPTIONS.has(entry.id)) {
				expect(out, `catalog:${entry.id}`).toContain('fill="currentColor"');
			} else {
				expect(out, `catalog:${entry.id}`).toContain('stroke="currentColor"');
			}
		}
	});

	it("白名单必须覆盖所有内置图标用到的标签 / 属性", () => {
		const missing: string[] = [];
		const check = (who: string, svg: string) => {
			const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
			const walk = (el: Element) => {
				if (!isAllowedIconTag(el.tagName.toLowerCase())) missing.push(`${who}: 标签 <${el.tagName}>`);
				for (const attr of el.attributes) {
					if (!isAllowedIconAttr(attr.name)) missing.push(`${who}: 属性 ${attr.name}`);
				}
				for (const child of el.children) walk(child);
			};
			walk(doc.documentElement);
		};
		for (const { dir, manifest } of manifests) if (manifest.iconSvg) check(dir, manifest.iconSvg);
		for (const entry of catalog) if (entry.iconSvg) check(`catalog:${entry.id}`, entry.iconSvg);
		expect(missing).toEqual([]);
	});

	it("sanitize 后不丢任何几何属性（points / ry 等）", () => {
		const runTrace = manifests.find((m) => m.dir === "run-trace")?.manifest.iconSvg ?? "";
		expect(runTrace).toContain("polyline");
		expect(sanitizeIconSvg(runTrace) ?? "").toContain("points=");
		const dbClient = manifests.find((m) => m.dir === "db-client")?.manifest.iconSvg ?? "";
		expect(sanitizeIconSvg(dbClient) ?? "").toContain('ry="');
	});
});
