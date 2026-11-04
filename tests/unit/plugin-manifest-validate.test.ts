import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { validatePluginManifest, KNOWN_PERMISSION_FAMILIES } from "../../server/plugin-manifest-validate.js";
import { parseUiContributions, parseUiItem } from "../../server/plugins.js";

const PLUGINS_DIR = fileURLToPath(new URL("../../plugins", import.meta.url));

describe("P1-6 manifest 校验失败即拒", () => {
	it("旧插件（无 permissions/apiVersion）放行", () => {
		const v = validatePluginManifest({ name: "x" }, "x");
		expect(v.errors).toEqual([]);
		expect(v.apiVersion).toBe(1);
		expect(v.strict).toBe(false);
	});

	it("非对象即拒", () => {
		expect(validatePluginManifest(null, "x").errors.length).toBeGreaterThan(0);
		expect(validatePluginManifest("str", "x").errors.length).toBeGreaterThan(0);
	});

	it("id 与目录不一致即拒；非法字符即拒", () => {
		expect(validatePluginManifest({ id: "other" }, "x").errors.some((e) => e.path === "id")).toBe(true);
		expect(validatePluginManifest({ id: "bad id!" }, "x").errors.some((e) => e.path === "id")).toBe(true);
		expect(validatePluginManifest({ id: "x" }, "x").errors).toEqual([]);
	});

	it("apiVersion 非整数即拒", () => {
		expect(validatePluginManifest({ apiVersion: "2" }, "x").errors.some((e) => e.path === "apiVersion")).toBe(true);
		expect(validatePluginManifest({ apiVersion: 0 }, "x").errors.some((e) => e.path === "apiVersion")).toBe(true);
	});

	it("v2 无 permissions 即拒；未来版本（v3+）不抢版本门的错误", () => {
		const v = validatePluginManifest({ apiVersion: 2 }, "x");
		expect(v.errors.some((e) => e.path === "permissions")).toBe(true);
		expect(v.strict).toBe(true);
		// v3 交给 activate/scan 的版本门出“请升级”，校验层不提前拒。
		const future = validatePluginManifest({ apiVersion: 99 }, "x");
		expect(future.errors.some((e) => e.path === "permissions")).toBe(false);
	});

	it("未知能力族即拒（拼写错了永远授权失败，不该静默）", () => {
		const v = validatePluginManifest({ permissions: ["tils"] }, "x");
		expect(v.errors.some((e) => e.path === "permissions[0]")).toBe(true);
	});

	it("已知能力族全过（含 notify / storage / secrets）", () => {
		for (const f of KNOWN_PERMISSION_FAMILIES) {
			const v = validatePluginManifest({ permissions: [f] }, "x");
			expect(v.errors).toEqual([]);
		}
		expect(KNOWN_PERMISSION_FAMILIES.has("notify")).toBe(true);
		expect(KNOWN_PERMISSION_FAMILIES.has("storage")).toBe(true);
		expect(KNOWN_PERMISSION_FAMILIES.has("secrets")).toBe(true);
		// 验证 imessage 等官方机器人插件的完整声明在 v2 严格模式下通过
		const botManifest = {
			apiVersion: 2,
			name: "imessage",
			permissions: ["ui", "tools", "notify", "storage", "secrets", "llm", "chat"],
		};
		const vBot = validatePluginManifest(botManifest, "imessage");
		expect(vBot.errors).toEqual([]);
	});

	it("有 ui 声明却无 ui 能力（严格模式）即拒", () => {
		const v = validatePluginManifest({ permissions: ["fs"], ui: { topbar: [] } }, "x");
		expect(v.errors.some((e) => e.path === "ui")).toBe(true);
		const ok = validatePluginManifest({ permissions: ["ui"], ui: { topbar: [] } }, "x");
		expect(ok.errors).toEqual([]);
	});

	it("坏类型字段只警告不阻断", () => {
		const v = validatePluginManifest({ name: 123, view: "yes", renderers: "x" }, "x");
		expect(v.errors).toEqual([]);
		expect(v.warnings.length).toBeGreaterThan(0);
	});

	it("permissions 非数组 / ui 非对象即拒", () => {
		expect(validatePluginManifest({ permissions: "ui" }, "x").errors.length).toBeGreaterThan(0);
		expect(validatePluginManifest({ permissions: ["ui"], ui: 123 }, "x").errors.some((e) => e.path === "ui")).toBe(
			true,
		);
	});

	it("所有内置官方插件 manifest.json 通过校验且入口不跨目录 import 其他插件 (#622)", () => {
		const entries = readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
		expect(entries.length).toBeGreaterThan(0);
		for (const dir of entries) {
			const manifestPath = join(PLUGINS_DIR, dir.name, "manifest.json");
			if (!existsSync(manifestPath)) continue;
			const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
			const v = validatePluginManifest(raw, dir.name);
			expect(v.errors, `plugins/${dir.name}/manifest.json validation errors`).toEqual([]);
			if (typeof raw.server === "string" && raw.server) {
				const serverEntry = join(PLUGINS_DIR, dir.name, raw.server);
				if (existsSync(serverEntry)) {
					const code = readFileSync(serverEntry, "utf8");
					expect(
						/from\s+["']\.\.\//.test(code),
						`plugins/${dir.name}/${raw.server} must not import across plugin directories (../)`,
					).toBe(false);
				}
			}
		}
	});

	it("所有注册 HTTP 路由的内置官方插件必须在 manifest.json 中声明 http 权限 (#645)", () => {
		const entries = readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
		for (const dir of entries) {
			const manifestPath = join(PLUGINS_DIR, dir.name, "manifest.json");
			if (!existsSync(manifestPath)) continue;
			const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as { permissions?: string[]; server?: unknown };
			const perms = new Set(raw.permissions ?? []);

			const serverCandidates = [
				"index.mjs",
				"server.mjs",
				"server/index.mjs",
				typeof raw.server === "string" ? raw.server : undefined,
			].filter((f): f is string => typeof f === "string" && Boolean(f));

			for (const file of serverCandidates) {
				const fullPath = join(PLUGINS_DIR, dir.name, file);
				if (!existsSync(fullPath)) continue;
				const code = readFileSync(fullPath, "utf8");
				if (/\bhost\s*\.\s*(route|registerProxy)\b/.test(code)) {
					expect(
						perms.has("http"),
						`插件 plugins/${dir.name} 在 ${file} 中调用了 host.route/registerProxy，但 manifest.permissions 缺少 "http" 能力声明`,
					).toBe(true);
				}
			}
		}
	});

	it("所有内置官方插件 manifest.ui 解析不得产生任何诊断警告（零未知 slot group / 丢弃）", () => {
		const entries = readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
		for (const dir of entries) {
			const manifestPath = join(PLUGINS_DIR, dir.name, "manifest.json");
			if (!existsSync(manifestPath)) continue;
			const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as { ui?: unknown };
			if (!raw.ui) continue;
			const diags: string[] = [];
			parseUiContributions(raw.ui, diags);
			expect(diags, `plugins/${dir.name}/manifest.json ui diagnostics`).toEqual([]);
		}
	});

	it("UI slot 别名支持 statusBar/statusbar/footer/bottom 映射至 bottombar", () => {
		const diags: string[] = [];
		const res = parseUiContributions(
			{
				statusBar: [{ id: "test-status", label: "Status" }],
				footer: [{ id: "test-footer", label: "Footer" }],
			},
			diags,
		);
		expect(diags).toEqual([]);
		expect(res?.items.every((it) => it.slot === "bottombar")).toBe(true);
	});

	it("UI 条目解析兼容 title 回落为 hint，且兼容 action={type:'view',viewId} 形式", () => {
		const diags: string[] = [];
		const item = parseUiItem(
			{
				id: "sample",
				label: "Sample",
				title: "Sample Title",
				action: { type: "view", viewId: "my-plugin" },
			},
			"bottombar",
			diags,
		);
		expect(diags).toEqual([]);
		expect(item).toBeDefined();
		expect(item?.hint).toBe("Sample Title");
		expect(item?.kind).toBe("view");
		expect(item?.view).toBe("plugin:my-plugin");
	});

	it("存量历史插件含 views/commands/statusBar 结构时零诊断警告且能正确解析（向后全兼容）", () => {
		const legacyUi = {
			views: [{ id: "discord", label: "Discord", icon: "🎮" }],
			topbar: [
				{
					id: "discord-open",
					label: "Discord",
					icon: "🎮",
					action: { type: "view", viewId: "discord" },
					order: 60,
				},
			],
			statusBar: [
				{
					id: "discord-status",
					label: "🎮 Discord",
					title: "点击打开 Discord 工作台",
					action: { type: "view", viewId: "discord" },
					order: 50,
				},
			],
			commands: [
				{
					id: "open",
					label: "打开 Discord 工作台",
					icon: "🎮",
					action: { type: "view", viewId: "discord" },
				},
			],
		};
		const diags: string[] = [];
		const res = parseUiContributions(legacyUi, diags);

		// 彻底消除未知 slot group 报警
		expect(diags).toEqual([]);
		expect(res?.items.length).toBe(2);

		const topbarItem = res?.items.find((it) => it.id === "discord-open");
		expect(topbarItem).toBeDefined();
		expect(topbarItem?.slot).toBe("topbar.primary");
		expect(topbarItem?.kind).toBe("view");
		expect(topbarItem?.view).toBe("plugin:discord");

		const statusItem = res?.items.find((it) => it.id === "discord-status");
		expect(statusItem).toBeDefined();
		expect(statusItem?.slot).toBe("bottombar");
		expect(statusItem?.kind).toBe("view");
		expect(statusItem?.view).toBe("plugin:discord");
		expect(statusItem?.hint).toBe("点击打开 Discord 工作台");
	});
});
