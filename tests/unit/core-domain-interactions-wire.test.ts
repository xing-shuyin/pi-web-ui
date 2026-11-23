import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	InteractionInbox,
	createApprovalWaiter,
	type ApprovalWaiter,
	type InteractionKind,
} from "../../server/core/domains/interactions/index.js";
import type { TransportPort } from "../../server/core/contracts/ports.js";
import type { ServerMessage } from "../../server/protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

type PendingFrame = Extract<ServerMessage, { type: "tool_approval_pending" }>;

interface SettledCall {
	kind: InteractionKind;
	id: string;
	result: unknown;
}

function makeTransport() {
	const frames: ServerMessage[] = [];
	const state = { closed: false, throwOnSend: false };
	const transport: TransportPort = {
		send(msg) {
			if (state.throwOnSend) throw new Error("socket is gone");
			frames.push(msg);
		},
		isClosed: () => state.closed,
	};
	return { transport, frames, state };
}

function makeRig(options: { nextId?: () => string } = {}) {
	const settled: SettledCall[] = [];
	const inbox = new InteractionInbox((kind, id, result) => {
		settled.push({ kind, id, result: result as unknown });
	});
	const { transport, frames, state } = makeTransport();
	const waiter: ApprovalWaiter = createApprovalWaiter({ inbox, transport, ...options });
	return { waiter, inbox, settled, frames, state };
}

function pendingFrames(frames: readonly ServerMessage[]): PendingFrame[] {
	return frames.filter((frame): frame is PendingFrame => frame.type === "tool_approval_pending");
}

function idsOf(frames: readonly ServerMessage[], type: ServerMessage["type"]): string[] {
	const out: string[] = [];
	for (const frame of frames) {
		if (frame.type !== type) continue;
		const id = (frame as { id?: string }).id;
		if (typeof id === "string") out.push(id);
	}
	return out;
}

describe("interactions/wire · 发帧形状", () => {
	it("最小输入只发协议字段：params 缺省成空对象，toolCallId 与审批 id 同源", () => {
		const { waiter, frames } = makeRig();
		void waiter.request({ conversationId: "c1", toolName: "bash" });

		expect(frames).toEqual([
			{
				type: "tool_approval_pending",
				id: "appr-1",
				toolCallId: "appr-1",
				toolName: "bash",
				params: {},
				conversationId: "c1",
			},
		]);
	});

	it("reason / params / category 按协议形状逐字段透传", () => {
		const { waiter, frames } = makeRig();
		void waiter.request({
			conversationId: "c1",
			toolName: "rm",
			params: { command: "rm -rf /" },
			reason: "危险删除",
			category: "fs-delete",
		});

		expect(pendingFrames(frames)[0]).toEqual({
			type: "tool_approval_pending",
			id: "appr-1",
			toolCallId: "appr-1",
			toolName: "rm",
			params: { command: "rm -rf /" },
			reason: "危险删除",
			category: { id: "fs-delete", label: "fs-delete", labelEn: "fs-delete" },
			conversationId: "c1",
		});
		expect(Object.keys(pendingFrames(frames)[0] as Record<string, unknown>).sort()).toEqual([
			"category",
			"conversationId",
			"id",
			"params",
			"reason",
			"toolCallId",
			"toolName",
			"type",
		]);
	});

	it("调用方没给的字段一个都不带（不自创 hits / parentTool / createdAt 之类）", () => {
		const { waiter, frames } = makeRig();
		void waiter.request({ conversationId: "c1", toolName: "bash", params: { command: "ls" } });

		const frame = pendingFrames(frames)[0] as unknown as Record<string, unknown>;
		for (const key of [
			"reason",
			"reasonEn",
			"category",
			"hits",
			"parentTool",
			"conversationTitle",
			"createdAt",
			"owner",
			"global",
			"scopeless",
		]) {
			expect(frame).not.toHaveProperty(key);
		}
	});

	it("id 全由 nextId 决定；缺省时按递增序号发", () => {
		const injected = ["a-1", "a-2"];
		let i = 0;
		const custom = makeRig({ nextId: () => injected[i++] });
		void custom.waiter.request({ conversationId: "c1", toolName: "x" });
		void custom.waiter.request({ conversationId: "c1", toolName: "y" });
		expect(pendingFrames(custom.frames).map((frame) => frame.id)).toEqual(["a-1", "a-2"]);

		const byDefault = makeRig();
		void byDefault.waiter.request({ conversationId: "c1", toolName: "x" });
		void byDefault.waiter.request({ conversationId: "c1", toolName: "y" });
		expect(pendingFrames(byDefault.frames).map((frame) => frame.id)).toEqual(["appr-1", "appr-2"]);
	});

	it("源文件不读时钟（id 与登记序号都来自注入/本地计数）", () => {
		const source = readFileSync(join(root, "server", "core", "domains", "interactions", "wire.ts"), "utf8");
		expect(source).not.toMatch(/Date\.now|new Date\(/);
	});
});

describe("interactions/wire · 登记与快照", () => {
	it("登记后 pendingForSnapshot 含该项，收件箱也有一条 approval", () => {
		const { waiter, inbox } = makeRig();
		void waiter.request({ conversationId: "c1", toolName: "bash", params: { command: "ls" }, reason: "写文件" });

		expect(waiter.pendingForSnapshot("c1")).toEqual([
			{
				id: "appr-1",
				toolCallId: "appr-1",
				toolName: "bash",
				params: { command: "ls" },
				reason: "写文件",
				conversationId: "c1",
			},
		]);
		expect(waiter.pendingForSnapshot("c2")).toEqual([]);
		expect(inbox.has("appr-1")).toBe(true);
		expect(inbox.size("approval")).toBe(1);
	});

	it("快照与帧同源：id / toolName / params / conversationId 一致", () => {
		const { waiter, frames } = makeRig();
		void waiter.request({ conversationId: "c1", toolName: "write", params: { path: "a.txt" } });

		const frame = pendingFrames(frames)[0];
		const snapshot = waiter.pendingForSnapshot("c1")[0];
		expect(snapshot?.id).toBe(frame.id);
		expect(snapshot?.toolName).toBe(frame.toolName);
		expect(snapshot?.params).toEqual(frame.params);
		expect(snapshot?.conversationId).toBe(frame.conversationId);
	});

	it("登记序号只保住顺序，不是时钟时间", () => {
		const { waiter, inbox } = makeRig();
		void waiter.request({ conversationId: "c1", toolName: "a" });
		void waiter.request({ conversationId: "c1", toolName: "b" });

		expect(inbox.get("appr-1")?.createdAt).toBe(1);
		expect(inbox.get("appr-2")?.createdAt).toBe(2);
	});
});

describe("interactions/wire · 结算", () => {
	it("resolve 结算 promise、清空 pending、发一帧 tool_approval_resolved、收件箱也摘掉", async () => {
		const { waiter, inbox, frames, settled } = makeRig();
		const waiting = waiter.request({ conversationId: "c1", toolName: "bash" });

		expect(waiter.resolve("appr-1", "approve")).toBe(true);
		await expect(waiting).resolves.toEqual({ decision: "approve" });
		expect(waiter.pendingForSnapshot("c1")).toEqual([]);
		expect(inbox.has("appr-1")).toBe(false);
		expect(frames[1]).toEqual({ type: "tool_approval_resolved", id: "appr-1" });
		expect(settled).toEqual([{ kind: "approval", id: "appr-1", result: { decision: "approve" } }]);
	});

	it("同一 id 第二次 resolve 返回 false，且不重复结算", async () => {
		const { waiter, frames, settled } = makeRig();
		const waiting = waiter.request({ conversationId: "c1", toolName: "bash" });

		expect(waiter.resolve("appr-1", "approve")).toBe(true);
		expect(waiter.resolve("appr-1", "deny", undefined, "再点一次")).toBe(false);
		await expect(waiting).resolves.toEqual({ decision: "approve" });
		expect(settled).toHaveLength(1);
		expect(idsOf(frames, "tool_approval_resolved")).toEqual(["appr-1"]);
	});

	it("未知 id 返回 false，不发帧、不回调", () => {
		const { waiter, frames, settled } = makeRig();

		expect(waiter.resolve("ghost", "approve")).toBe(false);
		expect(frames).toEqual([]);
		expect(settled).toEqual([]);
	});

	it("edit 决策把 editedParams 带进结算结果，且不塞 reason", async () => {
		const { waiter, settled } = makeRig();
		const waiting = waiter.request({ conversationId: "c1", toolName: "bash", params: { command: "ls" } });

		expect(waiter.resolve("appr-1", "edit", { command: "ls -la" })).toBe(true);
		const result = await waiting;
		expect(result).toEqual({ decision: "edit", editedParams: { command: "ls -la" } });
		expect(result).not.toHaveProperty("reason");
		expect(settled).toEqual([
			{ kind: "approval", id: "appr-1", result: { decision: "edit", editedParams: { command: "ls -la" } } },
		]);
	});

	it("deny 带 reason 时不带 editedParams", async () => {
		const { waiter } = makeRig();
		const waiting = waiter.request({ conversationId: "c1", toolName: "bash" });

		expect(waiter.resolve("appr-1", "deny", undefined, "用户拒绝")).toBe(true);
		await expect(waiting).resolves.toEqual({ decision: "deny", reason: "用户拒绝" });
	});
});

describe("interactions/wire · 取消与通道", () => {
	it("cancelConversation 结算成 deny（带 reason）、清空 pending、只碰本会话", async () => {
		const { waiter, inbox, frames } = makeRig();
		const first = waiter.request({ conversationId: "c1", toolName: "a" });
		const second = waiter.request({ conversationId: "c1", toolName: "b" });
		const elsewhere = waiter.request({ conversationId: "c2", toolName: "c" });

		expect(waiter.cancelConversation("c1", "会话已关闭")).toBe(2);
		await expect(first).resolves.toEqual({ decision: "deny", reason: "会话已关闭" });
		await expect(second).resolves.toEqual({ decision: "deny", reason: "会话已关闭" });
		expect(waiter.pendingForSnapshot("c1")).toEqual([]);
		expect(waiter.pendingForSnapshot("c2").map((approval) => approval.toolName)).toEqual(["c"]);
		expect(inbox.size("approval")).toBe(1);
		expect(idsOf(frames, "tool_approval_resolved")).toEqual(["appr-1", "appr-2"]);
		expect(waiter.cancelConversation("nope", "会话已关闭")).toBe(0);

		expect(waiter.resolve("appr-3", "approve")).toBe(true);
		await expect(elsewhere).resolves.toEqual({ decision: "approve" });
	});

	it("cancelConversation 不替问卷 / 页面 / 电话结算", async () => {
		const { waiter, inbox, settled } = makeRig();
		inbox.register({ kind: "question", id: "q-1", conversationId: "c1", createdAt: 99 });
		const waiting = waiter.request({ conversationId: "c1", toolName: "a" });

		expect(waiter.cancelConversation("c1", "会话已关闭")).toBe(1);
		await expect(waiting).resolves.toEqual({ decision: "deny", reason: "会话已关闭" });
		expect(inbox.has("q-1")).toBe(true);
		expect(settled.map((call) => call.kind)).toEqual(["approval"]);
	});

	it("通道已关：request 直接 deny，不登记也不发帧（不悬挂）", async () => {
		const { waiter, inbox, frames, state } = makeRig();
		state.closed = true;

		await expect(waiter.request({ conversationId: "c1", toolName: "bash" })).resolves.toEqual({
			decision: "deny",
			reason: "通道已关闭，审批无法送达",
		});
		expect(frames).toEqual([]);
		expect(inbox.size("approval")).toBe(0);
		expect(waiter.pendingForSnapshot("c1")).toEqual([]);
	});

	it("登记后通道关闭：resolve 仍能结算，只是不再发 resolved 帧", async () => {
		const { waiter, frames, state } = makeRig();
		const waiting = waiter.request({ conversationId: "c1", toolName: "bash" });
		state.closed = true;

		expect(waiter.resolve("appr-1", "approve")).toBe(true);
		await expect(waiting).resolves.toEqual({ decision: "approve" });
		expect(idsOf(frames, "tool_approval_resolved")).toEqual([]);
	});

	it("发帧抛错也不悬挂：结算成 deny 并清空登记", async () => {
		const { waiter, inbox, state } = makeRig();
		state.throwOnSend = true;

		await expect(waiter.request({ conversationId: "c1", toolName: "bash" })).resolves.toEqual({
			decision: "deny",
			reason: "审批帧发送失败",
		});
		expect(waiter.pendingForSnapshot("c1")).toEqual([]);
		expect(inbox.size("approval")).toBe(0);
	});

	it("通知帧发不出去也不回滚已结算的审批", async () => {
		const { waiter, state } = makeRig();
		const waiting = waiter.request({ conversationId: "c1", toolName: "bash" });
		state.throwOnSend = true;

		expect(waiter.resolve("appr-1", "approve")).toBe(true);
		await expect(waiting).resolves.toEqual({ decision: "approve" });
		expect(waiter.pendingForSnapshot("c1")).toEqual([]);
	});
});

describe("interactions/wire · 并发与冲突", () => {
	it("多个并发请求互不串号：结算哪条只动哪条", async () => {
		const { waiter, frames } = makeRig();
		const first = waiter.request({ conversationId: "c1", toolName: "a" });
		const second = waiter.request({ conversationId: "c1", toolName: "b" });
		const third = waiter.request({ conversationId: "c1", toolName: "c" });

		expect(pendingFrames(frames).map((frame) => frame.id)).toEqual(["appr-1", "appr-2", "appr-3"]);
		expect(pendingFrames(frames).map((frame) => frame.toolName)).toEqual(["a", "b", "c"]);

		expect(waiter.resolve("appr-2", "approve")).toBe(true);
		await expect(second).resolves.toEqual({ decision: "approve" });
		expect(waiter.pendingForSnapshot("c1").map((approval) => approval.id)).toEqual(["appr-1", "appr-3"]);

		expect(waiter.resolve("appr-3", "deny", undefined, "不批")).toBe(true);
		await expect(third).resolves.toEqual({ decision: "deny", reason: "不批" });
		expect(waiter.resolve("appr-1", "approve")).toBe(true);
		await expect(first).resolves.toEqual({ decision: "approve" });
	});

	it("id 撞车：登记失败直接 deny，不影响已在等的那条", async () => {
		const { waiter, inbox } = makeRig({ nextId: () => "same" });
		const first = waiter.request({ conversationId: "c1", toolName: "a" });

		await expect(waiter.request({ conversationId: "c1", toolName: "b" })).resolves.toEqual({
			decision: "deny",
			reason: "审批 id 重复：same",
		});
		expect(waiter.pendingForSnapshot("c1").map((approval) => approval.toolName)).toEqual(["a"]);
		expect(inbox.size("approval")).toBe(1);

		expect(waiter.resolve("same", "approve")).toBe(true);
		await expect(first).resolves.toEqual({ decision: "approve" });
	});
});
