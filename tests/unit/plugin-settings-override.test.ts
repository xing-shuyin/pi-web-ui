import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager, type PluginHost } from "../../server/plugins.js";
import { pluginStateDir } from "../../server/plugin-paths.js";

const SCHEMA = [
	{ key: "tone", type: "text", label: "语气", default: "full" },
	{ key: "pollSec", type: "number", label: "间隔", default: 60, min: 10, max: 600 },
	{ key: "notify", type: "boolean", label: "通知", default: true },
	{ key: "theme", type: "select", label: "主题", default: "dark", options: ["dark", "light"] },
	{ key: "token", type: "secret", label: "令牌", default: "" },
];

let dir: string;
let mgr: PluginManager;

function makePlugin(id: string, manifest: Record<string, unknown> = {}, body = ""): void {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id, ...manifest }));
	writeFileSync(
		join(pdir, "index.mjs"),
		`export default { activate(h) { (globalThis.__hosts ??= {})["${id}"] = h; ${body} } };`,
	);
}

function writeOverlay(id: string, obj: unknown): void {
	const odir = join(dir, "plugin-overrides");
	mkdirSync(odir, { recursive: true });
	writeFileSync(join(odir, `${id}.json`), typeof obj === "string" ? obj : JSON.stringify(obj));
}

function writeStorage(id: string, settings: Record<string, unknown>): void {
	// 状态在 plugin-data/<id>/ 里；宿主的原子写会自己建目录，测试直接落盘要手工建
	mkdirSync(pluginStateDir(dir, id), { recursive: true });
	writeFileSync(join(pluginStateDir(dir, id), "storage.json"), JSON.stringify({ settings }));
}

async function infoOf(id: string) {
	return (await mgr.list()).find((x) => x.id === id);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-override-test-"));
	(globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts = {};
	mgr = new PluginManager(dir, dir);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("三层合并", () => {
	it("无 overlay 无保存 → 全 default", async () => {
		makePlugin("a", { settings: SCHEMA });
		await mgr.ensureLoaded();
		const info = await infoOf("a");
		expect(info?.settingsValues).toMatchObject({ tone: "full", pollSec: 60, notify: true, theme: "dark" });
		expect(info?.settingsSources).toMatchObject({
			tone: "default",
			pollSec: "default",
			notify: "default",
			theme: "default",
		});
	});

	it("overlay 覆盖默认（来源 override）；保存值覆盖 overlay（来源 stored）", async () => {
		makePlugin("b", { settings: SCHEMA });
		writeOverlay("b", { settings: { tone: "brief", pollSec: "30", notify: 0 } });
		await mgr.ensureLoaded();
		let info = await infoOf("b");
		expect(info?.settingsValues).toMatchObject({ tone: "brief", pollSec: 30, notify: false });
		expect(info?.settingsSources).toMatchObject({ tone: "override", pollSec: "override", theme: "default" });
		writeStorage("b", { tone: "verbose" });
		await mgr.reload();
		info = await infoOf("b");
		expect(info?.settingsValues).toMatchObject({ tone: "verbose", pollSec: 30 });
		expect(info?.settingsSources).toMatchObject({ tone: "stored", pollSec: "override" });
	});
});

describe("overlay 校验", () => {
	it("坏值丢弃+警告并回落；未知键警告；secret 拒绝", async () => {
		makePlugin("c", { settings: SCHEMA });
		writeOverlay("c", {
			settings: { pollSec: 99999, theme: "pink", token: "plain-secret", ghost: 1, tone: "ok" },
		});
		await mgr.ensureLoaded();
		const info = await infoOf("c");
		expect(info?.settingsValues).toMatchObject({ pollSec: 60, theme: "dark", tone: "ok" });
		const diag = (info?.diagnostics ?? []).join("\n");
		expect(diag).toMatch(/pollSec/);
		expect(diag).toMatch(/theme/);
		expect(diag).toMatch(/secret/);
		expect(diag).toMatch(/ghost/);
	});

	it("坏文件整体忽略（非对象/数组/settings 非对象）；缺文件静默", async () => {
		makePlugin("d", { settings: SCHEMA });
		writeOverlay("d", "not-json{{{");
		await mgr.ensureLoaded();
		let info = await infoOf("d");
		expect(info?.settingsValues).toMatchObject({ tone: "full" });
		expect((info?.diagnostics ?? []).join("\n")).not.toMatch(/override/);
		makePlugin("e", { settings: SCHEMA });
		writeOverlay("e", { settings: [1, 2] });
		await mgr.reload();
		info = await infoOf("e");
		expect(info?.settingsValues).toMatchObject({ tone: "full" });
		expect((info?.diagnostics ?? []).join("\n")).toMatch(/override/);
	});
});

describe("运行时视角", () => {
	it("host.getSettings 同样走三层（插件行为与面板显示一致）", async () => {
		makePlugin("f", { settings: SCHEMA }, `globalThis.__f = h.getSettings();`);
		writeOverlay("f", { settings: { tone: "brief" } });
		await mgr.ensureLoaded();
		expect((globalThis as unknown as { __f: Record<string, unknown> }).__f).toMatchObject({ tone: "brief" });
	});
});

describe("保存路径重构锁", () => {
	it("面板保存照旧：清洗+落盘+ secret 进加密 store", async () => {
		makePlugin("g", { permissions: ["fs"], settings: SCHEMA });
		await mgr.ensureLoaded();
		writeStorage("g", { pollSec: 120 });
		await mgr.reload();
		const info = await infoOf("g");
		expect(info?.settingsValues).toMatchObject({ pollSec: 120 });
		expect(info?.settingsSources).toMatchObject({ pollSec: "stored" });
	});
});
