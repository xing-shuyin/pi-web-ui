import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager, type PluginHost } from "../../server/plugins.js";

let dir: string;
let mgr: PluginManager;

function makePlugin(id: string, code: string): void {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id }));
	writeFileSync(join(pdir, "index.mjs"), code);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-services-test-"));
	mgr = new PluginManager(dir, dir);
	(globalThis as unknown as { __hosts?: Record<string, PluginHost> }).__hosts = {};
});

afterEach(() => {
	mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
	delete (globalThis as unknown as { __hosts?: Record<string, PluginHost> }).__hosts;
});

async function loadPlugins(...ids: string[]): Promise<Record<string, PluginHost>> {
	for (const id of ids) {
		makePlugin(
			id,
			`export default { activate(h) {
				globalThis.__hosts["${id}"] = h;
			} };`,
		);
	}
	await mgr.ensureLoaded();
	const hosts = (globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts;
	for (const id of ids) {
		expect(hosts[id]).toBeTruthy();
	}
	return hosts;
}

describe("Plugin Service Bus", () => {
	it("基础提供与获取：provide / get / has / list", async () => {
		const hosts = await loadPlugins("provider", "consumer");
		const pHost = hosts["provider"];
		const cHost = hosts["consumer"];

		const mathService = {
			add: (a: number, b: number) => a + b,
		};

		const off = pHost.services.provide("math.calculator", mathService);

		expect(cHost.services.has("math.calculator")).toBe(true);
		expect(cHost.services.get("math.calculator")).toBe(mathService);
		expect(cHost.get("math.calculator")).toBe(mathService);

		const list = cHost.services.list();
		expect(list).toEqual([{ name: "math.calculator", pluginId: "provider" }]);

		off();
		expect(cHost.services.has("math.calculator")).toBe(false);
		expect(cHost.services.get("math.calculator")).toBeUndefined();
	});

	it("服务命名校验与同名冲突防范", async () => {
		const hosts = await loadPlugins("plugin_a", "plugin_b");
		const aHost = hosts["plugin_a"];
		const bHost = hosts["plugin_b"];

		expect(() => aHost.provide("", {})).toThrow(/非法服务名/);
		expect(() => aHost.provide("invalid name with spaces", {})).toThrow(/非法服务名/);
		expect(() => aHost.provide("a".repeat(65), {})).toThrow(/非法服务名/);

		aHost.provide("shared-db", { ready: true });

		expect(() => aHost.provide("shared-db", { ready: true, v2: true })).not.toThrow();

		expect(() => bHost.provide("shared-db", { hack: true })).toThrow(/已由插件 "plugin_a" 注册/);
	});

	it("生命周期：插件反激活时自动逆序回卷已发布的服务", async () => {
		const hosts = await loadPlugins("provider_auto", "consumer_auto");
		const pHost = hosts["provider_auto"];
		const cHost = hosts["consumer_auto"];

		pHost.provide("auto-service", { hello: "world" });
		expect(cHost.get("auto-service")).toEqual({ hello: "world" });

		rmSync(join(dir, "plugins", "provider_auto"), { recursive: true, force: true });
		await mgr.ensureLoaded();

		expect(cHost.get("auto-service")).toBeUndefined();
		expect(cHost.services.has("auto-service")).toBe(false);
	});

	it("响应式监听 onService：先监听后发布 vs 先发布后监听", async () => {
		const hosts = await loadPlugins("plugin_pub", "plugin_sub");
		const pub = hosts["plugin_pub"];
		const sub = hosts["plugin_sub"];

		const events: Array<unknown> = [];

		const offSub = sub.onService("my-stream", (svc) => {
			events.push(svc);
		});

		expect(events).toEqual([]);

		const streamInstance = { streamId: "123" };
		const offPub = pub.provide("my-stream", streamInstance);
		expect(events).toEqual([streamInstance]);

		let immediateReceived: unknown = null;
		const offImmediate = sub.services.on("my-stream", (svc) => {
			immediateReceived = svc;
		});
		expect(immediateReceived).toBe(streamInstance);

		offPub();
		expect(events).toEqual([streamInstance, undefined]);
		expect(immediateReceived).toBeUndefined();

		offSub();
		offImmediate();
	});

	it("监听者异常隔离：某个监听者抛错不影响其他监听者与宿主", async () => {
		const hosts = await loadPlugins("pub_err", "sub_err");
		const pub = hosts["pub_err"];
		const sub = hosts["sub_err"];

		let received = false;
		sub.onService("test-svc", () => {
			throw new Error("listener boom!");
		});
		sub.onService("test-svc", (svc) => {
			if (svc) received = true;
		});

		expect(() => {
			pub.provide("test-svc", { ok: true });
		}).not.toThrow();

		expect(received).toBe(true);
	});
});
