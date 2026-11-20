import { describe, expect, it, vi } from "vitest";
import type { AttachmentContext } from "../../server/attachments.js";
import { buildAttachmentMessages } from "../../server/attachments.js";
import type { TerminalInfo } from "../../server/protocol.js";
import { makePersistentTerminalTools } from "../../server/terminals.js";

type Aside = { message: { content: { text?: string }[]; details?: Record<string, unknown> } };

function terminalCtx(opts: {
	terminals: Record<string, TerminalInfo>;
	notices?: { level: string; text: string }[];
}): AttachmentContext {
	const notices = opts.notices ?? [];
	return {
		cwd: "/workspace",
		clientId: "test-client",
		emit: (msg: { level?: string; text?: string }) => notices.push({ level: msg.level ?? "", text: msg.text ?? "" }),
		settings: {} as never,
		session: { model: undefined } as never,
		resolveTerminal: (id: string) => opts.terminals[id],
	} as unknown as AttachmentContext;
}

const info = (over: Partial<TerminalInfo> = {}): TerminalInfo => ({
	id: "term-1",
	title: 'dev "shell"',
	cwd: "/workspace/app",
	cols: 80,
	rows: 24,
	running: true,
	exitCode: null,
	ownerKind: "client",
	...over,
});

describe("terminal tab references (object, not text)", () => {
	it("指向用户自己的终端标签：带 id/标题/cwd，并说明可以读也可以往里输入", async () => {
		const notices: { level: string; text: string }[] = [];
		const out = (await buildAttachmentMessages(terminalCtx({ terminals: { "term-1": info() }, notices }), [
			{ mode: "terminal", path: "", terminalId: "term-1", name: "stale title" },
		])) as Aside[];
		expect(out).toHaveLength(1);
		const text = out[0].message.content[0].text ?? "";
		expect(text).toContain('<terminal-ref id="term-1" title="dev &quot;shell&quot;" cwd="/workspace/app" owner="user"');
		expect(text).toContain('running="true"');
		expect(text).toContain('terminal(action="read", terminalId="term-1")');
		expect(text).toContain("you may type in it");
		expect(text).toContain("say what you are about to run");
		expect(text).toContain("这是他自己的 shell");
		expect(text).not.toContain("refused");
		expect(out[0].message.details).toEqual({
			mode: "terminal",
			path: "",
			name: 'dev "shell"',
			terminalId: "term-1",
		});
		expect(notices).toEqual([]);
	});

	it("会话自有的终端（agent bash）同样可读可驱动，只是措辞不强调「用户的 shell」", async () => {
		const out = (await buildAttachmentMessages(
			terminalCtx({
				terminals: {
					"term-2": info({
						id: "term-2",
						ownerKind: "conversation",
						command: { name: "dev", command: "npm run dev" },
					}),
				},
			}),
			[{ mode: "terminal", path: "", terminalId: "term-2" }],
		)) as Aside[];
		const text = out[0].message.content[0].text ?? "";
		expect(text).toContain('owner="conversation"');
		expect(text).toContain('command="npm run dev"');
		expect(text).toContain('action="input"/"key" drive this PTY');
		expect(text).not.toContain("user's own shell tab");
	});

	it("标签已被关掉时给一条 warning 提示并跳过，不塞一条死引用", async () => {
		const notices: { level: string; text: string }[] = [];
		const out = await buildAttachmentMessages(terminalCtx({ terminals: {}, notices }), [
			{ mode: "terminal", path: "", terminalId: "gone", name: "终端 1" },
		]);
		expect(out).toEqual([]);
		expect(notices).toHaveLength(1);
		expect(notices[0].level).toBe("warning");
		expect(notices[0].text).toContain("终端 1");
	});
});

describe("terminal tool 能驱动用户自己的终端标签", () => {
	function manager(withOutput = false) {
		const pending = new Map<string, string>();
		return {
			has: vi.fn((id: string) => id === "user-1"),
			list: vi.fn(() => []),
			read: vi.fn(() =>
				withOutput
					? { data: "pnpm dev ready\n", cursor: 42, running: true, exitCode: null, commandPending: false }
					: null,
			),
			waitForOutput: vi.fn(async () => undefined),
			kill: vi.fn(),
			inputChecked: vi.fn(() => null),
			noteAgentActivity: vi.fn(),
			isSentinelPending: vi.fn(() => false),
			endCursor: vi.fn(() => 0),
			waitForCompletion: vi.fn(async () => ({ finished: true })),
			getAgentPendingLine: vi.fn((id: string) => pending.get(id) ?? ""),
			setAgentPendingLine: vi.fn((id: string, line: string) => void pending.set(id, line)),
			clearAgentPendingLine: vi.fn((id: string) => void pending.delete(id)),
		};
	}

	function setup(checkSafety?: (cmd: string) => { blocked?: boolean; reason?: string }) {
		const own = manager();
		own.has.mockReturnValue(false);
		const userShell = manager(true);
		const tools = makePersistentTerminalTools(own as never, "/workspace", () => "en", {
			resolveExternal: (id) => (userShell.has(id) ? (userShell as never) : undefined),
			...(checkSafety ? { checkSafety: checkSafety as never } : {}),
		});
		const call = (params: Record<string, unknown>) =>
			tools[0].execute("call", params, undefined, undefined, {} as never);
		return { own, userShell, call };
	}

	it("read 读用户标签的输出（走它自己的 manager）", async () => {
		const { own, userShell, call } = setup();
		const result = (await call({ action: "read", terminalId: "user-1" })) as { content: { text: string }[] };
		expect(userShell.read).toHaveBeenCalledWith("user-1", 0, 20000);
		expect(own.read).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain("pnpm dev ready");
	});

	it("input 把按键写进用户自己的 shell，不落到会话那份 manager", async () => {
		const { own, userShell, call } = setup();
		await call({ action: "input", terminalId: "user-1", data: "pnpm test\r" });
		expect(userShell.inputChecked).toHaveBeenCalledWith("user-1", "pnpm test\r");
		expect(own.inputChecked).not.toHaveBeenCalled();
	});

	it("key 也能写字，待确认行记在用户那份 manager 上", async () => {
		const { own, userShell, call } = setup();
		await call({ action: "input", terminalId: "user-1", data: "git status" });
		await call({ action: "key", terminalId: "user-1", key: "Enter" });
		expect(userShell.setAgentPendingLine).toHaveBeenCalled();
		expect(userShell.inputChecked).toHaveBeenCalledWith("user-1", "\r");
		expect(own.inputChecked).not.toHaveBeenCalled();
	});

	it("close 关的是用户的标签（走它自己的 manager）", async () => {
		const { own, userShell, call } = setup();
		await call({ action: "close", terminalId: "user-1" });
		expect(userShell.kill).toHaveBeenCalledWith("user-1");
		expect(own.kill).not.toHaveBeenCalled();
	});

	it("写入照样过安全门禁：被拦的那条不会落进用户的 shell", async () => {
		const { userShell, call } = setup((cmd) =>
			cmd.includes("rm -rf") ? { blocked: true, reason: "rm -rf blocked" } : {},
		);
		await expect(call({ action: "input", terminalId: "user-1", data: "rm -rf /\r" })).rejects.toThrow(/blocked/);
		expect(userShell.inputChecked).not.toHaveBeenCalledWith("user-1", "rm -rf /\r");
	});

	it("不存在的 id 仍然说 not found，不会因为外部解析器在就假装存在", async () => {
		const { call } = setup();
		await expect(call({ action: "read", terminalId: "nope" })).rejects.toThrow(/Terminal not found/);
	});
});
