import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as atomicFile from "../../server/atomic-file.js";
import { withFileRmwLock } from "../../server/plugin-facilities.js";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager, type PluginHost } from "../../server/plugins.js";
import { pluginStateDir } from "../../server/plugin-paths.js";

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
		expect(existsSync(join(pluginStateDir(dir, "cfg"), "storage.json"))).toBe(false);
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

describe("optionsFrom（select 候选值由宿主动态提供）", () => {
	const DYNAMIC_PLUGIN = {
		settings: [
			{ key: "model", type: "select", optionsFrom: "models", label: "模型", default: "" },
			{ key: "thinking", optionsFrom: "thinkingLevels", label: "思考强度", default: "" },
			{ key: "bogus", type: "select", optionsFrom: "wat", label: "坏源", options: ["a"] },
		],
	};

	it("合法源透传到清单；非法源当没写（回落静态 options）；只给 optionsFrom 没给 type 视为 select", async () => {
		await makePlugin("dyn", DYNAMIC_PLUGIN);
		const list = await mgr.list();
		const p = list.find((x) => x.id === "dyn")!;
		expect(p.settingsSchema?.map((f) => [f.key, f.type, f.optionsFrom])).toEqual([
			["model", "select", "models"],
			["thinking", "select", "thinkingLevels"],
			["bogus", "select", undefined],
		]);
		expect(p.settingsValues).toEqual({ model: "", thinking: "", bogus: undefined });
	});

	it("动态字段不做候选值校验（清单在浏览器侧现算），落盘后回读一致", async () => {
		const h = await makePlugin("dyn", DYNAMIC_PLUGIN);
		expect(mgr.savePluginSettings("dyn", { model: "xai/grok-4", thinking: "high" }).error).toBeUndefined();
		expect(h.getSettings().model).toBe("xai/grok-4");
		expect(h.getSettings().thinking).toBe("high");
		expect(mgr.savePluginSettings("dyn", { model: "gone/model" }).error).toBeUndefined();
		expect(h.getSettings().model).toBe("gone/model");
		expect(JSON.parse(readFileSync(join(pluginStateDir(dir, "dyn"), "storage.json"), "utf8")).settings).toEqual({
			model: "gone/model",
			thinking: "",
		});
		expect(mgr.savePluginSettings("dyn", { model: "x".repeat(300) }, () => "zh").error).toContain("过长");
		expect(h.getSettings().model).toBe("gone/model");
	});
});

describe("savePluginSettings", () => {
	it("校验 + 原子落盘 + 保留 storage.json 其它键", async () => {
		const h = await makePlugin("cfg", SCHEMA_PLUGIN);
		h.storage.set("custom", 42);
		const r = mgr.savePluginSettings("cfg", {
			pollSec: 120,
			notify: false,
			theme: "light",
			name: "prod",
			pass: "s3cret",
		});
		expect(r.error).toBeUndefined();
		const raw = JSON.parse(readFileSync(join(pluginStateDir(dir, "cfg"), "storage.json"), "utf8"));
		expect(raw.settings).toEqual({ pollSec: 120, notify: false, theme: "light", name: "prod", pass: "s3cret" });
		expect(raw.custom).toBe(42);
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
		expect(mgr.savePluginSettings("cfg", { pollSec: 5 }).error).toContain("out of range");
		expect(mgr.savePluginSettings("cfg", { pollSec: 5 }, () => "zh").error).toContain("超出范围");
		expect(mgr.savePluginSettings("cfg", { pollSec: 9999 }, () => "zh").error).toContain("超出范围");
		expect(mgr.savePluginSettings("cfg", { theme: "neon" }, () => "zh").error).toContain("值非法");
		expect(mgr.savePluginSettings("cfg", { pollSec: 30 }).error).toBeUndefined();
	});

	it("select 静态 options 为对象数组（{ value, label }）：合法值通过，非法值被拒", async () => {
		await makePlugin("objopts", {
			settings: [
				{
					key: "model",
					type: "select",
					label: "模型",
					default: "shizuku",
					options: [
						{ value: "shizuku", label: "🌸 雫" },
						{ value: "haru", label: "🌿 春" },
					],
				},
			],
		});
		expect(mgr.savePluginSettings("objopts", { model: "haru" }, () => "zh").error).toBeUndefined();
		const list = await mgr.list();
		expect(list.find((x) => x.id === "objopts")?.settingsValues).toEqual({ model: "haru" });
		expect(mgr.savePluginSettings("objopts", { model: "invalid" }, () => "zh").error).toContain("值非法");
	});

	it("未声明 schema 的插件保存被拒", async () => {
		await makePlugin("noschema", { permissions: ["tools"] });
		expect(mgr.savePluginSettings("noschema", { a: 1 }, () => "zh").error).toContain("没有声明式设置");
	});
});

describe("host.getSettings + onSettingsChanged", () => {
	it("getSettings 实时反映存值；onSettingsChanged 在保存后触发", async () => {
		const h = await makePlugin("cfg", SCHEMA_PLUGIN);
		expect(h.getSettings().pollSec).toBe(60);
		const received: unknown[] = [];
		const off = h.onSettingsChanged((v) => received.push(v));
		mgr.savePluginSettings("cfg", { pollSec: 90 });
		expect(received).toEqual([{ pollSec: 90, notify: true, theme: "dark", name: "demo", pass: "" }]);
		expect(h.getSettings().pollSec).toBe(90);
		off();
		mgr.savePluginSettings("cfg", { pollSec: 100 });
		expect(received).toHaveLength(1);
	});
});

describe("secret 类型（P0-4 加密存、浏览器只见有无）", () => {
	const SECRET_PLUGIN = {
		settings: [
			{ key: "apiKey", type: "secret", label: "API 密钥" },
			{ key: "name", type: "text", label: "名字", default: "demo" },
		],
	};
	it("异步 storage 写锁未释放时拒绝同步保存，不提前通知成功", async () => {
		const h = await makePlugin("sec", SECRET_PLUGIN);
		mgr.savePluginSettings("sec", { apiKey: "old", name: "before" });
		const received: unknown[] = [];
		h.onSettingsChanged((v) => received.push(v));
		let release!: () => void;
		const held = withFileRmwLock(
			join(pluginStateDir(dir, "sec"), "storage.json"),
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		expect(mgr.savePluginSettings("sec", { apiKey: "new", name: "after" }).error).toContain("busy");
		expect(received).toEqual([]);
		release();
		await held;
		expect(h.getSettings()).toEqual({ apiKey: "old", name: "before" });
	});
	it.each(["{broken", "[]", "null"])("读取旧 secret 遇损坏 storage 返回 error 且不覆盖：%s", async (broken) => {
		const h = await makePlugin("sec", SECRET_PLUGIN);
		mgr.savePluginSettings("sec", { apiKey: "old", name: "before" });
		const received: unknown[] = [];
		h.onSettingsChanged((value) => received.push(value));
		const file = join(pluginStateDir(dir, "sec"), "storage.json");
		writeFileSync(file, broken);
		let result: { error?: string } = {};
		expect(() => {
			result = mgr.savePluginSettings("sec", { apiKey: "", name: "after" });
		}).not.toThrow();
		expect(result.error).toBeTruthy();
		expect(received).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe(broken);
	});
	it("后续字段校验失败不会提交前面的 secret", async () => {
		const h = await makePlugin("sec", {
			settings: [
				{ key: "apiKey", type: "secret", label: "key" },
				{ key: "count", type: "number", label: "count", min: 1, max: 10 },
			],
		});
		expect(mgr.savePluginSettings("sec", { apiKey: "old", count: 2 }).error).toBeUndefined();
		expect(mgr.savePluginSettings("sec", { apiKey: "new", count: 20 }).error).toBeTruthy();
		expect(h.getSettings()).toEqual({ apiKey: "old", count: 2 });
	});
	it("原子提交失败保留旧 secret 和配置，不通知成功", async () => {
		const h = await makePlugin("sec", SECRET_PLUGIN);
		expect(mgr.savePluginSettings("sec", { apiKey: "old", name: "before" }).error).toBeUndefined();
		const received: unknown[] = [];
		h.onSettingsChanged((value) => received.push(value));
		const file = join(pluginStateDir(dir, "sec"), "storage.json");
		const original = readFileSync(file, "utf8");
		const write = atomicFile.writeJsonAtomicSync;
		const fail = vi.spyOn(atomicFile, "writeJsonAtomicSync").mockImplementation((target, data, indent) => {
			if (target === file) throw new Error("injected atomic replace failure");
			return write(target, data, indent);
		});
		try {
			expect(mgr.savePluginSettings("sec", { apiKey: "new", name: "after" }).error).toContain(
				"injected atomic replace failure",
			);
			expect(received).toEqual([]);
			expect(readFileSync(file, "utf8")).toBe(original);
		} finally {
			fail.mockRestore();
		}
		expect(h.getSettings()).toEqual({ apiKey: "old", name: "before" });
	});
	it("清单 settingsValues：secret 只给有无布尔，不给明文", async () => {
		await makePlugin("sec", SECRET_PLUGIN);
		const list = await mgr.list();
		expect(list.find((x) => x.id === "sec")!.settingsValues).toEqual({ apiKey: false, name: "demo" });
	});
	it("保存 secret → getSettings 给真值；磁盘无明文；空串不改", async () => {
		const h = await makePlugin("sec", SECRET_PLUGIN);
		expect(mgr.savePluginSettings("sec", { apiKey: "sk-live-123" }).error).toBeUndefined();
		expect(h.getSettings().apiKey).toBe("sk-live-123");
		const list = await mgr.list();
		expect(list.find((x) => x.id === "sec")!.settingsValues?.apiKey).toBe(true);
		const raw = readFileSync(join(pluginStateDir(dir, "sec"), "storage.json"), "utf8");
		expect(raw).not.toContain("sk-live-123");
		expect(JSON.parse(raw).settings).toEqual({ name: "demo" });
		expect(mgr.savePluginSettings("sec", { apiKey: "" }).error).toBeUndefined();
		expect(h.getSettings().apiKey).toBe("sk-live-123");
		expect(mgr.savePluginSettings("sec", { apiKey: "sk-new" }).error).toBeUndefined();
		expect(h.getSettings().apiKey).toBe("sk-new");
		expect(mgr.savePluginSettings("sec", { apiKey: "x".repeat(5000) }, () => "zh").error).toContain("过长");
		expect(h.getSettings().apiKey).toBe("sk-new");
	});
	it("onSettingsChanged 收到的 clean 含 secret 真值（插件可用，但不下发浏览器）", async () => {
		const h = await makePlugin("sec", SECRET_PLUGIN);
		const received: unknown[] = [];
		h.onSettingsChanged((v) => received.push(v));
		mgr.savePluginSettings("sec", { apiKey: "sk-abc" });
		expect(received).toEqual([{ apiKey: "sk-abc", name: "demo" }]);
	});
});
