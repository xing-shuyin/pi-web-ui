import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	applyExtensionCompat,
	compatPages,
	compatVersionOf,
	COMPAT_SCRIPT,
	COMPAT_SCRIPT_FILE,
	COMPAT_SW_FILE,
	COMPAT_VERSION,
	isInside,
	withCompatHtml,
	withCompatManifest,
} from "../../browser/runtime/extension-compat.js";

const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "pi-compat-test-"));

describe("withCompatManifest", () => {
	it("把 MV3 service worker 换成兼容层入口，并保留原字段", () => {
		const patched = withCompatManifest({
			manifest_version: 3,
			name: "x",
			background: { service_worker: "background/index.js", type: "module" },
		});
		expect(patched.background).toEqual({ service_worker: COMPAT_SW_FILE, type: "module" });
		expect(patched.name).toBe("x");
	});

	it("MV2 的 background.scripts 在最前面插一行 shim", () => {
		expect(
			(
				withCompatManifest({ manifest_version: 2, background: { scripts: ["bg.js"] } }).background as {
					scripts: string[];
				}
			).scripts,
		).toEqual([COMPAT_SCRIPT_FILE, "bg.js"]);
	});

	it("content_scripts 逐个插入，但 world=MAIN 的不插（那里本来没有 chrome.*）", () => {
		const patched = withCompatManifest({
			manifest_version: 3,
			content_scripts: [
				{ matches: ["<all_urls>"], js: ["inject/proxy.js"], world: "MAIN" },
				{ matches: ["<all_urls>"], js: ["inject/fallback.js", "inject/index.js"] },
			],
		}) as { content_scripts: { js: string[] }[] };
		expect(patched.content_scripts[0].js).toEqual(["inject/proxy.js"]);
		expect(patched.content_scripts[1].js).toEqual([COMPAT_SCRIPT_FILE, "inject/fallback.js", "inject/index.js"]);
	});

	it("重复应用不会插第二遍，也不改入参", () => {
		const input = { manifest_version: 3, content_scripts: [{ matches: ["*://*/*"], js: ["a.js"] }] };
		const once = withCompatManifest(input);
		expect(withCompatManifest(once)).toEqual(once);
		expect(input.content_scripts[0].js).toEqual(["a.js"]);
	});
});

describe("compatPages", () => {
	it("收集弹窗与选项页并去重，只要 html", () => {
		expect(
			compatPages({
				action: { default_popup: "ui/popup/index.html" },
				browser_action: { default_popup: "ui/popup/index.html" },
				options_ui: { page: "ui/popup/index.html" },
				options_page: "options.html",
				side_panel: { default_path: "panel.html" },
			}),
		).toEqual(["ui/popup/index.html", "options.html"]);
	});

	it("没有页面声明时是空列表", () => {
		expect(compatPages({ manifest_version: 3 })).toEqual([]);
	});
});

describe("withCompatHtml", () => {
	it("插在 head 之后，且只插一次", () => {
		const once = withCompatHtml('<html><head><meta charset="utf-8"></head><body></body></html>');
		expect(once).toContain(`<script src="/${COMPAT_SCRIPT_FILE}"></script>`);
		expect(once.indexOf(COMPAT_SCRIPT_FILE)).toBeLessThan(once.indexOf("</head>"));
		expect(withCompatHtml(once)).toBe(once);
	});

	it("没有 head 就插在 html 之后", () => {
		expect(withCompatHtml("<html><body>x</body></html>")).toMatch(/<html>\s*<script/);
	});

	it("连 html 都没有的极简页面：插在 doctype 之后（落在隐式 head 里）", () => {
		expect(withCompatHtml("<!doctype html><title>t</title><body>x</body>")).toMatch(/^<!doctype html>\s*<script/);
		expect(withCompatHtml("<!doctype html><title>t</title>")).toContain(COMPAT_SCRIPT_FILE);
	});

	it("完全裸的文档也插在最前面（不能因为没写 html 就漏掉）", () => {
		expect(withCompatHtml("plain text")).toMatch(/^\s*<script src="\/__pi-compat\.js"><\/script>/);
	});
});

describe("isInside", () => {
	it("只有真正的子目录才算", () => {
		expect(isInside("/root", "/root/a")).toBe(true);
		expect(isInside("/root", "/root")).toBe(false);
		expect(isInside("/root", "/other/a")).toBe(false);
	});
});

describe("applyExtensionCompat", () => {
	const fixture = async (): Promise<string> => {
		const root = await tempDir();
		await writeFile(
			join(root, "manifest.json"),
			JSON.stringify(
				{
					manifest_version: 3,
					name: "Compat fixture",
					version: "1.0.0",
					background: { service_worker: "background/index.js" },
					action: { default_popup: "ui/popup/index.html" },
					content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"], run_at: "document_start" }],
				},
				null,
				1,
			),
			"utf8",
		);
		await mkdir(join(root, "background"), { recursive: true });
		await writeFile(join(root, "background", "index.js"), "// original", "utf8");
		await mkdir(join(root, "ui", "popup"), { recursive: true });
		await writeFile(join(root, "ui", "popup", "index.html"), "<html><head></head><body></body></html>", "utf8");
		await writeFile(join(root, "content.js"), "// content", "utf8");
		return root;
	};

	it("写入 shim、包住 SW、改写 manifest、注入页面，并留下版本标记", async () => {
		const root = await fixture();
		expect(await applyExtensionCompat(root)).toBe(true);
		expect(await readFile(join(root, COMPAT_SCRIPT_FILE), "utf8")).toContain("pi-web-ui extension compatibility shim");
		expect(await readFile(join(root, COMPAT_SW_FILE), "utf8")).toContain(
			'importScripts("__pi-compat.js", "background/index.js")',
		);
		const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
		expect(manifest.background.service_worker).toBe(COMPAT_SW_FILE);
		expect(manifest.content_scripts[0].js).toEqual([COMPAT_SCRIPT_FILE, "content.js"]);
		expect(await readFile(join(root, "ui", "popup", "index.html"), "utf8")).toContain(COMPAT_SCRIPT_FILE);
		expect(await readFile(join(root, "manifest.original.json"), "utf8")).toContain("background/index.js");
		expect(await compatVersionOf(root)).toBe(COMPAT_VERSION);
	});

	it("再跑一遍是幂等的（不会双重包 SW、不会插两次脚本）", async () => {
		const root = await fixture();
		await applyExtensionCompat(root);
		const first = await readFile(join(root, "manifest.json"), "utf8");
		await applyExtensionCompat(root);
		const second = await readFile(join(root, "manifest.json"), "utf8");
		expect(JSON.parse(second)).toEqual(JSON.parse(first));
		expect(await readFile(join(root, COMPAT_SW_FILE), "utf8")).toContain("background/index.js");
	});

	it("没有 manifest 的目录直接返回 false", async () => {
		const root = await tempDir();
		expect(await applyExtensionCompat(root)).toBe(false);
		expect(await compatVersionOf(root)).toBe(0);
	});
});

describe("COMPAT_SCRIPT", () => {
	it("不再自己造顶层命名空间：那块归 electron-chrome-extensions，且 chrome 已被 freeze", () => {
		expect(COMPAT_SCRIPT).not.toMatch(/api\.(windows|contextMenus|permissions|fontSettings|commands|action)\s*=/);
		expect(COMPAT_SCRIPT).not.toContain("namespace(");
	});

	it("补库没实现的 tabs 成员，并把 storage.sync 落到 local", () => {
		for (const member of ["captureVisibleTab", "duplicate", "move", "highlight", "discard"]) {
			expect(COMPAT_SCRIPT).toContain(member);
		}
		expect(COMPAT_SCRIPT).toContain("api.storage.sync = sync");
	});

	it("缺能力时不再假装成功：回调 undefined + 一次性警告", () => {
		expect(COMPAT_SCRIPT).toContain("is not implemented in this Electron build");
		expect(COMPAT_SCRIPT).not.toContain("callback(cb, true)");
	});

	it("版本号 ≥ 3（配合 electron-chrome-extensions 的新分工）", () => {
		expect(COMPAT_VERSION).toBeGreaterThanOrEqual(3);
	});
});
