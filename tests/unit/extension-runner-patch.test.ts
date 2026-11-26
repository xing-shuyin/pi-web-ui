import { describe, expect, it, vi } from "vitest";
import {
	applyExtensionRunnerPatch,
	extensionRunnerPatchTarget,
	patchAgentSessionDisposeSource,
	patchExtensionRunnerSource,
	SENTINEL,
} from "../../server/patch-extension-runner.js";
import { isStaleExtensionContextError, staleSafe } from "../../server/extension-guards.js";
import { requestContextExtension } from "../../server/request-context.js";

/** 与 SDK 1.6.0 `dist/core/extensions/runner.js` 同形的最小片段（#958）。 */
const RUNNER_SOURCE = `export class ExtensionRunner {
    staleMessage;
    constructor(extensions) {
        this.extensions = extensions;
    }
    async emitToolCall(event) {
        const ctx = this.createContext();
        let result;
        for (const { handlers } of snapshotEventHandlers(this.extensions, "tool_call")) {
            const handlerResult = await handler(event, ctx);
            result = handlerResult;
        }
        return result;
    }
    async emitContext(messages) {
        const ctx = this.createContext();
        let currentMessages = structuredClone(messages);
        return currentMessages;
    }
}
`;

/** 与 SDK 1.6.0 `dist/core/agent-session.js#dispose` 同形的最小片段。 */
const AGENT_SESSION_SOURCE = `export class AgentSession {
    _extensionRunnerRef;
    dispose() {
        this._extensionRunner.invalidate("This extension ctx is stale after session replacement or reload.");
        this._disconnectFromAgent();
        this._eventListeners = [];
    }
}
`;

describe("stale extension runner guard (#958)", () => {
	it("short-circuits emitContext / emitToolCall before the transcript clone and handler walk", () => {
		const { code, status } = patchExtensionRunnerSource(RUNNER_SOURCE);
		expect(status).toBe("patched");
		expect(code).toContain("if (this.staleMessage) return messages;");
		// 工具调用必须 fail-closed：退役会话既不执行工具，也不让审批 / 沙箱门槛被静默跳过。
		expect(code).toContain("if (this.staleMessage) return { block: true, reason:");
		expect(code).toContain(SENTINEL);
		// 守卫必须在 structuredClone 之前：克隆本身就是 #958 里白烧的那部分 CPU。
		expect(code.indexOf("if (this.staleMessage) return messages;")).toBeLessThan(
			code.indexOf("structuredClone(messages)"),
		);
		expect(patchExtensionRunnerSource(code)).toEqual({ code, status: "already" });
	});

	it("clears the extension runner reference on dispose so sdk.js falls back to identity", () => {
		const { code, status } = patchAgentSessionDisposeSource(AGENT_SESSION_SOURCE);
		expect(status).toBe("patched");
		expect(code).toContain("if (this._extensionRunnerRef) this._extensionRunnerRef.current = undefined;");
		expect(code).toContain(SENTINEL);
		expect(patchAgentSessionDisposeSource(code)).toEqual({ code, status: "already" });
	});

	it("leaves an upstream fix untouched instead of double patching", () => {
		const fixedRunner = RUNNER_SOURCE.replace(
			"    async emitContext(messages) {\n",
			"    async emitContext(messages) {\n        if (this.staleMessage) return messages;\n",
		);
		expect(patchExtensionRunnerSource(fixedRunner)).toEqual({ code: fixedRunner, status: "already" });
		const fixedSession = AGENT_SESSION_SOURCE.replace(
			"        this._disconnectFromAgent();",
			"        if (this._extensionRunnerRef) this._extensionRunnerRef.current = undefined;\n        this._disconnectFromAgent();",
		);
		expect(patchAgentSessionDisposeSource(fixedSession)).toEqual({ code: fixedSession, status: "already" });
	});

	it("reports unsupported (never assumes fixed) when the SDK structure changed", () => {
		const reshaped = RUNNER_SOURCE.replace("let currentMessages = structuredClone(messages);", "const x = 1;");
		expect(patchExtensionRunnerSource(reshaped)).toEqual({ code: reshaped, status: "unsupported" });
		expect(patchAgentSessionDisposeSource("export class AgentSession {}\n")).toEqual({
			code: "export class AgentSession {}\n",
			status: "unsupported",
		});
	});

	it("only targets the two pi-coding-agent dist modules", () => {
		expect(
			extensionRunnerPatchTarget(
				"file:///C:/npm/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js",
			),
		).toBe("extension-runner");
		expect(
			extensionRunnerPatchTarget(
				"file:///C:/npm/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js",
			),
		).toBe("agent-session");
		// Windows 分隔符与嵌套 node_modules 同样认得。
		expect(
			extensionRunnerPatchTarget("C:\\x\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\core\\agent-session.js"),
		).toBe("agent-session");
		expect(
			extensionRunnerPatchTarget("file:///x/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"),
		).toBeNull();
		expect(extensionRunnerPatchTarget("file:///x/pi-web-ui/dist/server/agent-service.js")).toBeNull();
		expect(applyExtensionRunnerPatch(AGENT_SESSION_SOURCE, "agent-session").status).toBe("patched");
	});
});

describe("request context extension on a stale ctx (#958)", () => {
	const register = () => {
		let handler: any;
		requestContextExtension({
			on: (_event: string, callback: any) => {
				handler = callback;
			},
		} as any);
		return handler as (event: any, ctx: any) => Promise<{ messages: any }>;
	};

	it("degrades to identity instead of re-throwing the stale ctx error", async () => {
		const handler = register();
		const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
		const stale = new Error("This extension ctx is stale after session replacement or reload.");
		const ctx = {
			get cwd() {
				throw stale;
			},
			get signal() {
				throw stale;
			},
			sessionManager: { getSessionFile: () => "/session.jsonl" },
		};
		await expect(handler({ messages }, ctx)).resolves.toEqual({ messages });
	});

	it("still propagates a real abort so the turn stops", async () => {
		const handler = register();
		const controller = new AbortController();
		controller.abort(new Error("stopped"));
		const ctx = {
			cwd: "/workspace",
			signal: controller.signal,
			sessionManager: { getSessionFile: () => undefined },
		};
		await expect(handler({ messages: [] }, ctx)).rejects.toThrow("stopped");
	});

	it("reads the signal once so a throwing getter cannot be queried twice", async () => {
		const handler = register();
		const getter = vi.fn(() => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		});
		const ctx = {
			cwd: "/workspace",
			get signal() {
				return getter();
			},
			sessionManager: { getSessionFile: () => undefined },
		};
		await handler({ messages: [] }, ctx);
		expect(getter).toHaveBeenCalledTimes(1);
	});
});

describe("stale-safe inline extension hooks (#958)", () => {
	const stale = () =>
		new Error(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ...",
		);
	const ctx = {
		get cwd() {
			throw stale();
		},
	} as any;

	it("recognises the SDK stale marker and nothing else", () => {
		expect(isStaleExtensionContextError(stale())).toBe(true);
		expect(isStaleExtensionContextError(new Error("ENOENT: no such file"))).toBe(false);
		expect(isStaleExtensionContextError("This extension ctx is stale")).toBe(false);
	});

	it("skips the hook for this turn instead of throwing on every turn", async () => {
		const handler = staleSafe(async (_event: { messages: unknown[] }, c: typeof ctx) => ({ messages: c.cwd }));
		await expect(handler({ messages: [] }, ctx)).resolves.toBeUndefined();
	});

	it("keeps guard hooks fail-closed: stale means block, never silent allow", async () => {
		const handler = staleSafe(async (_event: { toolName: string }, c: typeof ctx) => ({ block: false, via: c.cwd }), {
			onStale: () => ({ block: true, reason: "This session was retired; tool calls are blocked." }),
		});
		await expect(handler({ toolName: "bash" }, ctx)).resolves.toEqual({
			block: true,
			reason: "This session was retired; tool calls are blocked.",
		});
	});

	it("leaves every other error to the SDK error reporter", async () => {
		const boom = new Error("ENOENT: no such file");
		const handler = staleSafe(async (_event: unknown, _ctx: unknown) => {
			throw boom;
		});
		await expect(handler({}, ctx)).rejects.toBe(boom);
	});

	it("passes real results through untouched", async () => {
		const handler = staleSafe(async (event: { n: number }, _ctx: unknown) => ({ doubled: event.n * 2 }));
		await expect(handler({ n: 2 }, {} as any)).resolves.toEqual({ doubled: 4 });
	});
});
