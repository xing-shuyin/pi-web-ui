import { describe, expect, it, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager, pluginNetFetch, type PluginNetFetchInit } from "../../server/plugins.js";
import { WorkspaceFS, withFileRmwLock } from "../../server/plugin-facilities.js";
import { McpClient } from "../../server/mcp-bridge.js";
import { readCatalog } from "../../server/plugin-catalog.js";

const dirs: string[] = [];
function tmpRoot(): string {
	const d = mkdtempSync(join(tmpdir(), "pwi-audit-fix8-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

function fakeFetch(script: Array<{ status: number; location?: string; body?: string }>) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const impl = (input: string, init?: RequestInit): Promise<Response> => {
		calls.push({ url: input, init });
		const step = script[calls.length - 1] ?? { status: 500 };
		const headers: Record<string, string> = {};
		if (step.location) headers.location = step.location;
		return Promise.resolve(new Response(step.body ?? null, { status: step.status, headers }));
	};
	return { impl, calls };
}

describe("pluginNetFetch：重定向每跳复查白名单（item 3）", () => {
	const allow = (hosts: string[]) => (h: string) => hosts.includes(h);

	it("200 直达：ok + 文本", async () => {
		const f = fakeFetch([{ status: 200, body: "hello" }]);
		const r = await pluginNetFetch("https://a.example/x", undefined, {
			hostAllowed: allow(["a.example"]),
			fetchImpl: f.impl,
		});
		expect(r).toEqual({ ok: true, status: 200, text: "hello" });
		expect(f.calls).toHaveLength(1);
	});

	it("重定向到授权主机：跟随且每跳重新过白名单", async () => {
		const f = fakeFetch([
			{ status: 302, location: "https://b.example/y" },
			{ status: 200, body: "ok" },
		]);
		const r = await pluginNetFetch("https://a.example/x", undefined, {
			hostAllowed: allow(["a.example", "b.example"]),
			fetchImpl: f.impl,
		});
		expect(r).toEqual({ ok: true, status: 200, text: "ok" });
		expect(f.calls.map((c) => c.url)).toEqual(["https://a.example/x", "https://b.example/y"]);
	});

	it("重定向到未授权主机：拒绝（跟随重定向不再绕过白名单）", async () => {
		const f = fakeFetch([{ status: 302, location: "https://evil.example/y" }]);
		const r = await pluginNetFetch("https://a.example/x", undefined, {
			hostAllowed: allow(["a.example"]),
			fetchImpl: f.impl,
		});
		expect(r).toEqual({
			ok: false,
			error: "net: 主机 evil.example 未授权（manifest.netAllowlist 或 host.requestPermission 申请）",
		});
		expect(f.calls).toHaveLength(1);
	});

	it("首跳主机未授权：直接拒绝", async () => {
		const f = fakeFetch([]);
		const r = await pluginNetFetch("https://evil.example/x", undefined, {
			hostAllowed: allow(["a.example"]),
			fetchImpl: f.impl,
		});
		expect(r.ok).toBe(false);
		expect(f.calls).toHaveLength(0);
	});

	it("非 http(s) 协议拒绝", async () => {
		const r = await pluginNetFetch("file:///etc/passwd", undefined, {
			hostAllowed: () => true,
			fetchImpl: fakeFetch([]).impl,
		});
		expect(r).toEqual({ ok: false, error: "net: 不支持的协议 file:" });
	});

	it("重定向超过 5 跳：拒绝", async () => {
		const hops = Array.from({ length: 8 }, (_, i) => ({
			status: 301,
			location: `https://a.example/hop${i + 1}`,
		}));
		const f = fakeFetch(hops);
		const r = await pluginNetFetch("https://a.example/hop0", undefined, {
			hostAllowed: allow(["a.example"]),
			fetchImpl: f.impl,
		});
		expect(r).toEqual({ ok: false, error: "net: 重定向超过 5 跳上限" });
		expect(f.calls).toHaveLength(6);
	});

	it("跨宿主重定向剥掉 authorization/cookie 头；303 转 GET 丢 body", async () => {
		const f = fakeFetch([
			{ status: 303, location: "https://b.example/y" },
			{ status: 200, body: "done" },
		]);
		const init: PluginNetFetchInit = {
			method: "POST",
			headers: { authorization: "Bearer secret", cookie: "k=v", "x-custom": "keep" },
			body: "payload",
		};
		const r = await pluginNetFetch("https://a.example/x", init, {
			hostAllowed: allow(["a.example", "b.example"]),
			fetchImpl: f.impl,
		});
		expect(r).toEqual({ ok: true, status: 200, text: "done" });
		const second = f.calls[1]!;
		expect((second.init?.headers as Record<string, string>)?.["x-custom"]).toBe("keep");
		expect((second.init?.headers as Record<string, string>)?.authorization).toBeUndefined();
		expect((second.init?.headers as Record<string, string>)?.cookie).toBeUndefined();
		expect(second.init?.method).toBe("GET");
		expect(second.init?.body).toBeUndefined();
	});
});

describe("registerAgentTool：跨插件重名拒绝（item 4）", () => {
	type Reg = (pluginId: string, tool: unknown) => () => void;
	function makeTool(name: string) {
		return { name, description: "test tool", execute: async () => ({ content: [] }) };
	}

	it("他插件已注册同名工具 → 拒绝且返回空操作注销函数", async () => {
		const base = tmpRoot();
		const mgr = new PluginManager(base, process.cwd());
		const reg = (mgr as unknown as { registerAgentTool: Reg }).registerAgentTool.bind(mgr);
		try {
			const offA = reg("aaa", makeTool("dup_tool"));
			expect(mgr.getAgentTools().map((t) => t.name)).toEqual(["dup_tool"]);
			const offB = reg("bbb", makeTool("dup_tool"));
			expect(typeof offB).toBe("function");
			offB();
			expect(mgr.getAgentTools().map((t) => t.name)).toEqual(["dup_tool"]);
			expect(mgr.getAgentToolsGrouped().map((g) => g.pluginId)).toEqual(["aaa"]);
			offA();
			expect(mgr.getAgentTools()).toEqual([]);
			reg("bbb", makeTool("dup_tool"));
			expect(mgr.getAgentTools().map((t) => t.name)).toEqual(["dup_tool"]);
		} finally {
			mgr.dispose();
		}
	});

	it("同插件重名注册仍被拒绝（原语义保留）", async () => {
		const base = tmpRoot();
		const mgr = new PluginManager(base, process.cwd());
		const reg = (mgr as unknown as { registerAgentTool: Reg }).registerAgentTool.bind(mgr);
		try {
			reg("aaa", makeTool("same"));
			reg("aaa", makeTool("same"));
			expect(mgr.getAgentTools().map((t) => t.name)).toEqual(["same"]);
		} finally {
			mgr.dispose();
		}
	});
});

describe("WorkspaceFS 写类操作 realpath 复核（item 5）", () => {
	function setup(): { root: string; outside: string; fs: WorkspaceFS } {
		const root = tmpRoot();
		const outside = tmpRoot();
		const fs = new WorkspaceFS(() => root);
		return { root, outside, fs };
	}
	function linkInside(root: string, outside: string, name: string): void {
		symlinkSync(outside, join(root, name), process.platform === "win32" ? "junction" : "dir");
	}

	it("write 穿过指向工作区外的链接：拒绝且不落地", async () => {
		const { root, outside, fs } = setup();
		linkInside(root, outside, "escape");
		await expect(fs.write("escape/evil.txt", "x")).rejects.toThrow(/越界/);
		expect(existsSync(join(outside, "evil.txt"))).toBe(false);
	});

	it("write 目标本身是链接：拒绝", async () => {
		const { root, outside, fs } = setup();
		linkInside(root, outside, "escape");
		await expect(fs.write("escape", "x")).rejects.toThrow(/越界/);
	});

	it("mkdir/remove 穿过链接：同样拒绝（递归删除跟随目录链接更危险）", async () => {
		const { root, outside, fs } = setup();
		linkInside(root, outside, "escape");
		mkdirSync(join(outside, "junk"), { recursive: true });
		writeFileSync(join(outside, "junk", "keep.txt"), "data");
		await expect(fs.mkdir("escape/newdir")).rejects.toThrow(/越界/);
		await expect(fs.remove("escape/junk/keep.txt")).rejects.toThrow(/越界/);
		await expect(fs.remove("escape/junk")).rejects.toThrow(/越界/);
		expect(existsSync(join(outside, "junk", "keep.txt"))).toBe(true);
		await expect(fs.append("escape/log.txt", "x")).rejects.toThrow(/越界/);
	});

	it("工作区内的正常写/删不受影响", async () => {
		const { root, fs } = setup();
		await fs.write("sub/a.txt", "hello");
		expect(readFileSync(join(root, "sub", "a.txt"), "utf8")).toBe("hello");
		await fs.append("sub/a.txt", "!");
		expect(readFileSync(join(root, "sub", "a.txt"), "utf8")).toBe("hello!");
		await fs.remove("sub/a.txt");
		expect(existsSync(join(root, "sub", "a.txt"))).toBe(false);
	});
});

describe("McpClient.onData 缓冲上限（item 9）", () => {
	type OnData = (chunk: string) => void;
	type RequestFn = (m: string, p: Record<string, unknown>, t?: number) => Promise<unknown>;
	function rawClient(name: string): { c: McpClient; onData: OnData; request: RequestFn; logs: string[] } {
		const logs: string[] = [];
		const c = new McpClient(name, { command: "node" }, (...a: unknown[]) => logs.push(a.map(String).join(" ")));
		return {
			c,
			onData: (c as unknown as { onData: OnData }).onData.bind(c),
			request: (c as unknown as { request: RequestFn }).request.bind(c),
			logs,
		};
	}

	it("单行超过 1MB：拒绝在途请求并按协议错误关闭", async () => {
		const { onData, request, logs } = rawClient("cap-line");
		const pending = request("tools/call", {}, 5000);
		onData(`${"x".repeat(1024 * 1024 + 1)}\n`);
		await expect(pending).rejects.toThrow(/单行超过/);
		expect(logs.some((l) => l.includes("单行超过"))).toBe(true);
	});

	it("总缓冲超过 4MB（不换行）：拒绝在途请求并按协议错误关闭", async () => {
		const { onData, request, logs } = rawClient("cap-buffer");
		const pending = request("tools/call", {}, 5000);
		onData("x".repeat(4 * 1024 * 1024 + 1));
		await expect(pending).rejects.toThrow(/缓冲超过/);
		expect(logs.some((l) => l.includes("缓冲超过"))).toBe(true);
	});

	it("正常大小的行不受影响：合法 JSON-RPC 响应照常匹配", async () => {
		const { onData, request } = rawClient("cap-ok");
		const pending = request("tools/call", {}, 5000);
		onData(Array.from({ length: 10 }, (_, i) => `{"id":"${i}","result":{"pong":1}}`).join("\n") + "\n");
		await expect(pending).resolves.toEqual({ pong: 1 });
	});
});

describe("withFileRmwLock：RMW 进程内互斥（item 12）", () => {
	it("同一文件上的异步写者串行（不交叠）", async () => {
		const file = join(tmpRoot(), "storage.json");
		const order: string[] = [];
		const fnA = async (): Promise<void> => {
			order.push("a:start");
			await new Promise((r) => setTimeout(r, 20));
			order.push("a:end");
		};
		const fnB = async (): Promise<void> => {
			order.push("b:start");
			await new Promise((r) => setTimeout(r, 1));
			order.push("b:end");
		};
		const pa = withFileRmwLock(file, fnA) as Promise<void>;
		const pb = withFileRmwLock(file, fnB) as Promise<void>;
		await Promise.all([pa, pb]);
		expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
	});

	it("不同文件互不阻塞", async () => {
		const a = join(tmpRoot(), "a.json");
		const b = join(tmpRoot(), "b.json");
		const order: string[] = [];
		const fnA = async (): Promise<void> => {
			await new Promise((r) => setTimeout(r, 20));
			order.push("a");
		};
		const fnB = async (): Promise<void> => {
			order.push("b");
		};
		await Promise.all([withFileRmwLock(a, fnA), withFileRmwLock(b, fnB)]);
		expect(order).toEqual(["b", "a"]);
	});

	it("同步关键区走同步快路径：返回值原样、set 后立即可见语义不变", () => {
		const file = join(tmpRoot(), "c.json");
		let ran = false;
		const r = withFileRmwLock(file, () => {
			ran = true;
			return 42;
		});
		expect(ran).toBe(true);
		expect(r).toBe(42);
	});

	it("链上前一个失败不堵后一个", async () => {
		const file = join(tmpRoot(), "d.json");
		const p1 = withFileRmwLock(file, async () => {
			throw new Error("boom");
		}) as Promise<void>;
		const p2 = withFileRmwLock(file, async () => "ok") as Promise<string>;
		await expect(p1).rejects.toThrow("boom");
		await expect(p2).resolves.toBe("ok");
	});
});

describe("readCatalog：custom 覆盖 builtin 的标识（item 11）", () => {
	it("覆盖时强制 overridesBuiltin + builtin:false，source 保留真实来源", () => {
		const dir = tmpRoot();
		const builtin = join(dir, "catalog.json");
		const custom = join(dir, "custom.json");
		writeFileSync(builtin, JSON.stringify([{ id: "official", name: "Official", source: "official/official-plugin" }]));
		writeFileSync(custom, JSON.stringify({ entries: [{ id: "official", name: "仿冒", source: "evil/repo" }] }));
		const list = readCatalog(builtin, custom);
		const hit = list.find((e) => e.id === "official")!;
		expect(hit.builtin).toBe(false);
		expect(hit.overridesBuiltin).toBe(true);
		expect(hit.source).toBe("evil/repo");
		expect(hit.name).toBe("仿冒");
		writeFileSync(custom, JSON.stringify({ entries: [{ id: "plain", source: "a/b" }] }));
		const list2 = readCatalog(builtin, custom);
		expect(list2.find((e) => e.id === "plain")!.overridesBuiltin).toBeUndefined();
		expect(list2.find((e) => e.id === "plain")!.builtin).toBe(false);
		const official = list2.find((e) => e.id === "official")!;
		expect(official.builtin).toBe(true);
		expect(official.overridesBuiltin).toBeUndefined();
	});
});
