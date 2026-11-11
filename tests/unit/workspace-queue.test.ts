import { describe, expect, it, vi } from "vitest";
import { handleFileMessage, handleSessionLifecycleMessage } from "../../server/dispatch-domain-handlers.js";
import type { DispatchSession } from "../../server/index.js";
import type { ServerMessage } from "../../server/protocol.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 会话假体照着生产时序走：`setCwd` 慢（stat + 恢复最近会话 + 挂载 runtime），`this.cwd` 到末尾才更新；
 * `newChat` / `switchConversation` 全程读 `this.cwd`。这正是「切项目开工太早」的现场。
 */
function makeClient(initialCwd: string, opts: { delayMs?: number; fail?: boolean } = {}) {
	const createdIn: string[] = [];
	const cliCreatedIn: string[] = [];
	const switchedIn: string[] = [];
	const mkdirIn: string[] = [];
	const sent: ServerMessage[] = [];
	const state = {
		cwd: initialCwd,
		async setCwd(next: string) {
			await delay(opts.delayMs ?? 15);
			if (opts.fail) throw new Error("ENOENT: no such directory");
			state.cwd = next;
		},
		async newChat() {
			createdIn.push(state.cwd);
			return true;
		},
		async newCliChat(_config: unknown, cwd?: string) {
			cliCreatedIn.push(cwd ?? state.cwd);
			return true;
		},
		async switchConversation(id: string) {
			await delay(opts.delayMs ?? 15);
			switchedIn.push(`${id}@${state.cwd}`);
		},
		async makeDir(path: string, setAsCwd?: boolean) {
			mkdirIn.push(`${path}@${state.cwd}`);
			if (setAsCwd) state.cwd = path;
		},
		emitNotice: vi.fn(),
	};
	return { cs: state as unknown as DispatchSession, createdIn, cliCreatedIn, switchedIn, mkdirIn, sent, state };
}

describe("工作区命令队列：切项目与建会话的顺序", () => {
	it("声明式 new_chat.cwd：先切到目标项目，再建会话", async () => {
		const { cs, createdIn, state } = makeClient("/work/project-b");
		expect(handleSessionLifecycleMessage({ type: "new_chat", cwd: "/work/project-a" }, cs)).toBe(true);

		expect(createdIn).toEqual([]);
		await vi.waitFor(() => expect(createdIn).toEqual(["/work/project-a"]));
		expect(state.cwd).toBe("/work/project-a");
	});

	it("set_cwd 在飞时 new_chat 排队等它落定，不会建在旧 cwd", async () => {
		const { cs, createdIn, state } = makeClient("/work/project-b");
		handleFileMessage({ type: "set_cwd", path: "/work/project-a" }, cs);
		handleSessionLifecycleMessage({ type: "new_chat" }, cs);

		await vi.waitFor(() => expect(createdIn).toEqual(["/work/project-a"]));
		expect(state.cwd).toBe("/work/project-a");
	});

	it("切工作区失败时不建会话：提示 + 回执 ok:false，绝不静默落到旧项目", async () => {
		const { cs, createdIn, sent } = makeClient("/work/current", { fail: true });
		const send = (m: ServerMessage) => sent.push(m);
		handleSessionLifecycleMessage({ type: "new_chat", cwd: "/work/gone", requestId: "req-1" }, cs, send);

		await vi.waitFor(() => expect(sent.some((m) => m.type === "new_chat_result")).toBe(true));
		expect(createdIn).toEqual([]);
		expect(sent).toContainEqual({ type: "new_chat_result", requestId: "req-1", ok: false });
		const notices = sent.filter((m): m is Extract<ServerMessage, { type: "notice" }> => m.type === "notice");
		expect(notices.some((n) => n.level === "error" && n.text.includes("/work/gone"))).toBe(true);
	});

	it("switch_conversation 排在 set_cwd 之后：跨项目切会话读到的已是新工作区", async () => {
		const { cs, switchedIn } = makeClient("/work/project-b", { delayMs: 10 });
		handleFileMessage({ type: "set_cwd", path: "/work/project-a" }, cs);
		handleSessionLifecycleMessage({ type: "switch_conversation", id: "conv-1" }, cs);

		await vi.waitFor(() => expect(switchedIn).toEqual(["conv-1@/work/project-a"]));
	});

	it("新建目录并设为工作区：后续建会话落在新目录", async () => {
		const { cs, createdIn, mkdirIn } = makeClient("/work/project-b");
		handleFileMessage({ type: "make_dir", path: "/work/project-c", setAsCwd: true }, cs);
		handleSessionLifecycleMessage({ type: "new_chat" }, cs);

		await vi.waitFor(() => expect(createdIn).toEqual(["/work/project-c"]));
		expect(mkdirIn).toEqual(["/work/project-c@/work/project-b"]);
	});

	it("new_cli_chat 自带 cwd：切工作区失败也不拦，CLI 建在自己的目标目录", async () => {
		const { cs, createdIn, cliCreatedIn } = makeClient("/work/current", { fail: true });
		handleFileMessage({ type: "set_cwd", path: "/work/gone" }, cs);
		handleSessionLifecycleMessage(
			{ type: "new_cli_chat", config: { preset: "claude" } as never, cwd: "/work/cli" },
			cs,
		);

		await vi.waitFor(() => expect(cliCreatedIn).toEqual(["/work/cli"]));
		expect(createdIn).toEqual([]);
	});

	it("队列按会话实例隔离：一个客户端切目录不拖住另一个客户端", async () => {
		const slow = makeClient("/work/a", { delayMs: 150 });
		const fast = makeClient("/work/x");
		handleFileMessage({ type: "set_cwd", path: "/work/b" }, slow.cs);
		handleSessionLifecycleMessage({ type: "new_chat" }, slow.cs);
		handleSessionLifecycleMessage({ type: "new_chat" }, fast.cs);

		await vi.waitFor(() => expect(fast.createdIn).toEqual(["/work/x"]), { interval: 5 });
		expect(slow.createdIn).toEqual([]);
		await vi.waitFor(() => expect(slow.createdIn).toEqual(["/work/b"]));
	});
});
