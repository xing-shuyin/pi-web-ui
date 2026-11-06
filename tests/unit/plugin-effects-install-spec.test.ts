import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectInstallSpec } from "../../server/plugin-installer.js";
import {
	inspectLocalInstallSpec,
	manifestCandidateUrls,
	parseInstallSpec,
	pickManifestFields,
	suggestPluginId,
} from "../../server/plugin-install-spec.js";
import { PluginEffectStack, PluginManager, type PluginHost } from "../../server/plugins.js";

describe("PluginEffectStack —— 可逆副作用", () => {
	it("release 逆序回卷全部（后进先出）", () => {
		const order: string[] = [];
		const stack = new PluginEffectStack("demo");
		stack.add("a", () => order.push("a"));
		stack.add("b", () => order.push("b"));
		stack.add("c", () => order.push("c"));
		expect(stack.size).toBe(3);
		expect(stack.labels()).toEqual(["a", "b", "c"]);
		expect(stack.release()).toEqual([]);
		expect(order).toEqual(["c", "b", "a"]);
		expect(stack.size).toBe(0);
	});

	it("add 返回的注销函数只撤这一条，且幂等", () => {
		const order: string[] = [];
		const stack = new PluginEffectStack("demo");
		stack.add("a", () => order.push("a"));
		const offB = stack.add("b", () => order.push("b"));
		offB();
		offB();
		expect(stack.labels()).toEqual(["a"]);
		expect(stack.release()).toEqual([]);
		expect(order).toEqual(["b", "a"]);
	});

	it("cleanup 抛错被隔离：其它条目照常回卷，失败项被归因", () => {
		const order: string[] = [];
		const diags: string[] = [];
		const stack = new PluginEffectStack("demo", (m) => diags.push(m));
		stack.add("bad", () => {
			throw new Error("boom");
		});
		stack.add("good", () => order.push("good"));
		expect(stack.release()).toEqual(["bad"]);
		expect(order).toEqual(["good"]);
		expect(stack.size).toBe(0);
		expect(diags.some((d) => d.includes("bad") && d.includes("boom"))).toBe(true);
	});

	it("release 幂等（第二次是空操作）", () => {
		let n = 0;
		const stack = new PluginEffectStack("demo");
		stack.add("x", () => {
			n += 1;
		});
		stack.release();
		stack.release();
		expect(n).toBe(1);
	});
});

function writePlugin(pluginsDir: string, id: string, body: string): void {
	const dir = join(pluginsDir, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({ id, name: id, apiVersion: 2, permissions: ["tools", "http"] }, null, 2),
	);
	writeFileSync(join(dir, "index.mjs"), body);
}

describe("PluginManager —— effect 栈接线（反激活不留孤儿）", () => {
	let dataDir: string;
	let cwd: string;
	let mgr: PluginManager;

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "piweb-effects-"));
		cwd = mkdtempSync(join(tmpdir(), "piweb-effects-cwd-"));
		mgr = new PluginManager(dataDir, cwd);
	});

	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	it("注册的工具/命令/路由/自建副作用随反激活一起回收", async () => {
		writePlugin(
			join(dataDir, "plugins"),
			"eff",
			`
globalThis.__effBus = 0;
globalThis.__effIntervalCleared = false;
export default {
	activate(host) {
		host.registerAgentTool({ name: "eff_tool", description: "d", execute: async () => "ok" });
		host.registerCommand({ name: "effcmd", run: () => "hi" });
		host.route("GET", "/ping", (req, res) => res.end("pong"));
		host.events.on("demo:topic", () => { globalThis.__effBus += 1; });
		host.effect("my-interval", () => { globalThis.__effIntervalCleared = true; });
	},
};
`,
		);
		const list = await mgr.ensureLoaded();
		expect(list.some((p) => p.id === "eff" && !p.error)).toBe(true);
		expect(mgr.getAgentTools().map((t) => t.name)).toContain("eff_tool");
		expect(mgr.listCommands().map((c) => c.name)).toContain("effcmd");
		mgr.busHandlers.get("demo:topic")!.forEach((h) => h({ topic: "demo:topic", from: "eff" }));
		expect((globalThis as { __effBus?: number }).__effBus).toBe(1);

		mgr["deactivateEntry"]("eff", mgr["loaded"].get("eff")!);

		expect(mgr.getAgentTools().map((t) => t.name)).not.toContain("eff_tool");
		expect(mgr.listCommands().map((c) => c.name)).not.toContain("effcmd");
		expect(mgr.busHandlers.has("demo:topic")).toBe(false);
		expect((globalThis as { __effIntervalCleared?: boolean }).__effIntervalCleared).toBe(true);
		let status = 0;
		mgr.handleHttp(
			"eff",
			"GET",
			"/ping",
			{} as never,
			{
				status: (code: number) => {
					status = code;
					return { end: () => {} };
				},
			} as never,
		);
		expect(status).toBe(404);
		delete (globalThis as { __effBus?: number }).__effBus;
		delete (globalThis as { __effIntervalCleared?: boolean }).__effIntervalCleared;
	});

	it("dispose 后 effect 栈全空（loaded 里的 effects.size 归零）", async () => {
		writePlugin(
			join(dataDir, "plugins"),
			"eff2",
			`export default { activate(host) { host.registerCommand({ name: "eff2cmd", run: () => "x" }); } };`,
		);
		await mgr.ensureLoaded();
		const p = mgr["loaded"].get("eff2")!;
		expect(p.effects!.size).toBe(1);
		mgr.dispose();
		expect(p.effects!.size).toBe(0);
		expect(mgr.listCommands()).toEqual([]);
	});
});

describe("parseInstallSpec —— 形状分类", () => {
	it("owner/repo 与子目录/#ref", () => {
		expect(parseInstallSpec("acme/tool")).toMatchObject({ kind: "github", owner: "acme", repo: "tool" });
		expect(parseInstallSpec("acme/mono/plugins/tool")).toMatchObject({
			kind: "github",
			owner: "acme",
			repo: "mono",
			subpath: "plugins/tool",
		});
		expect(parseInstallSpec("acme/tool#v1.2")).toMatchObject({ kind: "github", ref: "v1.2" });
	});

	it("GitHub 网页 URL（含 tree/<ref>/<sub>）", () => {
		expect(parseInstallSpec("https://github.com/acme/tool")).toMatchObject({
			kind: "github",
			owner: "acme",
			repo: "tool",
		});
		expect(parseInstallSpec("https://github.com/acme/mono/tree/main/plugins/tool")).toMatchObject({
			kind: "github",
			ref: "main",
			subpath: "plugins/tool",
		});
	});

	it("npm 包名与非法形状", () => {
		expect(parseInstallSpec("some-plugin")).toMatchObject({ kind: "npm" });
		expect(parseInstallSpec("@scope/pkg")).toMatchObject({ kind: "npm" });
		expect(parseInstallSpec("!!!")).toMatchObject({ kind: "invalid" });
		expect(parseInstallSpec("")).toMatchObject({ kind: "invalid" });
	});
});

describe("inspectLocalInstallSpec —— 本地可判定的检查", () => {
	let dataDir: string;
	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "piweb-inspect-"));
	});
	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true });
	});

	it("已装 → already-installed（force 时不报）", () => {
		mkdirSync(join(dataDir, "plugins", "tool"), { recursive: true });
		const r = inspectLocalInstallSpec("acme/tool", { pluginsDir: join(dataDir, "plugins") });
		expect(r).toMatchObject({ problem: "already-installed", installed: true, suggestedId: "tool" });
		expect(
			inspectLocalInstallSpec("acme/tool", { pluginsDir: join(dataDir, "plugins"), force: true }).problem,
		).toBeUndefined();
	});

	it("形状不对 → invalid-spec；本地路径不存在 → not-found", () => {
		expect(inspectLocalInstallSpec("!!!", { pluginsDir: join(dataDir, "plugins") }).problem).toBe("invalid-spec");
		const r = inspectLocalInstallSpec(join(dataDir, "nope"), { pluginsDir: join(dataDir, "plugins") });
		expect(r).toMatchObject({ problem: "not-found", spec: { kind: "path" } });
	});

	it("suggestPluginId：manifest.id > 子目录末段 > 仓库名", () => {
		expect(suggestPluginId(parseInstallSpec("acme/tool"))).toBe("tool");
		expect(suggestPluginId(parseInstallSpec("acme/mono/plugins/my-tool"))).toBe("my-tool");
		expect(suggestPluginId(parseInstallSpec("acme/tool"), "custom-id")).toBe("custom-id");
	});
});

describe("inspectInstallSpec —— 远端探测（fetch 替身）", () => {
	let dataDir: string;
	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "piweb-inspect2-"));
	});
	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true });
	});

	const pluginsDir = () => join(dataDir, "plugins");

	it("探到 manifest → 展示字段 + id 用 manifest.id", async () => {
		const fake = (async () =>
			new Response(JSON.stringify({ id: "realId", name: "Real", version: "1.0.0" }), { status: 200 })) as typeof fetch;
		const r = await inspectInstallSpec("acme/tool", { pluginsDir: pluginsDir(), fetchImpl: fake });
		expect(r.problem).toBeUndefined();
		expect(r.suggestedId).toBe("realId");
		expect(r.manifest).toMatchObject({ id: "realId", name: "Real", version: "1.0.0" });
	});

	it("远端 404 → not-found；非 JSON 形状 → not-a-bundle", async () => {
		const notFound = (async () => new Response("nope", { status: 404 })) as typeof fetch;
		expect((await inspectInstallSpec("acme/tool", { pluginsDir: pluginsDir(), fetchImpl: notFound })).problem).toBe(
			"not-found",
		);
		const badShape = (async () => new Response(JSON.stringify({ foo: 1 }), { status: 200 })) as typeof fetch;
		expect((await inspectInstallSpec("acme/tool", { pluginsDir: pluginsDir(), fetchImpl: badShape })).problem).toBe(
			"not-a-bundle",
		);
	});

	it("网络异常 → network（不阻塞安装，只作提示）", async () => {
		const boom = (async () => {
			throw new Error("ENOTFOUND");
		}) as typeof fetch;
		const r = await inspectInstallSpec("acme/tool", { pluginsDir: pluginsDir(), fetchImpl: boom });
		expect(r.problem).toBe("network");
	});

	it("本地目录源：读它的 manifest.json（缺失 → not-a-package）", async () => {
		const good = mkdtempSync(join(tmpdir(), "piweb-local-ok-"));
		writeFileSync(join(good, "manifest.json"), JSON.stringify({ id: "local-one", name: "Local" }));
		expect(await inspectInstallSpec(good, { pluginsDir: pluginsDir() })).toMatchObject({
			suggestedId: "local-one",
			manifest: { id: "local-one" },
		});
		const bad = mkdtempSync(join(tmpdir(), "piweb-local-bad-"));
		expect((await inspectInstallSpec(bad, { pluginsDir: pluginsDir() })).problem).toBe("not-a-package");
		rmSync(good, { recursive: true, force: true });
		rmSync(bad, { recursive: true, force: true });
	});
});

describe("manifestCandidateUrls / pickManifestFields", () => {
	it("按 ref/子目录拼 raw URL", () => {
		expect(manifestCandidateUrls(parseInstallSpec("acme/tool"))[0]).toBe(
			"https://raw.githubusercontent.com/acme/tool/HEAD/manifest.json",
		);
		expect(manifestCandidateUrls(parseInstallSpec("acme/mono/sub#dev"))[0]).toBe(
			"https://raw.githubusercontent.com/acme/mono/dev/sub/manifest.json",
		);
		expect(manifestCandidateUrls(parseInstallSpec("some-npm-pkg"))).toEqual([]);
	});

	it("非插件 manifest 返回 null", () => {
		expect(pickManifestFields({ foo: 1 })).toBeNull();
		expect(pickManifestFields({ id: "x" })).toMatchObject({ id: "x" });
	});
});

export type _HostAnchor = PluginHost;
