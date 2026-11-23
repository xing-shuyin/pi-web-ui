import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as atomicFile from "../../server/atomic-file.js";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
import {
	PluginSecrets,
	PluginStorage,
	depName,
	depRange,
	depRangeSatisfied,
	globToRegExp,
	isDepAvailable,
	withFileRmwLock,
} from "../../server/plugin-facilities.js";
import { PLUGIN_API_VERSION, PluginManager, type PluginHost } from "../../server/plugins.js";
import { pluginStateDir } from "../../server/plugin-paths.js";

let dir: string;
let mgr: PluginManager;

function makePlugin(id: string, code: string, manifest?: Record<string, unknown>): void {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id, ...(manifest ?? {}) }));
	writeFileSync(join(pdir, "index.mjs"), code);
}

async function activate(id: string): Promise<PluginHost> {
	let host!: PluginHost;
	makePlugin(id, `export default { activate(h) { globalThis.__hosts["${id}"] = h; } };`);
	(globalThis as unknown as { __hosts?: Record<string, PluginHost> }).__hosts ??= {};
	await mgr.ensureLoaded();
	host = (globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts[id];
	expect(host).toBeTruthy();
	return host;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-facilities-test-"));
	mgr = new PluginManager(dir, dir);
});

afterEach(async () => {
	await mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("host.storage", () => {
	it.each([false, true])("异步 prev 未完成时 set 排队（不丢写，reject=%s）", async (rejectQueued) => {
		const file = join(dir, "queued.json");
		const store = new PluginStorage(file);
		let release!: () => void;
		const first = withFileRmwLock(
			file,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const queued = withFileRmwLock(file, async () => {
			if (rejectQueued) throw new Error("queued failure");
			return "done";
		});
		const early = store.set("early", true);
		const checked = rejectQueued
			? expect(queued).rejects.toThrow("queued failure")
			: expect(queued).resolves.toBe("done");
		release();
		await first;
		await checked;
		await early;
		expect(store.get("early")).toBe(true);
		await store.set("after", true);
		expect(store.get("after")).toBe(true);
	});
	it("get/set/all/delete 往返 + 落盘 <pluginDir>/storage.json", async () => {
		const h = await activate("a");
		await h.storage.set("layout", { split: 0.3 });
		expect(h.storage.get("layout")).toEqual({ split: 0.3 });
		expect(h.storage.get("missing", "fallback")).toBe("fallback");
		expect(Object.keys(h.storage.all())).toContain("layout");
		expect(existsSync(join(pluginStateDir(dir, "a"), "storage.json"))).toBe(true);

		await h.storage.set("k", 1);
		expect(h.storage.has("k")).toBe(true);
		expect(h.storage.has("nonexistent")).toBe(false);
		expect(h.storage.keys()).toContain("k");
		expect(h.storage.keys()).toContain("layout");

		await h.storage.delete("k");
		expect(h.storage.get("k")).toBeUndefined();
		expect(h.storage.has("k")).toBe(false);

		await h.storage.clear();
		expect(h.storage.keys()).toEqual([]);
	});

	it("宿主直写 storage.json 后，插件 set() 不抹掉外部写入的键（回归：设置重启即丢）", async () => {
		const file = join(dir, "external.json");
		writeFileSync(file, JSON.stringify({ cursor: "a" }));
		const store = new PluginStorage(file);
		expect(store.get("cursor")).toBe("a");
		writeFileSync(file, JSON.stringify({ cursor: "a", settings: { model: "x/y" } }));
		await store.set("cursor", "b");
		const after = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		expect(after.settings).toEqual({ model: "x/y" });
		expect(after.cursor).toBe("b");
	});

	it.each(["set", "delete", "clear"] as const)("%s 写失败 reject 且候选不进入缓存", async (operation) => {
		const file = join(dir, "storage.json");
		const secrets = new PluginSecrets(dir, dir);
		await secrets.commitSettings({ model: "old" }, { "setting:key": "old-secret" });
		const store = new PluginStorage(file);
		await store.set("cursor", "old");
		const original = readFileSync(file, "utf8");
		const committed = store.all();
		const fail = vi.spyOn(atomicFile, "writeAtomic").mockImplementation(() => {
			throw new Error("injected write failure");
		});
		try {
			await expect(
				operation === "set"
					? store.set("cursor", "new")
					: operation === "delete"
						? store.delete("cursor")
						: store.clear(false),
			).rejects.toThrow("injected write failure");
			expect((store as any).cache).toEqual(JSON.parse(original));
			expect(store.all()).toEqual(committed);
			expect(new PluginStorage(file).all()).toEqual(committed);
			expect(secrets.get("setting:key")).toBe("old-secret");
			expect(readFileSync(file, "utf8")).toBe(original);
		} finally {
			fail.mockRestore();
		}
	});

	it.each(["{broken", "null", "[]", "1"])("损坏 storage %s 不得被任何写路径覆盖", async (broken) => {
		const file = join(dir, "storage.json");
		const store = new PluginStorage(file);
		await store.set("cursor", "old");
		store.get("cursor");
		writeFileSync(file, broken);
		for (const mutate of [() => store.set("cursor", "new"), () => store.delete("cursor"), () => store.clear(false)]) {
			await expect(mutate()).rejects.toThrow();
			expect(readFileSync(file, "utf8")).toBe(broken);
		}
		expect(() => store.all()).toThrow();
	});

	it("不可读文件不会作为空表覆盖；缺失文件可以创建", async () => {
		const file = join(dir, "storage.json");
		mkdirSync(file);
		const store = new PluginStorage(file);
		await expect(store.set("a", 1)).rejects.toThrow();
		await expect(store.delete("a")).rejects.toThrow();
		await expect(store.clear()).rejects.toThrow();
		rmSync(file, { recursive: true });
		await store.set("a", 1);
		expect(store.get("a")).toBe(1);
	});

	it("异步写锁被占用时 set 排队（不丢写、不报 busy）", async () => {
		const file = join(dir, "storage.json");
		const store = new PluginStorage(file);
		await store.set("cursor", "old");
		let release!: () => void;
		const held = withFileRmwLock(
			file,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const pending = [store.set("cursor", "new"), store.delete("other"), store.clear(false)];
		release();
		await held;
		await Promise.all(pending);
		expect(store.get("cursor")).toBeUndefined(); // clear(false) 最后一个生效
	});

	it("同实例内连续 set/get 保留已提交数据", async () => {
		const file = join(dir, "self.json");
		const store = new PluginStorage(file);
		await store.set("a", 1);
		await store.set("b", 2);
		expect(store.get("a")).toBe(1);
		expect(store.get("b")).toBe(2);
		expect(store.all()).toEqual({ a: 1, b: 2 });
	});
});

describe("host.secrets", () => {
	it("set/get 往返；明文绝不写进文件；has/list/delete 正常", async () => {
		const h = await activate("b");
		const secret = "hunter2-super-secret-密码";
		await h.secrets.set("mail_pass", secret);
		expect(h.secrets.get("mail_pass")).toBe(secret);
		expect(h.secrets.has("mail_pass")).toBe(true);
		expect(h.secrets.list()).toEqual(["mail_pass"]);

		const raw = readFileSync(join(pluginStateDir(dir, "b"), "secrets.bin"), "utf8");
		expect(raw).not.toContain(secret);
		expect(raw.length).toBeGreaterThan(50);

		await h.secrets.delete("mail_pass");
		expect(h.secrets.get("mail_pass")).toBeUndefined();
		expect(h.secrets.has("mail_pass")).toBe(false);
	});

	it("重启后从文件加载的 key 仍可用（回归：hex 二次编码致 Invalid key length）", async () => {
		const keyHex = randomBytes(32).toString("hex");
		writeFileSync(join(dir, "secrets.key"), `${keyHex}\n`);
		const h = new PluginSecrets(dir, join(dir, "plugins", "x"));
		await h.set("k", "v");
		expect(h.get("k")).toBe("v");
	});

	it("损坏的 key 文件 → 重新生成可用 key（旧机密 fail closed）", async () => {
		writeFileSync(join(dir, "secrets.key"), "not-hex-at-all!!!");
		const h = new PluginSecrets(dir, join(dir, "plugins", "y"));
		await h.set("k", "v");
		expect(h.get("k")).toBe("v");
		expect(readFileSync(join(dir, "secrets.key"), "utf8").trim().length).toBe(64);
	});

	it("换了宿主密钥（拷到别的机器）解不开 → fail closed 返回 undefined", async () => {
		const h = await activate("c");
		await h.secrets.set("token", "t0psecret");
		const otherDataDir = mkdtempSync(join(tmpdir(), "other-data-"));
		try {
			const stolen = new PluginSecrets(otherDataDir, join(dir, "plugins", "c"));
			expect(stolen.get("token")).toBeUndefined();
		} finally {
			rmSync(otherDataDir, { recursive: true, force: true });
		}
	});
});

describe("deps 探测", () => {
	it("isDepAvailable 命中内置模块 / 未安装包返回 false", () => {
		const pdir = mkdirSync(join(dir, "plugins", "empty"), { recursive: true });
		expect(isDepAvailable(pdir ?? dir, "node:path")).toBe(true);
		expect(isDepAvailable(pdir ?? dir, "definitely-not-a-module-xyz")).toBe(false);
	});

	it("depName 剥掉版本号（require.resolve 不认 @后缀）", () => {
		expect(depName("@xenova/transformers@2.17.2")).toBe("@xenova/transformers");
		expect(depName("@xenova/transformers")).toBe("@xenova/transformers");
		expect(depName("lodash@^4.17.21")).toBe("lodash");
		expect(depName("lodash")).toBe("lodash");
		expect(depName("node:path")).toBe("node:path");
		expect(depName("https://example.com/x.tgz")).toBe("https://example.com/x.tgz");
	});

	it("depRange 取 name@ 之后的部分，裸包名不审计版本", () => {
		expect(depRange("openhongguo@~0.4.0")).toBe("~0.4.0");
		expect(depRange("lodash@^4.17.21")).toBe("^4.17.21");
		expect(depRange("lodash")).toBe("");
		expect(depRange("node:path")).toBe("");
	});

	it("depRangeSatisfied 只认仓库在用的写法，认不出就放行", () => {
		expect(depRangeSatisfied("0.4.0", "~0.4.0")).toBe(true);
		expect(depRangeSatisfied("0.1.0", "~0.4.0")).toBe(false);
		expect(depRangeSatisfied("0.5.0", "~0.4.0")).toBe(false);
		expect(depRangeSatisfied("0.4.0", "^0.4.0")).toBe(true);
		expect(depRangeSatisfied("0.5.0", "^0.4.0")).toBe(false);
		expect(depRangeSatisfied("1.9.0", "^1.2.0")).toBe(true);
		expect(depRangeSatisfied("2.0.0", "^1.2.0")).toBe(false);
		expect(depRangeSatisfied("0.0.3", "^0.0.3")).toBe(true);
		expect(depRangeSatisfied("0.0.4", "^0.0.3")).toBe(false);
		expect(depRangeSatisfied("3.7.1", "3.7.1")).toBe(true);
		expect(depRangeSatisfied("3.7.2", "3.7.1")).toBe(false);
		expect(depRangeSatisfied("9.9.9", ">=1.0.0")).toBe(true);
		expect(depRangeSatisfied("0.4.0", "")).toBe(true);
		expect(depRangeSatisfied("0.4.0", "latest")).toBe(true);
		expect(depRangeSatisfied("0.4.0", "||不认得的写法")).toBeNull();
		expect(depRangeSatisfied("", "~0.4.0")).toBeNull();
	});

	it("isDepAvailable 装了旧版且 spec 带 range 时判不在位（让宿主升级）", () => {
		const pluginDir = join(dir, "plugins", "versioned");
		const pkgDir = join(pluginDir, "node_modules", "probe-sdk");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "index.js"), "module.exports = {};\n");
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ name: "probe-sdk", version: "0.1.0", main: "index.js" }),
		);
		expect(isDepAvailable(pluginDir, "probe-sdk")).toBe(true);
		expect(isDepAvailable(pluginDir, "probe-sdk@~0.4.0")).toBe(false);
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ name: "probe-sdk", version: "0.4.0", main: "index.js" }),
		);
		expect(isDepAvailable(pluginDir, "probe-sdk@~0.4.0")).toBe(true);
	});

	it("isDepAvailable 认带版本的 spec（版本满足或读不到版本都在位）", () => {
		const probe = join(repoRoot, "tests", "scratch");
		expect(isDepAvailable(probe, "vitest")).toBe(true);
		expect(isDepAvailable(probe, "vitest@9.9.9")).toBe(false);
		expect(isDepAvailable(probe, "vitest@>=0.0.1")).toBe(true);
		expect(isDepAvailable(probe, "definitely-not-a-module-xyz@1.0.0")).toBe(false);
	});

	it("包已落盘时即便 CJS 解析失败也判可用（issue #383 的负缓存修复）", () => {
		const pdir = join(dir, "plugins", "stale-cache");
		const pkgDir = join(pdir, "node_modules", "@xenova", "transformers");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@xenova/transformers", main: "nope.js" }));
		expect(isDepAvailable(pdir, "@xenova/transformers")).toBe(true);
		const fresh = join(dir, "plugins", "stale-cache-2");
		mkdirSync(fresh, { recursive: true });
		expect(isDepAvailable(fresh, "@xenova/transformers")).toBe(false);
		mkdirSync(join(fresh, "node_modules", "@xenova", "transformers"), { recursive: true });
		writeFileSync(
			join(fresh, "node_modules", "@xenova", "transformers", "package.json"),
			JSON.stringify({ name: "@xenova/transformers", main: "nope.js" }),
		);
		expect(isDepAvailable(fresh, "@xenova/transformers")).toBe(true);
		expect(isDepAvailable(fresh, "@xenova/transformers@2.17.2")).toBe(true);
	});

	it("没落盘的非标准 spec 仍判缺（URL / 路径形状不误判）", () => {
		const pdir = join(dir, "plugins", "weird-spec");
		mkdirSync(pdir, { recursive: true });
		expect(isDepAvailable(pdir, "https://example.com/x.tgz")).toBe(false);
		expect(isDepAvailable(pdir, "./local-thing")).toBe(false);
	});
});

describe("apiVersion 门控", () => {
	it("manifest apiVersion 高于宿主 → 激活失败并提示升级；低于等于 → 正常激活", async () => {
		makePlugin("futuristic", "export default {};", { apiVersion: PLUGIN_API_VERSION + 1 });
		makePlugin("classic", "export default {};", { apiVersion: 1 });
		const list = await mgr.ensureLoaded(() => "zh");
		expect(list.find((p) => p.id === "futuristic")?.error).toContain("请升级 pi-web-ui");
		expect(list.find((p) => p.id === "classic")?.error).toBeUndefined();
	});
});

describe("host.registerCommand", () => {
	it("注册 → 目录可见 / findCommand 命中 → 注销后消失", async () => {
		let ran = "";
		const h = await activate("cmdly");
		const off = h.registerCommand({
			name: "deploy",
			description: "部署当前项目",
			run(args) {
				ran = args;
				return `deployed ${args}`;
			},
		});
		expect(mgr.listCommands().map((c) => c.name)).toEqual(["deploy"]);
		expect(mgr.findCommand("deploy")?.def.run("prod", { clientId: "x" })).toBe("deployed prod");

		off();
		expect(mgr.listCommands()).toHaveLength(0);
		expect(mgr.findCommand("deploy")).toBeNull();
	});

	it("跨插件重名拒绝（先注册者胜出）；dispose 清空全部命令", async () => {
		await activate("first");
		(globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts.first.registerCommand({
			name: "shared",
			run: () => "first",
		});
		const h2 = await activate("second");
		const off2 = h2.registerCommand({ name: "shared", run: () => "second" });
		expect(mgr.listCommands()).toHaveLength(1);
		expect(mgr.findCommand("shared")?.def.run("", { clientId: "" })).toBe("first");

		off2();
		expect(mgr.listCommands()).toHaveLength(1);

		await mgr.dispose();
		expect(mgr.listCommands()).toHaveLength(0);
	});

	it("非法名称（数字开头 / 空格）被忽略", async () => {
		const h = await activate("naughty");
		h.registerCommand({ name: "1bad", run: () => 1 });
		h.registerCommand({ name: "has space", run: () => 2 });
		expect(mgr.listCommands()).toHaveLength(0);
	});
});

describe("globToRegExp（P0-1 极简 glob）", () => {
	it("单星只跨单段、双星跨段、问号单字符", () => {
		expect(globToRegExp("*.json").test("a.json")).toBe(true);
		expect(globToRegExp("*.json").test("sub/a.json")).toBe(false);
		expect(globToRegExp("**/*.json").test("sub/deep/a.json")).toBe(true);
		expect(globToRegExp("**/*.json").test("a.json")).toBe(true);
		expect(globToRegExp("a?.txt").test("ab.txt")).toBe(true);
		expect(globToRegExp("a?.txt").test("abc.txt")).toBe(false);
	});
	it("特殊字符转义（点号不当通配）", () => {
		expect(globToRegExp("a.json").test("axjson")).toBe(false);
		expect(globToRegExp("a.json").test("a.json")).toBe(true);
	});
});

describe("host.fs 新增方法（P0-1 stat/mkdir/append/glob）", () => {
	async function fsHost(id: string, permissions: string[]): Promise<PluginHost> {
		makePlugin(id, `export default { activate(h) { globalThis.__hosts["${id}"] = h; } };`, { permissions });
		(globalThis as unknown as { __hosts?: Record<string, PluginHost> }).__hosts ??= {};
		await mgr.ensureLoaded();
		const h = (globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts[id];
		expect(h).toBeTruthy();
		return h;
	}
	it("mkdir/stat/append 往返", async () => {
		const h = await fsHost("fsx", ["fs"]);
		await h.fs.mkdir("logs/2026");
		await h.fs.write("logs/2026/a.txt", "line1\n");
		await h.fs.append("logs/2026/a.txt", "line2\n");
		expect(await h.fs.readText("logs/2026/a.txt")).toBe("line1\nline2\n");
		const st = await h.fs.stat("logs/2026/a.txt");
		expect(st.type).toBe("file");
		expect(st.size).toBe(Buffer.byteLength("line1\nline2\n"));
		expect(st.mtime).toBeGreaterThan(0);
		const dst = await h.fs.stat("logs/2026");
		expect(dst.type).toBe("dir");
		await expect(h.fs.stat("logs/2026/nope.txt")).rejects.toThrow();
	});
	it("glob 按 pattern 过滤（目录本身也可命中）", async () => {
		const h = await fsHost("fsg", ["fs"]);
		await h.fs.write("src/a.ts", "x");
		await h.fs.write("src/sub/b.ts", "x");
		await h.fs.write("src/sub/c.json", "{}");
		const ts = await h.fs.glob("**/*.ts", "src");
		expect(ts.sort()).toEqual(["a.ts", "sub/b.ts"]);
		expect(await h.fs.glob("*.json", "src")).toEqual([]);
		expect(await h.fs.glob("*.json", "src/sub")).toEqual(["c.json"]);
		await expect(h.fs.glob("")).rejects.toThrow();
	});
	it("跨目录 *Path 同口径：工作区内免授权、工作区外拒绝", async () => {
		const h = await fsHost("fsxp", ["fs"]);
		const inside = join(dir, "proj");
		await h.fs.mkdirPath(inside);
		await h.fs.writePath(join(inside, "n.txt"), "hi");
		expect((await h.fs.statPath(join(inside, "n.txt"))).size).toBe(2);
		expect(await h.fs.globPath(inside, "*.txt")).toEqual([join(inside, "n.txt")]);
		await h.fs.appendPath(join(inside, "n.txt"), "!");
		expect(await h.fs.readTextPath(join(inside, "n.txt"))).toBe("hi!");
		const outside = join(tmpdir(), "pi-web-ui-nope-dir");
		await expect(h.fs.statPath(join(outside, "x"))).rejects.toThrow(/未授权/);
		await expect(h.fs.listPath(outside)).rejects.toThrow(/未授权/);
	});
	it("只读插件（fs:read）：读放行、写/append/mkdir 被拒并提示缺写能力", async () => {
		const h = await fsHost("fsro", ["fs:read"]);
		writeFileSync(join(dir, "seed.txt"), "s");
		expect(await h.fs.readText("seed.txt")).toContain("s");
		expect((await h.fs.stat("seed.txt")).type).toBe("file");
		await expect(h.fs.append("seed.txt", "x")).rejects.toThrow(/写能力/);
		await expect(h.fs.mkdir("newdir")).rejects.toThrow(/写能力/);
		await expect(h.fs.appendPath(join(dir, "seed.txt"), "x")).rejects.toThrow(/写能力/);
	});
});
