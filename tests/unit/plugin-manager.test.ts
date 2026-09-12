/**
 * PluginManager 纯单测（零依赖、毫秒级）：不启 server、不碰真模型。
 *
 * 覆盖：
 * - activate/deactivate 生命周期（目录删除后 dispose 调 deactivate）
 * - handleMessage 按 pluginId 路由，onMessage 回调带来源 clientId，可注销
 * - emitToolEvent 扇出 + 单个 handler 抛错被隔离
 * - notifyAll / sendTo 定向投递（fake sender）
 * - scan 跳过坏 manifest；epoch 在 reload 后递增且重激活
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
		// 定向消息只进 b
		expect(a.filter((m) => m.type === "plugin_data")).toHaveLength(0);
		expect(b.filter((m) => m.type === "plugin_data")).toHaveLength(1);
	});

	it("scan skips bad manifests; epoch increments on reload; dispose deactivates", async () => {
		makePlugin("good", DEACT_PLUGIN);
		mkdirSync(join(dir, "plugins", "bad"), { recursive: true });
		writeFileSync(join(dir, "plugins", "bad", "manifest.json"), "{oops");
		const first = await mgr.ensureLoaded();
		expect(first.map((p) => p.id)).toEqual(["good"]);
		expect(mgr.epoch).toBe(0);

		const second = await mgr.reload();
		expect(second.map((p) => p.id)).toEqual(["good"]);
		expect(mgr.epoch).toBe(1);

		mgr.dispose();
		expect((globalThis as { __deact?: number[] }).__deact?.length).toBe(2);

		// 激活失败 → error 字段，不炸进程
		makePlugin("broken", THROW_PLUGIN);
		const third = await mgr.ensureLoaded();
		expect(third.find((p) => p.id === "broken")?.error).toContain("boom");
	});

	/** 回归：`pi-web-ui install --force` 会先 rm 再 cp，插件目录在安装窗口内不存在。
	 *  撞上窗口期的一次扫描会把插件反激活；目录回来后必须能重新激活（否则插件的
	 *  HTTP 路由在本进程内永远不会再注册 → 前端只看到「代理请求失败 404」）。 */
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

		// 安装窗口期：目录被删掉的一次扫描 → 反激活
		rmSync(join(dir, "plugins", "hotswap"), { recursive: true, force: true });
		expect(await mgr.ensureLoaded()).toEqual([]);
		res = fake();
		mgr.handleHttp("hotswap", "GET", "/ping", {} as never, res as never);
		expect(res.body).toBe("not found");

		// 安装完成，目录（新代码）回来 → 必须重新激活、路由恢复
		makePlugin("hotswap", code.replace("pong", "pong2"));
		const list = await mgr.ensureLoaded();
		expect(list.map((x) => x.id)).toEqual(["hotswap"]);
		res = fake();
		mgr.handleHttp("hotswap", "GET", "/ping", {} as never, res as never);
		expect(res.body).toBe("pong2"); // 必须拿到磁盘上的新代码（模块缓存被击穿）
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
});

// ---- cwd 跟随（host.cwd 活值 + onCwdChange 扇出） ----------------------------------
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
		// 初始值 = 构造时传入的服务启动目录
		expect(probe().activatedCwd).toBe(resolve(dir));

		const sent: ServerMessage[] = [];
		mgr.addSender(
			(m) => sent.push(m),
			() => null,
		);
		const next = resolve(join(dir, "proj-b"));
		mgr.notifyCwd(join(dir, "proj-b")); // 内部会 resolve，不必预先规范化
		expect(probe().seen).toEqual([next]);
		expect(probe().liveCwdInHandler).toBe(next);
		expect(sent).toEqual([{ type: "plugin_data", pluginId: "ed", payload: { kind: "workspace", root: next } }]);

		mgr.notifyCwd(join(dir, "proj-b")); // 幂等：同路径 no-op，不再触发钩子/广播
		expect(probe().seen).toHaveLength(1);
		expect(sent).toHaveLength(1);
	});

	it("抛错的 cwd 钩子被隔离，其余钩子照常执行", async () => {
		makePlugin("ed", CWD_PLUGIN); // 内含一个必抛错钩子 + 一个正常钩子
		await mgr.ensureLoaded();
		expect(() => mgr.notifyCwd(join(dir, "x"))).not.toThrow();
		expect(probe().seen).toHaveLength(1); // 正常钩子仍收到事件
	});

	it("dispose 反激活后旧钩子不再被触发", async () => {
		makePlugin("ed", CWD_PLUGIN);
		await mgr.ensureLoaded();
		mgr.dispose();
		mgr.notifyCwd(join(dir, "y"));
		expect(probe().seen).toHaveLength(0);
	});
});
