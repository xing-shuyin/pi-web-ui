import { describe, expect, it, vi } from "vitest";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { WorkspacePort } from "../../packages/keel/src/contracts/files.js";
import type { SandboxPort } from "../../packages/keel/src/contracts/sandbox.js";
import { createSandboxHandlers, type SandboxHandlers } from "../../packages/keel/src/domains/sandbox/handlers.js";

type Call = [name: string, ...args: unknown[]];

type CreateOpts = { name?: string; sourcePath?: string; ephemeral?: boolean };

function fakeSandbox(overrides: Partial<SandboxPort> = {}): { port: SandboxPort; calls: Call[] } {
	const calls: Call[] = [];
	const record =
		(name: string) =>
		(...args: unknown[]) => {
			calls.push([name, ...args]);
			return Promise.resolve();
		};
	const port: SandboxPort = {
		create: vi.fn(async (opts: CreateOpts) => {
			calls.push(["create", opts]);
			return { path: "/data/sandboxes/sandbox-1" };
		}) as unknown as SandboxPort["create"],
		reset: record("reset") as SandboxPort["reset"],
		persist: record("persist") as SandboxPort["persist"],
		promote: vi.fn(async (targetPath: string, path?: string, switchToTarget?: boolean) => {
			calls.push(["promote", targetPath, path, switchToTarget]);
			return { targetPath: "/work/exported" };
		}) as unknown as SandboxPort["promote"],
		diff: record("diff") as SandboxPort["diff"],
		applyToSource: record("applyToSource") as SandboxPort["applyToSource"],
		destroy: record("destroy") as SandboxPort["destroy"],
		...overrides,
	};
	return { port, calls };
}

function fakeWorkspace(): { port: WorkspacePort; calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		port: {
			setCwd: async (path: string) => void calls.push(["setCwd", path]),
			setWorkspaceRoots: async (roots?: string[]) => void calls.push(["setWorkspaceRoots", roots]),
		},
	};
}

function make(overrides: Partial<SandboxPort> = {}) {
	const { port, calls } = fakeSandbox(overrides);
	const workspace = fakeWorkspace();
	const handlers = createSandboxHandlers({ sandbox: () => port, workspace: () => workspace.port });
	return { handlers, calls, workspaceCalls: workspace.calls };
}

/** 7 个成员的调用样本：参数覆盖「可选字段 / revision / requestId / switchToTarget」。 */
const samples: [keyof SandboxHandlers, (h: SandboxHandlers) => Promise<unknown>][] = [
	["createSandbox", (h) => h.createSandbox({ name: "实验", sourcePath: "/src/proj", ephemeral: false })],
	["resetSandbox", (h) => h.resetSandbox("/data/sandboxes/sandbox-1")],
	["persistSandbox", (h) => h.persistSandbox("/data/sandboxes/sandbox-1")],
	["promoteSandbox", (h) => h.promoteSandbox("/work/exported", "/data/sandboxes/sandbox-1")],
	["diffSandbox", (h) => h.diffSandbox("/data/sandboxes/sandbox-1", "req-9")],
	["applySandboxToSource", (h) => h.applySandboxToSource("/data/sandboxes/sandbox-1", "rev-1")],
	["destroySandbox", (h) => h.destroySandbox("/data/sandboxes/sandbox-1")],
];

describe("沙盒 handler（B3）· 7 个按位转交", () => {
	const expected: Record<keyof SandboxHandlers, Call> = {
		createSandbox: ["create", { name: "实验", sourcePath: "/src/proj", ephemeral: false }],
		resetSandbox: ["reset", "/data/sandboxes/sandbox-1"],
		persistSandbox: ["persist", "/data/sandboxes/sandbox-1"],
		promoteSandbox: ["promote", "/work/exported", "/data/sandboxes/sandbox-1", true],
		diffSandbox: ["diff", "/data/sandboxes/sandbox-1", "req-9"],
		applySandboxToSource: ["applyToSource", "/data/sandboxes/sandbox-1", "rev-1"],
		destroySandbox: ["destroy", "/data/sandboxes/sandbox-1"],
	};

	for (const [member, invoke] of samples) {
		it(`${member} → ${expected[member][0]}`, async () => {
			const { handlers, calls } = make();
			await invoke(handlers);
			expect(calls).toStrictEqual([expected[member]]);
		});
	}

	it("createSandbox 三个可选字段不丢（宿主收到的是同一个键集，缺省交给宿主）", async () => {
		const { handlers, calls, workspaceCalls } = make();
		await handlers.createSandbox({});
		// `toStrictEqual` 逐键比对：少传 `sourcePath` / `ephemeral` 这两个键就算丢字段。
		expect(calls).toStrictEqual([["create", { name: undefined, sourcePath: undefined, ephemeral: undefined }]]);
		expect(workspaceCalls).toStrictEqual([["setCwd", "/data/sandboxes/sandbox-1"]]);
	});

	it("createSandbox 传 ephemeral 也照原值转交（不做本地缺省）", async () => {
		const { handlers, calls } = make();
		await handlers.createSandbox({ name: "空白", ephemeral: true });
		expect(calls).toStrictEqual([["create", { name: "空白", sourcePath: undefined, ephemeral: true }]]);
	});

	it("createSandbox 末尾把工作区切到新沙盒目录", async () => {
		const { handlers, workspaceCalls } = make();
		await handlers.createSandbox({ name: "实验" });
		expect(workspaceCalls).toStrictEqual([["setCwd", "/data/sandboxes/sandbox-1"]]);
	});

	it("createSandbox 建失败就不切工作区（不拿半成品去 setCwd）", async () => {
		const { handlers, workspaceCalls } = make({
			create: vi.fn(async () => {
				throw new Error("Cannot import a managed sandbox");
			}) as unknown as SandboxPort["create"],
		});
		await expect(handlers.createSandbox({ sourcePath: "/src/proj" })).rejects.toThrow(
			"Cannot import a managed sandbox",
		);
		expect(workspaceCalls).toStrictEqual([]);
	});

	it("resetSandbox / persistSandbox 的 path 缺省照样转交 undefined（宿主按当前 cwd 找）", async () => {
		const { handlers, calls, workspaceCalls } = make();
		await handlers.resetSandbox();
		await handlers.persistSandbox();
		expect(calls).toStrictEqual([
			["reset", undefined],
			["persist", undefined],
		]);
		expect(workspaceCalls).toStrictEqual([]);
	});

	it("promoteSandbox 切到宿主解析出的目标绝对路径（不是入参原样）", async () => {
		const { handlers, workspaceCalls } = make({
			promote: vi.fn(async () => ({ targetPath: "D:/work/expanded" })) as unknown as SandboxPort["promote"],
		});
		await handlers.promoteSandbox("~/work/expanded");
		expect(workspaceCalls).toStrictEqual([["setCwd", "D:/work/expanded"]]);
	});

	it("promoteSandbox(switchToTarget=false) 只转交、不切工作区", async () => {
		const { handlers, calls, workspaceCalls } = make();
		await handlers.promoteSandbox("/work/exported", "/data/sandboxes/sandbox-1", false);
		expect(calls).toStrictEqual([["promote", "/work/exported", "/data/sandboxes/sandbox-1", false]]);
		expect(workspaceCalls).toStrictEqual([]);
	});

	it("diffSandbox 把 requestId 原样交给宿主（帧由宿主出，内核不算 diff）", async () => {
		const { handlers, calls } = make();
		await handlers.diffSandbox(undefined, "req-42");
		expect(calls).toStrictEqual([["diff", undefined, "req-42"]]);
	});

	it("applySandboxToSource 的 path 可缺省，但 expectedRevision 一定带过去", async () => {
		const { handlers, calls } = make();
		await handlers.applySandboxToSource(undefined, "rev-7");
		expect(calls).toStrictEqual([["applyToSource", undefined, "rev-7"]]);
	});
});

describe("沙盒 handler · 端口未注入时同步抛", () => {
	for (const [member, invoke] of samples) {
		it(`${member} 同步抛 CoreEngineNotReadyError`, () => {
			// 必须是**同步**抛（不是 rejected promise）：端口解析在异步体之前，且 create/promote 会先解析工作区端口。
			expect(() => invoke(createSandboxHandlers({}))).toThrow(CoreEngineNotReadyError);
		});
	}

	it("端口在但工作区端口缺 → createSandbox / promoteSandbox 仍同步抛", () => {
		const { port } = fakeSandbox();
		const handlers = createSandboxHandlers({ sandbox: () => port });
		expect(() => handlers.createSandbox({})).toThrow(CoreEngineNotReadyError);
		expect(() => handlers.promoteSandbox("/work/exported")).toThrow(CoreEngineNotReadyError);
		// switchToTarget=false 不需要切目录，所以缺工作区端口也照常走端口。
		return expect(handlers.promoteSandbox("/work/exported", undefined, false)).resolves.toBeUndefined();
	});
});

describe("沙盒 handler · 不可逆操作失败必须可见（错误冒泡，不吞）", () => {
	it("destroySandbox 宿主报错 → 原样 reject", async () => {
		const { handlers } = make({
			destroy: vi.fn(async () => {
				throw new Error("EPERM: sandbox directory is locked");
			}) as unknown as SandboxPort["destroy"],
		});
		await expect(handlers.destroySandbox("/data/sandboxes/sandbox-1")).rejects.toThrow("EPERM");
	});

	it("applySandboxToSource 宿主报错（revision 过期）→ 原样 reject", async () => {
		const { handlers } = make({
			applyToSource: vi.fn(async () => {
				throw new Error("Sandbox or source changed; refresh preview");
			}) as unknown as SandboxPort["applyToSource"],
		});
		await expect(handlers.applySandboxToSource("/data/sandboxes/sandbox-1", "rev-stale")).rejects.toThrow(
			"refresh preview",
		);
	});

	it("promoteSandbox 切目录失败 → 也冒出来（不假装成功）", async () => {
		const { port } = fakeSandbox();
		const workspace: WorkspacePort = {
			setCwd: async () => {
				throw new Error("Failed to move sandbox owner to a safe workspace");
			},
			setWorkspaceRoots: async () => {},
		};
		await expect(
			createSandboxHandlers({ sandbox: () => port, workspace: () => workspace }).promoteSandbox("/work/exported"),
		).rejects.toThrow("safe workspace");
	});
});
