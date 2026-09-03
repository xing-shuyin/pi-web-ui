/**
 * 插件声明式设置（manifest "settings" schema）单测：schema 解析校验、
 * 默认值合并、savePluginSettings 持久化 + 通知、host.getSettings 读取。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager, type PluginHost } from "../../server/plugins.js";

let dir: string;
let mgr: PluginManager;

function makePlugin(id: string, manifest: Record<string, unknown>): Promise<PluginHost> {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id, ...manifest }));
	writeFileSync(
		join(pdir, "index.mjs"),
		`export default { activate(h) { (globalThis.__hosts ??= {})["${id}"] = h; } };`,
	);
	return mgr.ensureLoaded().then(() => (globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts[id]!);
}

const SCHEMA_PLUGIN = {
	settings: [
		{ key: "pollSec", type: "number", label: "间隔", default: 60, min: 10, max: 600 },
		{ key: "notify", type: "boolean", label: "通知", default: true },
		{ key: "theme", type: "select", label: "主题", default: "dark", options: ["dark", "light"] },
		{ key: "name", type: "text", label: "名字", default: "demo" },
		{ key: "pass", type: "password", label: "口令", default: "" },
	],
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-settings-test-"));
	mgr = new PluginManager(dir, dir);
});

afterEach(() => {
	mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("schema 解析 + 默认值", () => {
	it("清单带 schema 与默认合并后的值", async () => {
		await makePlugin("cfg", SCHEMA_PLUGIN);
		const list = await mgr.list();
		const p = list.find((x) => x.id === "cfg")!;
		expect(p.settingsSchema?.length).toBe(5);
		expect(p.settingsValues).toEqual({ pollSec: 60, notify: true, theme: "dark", name: "demo", pass: "" });
		// 没装过 → storage.json 不存在
		expect(existsSync(join(dir, "plugins", "cfg", "storage.json"))).toBe(false);
	});

	it("坏字段被跳过（非法 type / 重复 key / 缺 key）", async () => {
		await makePlugin("bad", {
			settings: [
				{ key: "ok", type: "boolean", label: "OK" },
				{ key: "x", type: "unknown", label: "坏类型" },
				{ key: "ok", type: "text", label: "重复" },
				{ type: "text", label: "缺 key" },
			],
		});
		const list = await mgr.list();
		const p = list.find((x) => x.id === "bad")!;
		expect(p.settingsSchema?.map((f) => f.key)).toEqual(["ok"]);
	});
});

describe("savePluginSettings", () => {
	it("校验 + 原子落盘 + 保留 storage.json 其它键", async () => {
		const h = await makePlugin("cfg", SCHEMA_PLUGIN);
		h.storage.set("custom", 42); // 插件自己的键
		const r = mgr.savePluginSettings("cfg", {
			pollSec: 120,
			notify: false,
			theme: "light",
			name: "prod",
			pass: "s3cret",
		});
		expect(r.error).toBeUndefined();
		const raw = JSON.parse(readFileSync(join(dir, "plugins", "cfg", "storage.json"), "utf8"));
		expect(raw.settings).toEqual({ pollSec: 120, notify: false, theme: "light", name: "prod", pass: "s3cret" });
		expect(raw.custom).toBe(42); // 插件数据不被覆盖
		// 重扫后默认值已被存值覆盖
		const list = await mgr.list();
		expect(list.find((x) => x.id === "cfg")?.settingsValues).toEqual({
			pollSec: 120,
			notify: false,
			theme: "light",
			name: "prod",
			pass: "s3cret",
		});
	});

	it("number 越界 / select 非法值被拒", async () => {
		await makePlugin("cfg", SCHEMA_PLUGIN);
		expect(mgr.savePluginSettings("cfg", { pollSec: 5 }).error).toContain("超出范围");
		expect(mgr.savePluginSettings("cfg", { pollSec: 9999 }).error).toContain("超出范围");
		expect(mgr.savePluginSettings("cfg", { theme: "neon" }).error).toContain("值非法");
		// 合法保存不受影响
		expect(mgr.savePluginSettings("cfg", { pollSec: 30 }).error).toBeUndefined();
	});

	it("未声明 schema 的插件保存被拒", async () => {
		await makePlugin("noschema", { permissions: ["tools"] });
		expect(mgr.savePluginSettings("noschema", { a: 1 }).error).toContain("没有声明式设置");
	});
});

describe("host.getSettings + onSettingsChanged", () => {
	it("getSettings 实时反映存值；onSettingsChanged 在保存后触发", async () => {
		const h = await makePlugin("cfg", SCHEMA_PLUGIN);
		expect(h.getSettings().pollSec).toBe(60); // 默认
		const received: unknown[] = [];
		const off = h.onSettingsChanged((v) => received.push(v));
		mgr.savePluginSettings("cfg", { pollSec: 90 });
		expect(received).toEqual([{ pollSec: 90, notify: true, theme: "dark", name: "demo", pass: "" }]);
		expect(h.getSettings().pollSec).toBe(90);
		off();
		mgr.savePluginSettings("cfg", { pollSec: 100 });
		expect(received).toHaveLength(1); // 注销后不再触发
	});
});
