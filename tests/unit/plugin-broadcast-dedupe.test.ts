/**
 * `plugin_data` 的重复推送抑制（issue #965）。
 *
 * 插件把 `broadcast` 当状态通道用，宿主原本无条件全量扇出：首屏实测 12 帧 524KB、
 * 空转 28 秒还有 2 帧 171KB，全是内容相同的状态。抑制按**连接**记指纹：
 * 新连接没有记录，所以首次推送一定拿得到，不需要额外的 attach 回放。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "../../server/protocol.js";
import { PluginManager } from "../../server/plugins.js";

let base: string;
let mgr: PluginManager;

function connect(): ServerMessage[] {
	const got: ServerMessage[] = [];
	mgr.addSender(
		(msg) => void got.push(msg),
		() => "cid",
	);
	return got;
}

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "pwi-plugin-broadcast-"));
	mgr = new PluginManager(base, process.cwd());
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("plugin broadcast 去重", () => {
	it("同一连接连续收到相同 payload 只发一次", () => {
		const got = connect();
		mgr.broadcast("p", { items: [1, 2] });
		mgr.broadcast("p", { items: [1, 2] });
		mgr.broadcast("p", { items: [1, 2] });
		expect(got).toHaveLength(1);
	});

	it("内容变了照常发", () => {
		const got = connect();
		mgr.broadcast("p", { items: [1] });
		mgr.broadcast("p", { items: [1, 2] });
		expect(got).toHaveLength(2);
	});

	it("不同插件互不影响（指纹按 pluginId 分桶）", () => {
		const got = connect();
		mgr.broadcast("a", { ready: true });
		mgr.broadcast("b", { ready: true });
		expect(got).toHaveLength(2);
	});

	it("新连接一定收到当前状态（首次推送不被抑制）", () => {
		const first = connect();
		mgr.broadcast("p", { items: [1] });
		mgr.broadcast("p", { items: [1] });
		const second = connect();
		mgr.broadcast("p", { items: [1] });
		expect(first).toHaveLength(1);
		expect(second).toHaveLength(1);
	});

	it("超过体积上限的 payload 不记指纹，照常直发", () => {
		const got = connect();
		const huge = { blob: "x".repeat(300 * 1024) };
		mgr.broadcast("p", huge);
		mgr.broadcast("p", huge);
		expect(got).toHaveLength(2);
	});

	it("循环引用不炸，退化为直发", () => {
		const got = connect();
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		mgr.broadcast("p", cyclic);
		expect(got).toHaveLength(1);
	});
});
