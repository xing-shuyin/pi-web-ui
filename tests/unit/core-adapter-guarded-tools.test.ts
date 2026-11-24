import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolGuardHook } from "../../packages/keel/src/tool-guards.js";
import { createGuardedBuiltinTools, GUARDED_BUILTIN_NAMES } from "../../packages/keel/src/adapters/tools/guarded.js";

type Executable = ToolDefinition & { execute: (...args: unknown[]) => Promise<unknown> };

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-guarded-tools-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function toolNamed(tools: ToolDefinition[], name: string): Executable {
	const found = tools.find((tool) => tool.name === name);
	if (!found) throw new Error(`没有这个工具：${name}`);
	return found as Executable;
}

/** 前 / 后钩子都记一笔的插件守卫（形状就是引擎钩子 `svc.toolGuard`）。 */
function recordingGuard(overrides: Partial<ToolGuardHook> = {}): ToolGuardHook & {
	preCalls: unknown[];
	postCalls: unknown[];
} {
	const preCalls: unknown[] = [];
	const postCalls: unknown[] = [];
	return {
		preCalls,
		postCalls,
		pre: async (req, lang) => {
			preCalls.push([req, lang]);
			return overrides.pre ? overrides.pre(req, lang) : { verdict: { decision: "allow" as const } };
		},
		post: async (req, lang) => {
			postCalls.push([req, lang]);
			return overrides.post ? overrides.post(req, lang) : undefined;
		},
	};
}

describe("adapters/tools · 内置工具审批闸", () => {
	it("重建同名 bash 工具（名字必须与内置一致才能覆盖）", () => {
		const tools = createGuardedBuiltinTools({
			cwd: "/work",
			getLang: () => "zh",
			askApproval: vi.fn(async () => ({ decision: "deny" as const })),
		});
		expect(tools.map((t) => t.name)).toEqual(["bash", "write", "edit"]);
		for (const tool of tools) expect(typeof tool.execute).toBe("function");
	});

	it("声明的受闸名字与实现一致", () => {
		expect([...GUARDED_BUILTIN_NAMES]).toEqual(["bash", "write", "edit"]);
	});

	it("描述/参数 schema 沿用 SDK 内置定义（不自己写一份）", () => {
		const tools = createGuardedBuiltinTools({
			cwd: "/work",
			getLang: () => "zh",
			askApproval: vi.fn(async () => ({ decision: "deny" as const })),
		});
		expect(tools[0].description.length).toBeGreaterThan(0);
		expect(tools[0].parameters).toBeTruthy();
	});
});

describe("adapters/tools · 插件 pre/post 守卫真的跑（引擎钩子 svc.toolGuard）", () => {
	it("pre 先跑：拿到工具名、参数、对话身份；工具照旧执行，post 拿到结果", async () => {
		const guard = recordingGuard();
		const tools = createGuardedBuiltinTools({
			cwd: root,
			getLang: () => "zh",
			conversationId: () => "c1",
			askApproval: vi.fn(async () => ({ decision: "approve" as const })),
			guard: () => guard,
		});
		const file = join(root, "a.txt");
		const result = (await toolNamed(tools, "write").execute(
			"call-1",
			{ path: file, content: "hello" },
			undefined,
			undefined,
			{} as never,
		)) as { isError?: boolean };

		expect(result?.isError).not.toBe(true);
		expect(readFileSync(file, "utf8")).toBe("hello");
		expect(guard.preCalls).toHaveLength(1);
		const [preReq, preLang] = guard.preCalls[0] as [{ toolName: string; conversationId?: string }, string];
		expect(preReq).toMatchObject({ toolName: "write", conversationId: "c1" });
		expect(preLang).toBe("zh");
		// post 在真执行之后、拿到结果（老实现 `evaluateToolPost` 的入口口径）。
		expect(guard.postCalls).toHaveLength(1);
		const [postReq] = guard.postCalls[0] as [{ toolName: string; result: unknown }];
		expect(postReq.toolName).toBe("write");
		expect(postReq.result).toBeDefined();
	});

	it("pre 返回 deny：工具不执行（文件没写）、post 不跑、也不需要用户审批", async () => {
		const askApproval = vi.fn(async () => ({ decision: "approve" as const }));
		const guard = recordingGuard({
			pre: async () => ({ verdict: { decision: "deny" as const, reason: "插件不许写" }, pluginId: "demo" }),
		});
		const tools = createGuardedBuiltinTools({
			cwd: root,
			getLang: () => "zh",
			askApproval,
			guard: () => guard,
		});
		const file = join(root, "denied.txt");
		const result = (await toolNamed(tools, "write").execute(
			"call-2",
			{ path: file, content: "nope" },
			undefined,
			undefined,
			{} as never,
		)) as { isError?: boolean; content?: { text?: string }[]; details?: Record<string, unknown> };

		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ guardDenied: true, decision: "deny", pluginId: "demo" });
		expect(result.content?.[0]?.text).toContain("插件不许写");
		expect(existsSync(file)).toBe(false);
		expect(guard.postCalls).toHaveLength(0);
		// deny 是插件自己给的结论：不该再弹一次审批。
		expect(askApproval).not.toHaveBeenCalled();
	});

	it("post 可以改写结果内容", async () => {
		const guard = recordingGuard({
			post: async () => ({ content: [{ type: "text", text: "被插件改写" }], pluginIds: ["demo"] }),
		});
		const tools = createGuardedBuiltinTools({
			cwd: root,
			getLang: () => "zh",
			askApproval: vi.fn(async () => ({ decision: "approve" as const })),
			guard: () => guard,
		});
		const result = (await toolNamed(tools, "write").execute(
			"call-3",
			{ path: join(root, "post.txt"), content: "x" },
			undefined,
			undefined,
			{} as never,
		)) as { content?: { text?: string }[] };
		expect(result.content?.[0]?.text).toBe("被插件改写");
	});

	it("钩子抛错不阻断执行（插件坏掉不能把用户的操作卡死）", async () => {
		const guard: ToolGuardHook = {
			pre: async () => {
				throw new Error("plugin boom");
			},
			post: async () => {
				throw new Error("plugin boom");
			},
		};
		const tools = createGuardedBuiltinTools({
			cwd: root,
			getLang: () => "zh",
			askApproval: vi.fn(async () => ({ decision: "approve" as const })),
			guard: () => guard,
		});
		const file = join(root, "boom.txt");
		const result = (await toolNamed(tools, "write").execute(
			"call-4",
			{ path: file, content: "still works" },
			undefined,
			undefined,
			{} as never,
		)) as { isError?: boolean };

		expect(result?.isError).not.toBe(true);
		expect(readFileSync(file, "utf8")).toBe("still works");
	});

	it("没装钩子（`guard` 返回 undefined）：工具照常跑，不因缺失报错", async () => {
		const tools = createGuardedBuiltinTools({
			cwd: root,
			getLang: () => "zh",
			askApproval: vi.fn(async () => ({ decision: "approve" as const })),
			guard: () => undefined,
		});
		const file = join(root, "plain.txt");
		await toolNamed(tools, "write").execute("call-5", { path: file, content: "ok" }, undefined, undefined, {} as never);
		expect(readFileSync(file, "utf8")).toBe("ok");
	});
});
