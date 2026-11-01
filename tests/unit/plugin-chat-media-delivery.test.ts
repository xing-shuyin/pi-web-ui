import { describe, expect, it, vi } from "vitest";
import { AgentService } from "../../server/agent-service-daemon.js";
import { fakeAgentService } from "../helpers/fake-session.js";

function fixture() {
	const conv = { id: "c1", cwd: process.cwd(), session: { sessionId: "sdk-session-peer" } };
	const owner = {
		getConversation: vi.fn((id: string) => (id === conv.id ? conv : undefined)),
		readConversationForPlugins: vi.fn(() => ({ conversationId: conv.id })),
		markPluginRun: vi.fn(() => conv.id),
		prompt: vi.fn().mockResolvedValue(undefined),
		switchModelOrThrow: vi.fn().mockResolvedValue(undefined),
		setThinking: vi.fn(),
		setConversationIndependent: vi.fn(),
	};
	const svc = fakeAgentService() as any;
	svc.clients = new Map([["plugin:telegram:peer", owner]]);
	svc.attach = vi.fn().mockResolvedValue(owner);
	return { svc, owner, conv };
}
const attachments = [{ path: "", imageData: "YQ==", mimeType: "image/png", name: "photo.png" }];

describe("plugin media delivery", () => {
	it("stops the stable run owner after takeover and never falls back to a local conversation id", async () => {
		const { svc } = fixture();
		const wrong = { findPluginRun: vi.fn(() => undefined), abortPluginRun: vi.fn() };
		const right = {
			findPluginRun: vi.fn(() => ({ id: "renamed" })),
			abortPluginRun: vi.fn().mockResolvedValue({ ok: true }),
		};
		svc.clients = new Map<string, any>([
			["browser-a", wrong],
			["browser-b", right],
		]);
		expect(await svc.abortPluginRun("pr-owned")).toEqual({ ok: true });
		expect(right.abortPluginRun).toHaveBeenCalledWith("pr-owned");
		expect(wrong.abortPluginRun).not.toHaveBeenCalled();
		right.findPluginRun.mockReturnValue(undefined as any);
		expect(await svc.abortPluginRun("pr-expired")).toMatchObject({ ok: false });
		expect(right.abortPluginRun).toHaveBeenCalledTimes(1);
	});
	it("delivers image bytes to a fresh channel conversation", async () => {
		const { svc, owner, conv } = fixture();
		const receipt = await svc.chatFromPlugin("telegram", { accountId: "peer", text: "Describe", attachments });
		expect(receipt).toMatchObject({
			conversationId: "c1",
			clientId: "plugin:telegram:peer",
			sessionId: "sdk-session-peer",
			runId: expect.any(String),
		});
		expect(owner.setConversationIndependent).toHaveBeenCalledWith("c1", false);
		expect(owner.prompt).toHaveBeenCalledWith(
			"Describe",
			expect.arrayContaining([expect.objectContaining({ imageData: "YQ==" })]),
			false,
			conv,
		);
		expect(owner.markPluginRun.mock.invocationCallOrder[0]).toBeLessThan(owner.prompt.mock.invocationCallOrder[0]);
	});
	it("preserves media and stable object when binding an existing conversation", async () => {
		const { svc, owner, conv } = fixture();
		svc.clients.set("browser", { getConversation: () => ({ id: "c1" }) });
		await svc.chatFromPlugin("telegram", { accountId: "peer", text: "Describe", conversationId: "c1", attachments });
		expect(svc.attach).not.toHaveBeenCalled();
		expect(owner.setConversationIndependent).not.toHaveBeenCalled();
		expect(owner.prompt).toHaveBeenCalledWith("Describe", expect.any(Array), false, conv);
	});
	it("refuses ambiguous local conversation ids instead of delivering to another user's conversation", async () => {
		const { svc, owner } = fixture();
		svc.clients = new Map([
			["browser-a", owner],
			["browser-b", owner],
		]);
		await expect(
			svc.chatFromPlugin("telegram", { accountId: "peer", text: "hi", conversationId: "c1" }),
		).rejects.toThrow(/ambiguous/);
		expect(owner.prompt).not.toHaveBeenCalled();
	});
	it("rejects malformed media before creating or waking a session", async () => {
		const { svc, owner } = fixture();
		await expect(
			svc.chatFromPlugin("telegram", {
				accountId: "peer",
				text: "hi",
				attachments: [{ path: "", imageData: "broken" }],
			}),
		).rejects.toThrow();
		expect(svc.attach).not.toHaveBeenCalled();
		expect(owner.prompt).not.toHaveBeenCalled();
	});
});
