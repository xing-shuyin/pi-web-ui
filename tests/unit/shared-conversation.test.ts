import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { AgentService } from "../../server/agent-service-daemon.js";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession, fakeAgentService } from "../helpers/fake-session.js";

function fixture() {
	const conversation = { id: "c1", independent: false, cwd: process.cwd() };
	const owner = fakeClientSession() as any;
	owner.convs = new Map([[conversation.id, conversation]]);
	owner.activeId = "other";
	owner.conversationViewers = new Map();
	owner.sharedTerminalSinks = new Map();
	owner.sinks = new Set();
	owner.attachSink = vi.fn((send) => owner.sinks.add(send));
	owner.detachSink = vi.fn((send) => owner.sinks.delete(send));
	let rev = 0;
	owner.snapshotForConversation = vi.fn((conv) => ({
		conversationId: conv.id,
		rev: ++rev,
		sessionId: "stable",
		messages: [],
	}));
	owner.prompt = vi.fn().mockResolvedValue(undefined);
	owner.abortConversation = vi.fn().mockResolvedValue(undefined);
	owner.readConversationForPlugins = () => ({ conversationId: owner.activeId });
	const service = fakeAgentService() as any;
	service.clients = new Map([
		["owner", owner],
		["viewer", {}],
	]);
	service.sharedViewers = new Map();
	service.sharedInteractionSinks = new WeakMap();
	const send = vi.fn();
	return { service, owner, conversation, send };
}

afterEach(() => vi.useRealTimers());
describe("shared conversation identity", () => {
	it("opens a background target without migrating or activating it, and cleans subscriptions", () => {
		const { service, owner, conversation, send } = fixture();
		expect(service.openSharedConversation("viewer", "owner", "c1", send)).toBe(true);
		expect(owner.activeId).toBe("other");
		expect(owner.convs.get("c1")).toBe(conversation);
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "snapshot",
				state: expect.objectContaining({
					clientId: "viewer",
					conversationId: "c1",
					sharedConversation: { owner: "owner", conversationId: "c1" },
				}),
			}),
		);
		service.closeSharedConversation("viewer");
		expect(owner.sinks.size).toBe(0);
		expect(owner.convs.get("c1")).toBe(conversation);
	});
	it("refuses ordinary legacy conversations and invalidates replaced objects with the same local id", () => {
		const { service, owner, conversation, send } = fixture();
		delete (conversation as any).independent;
		expect(service.openSharedConversation("viewer", "owner", "c1", send)).toBe(false);
		conversation.independent = false;
		service.openSharedConversation("viewer", "owner", "c1", send);
		owner.convs.set("c1", { ...conversation });
		expect(service.sharedConversationTarget("viewer")).toBeUndefined();
		expect(owner.sinks.size).toBe(0);
	});
	it("routes prompt and abort to the captured background object and exits on navigation", () => {
		const { service, owner, conversation, send } = fixture();
		service.openSharedConversation("viewer", "owner", "c1", send);
		service.dispatchSharedConversationMessage("viewer", { type: "prompt", text: "continue", queue: true });
		expect(owner.prompt).toHaveBeenCalledWith("continue", undefined, true, conversation);
		service.dispatchSharedConversationMessage("viewer", { type: "abort" });
		expect(owner.abortConversation).toHaveBeenCalledWith(conversation);
		expect(service.dispatchSharedConversationMessage("viewer", { type: "apply_preset", preset: "standard" })).toBe(
			true,
		);
		expect(service.dispatchSharedConversationMessage("viewer", { type: "new_chat" })).toBe(false);
		expect(service.sharedConversationTarget("viewer")).toBeUndefined();
	});
	it("filters deltas by target and coalesces snapshots, including cancellation", () => {
		vi.useFakeTimers();
		const { service, owner, conversation, send } = fixture();
		service.openSharedConversation("viewer", "owner", "c1", send);
		const sink = [...owner.sinks][0] as (msg: unknown) => void;
		sink({ type: "message_delta", conversationId: "other" });
		expect(send).toHaveBeenCalledTimes(1);
		sink({ type: "message_delta", conversationId: "c1" });
		expect(send).toHaveBeenCalledTimes(2);
		for (const push of owner.conversationViewers.get(conversation)) {
			push();
			push();
		}
		vi.advanceTimersByTime(60);
		expect(send).toHaveBeenCalledTimes(3);
		expect(send.mock.calls[2][0]).toMatchObject({
			type: "snapshot_delta",
			baseRev: 1,
			rev: 2,
			state: { clientId: "viewer", sharedConversation: { owner: "owner", conversationId: "c1" } },
		});
		for (const push of owner.conversationViewers.get(conversation)) push();
		service.closeSharedConversation("viewer");
		vi.runAllTimers();
		expect(send).toHaveBeenCalledTimes(3);
	});
	it("excludes private owner approvals from a shared snapshot", () => {
		const { owner, conversation } = fixture();
		owner.buildLightState = () => ({
			pendingApprovals: [
				{ id: "shared", conversationId: "c1" },
				{ id: "private", conversationId: "other" },
			],
		});
		owner.messagesOf = () => [];
		const snapshot = ClientSession.prototype.snapshotForConversation.call(owner, conversation as any);
		expect(snapshot.pendingApprovals).toEqual([{ id: "shared", conversationId: "c1" }]);
	});
	it("forwards only terminals owned by the captured conversation", () => {
		const { service, owner, send } = fixture();
		service.openSharedConversation("viewer", "owner", "c1", send);
		const sink = [...owner.sinks][0] as (msg: unknown) => void;
		sink({ type: "terminal_output", conversationId: "other", ownerKind: "conversation" });
		sink({ type: "terminal_output", conversationId: "c1", ownerKind: "client" });
		sink({ type: "terminal_exit", conversationId: "c1" });
		expect(send).toHaveBeenCalledTimes(1);
		for (const type of ["terminal_output", "terminal_exit"])
			sink({ type, conversationId: "c1", ownerKind: "conversation" });
		sink({ type: "terminal_list", conversationId: "c1", terminals: [] });
		expect(send).toHaveBeenCalledTimes(4);
		owner.emit = vi.fn();
		owner.emitTerminal("c1", { type: "terminal_output", ownerKind: "conversation", terminalId: "pty", data: "hello" });
		expect(send).toHaveBeenCalledTimes(5);
		expect(owner.emit).not.toHaveBeenCalled();
		service.closeSharedConversation("viewer");
		expect(owner.sharedTerminalSinks.size).toBe(0);
	});
	it("keeps a detached logical target and resumes with a full snapshot on the new transport", () => {
		const { service, owner, conversation, send } = fixture();
		const viewer = { detachSink: vi.fn(), sinkCount: () => 1 };
		service.clients.set("viewer", viewer);
		service.openSharedConversation("viewer", "owner", "c1", send);
		service.detach("viewer", send);
		expect(owner.sinks.size).toBe(0);
		expect(service.sharedConversationTarget("viewer")?.conversation).toBe(conversation);
		const reconnected = vi.fn();
		service.resumeSharedConversation("viewer", reconnected);
		expect(reconnected).toHaveBeenCalledWith(expect.objectContaining({ type: "snapshot" }));
		expect(owner.sinks.size).toBe(1);
		// A delayed close from the old socket must not detach the new subscription.
		service.detach("viewer", send);
		expect(owner.sinks.size).toBe(1);
		expect(owner.activeId).toBe("other");
		service.closeSharedConversation("viewer");
	});
	it("rejects a replaced owner after a disconnect and releases disposed source subscriptions", () => {
		const { service, owner, send } = fixture();
		service.openSharedConversation("viewer", "owner", "c1", send);
		service.releaseSharedClient(owner);
		expect(service.sharedConversationTarget("viewer")).toBeUndefined();
		expect(owner.sinks.size).toBe(0);
		service.openSharedConversation("viewer", "owner", "c1", send);
		service.clients.set("owner", { getConversation: () => owner.getConversation("c1") });
		const reconnected = vi.fn();
		service.resumeSharedConversation("viewer", reconnected);
		expect(reconnected).not.toHaveBeenCalled();
		expect(owner.sinks.size).toBe(0);
	});
	it("keeps idle device task conversations visible without a browser sink", () => {
		const { service, owner } = fixture();
		service.clients.delete("viewer");
		service.clients.delete("owner");
		service.clients.set("device-task-bot", owner);
		owner.sinkCount = () => 0;
		owner.streamingSummariesAll = () => [
			{
				id: "c1",
				cwd: process.cwd(),
				title: "Bot",
				isStreaming: false,
				activity: 1,
				independent: false,
			},
		];
		const rows = service.listExternalRunning("browser");
		expect(rows).toEqual([expect.objectContaining({ owner: "device-task-bot", pseudo: true })]);
		expect(rows[0].ownerOffline).toBeUndefined();
	});
	it("keeps distinct shared chats with identical blank titles visible alongside a local chat", () => {
		const { service, owner } = fixture();
		const row = { convId: "c1", cwd: process.cwd(), title: "New chat", independent: false, isStreaming: false };
		const viewer = { takeoverBriefs: () => [{ ...row, independent: true }] };
		service.clients.set("viewer", viewer);
		service.clients.delete("owner");
		owner.sinkCount = () => 0;
		owner.streamingSummariesAll = () => [row, { ...row, convId: "c2" }];
		service.clients.set("device-task-a", owner);
		service.clients.set("device-task-b", { sinkCount: () => 0, streamingSummariesAll: () => [row] });
		const rows = service.listExternalRunning("viewer");
		expect(rows.map((entry: { owner: string; convId: string }) => [entry.owner, entry.convId])).toEqual([
			["device-task-a", "c1"],
			["device-task-a", "c2"],
			["device-task-b", "c1"],
		]);
	});
	it("publishes an authoritative queue without disposed source interactions", () => {
		const { service, owner } = fixture();
		const emitSharedInteraction = vi.fn();
		service.clients.set("viewer", { emitSharedInteraction });
		service.clients.delete("owner");
		service.clients.set("device-task-bot", owner);
		owner.sharedPendingMessages = () => [{ type: "question_pending", id: "old" }];
		const relay = vi.fn();
		service.sharedInteractionSinks.set(owner, relay);
		service.releaseSharedClient(owner);
		expect(owner.detachSink).toHaveBeenCalledWith(relay);
		expect(emitSharedInteraction).toHaveBeenCalledWith({ type: "global_interactions", questions: [], approvals: [] });
	});
	it("persists an explicit shared restore before reusing an already-open runtime", async () => {
		const session = fakeClientSession() as any;
		const sessionFile = resolve(process.cwd(), "sessions", "restore.jsonl");
		session.agentDir = process.cwd();
		session.convs = new Map([["c1", { id: "c1", session: { sessionFile } }]]);
		session.quiesceBlocked = () => false;
		session.setConversationIndependent = vi.fn();
		session.switchConversation = vi.fn().mockResolvedValue(undefined);
		session.emit = vi.fn();
		await session.switchSession(sessionFile, undefined, false);
		expect(session.setConversationIndependent).toHaveBeenCalledWith("c1", false);
		expect(session.switchConversation).toHaveBeenCalledWith("c1");
		expect(session.setConversationIndependent.mock.invocationCallOrder[0]).toBeLessThan(
			session.switchConversation.mock.invocationCallOrder[0],
		);
	});
	it("persists the flag before publishing and restores legacy ordinary and pseudo defaults", () => {
		const session = fakeClientSession() as any;
		const entries: any[] = [];
		const sdk = {
			sessionManager: {
				getEntries: () => entries,
				appendCustomEntry: vi.fn((_type, data) =>
					entries.push({ type: "custom", customType: "webui/independent", data }),
				),
			},
		};
		const conv = { id: "c1", session: sdk, independent: false };
		session.convs = new Map([["c1", conv]]);
		session.emitConversations = vi.fn();
		session.clientId = "browser";
		expect(session.readConversationIndependent(sdk)).toBe(true);
		session.clientId = "plugin:test";
		expect(session.readConversationIndependent(sdk)).toBe(false);
		session.setConversationIndependent("c1", false);
		session.clientId = "browser";
		expect(session.readConversationIndependent(sdk)).toBe(false);
		expect(sdk.sessionManager.appendCustomEntry).toHaveBeenCalledWith("webui/independent", { independent: false });
		expect(sdk.sessionManager.appendCustomEntry.mock.invocationCallOrder[0]).toBeLessThan(
			session.emitConversations.mock.invocationCallOrder[0],
		);
	});
});
