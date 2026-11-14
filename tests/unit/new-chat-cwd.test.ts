import { describe, expect, it, vi } from "vitest";
import { handleSessionLifecycleMessage } from "../../server/dispatch-domain-handlers.js";
import type { DispatchSession } from "../../server/index.js";
import type { ServerMessage } from "../../server/protocol.js";
import { normalizePathKey } from "../../server/client-state.js";

type Stub = {
	cs: DispatchSession;
	order: string[];
	setCwd: ReturnType<typeof vi.fn>;
	newChat: ReturnType<typeof vi.fn>;
	notices: ServerMessage[];
};

/**
 * 造一个最小 ClientSession 假体：`cwd` 可写，`setCwd` 成功后原地更新它，
 * 与真实 `ClientSession.setCwd()` 的对外表现一致（异步、写 this.cwd）。
 */
function stub(startCwd: string, opts: { setCwdSucceeds?: boolean } = {}): Stub {
	const order: string[] = [];
	const notices: ServerMessage[] = [];
	const cs = {
		cwd: startCwd,
		refreshSessions: vi.fn(async () => {}),
	} as unknown as DispatchSession;
	const setCwd = vi.fn(async (path: string) => {
		order.push(`setCwd:${path}`);
		if (opts.setCwdSucceeds === false) return;
		(cs as { cwd: string }).cwd = path;
	});
	const newChat = vi.fn(async () => {
		order.push(`newChat:${cs.cwd}`);
		return true;
	});
	Object.assign(cs, { setCwd, newChat });
	return { cs, order, setCwd, newChat, notices };
}

function collect(stubState: Stub) {
	return (message: ServerMessage) => {
		stubState.notices.push(message);
	};
}

describe("new_chat 的目标 cwd", () => {
	it("先切目录再建会话，新对话落在目标项目", async () => {
		const state = stub("E:\\work\\project-a");
		const send = collect(state);

		handleSessionLifecycleMessage({ type: "new_chat", cwd: "E:\\work\\project-b" }, state.cs, send);

		await vi.waitFor(() => expect(state.newChat).toHaveBeenCalledTimes(1));
		expect(state.order).toEqual(["setCwd:E:\\work\\project-b", "newChat:E:\\work\\project-b"]);
	});

	it("目标目录就是当前目录时不重复切（大小写、分隔符、尾斜杠都算同一个）", async () => {
		const state = stub("E:\\work\\project-a");

		handleSessionLifecycleMessage({ type: "new_chat", cwd: "e:/WORK/project-a/" }, state.cs, collect(state));

		await vi.waitFor(() => expect(state.newChat).toHaveBeenCalledTimes(1));
		expect(state.setCwd).not.toHaveBeenCalled();
	});

	it("非 win32 下盘符路径同样归一（CI 跑 ubuntu，这条防回归）", async () => {
		// normalizePathKey 在非 win32 上手拼盘符路径，早先没去尾斜杠：
		// Windows 上 resolve() 会去，Linux 上不会，于是同一路径在 CI 里被当成两个。
		const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		try {
			expect(normalizePathKey("E:\\work\\project-a")).toBe(normalizePathKey("e:/WORK/project-a/"));
			const state = stub("E:\\work\\project-a");
			handleSessionLifecycleMessage({ type: "new_chat", cwd: "e:/WORK/project-a/" }, state.cs, collect(state));
			await vi.waitFor(() => expect(state.newChat).toHaveBeenCalledTimes(1));
			expect(state.setCwd).not.toHaveBeenCalled();
		} finally {
			platform.mockRestore();
		}
	});

	it("没带 cwd 时保持原行为：直接建会话", async () => {
		const state = stub("E:\\work\\project-a");

		handleSessionLifecycleMessage({ type: "new_chat" }, state.cs, collect(state));

		await vi.waitFor(() => expect(state.newChat).toHaveBeenCalledTimes(1));
		expect(state.setCwd).not.toHaveBeenCalled();
	});

	it("切目录失败就不建会话，并回执 ok:false", async () => {
		const state = stub("E:\\work\\project-a", { setCwdSucceeds: false });
		const send = collect(state);

		handleSessionLifecycleMessage({ type: "new_chat", cwd: "E:\\work\\project-b", requestId: "req-1" }, state.cs, send);

		await vi.waitFor(() => expect(state.setCwd).toHaveBeenCalledTimes(1));
		await vi.waitFor(() =>
			expect(state.notices.some((m) => m.type === "new_chat_result" && m.requestId === "req-1")).toBe(true),
		);
		expect(state.newChat).not.toHaveBeenCalled();
		const result = state.notices.find((m) => m.type === "new_chat_result");
		expect(result && result.type === "new_chat_result" ? result.ok : null).toBe(false);
		expect(
			state.notices.some((m) => m.type === "notice" && m.level === "error" && m.text.includes("E:\\work\\project-b")),
		).toBe(true);
	});
});
