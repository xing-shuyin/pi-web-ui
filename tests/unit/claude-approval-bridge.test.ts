/**
 * Claude Code 权限桥的宿主侧行为（PR #928 复核补测）。
 *
 * 驱动层（argv / control_response 报文）在 `claude-driver-launch.test.ts` 里覆盖；这里管
 * `UniversalSession` 这一侧三件容易说假话的事：
 *   1. 有界面在时，审批如实下发并标 `scopeless`（引擎侧没有持久规则库，不该给
 *      「本会话一直允许」这样的按钮）；
 *   2. 没人可答（客户端已全部断开 / plugin:、scheduler: 这类无人值守 client id）时必须
 *      deny 或超时 deny —— 否则 CLI 等一个永远不来的答复，turn 就挂死；
 *   3. abort 要把还没答的审批一并 deny 掉。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UniversalSessionStore, UniversalSession } from "../../server/universal/index.js";
import "../../server/markers/index.js";
import type { ServerMessage } from "../../server/protocol.js";

interface ApprovalSink {
	onApprovalRequest: (requestId: string, toolName: string, params: Record<string, unknown>) => void;
}

function makeDriver() {
	let captured: ApprovalSink | null = null;
	const driver = {
		id: "mock-claude",
		name: "Mock Claude",
		createSession: async () => "sess-1",
		resumeSession: async () => {},
		getActiveSessionId: () => "sess-1",
		sendPrompt: async (_prompt: string, _attachments: unknown, sink: ApprovalSink) => {
			captured = sink;
		},
		abort: async () => {},
		dispose: () => {},
		respondApproval: vi.fn(async () => true),
	};
	return {
		driver,
		sink: () => {
			if (!captured) throw new Error("sink 还没被驱动捕获");
			return captured;
		},
	};
}

describe("Claude 权限桥：宿主侧审批", () => {
	let dataDir: string;
	let cwd: string;

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "pi-claude-approval-"));
		cwd = mkdtempSync(join(tmpdir(), "pi-claude-approval-cwd-"));
	});

	afterEach(() => {
		for (const dir of [dataDir, cwd]) {
			try {
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
			} catch {
				// Windows 上残留句柄会让清理抛 EPERM：临时目录留给 OS，用例结论不受影响
			}
		}
		delete process.env.PI_WEB_UNATTENDED_APPROVAL_TIMEOUT;
	});

	function build(clientId: string) {
		const { driver, sink } = makeDriver();
		const sent: ServerMessage[] = [];
		const send = (msg: ServerMessage) => sent.push(msg);
		const store = new UniversalSessionStore(dataDir);
		const session = new UniversalSession({
			clientId,
			cwd,
			dataDir,
			store,
			driver: driver as never,
			send,
		});
		return { driver, sink, sent, send, session };
	}

	const pendingOf = (sent: ServerMessage[]) =>
		sent.filter(
			(m): m is Extract<ServerMessage, { type: "tool_approval_pending" }> => m.type === "tool_approval_pending",
		);

	it("有界面时如实下发审批，并标记 scopeless", async () => {
		const { driver, sink, sent, session } = build("client-approval");
		await session.prompt("跑个命令");
		sink().onApprovalRequest("req-1", "Bash", { command: "ls" });

		const pending = pendingOf(sent);
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ toolName: "Bash", params: { command: "ls" }, scopeless: true });

		// 答一次就走一次：结论要带着原 request id 回给 CLI
		expect(session.resolveToolApproval(pending[0].id, "approve")).toBe(true);
		expect(driver.respondApproval).toHaveBeenCalledWith("req-1", "approve", undefined, undefined);
		expect(sent.some((m) => m.type === "tool_approval_resolved")).toBe(true);
		session.dispose();
	});

	it("没有已连接的客户端时直接拒绝，不把 CLI 留在等待里", async () => {
		const { driver, sink, sent, send, session } = build("client-detached");
		await session.prompt("跑个命令");
		session.detachSink(send);
		sink().onApprovalRequest("req-2", "Bash", { command: "rm -rf /" });

		expect(driver.respondApproval).toHaveBeenCalledWith("req-2", "deny", undefined, "no attached client");
		expect(pendingOf(sent)).toHaveLength(0);
		session.dispose();
	});

	it("无人值守会话（plugin:/scheduler:）超时后拒绝，并把弹窗收回去", async () => {
		process.env.PI_WEB_UNATTENDED_APPROVAL_TIMEOUT = "0.05";
		const { driver, sink, sent, session } = build("plugin:demo");
		await session.prompt("跑个命令");
		sink().onApprovalRequest("req-3", "Bash", { command: "ls" });

		expect(pendingOf(sent)).toHaveLength(1);
		await vi.waitFor(() =>
			expect(driver.respondApproval).toHaveBeenCalledWith("req-3", "deny", undefined, "unattended timeout"),
		);
		expect(sent.some((m) => m.type === "tool_approval_resolved")).toBe(true);
		session.dispose();
	});

	it("abort 把还没答的审批一起拒掉", async () => {
		const { driver, sink, sent, session } = build("client-abort");
		await session.prompt("跑个命令");
		sink().onApprovalRequest("req-4", "Bash", { command: "ls" });
		await session.abort();
		expect(driver.respondApproval).toHaveBeenCalledWith("req-4", "deny", undefined, "aborted");
		expect(sent.some((m) => m.type === "tool_approval_resolved")).toBe(true);
		session.dispose();
	});
});
