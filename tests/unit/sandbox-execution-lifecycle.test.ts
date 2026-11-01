import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeEditSoftTool } from "../../server/edit-soft-tool.js";
import { makeSandboxTool } from "../../server/sandbox-tool.js";
import { ClientSession } from "../../server/agent-service.js";
import { SandboxManager, withSandboxJailGate } from "../../server/sandbox-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

const dirs: string[] = [];
function manager() {
	const dir = mkdtempSync(join(tmpdir(), "sandbox-execution-"));
	dirs.push(dir);
	return new SandboxManager(dir);
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function client(mgr: SandboxManager): any {
	return Object.assign(fakeClientSession(), {
		sandboxes: mgr,
		convs: new Map(),
		activeId: "",
		cwd: tmpdir(),
		settlePendingsForConv: vi.fn(),
		clearConversationToolStates: vi.fn(),
		goalSvc: { notifyConversationRemoved: vi.fn() },
		removeConversation: vi.fn(function (this: any, id: string) {
			this.convs.delete(id);
		}),
		userTerminals: { list: () => [], kill: vi.fn() },
	});
}

describe("sandbox execution ownership and lifecycle", () => {
	it("can switch workspace after lifecycle removal leaves no active runtime", () => {
		const owner = client(manager());
		expect(owner.displaceActive()).toBeNull();
	});

	it("does not mutate when moving an owner to a safe workspace fails silently", async () => {
		const mgr = manager();
		const { sandbox } = await mgr.create({});
		const owner = client(mgr);
		owner.cwd = sandbox.path;
		owner.setCwd = vi.fn(async () => {});
		await expect(owner.coordinateSandboxLifecycle(sandbox.id, "destroy")).rejects.toThrow(/Failed to move/);
		expect(mgr.get(sandbox.id)).toBeDefined();
	});
	it("allows real local edit_soft operations through the sandbox gate", async () => {
		const mgr = manager();
		const { sandbox } = await mgr.create({});
		writeFileSync(join(sandbox.path, "a.txt"), "  before\n");
		const tool = withSandboxJailGate(
			makeEditSoftTool(sandbox.path, () => "en"),
			() => mgr.getExecutionIdentity(sandbox.path, sandbox),
			() => sandbox.path,
			() => "en",
			{ trustedTool: true },
			() => mgr.acquireExecution(sandbox.path, sandbox),
		);
		const result = await tool.execute(
			"edit",
			{ path: "a.txt", edits: [{ oldText: "before", newText: "after" }] },
			undefined,
			undefined,
			{} as any,
		);
		expect(result.isError).not.toBe(true);
		expect(readFileSync(join(sandbox.path, "a.txt"), "utf8")).toContain("after");
	});

	it("rejects sandbox management escapes before approval and limits listing to itself", async () => {
		const mgr = manager();
		const { sandbox } = await mgr.create({});
		const other = await mgr.create({});
		const approve = vi.fn();
		const reset = vi.fn();
		const destroy = vi.fn();
		const apply = vi.fn();
		const tool = makeSandboxTool(
			{
				sandboxes: mgr,
				getCwd: () => sandbox.path,
				setCwd: vi.fn(),
				onSandboxesChanged: vi.fn(),
				askApproval: approve,
				resetSandbox: reset,
				destroySandbox: destroy,
				applySandboxToSource: apply,
			},
			() => "en",
		);
		for (const action of ["create", "diff", "promote", "reset", "destroy", "apply_to_source"] as const) {
			const result = await tool.execute(action, { action, sandbox: other.sandbox.id }, undefined, undefined, {} as any);
			expect(result.isError).toBe(true);
		}
		const result = await tool.execute("list", { action: "list" }, undefined, undefined, {} as any);
		expect((result.details as any).sandboxes.map((entry: any) => entry.id)).toEqual([sandbox.id]);
		expect(approve).not.toHaveBeenCalled();
		expect(reset).not.toHaveBeenCalled();
		expect(destroy).not.toHaveBeenCalled();
		expect(apply).not.toHaveBeenCalled();
	});
	it("rejects spawn cwd and worktree escapes before allocating a runtime", async () => {
		const mgr = manager();
		const { sandbox } = await mgr.create({});
		const owner = client(mgr);
		owner.cwd = sandbox.path;
		const parent = { id: "parent", cwd: sandbox.path, session: {}, runtime: {} };
		owner.convs.set(parent.id, parent);
		await expect(
			owner.spawnSubagentConversation("prompt", "test", tmpdir(), undefined, undefined, parent.id),
		).rejects.toThrow(/remain inside/);
		await expect(
			owner.spawnSubagentConversation(
				"prompt",
				"test",
				sandbox.path,
				undefined,
				undefined,
				parent.id,
				false,
				undefined,
				undefined,
				false,
				"worktree",
			),
		).rejects.toThrow(/worktrees/);
		expect(owner.convs.size).toBe(1);
	});

	it("rejects handoff from sandbox to an outside conversation", async () => {
		const mgr = manager();
		const { sandbox } = await mgr.create({});
		const owner = client(mgr);
		owner.subagentOwnerOf = () => owner;
		owner.convs.set("inside", { id: "inside", cwd: sandbox.path, session: {} });
		owner.convs.set("outside", { id: "outside", cwd: tmpdir(), session: {} });
		await expect(owner.handoffSubagent("inside", "outside", "payload")).rejects.toThrow(
			/Cross-project|sandbox boundaries/,
		);
	});
	it("holds a lease until execution settles and releases it after rejection", async () => {
		const mgr = manager();
		const { sandbox } = await mgr.create({});
		let fail!: (error: Error) => void;
		const execute = vi.fn(
			() =>
				new Promise<never>((_resolve, reject) => {
					fail = reject;
				}),
		);
		const tool = withSandboxJailGate(
			{ name: "read", execute } as any,
			() => mgr.getExecutionIdentity(sandbox.path, sandbox),
			() => sandbox.path,
			() => "en",
			{ trustedTool: true },
			() => mgr.acquireExecution(sandbox.path, sandbox),
		);
		const running = tool.execute("x", { path: "file.txt" }, undefined, undefined, {} as any);
		await expect(mgr.reset(sandbox.id)).rejects.toThrow(/running/);
		fail(new Error("cancelled"));
		await expect(running).rejects.toThrow("cancelled");
		await expect(mgr.reset(sandbox.id)).resolves.toBeDefined();
	});

	it("stops every client's matching runtime and only matching user terminals before mutation", async () => {
		const mgr = manager();
		const { sandbox } = await mgr.create({});
		mkdirSync(join(sandbox.path, "sub"));
		const first = client(mgr);
		const second = client(mgr);
		let finish!: () => void;
		const disposed = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const release = mgr.acquireExecution(sandbox.path, sandbox);
		const conv = {
			id: "child",
			cwd: join(sandbox.path, "sub"),
			terminals: { killAll: vi.fn() },
			session: { abort: vi.fn(async () => {}) },
			runtime: {
				dispose: vi.fn(async () => {
					await disposed;
					release();
				}),
			},
		};
		second.convs.set(conv.id, conv);
		second.userTerminals.list = () => [
			{ id: "inside", cwd: sandbox.path },
			{ id: "outside", cwd: tmpdir() },
		];
		first.allSubagentSessions = () => [second];
		let completed = false;
		const reset = first.coordinateSandboxLifecycle(sandbox.id, "reset").then(() => {
			completed = true;
		});
		await vi.waitFor(() => expect(conv.runtime.dispose).toHaveBeenCalled());
		expect(completed).toBe(false);
		expect(() => mgr.acquireExecution(sandbox.path, sandbox)).toThrow(/lifecycle/);
		expect(second.userTerminals.kill.mock.calls).toEqual([["inside"]]);
		finish();
		await reset;
		expect(conv.terminals.killAll).toHaveBeenCalled();
		expect(second.removeConversation).toHaveBeenCalledWith("child", true);
	});

	it("refuses mutation when a runtime cannot be stopped", async () => {
		const mgr = manager();
		const { sandbox } = await mgr.create({});
		const owner = client(mgr);
		owner.convs.set("stuck", {
			id: "stuck",
			cwd: sandbox.path,
			terminals: { killAll: vi.fn() },
			session: {
				abort: vi.fn(async () => {
					throw new Error("stop failed");
				}),
			},
		});
		await expect(owner.coordinateSandboxLifecycle(sandbox.id, "destroy")).rejects.toThrow("stop failed");
		expect(mgr.get(sandbox.id)).toBeDefined();
	});

	it("does not downgrade captured execution when the managed root disappears", async () => {
		const mgr = manager();
		const { sandbox } = await mgr.create({});
		const execute = vi.fn();
		const tool = withSandboxJailGate(
			{ name: "read", execute } as any,
			() => mgr.getExecutionIdentity(sandbox.path, sandbox),
			() => sandbox.path,
			() => "en",
			{ trustedTool: true },
		);
		await mgr.destroy(sandbox.id);
		await expect(tool.execute("x", { path: "a" }, undefined, undefined, {} as any)).rejects.toThrow();
		expect(execute).not.toHaveBeenCalled();
	});
});
