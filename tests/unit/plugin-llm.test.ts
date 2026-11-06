import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { completeWithIsolatedSession, llmInflight } from "../../server/plugin-llm.js";
import { PluginManager, type PluginHost } from "../../server/plugins.js";

const env = { cwd: tmpdir(), agentDir: mkdtempSync(join(tmpdir(), "plugin-llm-test-")) };

describe("completeWithIsolatedSession 入参校验（不建会话）", () => {
	it("空 prompt 拒绝", async () => {
		expect(await completeWithIsolatedSession(env, { prompt: "" })).toEqual({
			ok: false,
			error: "llm.complete: prompt 为空",
		});
		expect(await completeWithIsolatedSession(env, { prompt: "   " })).toMatchObject({ ok: false });
		expect(llmInflight()).toBe(0);
	});
	it("超长 prompt/system 拒绝", async () => {
		const r1 = await completeWithIsolatedSession(env, { prompt: "x".repeat(8001) });
		expect(r1.ok).toBe(false);
		expect(r1).toMatchObject({ ok: false });
		if (!r1.ok) expect(r1.error).toContain("超长");
		const r2 = await completeWithIsolatedSession(env, { prompt: "hi", system: "y".repeat(4001) });
		expect(r2.ok).toBe(false);
		if (!r2.ok) expect(r2.error).toContain("超长");
		expect(llmInflight()).toBe(0);
	});
	it("未知模型在本地即拒绝（不发请求、不花 token）", async () => {
		const r = await completeWithIsolatedSession(env, { prompt: "hi", model: "no-such-provider/no-such-model" });
		expect(r).toEqual({ ok: false, error: "llm.complete: 找不到模型 no-such-provider/no-such-model" });
		expect(llmInflight()).toBe(0);
	});
	it("非法 model 形状（无斜杠）走默认模型路径——此处不断言结果，只断言不抛错", async () => {
		const r = await completeWithIsolatedSession(env, { prompt: "hi", model: "not-a-spec", timeoutMs: 5000 });
		expect(typeof r.ok).toBe("boolean");
		if (!r.ok) expect(typeof r.error).toBe("string");
		expect(llmInflight()).toBe(0);
	});
});

describe("host.llm.complete 门控（permissions llm 族 + llmProvider 注入）", () => {
	let dir: string;
	let mgr: PluginManager;

	function makePlugin(id: string, manifest: Record<string, unknown>): void {
		const pdir = join(dir, "plugins", id);
		mkdirSync(pdir, { recursive: true });
		writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id, ...manifest }));
		writeFileSync(join(pdir, "index.mjs"), `export default { activate(h) { globalThis.__hosts["${id}"] = h; } };`);
	}

	async function hostOf(id: string): Promise<PluginHost> {
		(globalThis as unknown as { __hosts?: Record<string, PluginHost> }).__hosts ??= {};
		await mgr.ensureLoaded();
		const h = (globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts[id];
		expect(h).toBeTruthy();
		return h;
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "plugin-llm-host-test-"));
		mgr = new PluginManager(dir, dir);
	});
	afterEach(() => {
		mgr.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	it("未声明 llm 能力 → 拒绝并提示缺哪族", async () => {
		makePlugin("nope", { permissions: ["tools"], apiVersion: 2 });
		const h = await hostOf("nope");
		const r = await h.llm.complete({ prompt: "hi" });
		expect(r.ok).toBe(false);
		expect(r.error).toContain('"llm"');
	});
	it("声明了但宿主未注入 → {ok:false}（DSH 回退语义）", async () => {
		makePlugin("yes", { permissions: ["llm"] });
		const h = await hostOf("yes");
		expect(mgr.llmProvider).toBeUndefined();
		const r = await h.llm.complete({ prompt: "hi" });
		expect(r).toEqual({ ok: false, error: "宿主未提供 LLM 直调（llmProvider 未接入）" });
	});
	it("advertises image support and forwards images and the host-only signal unchanged", async () => {
		makePlugin("vision", { permissions: ["llm"] });
		const h = await hostOf("vision");
		const req = {
			prompt: "describe",
			images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
			signal: new AbortController().signal,
		};
		let received: unknown;
		mgr.llmProvider = async (_id, input) => {
			received = input;
			return { ok: true, text: "seen" };
		};
		expect(h.llm.supportsImages).toBe(true);
		expect(await h.llm.complete(req)).toMatchObject({ ok: true });
		expect(received).toBe(req);
	});
	it("注入后直通 provider 回执；provider 抛错转 {ok:false}", async () => {
		makePlugin("yes", { permissions: ["llm"] });
		const h = await hostOf("yes");
		mgr.llmProvider = async () => ({ ok: true as const, text: "hello", model: "p/m" });
		expect(await h.llm.complete({ prompt: "hi" })).toEqual({ ok: true, text: "hello", model: "p/m" });
		mgr.llmProvider = async () => {
			throw new Error("boom");
		};
		const r = await h.llm.complete({ prompt: "hi" });
		expect(r).toEqual({ ok: false, error: "boom" });
	});
});
