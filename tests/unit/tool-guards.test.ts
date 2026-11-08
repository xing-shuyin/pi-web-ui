import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	withApprovalGate,
	withToolGuard,
	withPlanModeGate,
	withGoalReviewGate,
	withDelegationGate,
	wrapWriteToolWithPermission,
	wrapEditToolWithPermission,
	wrapPatchToolWithPermission,
	wrapBashToolWithPermission,
	type AskApprovalFn,
	type ToolGuardHook,
} from "../../server/tool-guards.js";

const cwd = process.cwd();
const result = () => ({ content: [{ type: "text" as const, text: "ok" }] });
function base(name = "write") {
	const execute = vi.fn(async () => result());
	return { tool: { name, execute } as unknown as ToolDefinition, execute };
}
function run(tool: ToolDefinition, signal: AbortSignal) {
	return tool.execute(
		"call",
		{ path: ".env", content: "x", patch: "[.env#abcd]\nPUT 1.=1:\n+x\n" },
		signal,
		undefined,
		{} as any,
	);
}
const wrappers: Record<string, (tool: ToolDefinition, ask: AskApprovalFn) => ToolDefinition> = {
	write: (tool, ask) =>
		wrapWriteToolWithPermission(
			cwd,
			() => "danger-full-access",
			() => [],
			() => "en",
			ask,
			() => "conv",
			undefined,
			tool,
		),
	edit: (tool, ask) =>
		wrapEditToolWithPermission(
			cwd,
			() => "danger-full-access",
			() => [],
			() => "en",
			ask,
			() => "conv",
			undefined,
			tool,
		),
	patch: (tool, ask) =>
		wrapPatchToolWithPermission(
			tool,
			cwd,
			() => "danger-full-access",
			() => [],
			() => "en",
			ask,
			() => "conv",
		),
	generic: (tool, ask) =>
		withApprovalGate(tool, { cwd: () => cwd, getLang: () => "en", askApproval: ask, conversationId: () => "conv" }),
	plugin: (tool, ask) =>
		withToolGuard(tool, {
			toolName: "read",
			guard: {
				pre: async () => ({ verdict: { decision: "ask" } }),
				post: async () => undefined,
			},
			cwd,
			getLang: () => "en",
			askApproval: ask,
			conversationId: () => "conv",
		}),
};

describe("tool guard cancellation", () => {
	for (const [name, wrap] of Object.entries(wrappers)) {
		it(`${name}: never opens approval or executes an already cancelled call`, async () => {
			const controller = new AbortController();
			controller.abort();
			const { tool, execute } = base(name === "generic" ? "write" : name === "plugin" ? "read" : name);
			const ask = vi.fn<AskApprovalFn>(async () => ({ decision: "approve" }));
			await expect(run(wrap(tool, ask), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
			expect(ask).not.toHaveBeenCalled();
			expect(execute).not.toHaveBeenCalled();
		});
		it(`${name}: forwards signal and stops after approval resolves during cancellation`, async () => {
			const controller = new AbortController();
			const { tool, execute } = base(name === "generic" ? "write" : name === "plugin" ? "read" : name);
			const ask = vi.fn<AskApprovalFn>(async (...args) => {
				expect(args[8]).toBe(controller.signal);
				await Promise.resolve();
				controller.abort();
				return { decision: "approve" };
			});
			await expect(run(wrap(tool, ask), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
			expect(ask).toHaveBeenCalledOnce();
			expect(execute).not.toHaveBeenCalled();
		});
	}
	for (const phase of ["pre", "execute", "post"] as const) {
		for (const rejects of [false, true]) {
			it(`does not swallow abort in ${phase}, rejects=${rejects}`, async () => {
				const controller = new AbortController();
				const pause = async () => {
					await Promise.resolve();
					controller.abort();
					if (rejects) throw controller.signal.reason;
				};
				const { tool, execute } = base("read");
				if (phase === "execute")
					execute.mockImplementation(async () => {
						await pause();
						return result();
					});
				const guard: ToolGuardHook = {
					pre: vi.fn(async () => {
						if (phase === "pre") await pause();
						return { verdict: { decision: "allow" as const } };
					}),
					post: vi.fn(async () => {
						if (phase === "post") await pause();
						return undefined;
					}),
				};
				await expect(
					run(withToolGuard(tool, { toolName: "read", guard, getLang: () => "en" }), controller.signal),
				).rejects.toMatchObject({ name: "AbortError" });
				if (phase === "pre") expect(execute).not.toHaveBeenCalled();
				if (phase !== "post") expect(guard.post).not.toHaveBeenCalled();
			});
		}
	}
	it("does not create an approval after a suspended pre hook is cancelled", async () => {
		const controller = new AbortController();
		const { tool, execute } = base("read");
		const ask = vi.fn<AskApprovalFn>(async () => ({ decision: "approve" }));
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const guard: ToolGuardHook = {
			pre: async () => {
				await pending;
				return { verdict: { decision: "ask" } };
			},
			post: async () => undefined,
		};
		const running = run(
			withToolGuard(tool, { toolName: "read", guard, askApproval: ask, getLang: () => "en" }),
			controller.signal,
		);
		controller.abort();
		release();
		await expect(running).rejects.toMatchObject({ name: "AbortError" });
		expect(ask).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});

	it("mode gates and bash wrapper reject cancelled passthroughs", async () => {
		const controller = new AbortController();
		controller.abort();
		const { tool, execute } = base("read");
		for (const wrapped of [
			withPlanModeGate(
				tool,
				() => false,
				() => "en",
			),
			withGoalReviewGate(
				tool,
				() => false,
				() => "en",
			),
			withDelegationGate(
				tool,
				() => false,
				() => "en",
			),
			wrapBashToolWithPermission(
				tool,
				() => "danger-full-access",
				() => "en",
			),
		]) {
			await expect(run(wrapped, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		}
		expect(execute).not.toHaveBeenCalled();
	});
});
