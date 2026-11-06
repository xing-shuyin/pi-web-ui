import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PluginManager,
	formatPluginLogText,
	normalizePluginLogLevel,
	PLUGIN_LOG_CAP,
	PLUGIN_LOG_TEXT_MAX,
} from "../../server/plugins.js";
import type { ServerMessage } from "../../server/protocol.js";

let dir: string;
let mgr: PluginManager;

function makePlugin(id: string, code: string): void {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id }));
	writeFileSync(join(pdir, "index.mjs"), code);
}

const seen: Array<[unknown, string | undefined]> = [];

const LOG_PLUGIN = `
export default {
	activate(host) {
		globalThis.__logSeen = [];
		host.onMessage((payload, from) => { globalThis.__logSeen.push([payload, from]); });
		host.log("boot ok");
		host.log("warn", "disk low", { pct: 3 });
		host.log("error", "boom");
		host.log("debug", "detail");
	},
};`;

function logSeen(): Array<[unknown, string | undefined]> {
	return (globalThis as { __logSeen?: Array<[unknown, string | undefined]> }).__logSeen ?? [];
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-log-test-"));
	mgr = new PluginManager(dir, dir);
	seen.length = 0;
	delete (globalThis as { __logSeen?: unknown }).__logSeen;
});

afterEach(() => {
	mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("normalizePluginLogLevel / formatPluginLogText", () => {
	it("合法级别原样回，否则缺省 info", () => {
		expect(normalizePluginLogLevel("debug")).toBe("debug");
		expect(normalizePluginLogLevel("error")).toBe("error");
		expect(normalizePluginLogLevel("boot ok")).toBe("info");
		expect(normalizePluginLogLevel(undefined)).toBe("info");
		expect(normalizePluginLogLevel(42)).toBe("info");
	});

	it("string 原样、对象 JSON 化、空格拼接、超长截断", () => {
		expect(formatPluginLogText(["a", 1])).toBe("a 1");
		expect(formatPluginLogText([{ a: 1 }])).toBe('{"a":1}');
		const long = formatPluginLogText(["x".repeat(PLUGIN_LOG_TEXT_MAX + 10)]);
		expect(long).toBe("x".repeat(PLUGIN_LOG_TEXT_MAX));
	});
});

describe("PluginManager plugin logs", () => {
	it("host.log(level?, ...args) 分级写入；老写法按 info 兼容", async () => {
		makePlugin("logger", LOG_PLUGIN);
		await mgr.ensureLoaded();
		const logs = mgr.getPluginLogs("logger");
		expect(logs.map((e) => [e.level, e.text])).toEqual([
			["info", "boot ok"],
			["warn", 'disk low {"pct":3}'],
			["error", "boom"],
			["debug", "detail"],
		]);
		for (const e of logs) expect(typeof e.ts).toBe("number");
	});

	it("缓冲封顶 200 条（丢最旧），单条截断 500 字符", async () => {
		makePlugin(
			"flooder",
			`export default { activate(host) { for (let i = 0; i < ${PLUGIN_LOG_CAP + 50}; i++) host.log("info", "n" + i); host.log("x".repeat(2000)); } };`,
		);
		await mgr.ensureLoaded();
		const logs = mgr.getPluginLogs("flooder");
		expect(logs).toHaveLength(PLUGIN_LOG_CAP);
		expect(logs[0]!.text).toBe("n51");
		expect(logs[logs.length - 1]!.text).toBe("x".repeat(PLUGIN_LOG_TEXT_MAX));
	});

	it("get 按需拉取：定向 plugin_data 回包，且不进插件 onMessage", async () => {
		makePlugin("logger", LOG_PLUGIN);
		await mgr.ensureLoaded();
		const sent: ServerMessage[] = [];
		mgr.addSender(
			(m) => sent.push(m),
			() => "client-1",
		);
		expect(logSeen()).toHaveLength(0);
		mgr.handleMessage("logger", { __host: "logs", op: "get" }, "client-1");
		expect(sent).toHaveLength(1);
		const back = sent[0] as { type: string; pluginId: string; payload: { __host: string; logs: unknown[] } };
		expect(back.type).toBe("plugin_data");
		expect(back.pluginId).toBe("logger");
		expect(back.payload.__host).toBe("logs");
		expect(back.payload.logs).toHaveLength(4);
		expect(logSeen()).toHaveLength(0);
	});

	it("clear 清空缓冲并回 cleared 空包；from 缺席静默丢弃", async () => {
		makePlugin("logger", LOG_PLUGIN);
		await mgr.ensureLoaded();
		const sent: ServerMessage[] = [];
		mgr.addSender(
			(m) => sent.push(m),
			() => "client-1",
		);
		mgr.handleMessage("logger", { __host: "logs", op: "get" }, undefined);
		expect(sent).toHaveLength(0);
		mgr.handleMessage("logger", { __host: "logs", op: "clear" }, "client-1");
		expect(sent).toHaveLength(1);
		expect((sent[0] as { payload: { cleared?: boolean; logs: unknown[] } }).payload).toEqual({
			__host: "logs",
			logs: [],
			cleared: true,
		});
		expect(mgr.getPluginLogs("logger")).toEqual([]);
	});

	it("未知插件 get 回空日志；deactivate 后缓冲清掉", async () => {
		const sent: ServerMessage[] = [];
		mgr.addSender(
			(m) => sent.push(m),
			() => "client-1",
		);
		mgr.handleMessage("ghost", { __host: "logs", op: "get" }, "client-1");
		expect((sent[0] as { payload: { logs: unknown[] } }).payload.logs).toEqual([]);

		makePlugin("temp", `export default { activate(host) { host.log("hi"); } };`);
		await mgr.ensureLoaded();
		expect(mgr.getPluginLogs("temp")).toHaveLength(1);
		mgr.dispose();
		expect(mgr.getPluginLogs("temp")).toEqual([]);
	});
});
