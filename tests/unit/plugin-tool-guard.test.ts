import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyPostEdit,
	denialText,
	freezeParams,
	isBlockingDecision,
	normalizePostEdit,
	normalizePreDecision,
	withGuardTimeout,
	GUARD_CONTEXT_CAP,
} from "../../server/plugin-tool-guard.js";
import { PluginManager, type PluginHost } from "../../server/plugins.js";
import { withToolGuard } from "../../server/agent-service.js";

describe("guard 纯函数", () => {
	it("normalizePreDecision：void/垃圾→allow，只认三决策", () => {
		expect(normalizePreDecision(undefined)).toEqual({ decision: "allow" });
		expect(normalizePreDecision(null)).toEqual({ decision: "allow" });
		expect(normalizePreDecision("deny")).toEqual({ decision: "allow" });
		expect(normalizePreDecision({ decision: "allow" })).toEqual({ decision: "allow" });
		expect(normalizePreDecision({ decision: "deny", reason: "危险", reasonEn: "danger" })).toEqual({
			decision: "deny",
			reason: "危险",
			reasonEn: "danger",
		});
		expect(normalizePreDecision({ decision: "ask" })).toEqual({
			decision: "ask",
			reason: undefined,
			reasonEn: undefined,
		});
		expect(normalizePreDecision({ decision: "rewrite" })).toEqual({ decision: "allow" });
	});

	it("isBlockingDecision：deny/ask 阻断，allow 放行", () => {
		expect(isBlockingDecision({ decision: "allow" })).toBe(false);
		expect(isBlockingDecision({ decision: "deny" })).toBe(true);
		expect(isBlockingDecision({ decision: "ask" })).toBe(true);
	});

	it("denialText：ask 注明待确认+按拒绝处理；中英按 lang 取", () => {
		const askZh = denialText({ decision: "ask", reason: "等我确认" }, "p", "zh");
		expect(askZh).toContain("等我确认");
		const askEn = denialText({ decision: "ask" }, "p", "en");
		expect(askEn).toMatch(/ask.*deny/i);
		expect(denialText({ decision: "deny", reason: "危险" }, "p", "zh")).toContain("危险");
		expect(denialText({ decision: "deny" }, "p", "en")).toContain("p");
	});

	it("normalizePostEdit：void→undefined；坏 content 丢弃但保留上下文；上下文封顶", () => {
		expect(normalizePostEdit(undefined)).toBeUndefined();
		expect(normalizePostEdit({})).toBeUndefined();
		expect(normalizePostEdit({ content: "str" })).toBeUndefined();
		const edit = normalizePostEdit({
			content: [{ type: "text", text: "x" }],
			additionalContext: "y".repeat(GUARD_CONTEXT_CAP + 100),
		});
		expect(edit?.content).toEqual([{ type: "text", text: "x" }]);
		expect(edit?.additionalContext?.length).toBe(GUARD_CONTEXT_CAP);
	});

	it("applyPostEdit：换正文+补上下文；只补上下文时追加；不改原对象", () => {
		const base = { content: [{ type: "text", text: "orig" }], details: { a: 1 } };
		const out = applyPostEdit(base, { content: [{ type: "text", text: "redacted" }], additionalContext: "ctx" }, "en");
		expect(out.content).toEqual([
			{ type: "text", text: "redacted" },
			{ type: "text", text: "ctx" },
		]);
		expect(base.content).toEqual([{ type: "text", text: "orig" }]);
		const appended = applyPostEdit({ content: [] }, { additionalContext: "c", additionalContextEn: "e" }, "en");
		expect(appended.content).toEqual([{ type: "text", text: "e" }]);
		const noop = applyPostEdit({ content: [] }, {}, "en");
		expect(noop.content).toEqual([]);
	});

	it("withGuardTimeout：超时按弃权（undefined），快的不拦", async () => {
		const slow = withGuardTimeout(new Promise<string>(() => {}), 20);
		expect(await slow).toBeUndefined();
		expect(await withGuardTimeout(Promise.resolve("v"), 100)).toBe("v");
	});

	it("freezeParams：对象浅冻，原始值原样", () => {
		const o = { a: 1 };
		expect(freezeParams(o)).toBe(o);
		expect(Object.isFrozen(o)).toBe(true);
		expect(freezeParams("s")).toBe("s");
	});
});

let dir: string;
let mgr: PluginManager;

function makePlugin(id: string, manifest: Record<string, unknown>, body = ""): void {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id, ...manifest }));
	writeFileSync(
		join(pdir, "index.mjs"),
		`export default { activate(h) { (globalThis.__hosts ??= {})["${id}"] = h; ${body} } };`,
	);
}

async function load(id: string, manifest: Record<string, unknown> = {}, body = ""): Promise<PluginHost | undefined> {
	makePlugin(id, manifest, body);
	await mgr.ensureLoaded();
	return (globalThis as unknown as { __hosts: Record<string, PluginHost | undefined> }).__hosts[id];
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-guard-test-"));
	(globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts = {};
	mgr = new PluginManager(dir, dir);
});

afterEach(() => {
	vi.restoreAllMocks();
	mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("host.onToolPre/onToolPost 接线", () => {
	it("无 tools 能力 → 注册被拒（回 noop），求值看不到守卫", async () => {
		const h = await load("noguard", { permissions: ["ui"] }, `h.onToolPre(() => ({ decision: "deny" }));`);
		expect(h).toBeTruthy();
		const r = await mgr.evaluateToolPre({ toolName: "bash", params: { command: "rm -rf /" } }, "zh");
		expect(r.verdict).toEqual({ decision: "allow" });
		expect(r.pluginId).toBeUndefined();
	});

	it("pre：危险命令 deny，别人的 allow 不挡路；首个阻断胜出", async () => {
		await load(
			"guard",
			{ permissions: ["tools"] },
			`h.onToolPre((req) => {
				if (req.toolName === "bash" && String(req.params?.command ?? "").includes("rm -rf")) {
					return { decision: "deny", reason: "危险命令", reasonEn: "dangerous command" };
				}
			});`,
		);
		const denied = await mgr.evaluateToolPre({ toolName: "bash", params: { command: "rm -rf /tmp/x" } }, "zh");
		expect(denied.verdict.decision).toBe("deny");
		expect(denied.pluginId).toBe("guard");
		expect(mgr.guardDenialText(denied.verdict as { decision: "deny"; reason?: string }, "guard", "zh")).toContain(
			"危险命令",
		);
		const ok = await mgr.evaluateToolPre({ toolName: "bash", params: { command: "ls" } }, "zh");
		expect(ok.verdict).toEqual({ decision: "allow" });
		const read = await mgr.evaluateToolPre({ toolName: "read", params: { path: "rm -rf" } }, "zh");
		expect(read.verdict).toEqual({ decision: "allow" });
	});

	it("pre：抛错/超时按弃权，不阻断；ask 也阻断", async () => {
		await load(
			"flaky",
			{ permissions: ["tools"] },
			`h.onToolPre(() => { throw new Error("boom"); });
			 h.onToolPre(() => new Promise(() => {}));
			 h.onToolPre(() => ({ decision: "ask", reason: "等确认" }));`,
		);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const r = await mgr.evaluateToolPre({ toolName: "bash", params: {} }, "zh");
		expect(r.verdict.decision).toBe("ask");
		expect(r.pluginId).toBe("flaky");
		expect(errSpy).toHaveBeenCalled();
	}, 20000);

	it("post：脱敏换正文 + 补上下文合并；抛错的被跳过", async () => {
		await load(
			"redact",
			{ permissions: ["tools"] },
			`h.onToolPost((req) => {
				const text = req.result?.content?.[0]?.text ?? "";
				return { content: [{ type: "text", text: String(text).replaceAll("sk-secret", "[REDACTED]") }] };
			});
			h.onToolPost(() => { throw new Error("post-boom"); });
			h.onToolPost(() => ({ additionalContext: "注意：这是生产环境", additionalContextEn: "note: production" }));`,
		);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const merged = await mgr.evaluateToolPost(
			{
				toolName: "bash",
				params: { command: "env" },
				result: { content: [{ type: "text", text: "key=sk-secret" }] },
			},
			"en",
		);
		expect(merged?.content).toEqual([
			{ type: "text", text: "key=[REDACTED]" },
			{ type: "text", text: "note: production" },
		]);
		expect(merged?.pluginIds).toEqual(["redact", "redact"]);
		expect(errSpy).toHaveBeenCalled();
	});

	it("post：无守卫回 undefined；反激活后守卫消失", async () => {
		await load("tmp", { permissions: ["tools"] }, `globalThis.__off = h.onToolPre(() => ({ decision: "deny" }));`);
		expect((await mgr.evaluateToolPre({ toolName: "bash", params: {} }, "en")).verdict.decision).toBe("deny");
		(globalThis as unknown as { __off: () => void }).__off();
		expect((await mgr.evaluateToolPre({ toolName: "bash", params: {} }, "en")).verdict).toEqual({
			decision: "allow",
		});
		expect(await mgr.evaluateToolPost({ toolName: "read", params: {}, result: { content: [] } }, "en")).toBeUndefined();
	});
});

describe("withToolGuard 包装", () => {
	const fakeDef = (text: string) =>
		({
			name: "bash",
			execute: vi.fn(async () => ({ content: [{ type: "text", text }] })),
		}) as unknown as Parameters<typeof withToolGuard>[0];

	it("无 hook 原样返回（零开销直通）", () => {
		const def = fakeDef("x");
		expect(withToolGuard(def, { toolName: "bash", getLang: () => "en" })).toBe(def);
	});

	it("deny 跳过真执行，回阻断文本 + guardDenied", async () => {
		const def = fakeDef("real");
		const wrapped = withToolGuard(def, {
			toolName: "bash",
			getLang: () => "zh",
			guard: {
				pre: async () => ({ verdict: { decision: "deny", reason: "不许" }, pluginId: "g" }),
				post: async () => undefined,
			},
		});
		const out = (await (wrapped.execute as (...a: unknown[]) => Promise<unknown>)("id", {}, null, null, {})) as {
			content: Array<{ text: string }>;
			details: Record<string, unknown>;
		};
		expect(def.execute).not.toHaveBeenCalled();
		expect(out.content[0]?.text).toContain("不许");
		expect(out.details).toMatchObject({ guardDenied: true, pluginId: "g" });
	});

	it("allow 跑真执行，post 换正文", async () => {
		const def = fakeDef("real");
		const wrapped = withToolGuard(def, {
			toolName: "read",
			getLang: () => "en",
			conversationId: () => "conv1",
			guard: {
				pre: async (req) => {
					expect(req.toolName).toBe("read");
					expect(req.conversationId).toBe("conv1");
					return { verdict: { decision: "allow" } };
				},
				post: async () => ({ content: [{ type: "text", text: "redacted" }], pluginIds: ["g"] }),
			},
		});
		const out = (await (wrapped.execute as (...a: unknown[]) => Promise<unknown>)("id", {}, null, null, {})) as {
			content: Array<{ text: string }>;
		};
		expect(def.execute).toHaveBeenCalledTimes(1);
		expect(out.content).toEqual([{ type: "text", text: "redacted" }]);
	});

	it("pre 抛错按放行（包装层兜底）", async () => {
		const def = fakeDef("real");
		const wrapped = withToolGuard(def, {
			toolName: "bash",
			getLang: () => "en",
			guard: {
				pre: async () => {
					throw new Error("hook boom");
				},
				post: async () => undefined,
			},
		});
		const out = (await (wrapped.execute as (...a: unknown[]) => Promise<unknown>)("id", {}, null, null, {})) as {
			content: Array<{ text: string }>;
		};
		expect(out.content).toEqual([{ type: "text", text: "real" }]);
	});
});
