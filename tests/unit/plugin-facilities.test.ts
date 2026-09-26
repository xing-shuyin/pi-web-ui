/**
 * 插件宿主设施单测（零依赖、毫秒级）：storage / secrets / deps 探测 /
 * apiVersion 门控 / 斜杠命令注册表。不启 server、不碰网络。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
import { PluginSecrets, PluginStorage, depName, globToRegExp, isDepAvailable } from "../../server/plugin-facilities.js";
import { PLUGIN_API_VERSION, PluginManager, type PluginHost } from "../../server/plugins.js";

let dir: string;
let mgr: PluginManager;

function makePlugin(id: string, code: string, manifest?: Record<string, unknown>): void {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id, ...(manifest ?? {}) }));
	writeFileSync(join(pdir, "index.mjs"), code);
}

/** 抓取宿主对象，供断言宿主设施行为。 */
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

afterEach(() => {
	mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("host.storage", () => {
	it("get/set/all/delete 往返 + 落盘 <pluginDir>/storage.json", async () => {
		const h = await activate("a");
		h.storage.set("layout", { split: 0.3 });
		expect(h.storage.get("layout")).toEqual({ split: 0.3 });
		expect(h.storage.get("missing", "fallback")).toBe("fallback");
		expect(Object.keys(h.storage.all())).toContain("layout");
		// 明文落盘到插件目录，跨实例（重新 load）可读
		expect(existsSync(join(dir, "plugins", "a", "storage.json"))).toBe(true);

		h.storage.set("k", 1);
		h.storage.delete("k");
		expect(h.storage.get("k")).toBeUndefined();
	});

	it("宿主直写 storage.json 后，插件 set() 不抹掉外部写入的键（回归：设置重启即丢）", () => {
		// 真实场景：设置面板的 saveSettingsValues 直写 settings 键（不经过本缓存），
		// 而 wechat-ilink 这类长轮询插件每隔几秒就 store.set("cursor", …) 一次。
		const file = join(dir, "external.json");
		writeFileSync(file, JSON.stringify({ cursor: "a" }));
		const store = new PluginStorage(file);
		expect(store.get("cursor")).toBe("a"); // 预热缓存
		// 宿主直写磁盘（模拟 settings 面板保存）
		writeFileSync(file, JSON.stringify({ cursor: "a", settings: { model: "x/y" } }));
		// 插件长轮询继续写自己的键
		store.set("cursor", "b");
		const after = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		expect(after.settings).toEqual({ model: "x/y" }); // 旧实现这里被旧缓存抹成 undefined
		expect(after.cursor).toBe("b");
	});

	it("同实例内连续 set/get 仍走缓存语义（mtime 变化才重读）", () => {
		const file = join(dir, "self.json");
		const store = new PluginStorage(file);
		store.set("a", 1);
		store.set("b", 2);
		expect(store.get("a")).toBe(1); // 第二次 set 没有丢掉第一个键
		expect(store.get("b")).toBe(2);
		expect(store.all()).toEqual({ a: 1, b: 2 });
	});
});

describe("host.secrets", () => {
	it("set/get 往返；明文绝不写进文件；has/list/delete 正常", async () => {
		const h = await activate("b");
		const secret = "hunter2-super-secret-密码";
		h.secrets.set("mail_pass", secret);
		expect(h.secrets.get("mail_pass")).toBe(secret);
		expect(h.secrets.has("mail_pass")).toBe(true);
		expect(h.secrets.list()).toEqual(["mail_pass"]);

		const raw = readFileSync(join(dir, "plugins", "b", "secrets.bin"), "utf8");
		expect(raw).not.toContain(secret); // 密文形态存在
		expect(raw.length).toBeGreaterThan(50);

		h.secrets.delete("mail_pass");
		expect(h.secrets.get("mail_pass")).toBeUndefined();
		expect(h.secrets.has("mail_pass")).toBe(false);
	});

	it("重启后从文件加载的 key 仍可用（回归：hex 二次编码致 Invalid key length）", () => {
		// 预置合法 key 文件，模拟“老版本已生成 key → 进程重启后重新加载”。
		// 注意静态 key 缓存按 dataDir 隔离：beforeEach 每次给新 dir，必走文件路径。
		const keyHex = randomBytes(32).toString("hex");
		writeFileSync(join(dir, "secrets.key"), `${keyHex}\n`);
		const h = new PluginSecrets(dir, join(dir, "plugins", "x"));
		h.set("k", "v");
		expect(h.get("k")).toBe("v");
	});

	it("损坏的 key 文件 → 重新生成可用 key（旧机密 fail closed）", () => {
		writeFileSync(join(dir, "secrets.key"), "not-hex-at-all!!!");
		const h = new PluginSecrets(dir, join(dir, "plugins", "y"));
		h.set("k", "v");
		expect(h.get("k")).toBe("v");
		expect(readFileSync(join(dir, "secrets.key"), "utf8").trim().length).toBe(64);
	});

	it("换了宿主密钥（拷到别的机器）解不开 → fail closed 返回 undefined", async () => {
		const h = await activate("c");
		h.secrets.set("token", "t0psecret");
		// 同一插件目录、不同 dataDir（= 不同密钥）
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

	it("isDepAvailable 认带版本的 spec（只判存在，不审计版本）", () => {
		// 仓库根下探测：沿目录树向上能走到本仓库 node_modules（vitest 已安装）。
		const probe = join(repoRoot, "tests", "scratch");
		expect(isDepAvailable(probe, "vitest")).toBe(true);
		expect(isDepAvailable(probe, "vitest@9.9.9")).toBe(true);
		expect(isDepAvailable(probe, "definitely-not-a-module-xyz@1.0.0")).toBe(false);
	});

	it("包已落盘时即便 CJS 解析失败也判可用（issue #383 的负缓存修复）", () => {
		// 复刻现场：探测时包还没装（Node 把 package.json 不存在记成进程级负结果），
		// 随后 npm install 把它写上盘。真实包这里故意给一个不存在的 main，
		// 让 createRequire().resolve() 必然失败 —— 判据得由落盘事实兜住。
		const pdir = join(dir, "plugins", "stale-cache");
		const pkgDir = join(pdir, "node_modules", "@xenova", "transformers");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@xenova/transformers", main: "nope.js" }));
		// 先在没有包的目录上探测一次，污染进程级解析缓存。
		expect(isDepAvailable(pdir, "@xenova/transformers")).toBe(true); // 此时已落盘
		const fresh = join(dir, "plugins", "stale-cache-2");
		mkdirSync(fresh, { recursive: true });
		expect(isDepAvailable(fresh, "@xenova/transformers")).toBe(false);
		mkdirSync(join(fresh, "node_modules", "@xenova", "transformers"), { recursive: true });
		writeFileSync(
			join(fresh, "node_modules", "@xenova", "transformers", "package.json"),
			JSON.stringify({ name: "@xenova/transformers", main: "nope.js" }),
		);
		// 同一个 spec、同一个进程：上一轮的负结果不该把这一轮也带进坑里。
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
		const off2 = h2.registerCommand({ name: "shared", run: () => "second" }); // 应被拒绝
		expect(mgr.listCommands()).toHaveLength(1);
		expect(mgr.findCommand("shared")?.def.run("", { clientId: "" })).toBe("first");

		off2(); // 被拒的注销函数应是空操作
		expect(mgr.listCommands()).toHaveLength(1);

		mgr.dispose();
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
		writeFileSync(join(dir, "seed.txt"), "s"); // 直写磁盘（只读插件自己写不进去）
		expect(await h.fs.readText("seed.txt")).toContain("s");
		expect((await h.fs.stat("seed.txt")).type).toBe("file");
		await expect(h.fs.append("seed.txt", "x")).rejects.toThrow(/写能力/);
		await expect(h.fs.mkdir("newdir")).rejects.toThrow(/写能力/);
		await expect(h.fs.appendPath(join(dir, "seed.txt"), "x")).rejects.toThrow(/写能力/);
	});
});
