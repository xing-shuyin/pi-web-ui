import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createMockHost as legacyCreateMockHost, definePlugin, SDK_VERSION } from "../../plugin-sdk/index.mjs";
import { createMockHost as createRawMockHost } from "../../plugin-sdk/testing.mjs";
import type { PluginHost, PluginModule } from "../../plugin-sdk/index";
import type { MockHost, MockHostCall, MockHostOverrides } from "../../plugin-sdk/testing";
import type { PluginHost as ServerPluginHost } from "../../server/plugins";
type ServerKeysMissingFromMock = Exclude<keyof ServerPluginHost, keyof MockHost>;
const _serverHostCoveredByMock: ServerKeysMissingFromMock extends never ? true : never = true;

const createMockHost = (overrides?: MockHostOverrides): MockHost => createRawMockHost(overrides) as unknown as MockHost;

const demoPlugin: PluginModule = definePlugin({
	async activate(host: PluginHost) {
		const tone = String(host.getSettings().tone ?? "short");
		host.ui.register({
			slot: "composer.actions",
			id: "tone",
			label: "语气",
			kind: "select",
			action: "demo:tone",
			value: tone,
			options: [{ value: "short", label: "简短" }],
		});
		const offMsg = host.onMessage(() => {});
		const offTool = host.registerAgentTool({
			name: "demo_hello",
			description: "打招呼",
			execute: async () => "hi",
		});
		const offCmd = host.registerCommand({ name: "demo", run: () => {} });
		host.log("warn", "hello", 123);
		host.notify("info", "ready");
		return () => {
			offMsg();
			offTool();
			offCmd();
		};
	},
});

const methods = (host: MockHost): string[] => host.calls.map((c) => c.method);
const regValue = (host: MockHost, m: string): unknown => {
	const reg = host.calls.find((c) => c.method === m);
	expect(reg).toBeDefined();
	return ((reg as MockHostCall).args[0] as { value?: unknown }).value;
};

describe("createMockHost：独立 Node 测试入口", () => {
	it("兼容总入口与 testing 入口共享同一个 Harness", () => {
		expect(legacyCreateMockHost).toBe(createRawMockHost);
	});

	it("原生路径解析成功与越界调用均只记录一次，reset 保留 Harness 状态", () => {
		const cwd = resolve("sdk-mock-workspace");
		const host = createMockHost({ cwd });
		expect(host.resolveInWorkspace("src/../entry.mjs")).toBe(resolve(cwd, "entry.mjs"));
		expect(() => host.resolveInWorkspace("../outside.txt")).toThrowError(/工作区/);
		expect(host.mock.calls("resolveInWorkspace")).toEqual([
			{ method: "resolveInWorkspace", args: ["src/../entry.mjs"], seq: 0 },
			{ method: "resolveInWorkspace", args: ["../outside.txt"], seq: 1 },
		]);
		host.reset();
		expect(host.calls).toEqual([]);
		expect(host.resolveInWorkspace(".")).toBe(cwd);
		expect(host.calls[0]).toMatchObject({ method: "resolveInWorkspace", seq: 0 });
	});
});

describe("createMockHost：示例插件 activate", () => {
	it("记录调用 + 读到注入的 settings + 分级日志", async () => {
		const host = createMockHost({ settings: { tone: "full" } });
		await demoPlugin.activate(host);
		const m = methods(host);
		for (const want of [
			"getSettings",
			"ui.register",
			"onMessage",
			"registerAgentTool",
			"registerCommand",
			"log",
			"notify",
		]) {
			expect(m).toContain(want);
		}
		expect(regValue(host, "ui.register")).toBe("full");
		expect(host.logs).toEqual([{ level: "warn", text: "hello 123" }]);
	});

	it("缺 settings 预设时 getSettings 回 {}（插件侧 ?? 生效）", async () => {
		const host = createMockHost();
		expect(host.getSettings()).toEqual({});
		await demoPlugin.activate(host);
		expect(regValue(host, "ui.register")).toBe("short");
	});
});

describe("createMockHost：overrides", () => {
	it("命名空间按子键合并覆盖，且仍进 calls 记录", async () => {
		const host = createMockHost({
			conversations: { list: () => [{ id: "c1", title: "t" }] },
			llm: { complete: async () => ({ ok: true, text: "mock answer" }) },
		});
		expect(await host.conversations.list()).toEqual([{ id: "c1", title: "t" }]);
		expect(await host.llm.complete({ prompt: "hi" })).toEqual({ ok: true, text: "mock answer" });
		expect(methods(host)).toContain("conversations.list");
		expect(methods(host)).toContain("llm.complete");
		expect(host.conversations.get("c1")).toBeNull();
	});

	it("顶层方法整体替换；log 被换掉后不再写 logs（但仍记 calls）", () => {
		const seen: unknown[][] = [];
		const host = createMockHost({
			log: (...a: unknown[]) => {
				seen.push(a);
			},
		});
		host.log("warn", "x");
		expect(seen).toEqual([["warn", "x"]]);
		expect(host.logs).toEqual([]);
		expect(methods(host)).toEqual(["log"]);
	});

	it("cwd/dir/dataDir 标量可改；非法 overrides 与覆盖 harness 字段直接抛错", () => {
		const host = createMockHost({ cwd: "/proj", dir: "/proj/.p", dataDir: "/d" });
		expect(host.cwd).toBe("/proj");
		expect(host.dir).toBe("/proj/.p");
		expect(host.dataDir).toBe("/d");
		expect(() => createMockHost("x" as unknown as undefined)).toThrow();
		expect(() => createMockHost({ reset: () => {} })).toThrow();
		expect(() => createMockHost({ calls: [] })).toThrow();
	});
});

describe("createMockHost：reset()", () => {
	it("清空 calls + logs（原地）；settings 与 handlers 保留", async () => {
		const host = createMockHost({ settings: { a: 1 } });
		const callsRef = host.calls;
		const logsRef = host.logs;
		await demoPlugin.activate(host);
		expect(host.calls.length).toBeGreaterThan(0);
		host.reset();
		expect(host.calls).toEqual([]);
		expect(host.logs).toEqual([]);
		expect(host.calls).toBe(callsRef);
		expect(host.logs).toBe(logsRef);
		expect(host.getSettings()).toEqual({ a: 1 });
		expect(host.mock.handlers["onMessage"].length).toBe(1);
		expect(host.mock.agentTools.map((t) => t.name)).toEqual(["demo_hello"]);
		expect(host.ui.list().items.length).toBe(1);
	});
});

describe("createMockHost：无注入回退语义", () => {
	it("对话/模型/权限/客户端桥 extras", async () => {
		const host = createMockHost();
		expect((await host.prompt("c", { text: "hi" })).ok).toBe(false);
		expect((await host.steer("c", "x")).ok).toBe(false);
		expect((await host.abortRun("c")).ok).toBe(false);
		expect((await host.chatWait({ text: "hi" })).ok).toBe(false);
		expect((await host.chat({ text: "hi" })).ok).toBe(false);
		expect((await host.llm.complete({ prompt: "hi" })).ok).toBe(false);
		expect(await host.requestPermission({ family: "net", hosts: ["example.com"] })).toBe(false);
		expect(await host.models.list()).toEqual([]);
		expect(await host.conversations.list()).toEqual([]);
		expect(await host.conversations.search("x")).toEqual([]);
		expect(host.conversations.get("c")).toBeNull();
		expect(host.getActiveConversation()).toBeNull();
		expect(typeof host.onClientModelChanged(() => {})).toBe("function");
		expect((await host.net.fetch("https://example.com")).ok).toBe(false);
		expect(await host.dialogs.confirm({})).toBe(false);
		expect(await host.dialogs.select({})).toEqual({ ok: false });
		expect(await host.dialogs.input({})).toEqual({ ok: false });
		expect(await host.notifyAction({ text: "t", actions: [] })).toBeNull();
		expect(host.searchProviders.list()).toEqual([]);
		expect(host.composerProviders.list()).toEqual([]);
		expect(typeof host.shortcuts.register("ctrl+k", () => {})).toBe("function");
		expect(typeof host.searchProviders.register({ id: "s", label: "s", search: async () => [] })).toBe("function");
	});

	it("fs/scm/bash/project/schedule/route/storage", async () => {
		const host = createMockHost();
		expect(await host.fs.list()).toEqual([]);
		expect(await host.fs.readText("a.txt")).toBe("");
		expect(await host.fs.read("a.txt")).toBeInstanceOf(Uint8Array);
		expect(await host.fs.glob("**")).toEqual([]);
		expect(await host.fs.requestAccess("/elsewhere")).toBe(false);
		expect(host.fs.authorizedDirs()).toEqual([]);
		expect((await host.fs.stat("a/b.txt")).name).toBe("b.txt");
		await host.fs.write("a.txt", "x");
		expect(methods(host)).toContain("fs.write");
		expect((await host.scm.status()) as { ok: boolean }).toMatchObject({ ok: false });
		const bash = await host.bash("echo hi");
		expect(bash.ok).toBe(false);
		expect(bash.output).toBe("");
		expect(await host.project.create({ dir: "/x" })).toMatchObject({ ok: false });
		expect(host.ui.list()).toEqual({ items: [], arrange: [] });
		expect(typeof host.route("GET", "/ping", () => {})).toBe("function");
		expect(typeof host.schedule("0 9 * * *", () => {})).toBe("function");
		const bg = host.registerBackgroundTask({ id: "t", label: "T" });
		expect(typeof bg.update).toBe("function");
		expect(typeof bg.unregister).toBe("function");
		expect(await host.ensureDeps(["left-pad"])).toBe(true);
		host.storage.set("k", 1);
		expect(host.storage.get("k", 0)).toBe(1);
		expect(host.storage.get("missing", "fb")).toBe("fb");
		host.secrets.set("token", "s3cr3t");
		expect(host.secrets.has("token")).toBe(true);
		expect(host.secrets.get("token")).toBe("s3cr3t");
		expect(methods(host)).toContain("storage.set");
	});

	it("schedule 只记调用不设真定时器", async () => {
		const host = createMockHost();
		let fired = false;
		const off = host.schedule("*/5 * * * *", () => {
			fired = true;
		});
		expect(typeof off).toBe("function");
		await new Promise((r) => setTimeout(r, 20));
		expect(fired).toBe(false);
		expect(methods(host)).toContain("schedule");
	});
});

describe("createMockHost：mock 驱动器", () => {
	it("emit 触发订阅 handler；注销后不再触发", () => {
		const host = createMockHost();
		const got: unknown[][] = [];
		const off = host.onMessage((p, from) => {
			got.push([p, from]);
		});
		expect(host.mock.handlers["onMessage"].length).toBe(1);
		host.mock.emit("onMessage", { a: 1 }, "c1");
		expect(got).toEqual([[{ a: 1 }, "c1"]]);
		off();
		expect(host.mock.handlers["onMessage"].length).toBe(0);
		host.mock.emit("onMessage", { a: 2 });
		expect(got).toHaveLength(1);
	});

	it("emitSettings 合并预设 + 触发 onSettingsChanged；setSettings 只合并", () => {
		const host = createMockHost({ settings: { tone: "short" } });
		const seen: unknown[] = [];
		host.onSettingsChanged((v) => seen.push({ ...v } as Record<string, unknown>));
		host.mock.setSettings({ other: 1 });
		expect(seen).toHaveLength(0);
		expect(host.getSettings()).toMatchObject({ tone: "short", other: 1 });
		host.mock.emitSettings({ tone: "full" });
		expect(host.getSettings()).toMatchObject({ tone: "full", other: 1 });
		expect(seen).toEqual([{ tone: "full", other: 1 }]);
	});

	it("fs.watch 也走同一套 handlers/emit（点分方法名）", () => {
		const host = createMockHost();
		const evs: unknown[] = [];
		const off = host.fs.watch("notes", (ev) => evs.push(ev));
		host.mock.emit("fs.watch", { type: "change", path: "notes/a.md" });
		expect(evs).toEqual([{ type: "change", path: "notes/a.md" }]);
		off();
		expect(host.mock.handlers["fs.watch"].length).toBe(0);
	});

	it("events.on / shortcuts.register 的回调在第二参，照样存 + 可 emit", () => {
		const host = createMockHost();
		const got: unknown[][] = [];
		const offEv = host.events.on("topic", (ev) => {
			got.push(["ev", ev]);
		});
		let cut = 0;
		const offCut = host.shortcuts.register("ctrl+k", () => {
			cut += 1;
		});
		host.mock.emit("events.on", { n: 1 });
		host.mock.emit("shortcuts.register");
		expect(got).toEqual([["ev", { n: 1 }]]);
		expect(cut).toBe(1);
		offEv();
		offCut();
		expect(host.mock.handlers["events.on"].length).toBe(0);
		expect(host.mock.handlers["shortcuts.register"].length).toBe(0);
	});
});

describe("createMockHost：ui 内存注册表", () => {
	it("register/update/remove/list/arrange + 同 id 覆盖 + off 只摘除本次", () => {
		const host = createMockHost();
		const offA = host.ui.register([{ id: "a", label: "A" }, { label: "no-id" }]);
		expect(host.ui.list().items.map((i) => i.id)).toEqual(["a", "mock-1"]);
		host.ui.update("a", { label: "A2", badge: "1" });
		expect(host.ui.list().items.find((i) => i.id === "a")).toMatchObject({ label: "A2", badge: "1" });
		host.ui.update("missing", { label: "x" });
		expect(host.ui.list().items.some((i) => i.id === "missing")).toBe(false);
		host.ui.register({ id: "a", label: "A-override" });
		expect(host.ui.list().items.find((i) => i.id === "a")?.label).toBe("A-override");
		host.ui.remove("mock-1");
		expect(host.ui.list().items.map((i) => i.id)).toEqual(["a"]);
		host.ui.arrange([{ op: "hide", id: "host:x" }]);
		expect(host.ui.list().arrange).toEqual([{ op: "hide", id: "host:x" }]);
		offA();
		expect(host.ui.list().items).toEqual([]);
	});

	it("单次 register 上限 32 条（与宿主同口径）", () => {
		const host = createMockHost();
		host.ui.register(Array.from({ length: 40 }, (_, i) => ({ id: `k${i}` })));
		expect(host.ui.list().items.length).toBe(32);
	});
});

describe("createMockHost：工具/命令/路由/定时注册表", () => {
	it("定义体进 mock 存档，可直接调 execute；注销即摘除", async () => {
		const host = createMockHost();
		const offTool = host.registerAgentTool({
			name: "demo_hello",
			description: "d",
			execute: async (_id, params) => `hi ${(params as { name?: string }).name ?? "?"}`,
		});
		const offCmd = host.registerCommand({ name: "demo", run: () => "ran" });
		const offRoute = host.route("GET", "/ping", () => {});
		expect(host.mock.agentTools.map((t) => t.name)).toEqual(["demo_hello"]);
		expect(host.mock.commands.map((c) => c.name)).toEqual(["demo"]);
		expect(host.mock.routes).toMatchObject([{ method: "GET", path: "/ping" }]);
		expect(await host.mock.agentTools[0].execute("cid", { name: "x" })).toBe("hi x");
		offTool();
		offCmd();
		offRoute();
		expect(host.mock.agentTools).toEqual([]);
		expect(host.mock.commands).toEqual([]);
		expect(host.mock.routes).toEqual([]);
	});

	it("schedule 只登记不跑；fireSchedules 手动触发；注销即摘除", async () => {
		const host = createMockHost();
		const ran: string[] = [];
		const off1 = host.schedule(60_000, () => {
			ran.push("a");
			return "A";
		});
		host.schedule(
			"0 9 * * *",
			async () => {
				ran.push("b");
				return "B";
			},
			{ id: "daily" },
		);
		expect(host.mock.schedules.map((s) => s.spec)).toEqual([60_000, "0 9 * * *"]);
		expect(host.mock.schedules[1].opts).toEqual({ id: "daily" });
		await expect(host.mock.fireSchedules()).resolves.toEqual(["A", "B"]);
		expect(ran).toEqual(["a", "b"]);
		off1();
		await host.mock.fireSchedules();
		expect(ran).toEqual(["a", "b", "b"]);
	});
});

describe("createMockHost：emitAsync / seq / calls 过滤", () => {
	it("emitAsync 按序 await 异步 handler，返回各返回值；抛错即 reject", async () => {
		const host = createMockHost();
		const order: string[] = [];
		host.onMessage(async (p) => {
			const n = (p as { n?: number }).n ?? 0;
			await new Promise((r) => setTimeout(r, 10));
			order.push(`slow:${n}`);
			return `r${n}`;
		});
		host.onMessage((p) => {
			const n = (p as { n?: number }).n ?? 0;
			order.push(`fast:${n}`);
			return "fast";
		});
		await expect(host.mock.emitAsync("onMessage", { n: 1 })).resolves.toEqual(["r1", "fast"]);
		expect(order).toEqual(["slow:1", "fast:1"]);
		const failing = createMockHost();
		failing.onMessage(() => {
			throw new Error("boom");
		});
		await expect(failing.mock.emitAsync("onMessage", {})).rejects.toThrow("boom");
	});

	it("同步 emit 不等待异步 handler（对照语义）", async () => {
		const host = createMockHost();
		const order: string[] = [];
		host.onMessage(async () => {
			await new Promise((r) => setTimeout(r, 10));
			order.push("slow");
		});
		host.onMessage(() => {
			order.push("fast");
		});
		host.mock.emit("onMessage", {});
		expect(order).toEqual(["fast"]);
		await new Promise((r) => setTimeout(r, 30));
		expect(order).toEqual(["fast", "slow"]);
	});

	it("calls 条目带 seq；mock.calls(method?) 过滤", async () => {
		const host = createMockHost();
		await demoPlugin.activate(host);
		expect(host.calls[0]).toMatchObject({ method: "getSettings", seq: 0 });
		const seqs = host.calls.map((c) => c.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);
		expect(host.mock.calls("log").length).toBe(1);
		expect(host.mock.calls("log")[0]).toBe(host.calls.find((c) => c.method === "log"));
		expect(host.mock.calls("nope")).toEqual([]);
		expect(host.mock.calls()).toHaveLength(host.calls.length);
	});
});

describe("plugin-sdk 版本", () => {
	it("SDK_VERSION 与 package.json 一致（单源：改版本两处同步）", () => {
		const pkg = JSON.parse(readFileSync(new URL("../../plugin-sdk/package.json", import.meta.url), "utf8")) as {
			version?: string;
		};
		expect(SDK_VERSION).toBe(pkg.version);
		expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
