import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { checkPluginCwd } from "../../server/agent-service.js";
import { PluginManager, type PluginChatRequest } from "../../server/plugins.js";

describe("checkPluginCwd", () => {
	it("空目录拒绝", () => {
		expect(checkPluginCwd("").ok).toBe(false);
		expect(checkPluginCwd("   ").ok).toBe(false);
	});

	it("不存在的目录拒绝（不默默跑错目录）", () => {
		const r = checkPluginCwd(join(tmpdir(), `pi-web-ui-no-such-dir-${Date.now()}`));
		expect(r.ok).toBe(false);
		expect(r.error ?? "").toMatch(/不存在或不是目录/);
	});

	it("文件（非目录）拒绝", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-web-ui-chatcwd-"));
		const f = join(dir, "a.txt");
		writeFileSync(f, "x");
		const r = checkPluginCwd(f);
		expect(r.ok).toBe(false);
		expect(r.error ?? "").toMatch(/不存在或不是目录/);
	});

	it("正常目录通过并返回绝对路径", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-web-ui-chatcwd-"));
		const r = checkPluginCwd(dir);
		expect(r.ok).toBe(true);
		expect(typeof r.abs).toBe("string");
	});

	it("Windows 系统目录拒绝（后台启动 cwd 飘到 system32 的高危情形）", () => {
		if (process.platform !== "win32") return;
		const sysRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
		expect(checkPluginCwd(sysRoot).ok).toBe(false);
		expect(checkPluginCwd(join(sysRoot, "System32")).ok).toBe(false);
		expect(checkPluginCwd(join(sysRoot, "System32")).error ?? "").toMatch(/系统目录/);
	});
});

describe("wechat-ilink manifest（issue #226 新增设置）", () => {
	it("workspace/model/thinkingLevel/bindActive 四键齐全", () => {
		const raw = readFileSync(new URL("../../plugins/wechat-ilink/manifest.json", import.meta.url), "utf8");
		const m = JSON.parse(raw) as { settings: { key: string }[] };
		const keys = new Set(m.settings.map((s) => s.key));
		for (const k of ["workspace", "model", "thinkingLevel", "bindActive"]) {
			expect(keys.has(k), `manifest 缺设置键 ${k}`).toBe(true);
		}
	});
});

describe("host.chat 四件套透传（issue #226）", () => {
	let dir: string;
	let mgr: PluginManager;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "plugin-chat-test-"));
		mgr = new PluginManager(dir, dir);
	});
	afterEach(() => {
		mgr.dispose();
		rmSync(dir, { recursive: true, force: true });
		(globalThis as Record<string, unknown>).__chatHost = undefined;
	});
	function makeChatter(id: string, permissions: string[]): void {
		const pdir = join(dir, "plugins", id);
		mkdirSync(pdir, { recursive: true });
		writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id, permissions }));
		writeFileSync(join(pdir, "index.mjs"), `export default { activate(host) { globalThis.__chatHost = host; } };`);
	}
	async function chatHost(): Promise<{ chat: (req: PluginChatRequest) => Promise<unknown> }> {
		await mgr.ensureLoaded();
		const h = (globalThis as Record<string, unknown>).__chatHost as {
			chat: (req: PluginChatRequest) => Promise<unknown>;
		};
		expect(h?.chat, "插件 host 未拿到 chat").toBeTruthy();
		return h;
	}
	it("cwd/conversationId/model/thinkingLevel 原样透给 chatProvider", async () => {
		makeChatter("chatter", ["chat"]);
		let got: { pluginId: string; req: PluginChatRequest } | undefined;
		mgr.chatProvider = async (pluginId, req) => {
			got = { pluginId, req };
			return { conversationId: "c1", clientId: "plugin:chatter:wx" };
		};
		const host = await chatHost();
		await host.chat({
			text: "hi",
			accountId: "wx",
			cwd: "/tmp",
			conversationId: "conv-1",
			model: "openai/gpt-5",
			thinkingLevel: "high",
		});
		expect(got?.pluginId).toBe("chatter");
		expect(got?.req).toEqual({
			text: "hi",
			accountId: "wx",
			cwd: "/tmp",
			conversationId: "conv-1",
			model: "openai/gpt-5",
			thinkingLevel: "high",
		});
	});
	it("不传四件套时只发 text+accountId（老插件语义不变）", async () => {
		makeChatter("chatter", ["chat"]);
		let got: PluginChatRequest | undefined;
		mgr.chatProvider = async (_id, req) => {
			got = req;
			return { conversationId: "c1", clientId: "x" };
		};
		const host = await chatHost();
		await host.chat({ text: "hi" });
		expect(got).toEqual({ text: "hi", accountId: "default" });
	});
	it("无 chat 能力声明时拒绝", async () => {
		makeChatter("nochatter", ["tools"]);
		mgr.chatProvider = async () => ({ conversationId: "c1", clientId: "x" });
		const host = await chatHost();
		await expect(host.chat({ text: "hi" })).rejects.toThrow(/chat/);
	});
});
