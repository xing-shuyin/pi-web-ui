import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PluginManager, type PluginToolEvent } from "../../server/plugins.js";
import type { ServerMessage } from "../../server/protocol.js";

let dir: string;
let mgr: PluginManager;

function makePlugin(id: string, code: string, opts?: { client?: boolean; manifest?: Record<string, unknown> }): void {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id, ...(opts?.manifest ?? {}) }));
	writeFileSync(join(pdir, "index.mjs"), code);
	if (opts?.client) {
		mkdirSync(join(pdir, "client"), { recursive: true });
		writeFileSync(join(pdir, "client", "entry.mjs"), "export default {};");
	}
}

const ECHO_PLUGIN = `
export default {
	activate(host) {
		host.seen = [];
		return host.onMessage((payload, from) => {
			host.seen.push([payload, from]);
			if (payload?.action === "ping") host.broadcast({ pong: payload.value });
			if (payload?.action === "to") host.sendTo(payload.clientId, { private: true });
			if (payload?.action === "notify") host.notify("warning", "plugin says hi");
		});
	},
};`;
const THROW_PLUGIN = `export default { activate() { throw new Error("boom"); } };`;
const DEACT_PLUGIN = `
globalThis.__deact = globalThis.__deact || [];
export default {
	activate() { return () => { globalThis.__deact.push(1); }; },
};`;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-mgr-test-"));
	mgr = new PluginManager(dir, dir);
});

afterEach(() => {
	mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("PluginManager", () => {
	it("activate + onMessage routing with sender clientId", async () => {
		makePlugin("echo", ECHO_PLUGIN);
		const list = await mgr.ensureLoaded();
		expect(list.find((p) => p.id === "echo")?.error).toBeUndefined();

		const sent: ServerMessage[] = [];
		mgr.addSender(
			(m) => sent.push(m),
			() => "client-1",
		);
		mgr.handleMessage("echo", { action: "ping", value: 7 }, "client-1");
		expect(sent).toEqual([{ type: "plugin_data", pluginId: "echo", payload: { pong: 7 } }]);
	});

	it("handler exceptions are isolated and do not break other handlers", async () => {
		makePlugin("thrower", `export default { activate(h) { h.onMessage(() => { throw new Error("nope"); }); } };`);
		makePlugin("echo2", ECHO_PLUGIN);
		await mgr.ensureLoaded();
		const sent: ServerMessage[] = [];
		mgr.addSender(
			(m) => sent.push(m),
			() => null,
		);
		mgr.handleMessage("thrower", {}, undefined);
		mgr.handleMessage("echo2", { action: "ping", value: 1 }, undefined);
		expect(sent).toHaveLength(1);
	});

	it("emitToolEvent fans out; throwing handler is isolated", async () => {
		makePlugin(
			"tools",
			`
			globalThis.__toolSeen = [];
			export default {
				activate(h) {
					const offBad = h.onToolEvent(() => { throw new Error("bad"); });
					const off = h.onToolEvent((ev) => { globalThis.__toolSeen.push(ev.phase); });
					return () => { off(); offBad(); };
				},
			};`,
		);
		await mgr.ensureLoaded();
		const ev: PluginToolEvent = { phase: "start", toolName: "bash" };
		mgr.emitToolEvent(ev);
		mgr.emitToolEvent(ev);
		const g = globalThis as { __toolSeen?: string[] };
		expect(g.__toolSeen).toEqual(["start", "start"]);
	});

	it("emitConversationChanged fans out; throwing handler is isolated", async () => {
		makePlugin(
			"convwatch",
			`
			globalThis.__convSeen = [];
			export default {
				activate(h) {
					const offBad = h.onConversationChanged(() => { throw new Error("bad"); });
					const off = h.onConversationChanged(() => { globalThis.__convSeen.push(1); });
					const offRun = h.onRunEvent(() => {});
					if (typeof h.getActiveConversation !== "function") throw new Error("missing getActiveConversation");
					return () => { off(); offBad(); offRun(); };
				},
			};`,
		);
		await mgr.ensureLoaded();
		mgr.emitConversationChanged();
		mgr.emitConversationChanged();
		const g = globalThis as { __convSeen?: number[] };
		expect(g.__convSeen).toEqual([1, 1]);
	});

	it("notifyAll broadcasts a notice; sendTo targets one socket only", async () => {
		makePlugin("echo3", ECHO_PLUGIN);
		await mgr.ensureLoaded();
		const a: ServerMessage[] = [];
		const b: ServerMessage[] = [];
		mgr.addSender(
			(m) => a.push(m),
			() => "a",
		);
		mgr.addSender(
			(m) => b.push(m),
			() => "b",
		);
		mgr.handleMessage("echo3", { action: "notify" }, "a");
		mgr.handleMessage("echo3", { action: "to", clientId: "b" }, "b");
		expect(a).toContainEqual({
			type: "notice",
			level: "warning",
			text: "plugin says hi",
		});
		expect(a.filter((m) => m.type === "plugin_data")).toHaveLength(0);
		expect(b.filter((m) => m.type === "plugin_data")).toHaveLength(1);
	});

	it("scan 坏 manifest 给占位行（不再跳过）; epoch increments on reload; dispose deactivates", async () => {
		makePlugin("good", DEACT_PLUGIN);
		mkdirSync(join(dir, "plugins", "bad"), { recursive: true });
		writeFileSync(join(dir, "plugins", "bad", "manifest.json"), "{oops");
		const first = await mgr.ensureLoaded();
		expect(first.map((p) => p.id).sort()).toEqual(["bad", "good"]);
		expect(first.find((p) => p.id === "bad")?.error).toContain("manifest.json");
		expect(first.find((p) => p.id === "bad")?.active).toBe(false);
		expect(mgr.epoch).toBe(0);

		const second = await mgr.reload();
		expect(second.map((p) => p.id).sort()).toEqual(["bad", "good"]);
		expect(mgr.epoch).toBe(1);

		mgr.dispose();
		expect((globalThis as { __deact?: number[] }).__deact?.length).toBe(2);

		makePlugin("broken", THROW_PLUGIN);
		const third = await mgr.ensureLoaded();
		expect(third.find((p) => p.id === "broken")?.error).toContain("boom");
	});

	it("scan 优雅跳过失效的死链/非目录，不误报 manifest 缺失", async () => {
		makePlugin("valid", DEACT_PLUGIN);
		const deadTarget = join(dir, "does-not-exist");
		const deadLink = join(dir, "plugins", "broken-link");
		try {
			symlinkSync(deadTarget, deadLink, process.platform === "win32" ? "junction" : "dir");
		} catch {
			try {
				symlinkSync(deadTarget, deadLink);
			} catch {}
		}

		const list = await mgr.ensureLoaded();
		expect(list.find((p) => p.id === "broken-link")).toBeUndefined();
		expect(list.find((p) => p.id === "valid")?.active).toBe(true);
	});

	it("目录短暂消失（install --force 的 rm→cp 窗口）后，下次扫描重新激活并恢复路由", async () => {
		const code = `export default {
			activate(h) {
				h.route("GET", "/ping", (req, res) => res.end("pong"));
			},
		};`;
		makePlugin("hotswap", code);
		const fake = () => {
			const res = {
				status: () => res,
				end: (body?: string) => void (res.body = body),
				body: undefined as string | undefined,
			};
			return res;
		};
		await mgr.ensureLoaded();
		let res = fake();
		mgr.handleHttp("hotswap", "GET", "/ping", {} as never, res as never);
		expect(res.body).toBe("pong");

		rmSync(join(dir, "plugins", "hotswap"), { recursive: true, force: true });
		expect(await mgr.ensureLoaded()).toEqual([]);
		res = fake();
		mgr.handleHttp("hotswap", "GET", "/ping", {} as never, res as never);
		expect(res.body).toBe("not found");

		makePlugin("hotswap", code.replace("pong", "pong2"));
		const list = await mgr.ensureLoaded();
		expect(list.map((x) => x.id)).toEqual(["hotswap"]);
		res = fake();
		mgr.handleHttp("hotswap", "GET", "/ping", {} as never, res as never);
		expect(res.body).toBe("pong2");
	});

	it("manifest icon/description surface in the catalog", async () => {
		makePlugin("pretty", "export default {};", {
			client: true,
			manifest: { name: "漂亮", icon: "✨", description: "desc" },
		});
		const list = await mgr.list();
		const p = list.find((x) => x.id === "pretty");
		expect(p?.icon).toBe("✨");
		expect(p?.description).toBe("desc");
		expect(p?.hasClient).toBe(true);
	});

	it("manifest view/preload surface in the catalog（无视图但要常驻的插件）", async () => {
		makePlugin("floaty", "export default {};", {
			client: true,
			manifest: { name: "浮窗", view: false, preload: true },
		});
		makePlugin("plain", "export default {};", { client: true, manifest: { name: "普通" } });
		makePlugin("backend-only", "export default {};", { client: false, manifest: { name: "纯后端" } });
		const list = await mgr.list();
		const floaty = list.find((x) => x.id === "floaty");
		expect(floaty?.view).toBe(false);
		expect(floaty?.preload).toBe(true);
		const plain = list.find((x) => x.id === "plain");
		expect(plain?.view).toBe(true);
		expect(plain?.preload).toBe(false);
		const backendOnly = list.find((x) => x.id === "backend-only");
		expect(backendOnly?.view).toBe(false);
	});
});

type Probe = { activatedCwd?: string; seen?: string[]; liveCwdInHandler?: string };
const probe = (): Probe => (globalThis as unknown as { __cwdProbe: Probe }).__cwdProbe;

const CWD_PLUGIN = `
globalThis.__cwdProbe = globalThis.__cwdProbe || {};
export default {
	activate(host) {
		const p = globalThis.__cwdProbe;
		p.activatedCwd = host.cwd;
		p.seen = [];
		host.onCwdChange(() => { throw new Error("boom"); }); // 抛错钩子：验证扇出隔离
		return host.onCwdChange((cwd) => {
			p.seen.push(cwd);
			p.liveCwdInHandler = host.cwd; // getter 必须返回活值（新根）
			if (String(cwd).endsWith("proj-b")) host.broadcast({ kind: "workspace", root: cwd });
		});
	},
};`;

describe("PluginManager cwd 跟随", () => {
	it("notifyCwd 更新 host.cwd、触发钩子并广播 workspace", async () => {
		makePlugin("ed", CWD_PLUGIN);
		await mgr.ensureLoaded();
		expect(probe().activatedCwd).toBe(resolve(dir));

		const sent: ServerMessage[] = [];
		mgr.addSender(
			(m) => sent.push(m),
			() => null,
		);
		const next = resolve(join(dir, "proj-b"));
		mgr.notifyCwd(join(dir, "proj-b"));
		expect(probe().seen).toEqual([next]);
		expect(probe().liveCwdInHandler).toBe(next);
		expect(sent).toEqual([{ type: "plugin_data", pluginId: "ed", payload: { kind: "workspace", root: next } }]);

		mgr.notifyCwd(join(dir, "proj-b"));
		expect(probe().seen).toHaveLength(1);
		expect(sent).toHaveLength(1);
	});

	it("抛错的 cwd 钩子被隔离，其余钩子照常执行", async () => {
		makePlugin("ed", CWD_PLUGIN);
		await mgr.ensureLoaded();
		expect(() => mgr.notifyCwd(join(dir, "x"))).not.toThrow();
		expect(probe().seen).toHaveLength(1);
	});

	it("dispose 反激活后旧钩子不再被触发且清理全局表与定时器", async () => {
		makePlugin("ed", CWD_PLUGIN);
		await mgr.ensureLoaded();
		mgr.dispose();
		mgr.notifyCwd(join(dir, "y"));
		expect(probe().seen).toHaveLength(0);
		expect(mgr.listCommands()).toHaveLength(0);
	});
});

type Snap = import("../../server/plugins.js").PluginConversationSnapshot;

const snap = (over: Partial<Snap> = {}): Snap => ({
	clientId: "tab-1",
	conversationId: "conv-1",
	isSubagent: false,
	title: "t",
	model: "openai/gpt-5",
	at: 1,
	isStreaming: false,
	messages: [],
	streamingMessage: null,
	stats: { totalMessages: 0, tokens: { input: 0, output: 0, total: 0 }, cost: 0 },
	...over,
});

const MODEL_WATCH_PLUGIN = `
globalThis.__modelSeen = [];
export default {
	activate(host) {
		const offBad = host.onClientModelChanged(() => { throw new Error("bad"); });
		const off = host.onClientModelChanged((s) => { globalThis.__modelSeen.push(s.model ?? "(none)"); });
		return () => { off(); offBad(); };
	},
};`;

describe("PluginManager #542 客户端会话快照与模型事件", () => {
	const seen = (): string[] => (globalThis as { __modelSeen?: string[] }).__modelSeen ?? [];

	it("getActiveConversation 透传 {clientId}，且交给插件的快照是拷贝", () => {
		const calls: unknown[] = [];
		const live = { ...snap(), messages: [{ role: "user", text: "hi" }] } as unknown as Snap;
		mgr.conversationProvider = (opts) => {
			calls.push(opts);
			return live;
		};
		const got = mgr.getActiveConversation({ clientId: "tab-1" });
		expect(calls).toEqual([{ clientId: "tab-1" }]);
		expect(got?.clientId).toBe("tab-1");
		expect(got?.messages).toHaveLength(1);
		expect(got?.messages[0]).not.toBe(live.messages[0]);
		(got!.messages[0] as unknown as { text: string }).text = "tampered";
		got!.messages.push({ role: "user" } as never);
		expect(live.messages).toHaveLength(1);
		expect((live.messages[0] as unknown as { text: string }).text).toBe("hi");
		expect(mgr.getActiveConversation()?.conversationId).toBe("conv-1");
		expect(calls[1]).toBeUndefined();
	});

	it("未注入 provider / provider 抛错 → null（插件侧不炸）", () => {
		expect(mgr.getActiveConversation({ clientId: "tab-1" })).toBeNull();
		mgr.conversationProvider = () => {
			throw new Error("boom");
		};
		expect(mgr.getActiveConversation()).toBeNull();
	});

	it("emitClientModelChanged 扇出（抛错隔离）+ 反激活后不再触发", async () => {
		makePlugin("modelwatch", MODEL_WATCH_PLUGIN);
		await mgr.ensureLoaded();
		mgr.emitClientModelChanged(snap({ model: "anthropic/sonnet" }));
		mgr.emitClientModelChanged(snap({ model: "anthropic/sonnet", conversationId: "conv-2" }));
		expect(seen()).toEqual(["anthropic/sonnet", "anthropic/sonnet"]);
		mgr.dispose();
		mgr.emitClientModelChanged(snap({ model: "other/model" }));
		expect(seen()).toHaveLength(2);
	});

	it("随包官方插件自动同步升级：低版本已装插件自动热更新至随包新版并备份", async () => {
		const fakePkgRoot = join(dir, "fake-pkg");
		const fakeBuiltinPlugins = join(fakePkgRoot, "plugins");
		mkdirSync(fakeBuiltinPlugins, { recursive: true });
		writeFileSync(join(fakeBuiltinPlugins, "catalog.json"), JSON.stringify([{ id: "pm2-manager" }]));

		const builtinPm2Dir = join(fakeBuiltinPlugins, "pm2-manager");
		mkdirSync(join(builtinPm2Dir, "client"), { recursive: true });
		writeFileSync(join(builtinPm2Dir, "manifest.json"), JSON.stringify({ name: "进程管家", version: "0.3.2" }));
		writeFileSync(join(builtinPm2Dir, "index.mjs"), "export default {};");
		writeFileSync(join(builtinPm2Dir, "client", "entry.mjs"), "export default { v: '0.3.2' };");

		const installedDir = join(dir, "plugins", "pm2-manager");
		mkdirSync(join(installedDir, "client"), { recursive: true });
		writeFileSync(join(installedDir, "manifest.json"), JSON.stringify({ name: "进程管家", version: "0.2.0" }));
		writeFileSync(join(installedDir, "index.mjs"), "export default {};");
		writeFileSync(join(installedDir, "client", "entry.mjs"), "export default { v: '0.2.0' };");
		writeFileSync(join(installedDir, "custom-data.json"), '{"token":"123"}');

		const testMgr = new PluginManager(dir, dir, join(fakeBuiltinPlugins, "catalog.json"));
		const plugins = await testMgr.ensureLoaded();

		const pm2 = plugins.find((p) => p.id === "pm2-manager");
		expect(pm2?.version).toBe("0.3.2");

		const { readFileSync } = await import("node:fs");
		const updatedEntry = readFileSync(join(installedDir, "client", "entry.mjs"), "utf8");
		expect(updatedEntry).toContain("0.3.2");

		const customData = readFileSync(join(installedDir, "custom-data.json"), "utf8");
		expect(customData).toContain("123");

		testMgr.dispose();
	});

	it("handleHttp 支持通配符路由匹配并透传 pluginPath", async () => {
		const code = `export default {
			activate(host) {
				host.route("GET", "/assets/*", (req, res) => {
					res.end("wildcard:" + req.pluginPath);
				});
				host.route("GET", "/assets/exact", (req, res) => {
					res.end("exact");
				});
			}
		};`;
		makePlugin("wildcard-test", code);
		const fake = () => {
			const res = {
				status: () => res,
				end: (body?: string) => void (res.body = body),
				body: undefined as string | undefined,
			};
			return res;
		};
		await mgr.ensureLoaded();

		let res = fake();
		mgr.handleHttp("wildcard-test", "GET", "/assets/exact", {} as never, res as never);
		expect(res.body).toBe("exact");

		res = fake();
		const reqMock: Record<string, unknown> = {};
		mgr.handleHttp("wildcard-test", "GET", "/assets/vendor/sub/file.js", reqMock as never, res as never);
		expect(res.body).toBe("wildcard:/assets/vendor/sub/file.js");
		expect(reqMock.pluginPath).toBe("/assets/vendor/sub/file.js");

		res = fake();
		mgr.handleHttp("wildcard-test", "GET", "/other/path", {} as never, res as never);
		expect(res.body).toBe("not found");
	});
});
