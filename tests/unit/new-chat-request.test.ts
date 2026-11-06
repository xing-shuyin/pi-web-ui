import { describe, expect, it, vi } from "vitest";
import { requestNativeCliChat, requestNewChat, resolveNewChatResult } from "../../web/src/new-chat-request";
import { createPluginHostApi } from "../../web/src/plugin-host";
import type { ClientMessage } from "../../web/src/types";

describe("correlated new chat acknowledgement", () => {
	it("only resolves the matching request and preserves its target", async () => {
		let id = "";
		const promise = requestNewChat((message) => {
			if (message.type === "new_chat") id = message.requestId!;
			return true;
		});
		resolveNewChatResult({ type: "new_chat_result", requestId: "unrelated", ok: true, conversationId: "wrong" });
		resolveNewChatResult({ type: "new_chat_result", requestId: id, ok: true, conversationId: "created" });
		expect(await promise).toBe("created");
	});
	it("keeps CLI creation independent from a concurrent normal-chat request", async () => {
		const messages: ClientMessage[] = [];
		const send = (message: ClientMessage) => {
			messages.push(message);
			return true;
		};
		const normal = requestNewChat(send);
		const native = requestNativeCliChat(
			send,
			{ preset: "custom", executable: "my-cli", args: ["literal argument"] },
			"/other/project",
		);
		const chatMessage = messages[0] as Extract<ClientMessage, { type: "new_chat" }>;
		const cliMessage = messages[1] as Extract<ClientMessage, { type: "new_cli_chat" }>;
		expect(cliMessage).toMatchObject({
			type: "new_cli_chat",
			cwd: "/other/project",
			config: { preset: "custom", executable: "my-cli", args: ["literal argument"] },
		});
		expect(cliMessage.requestId).not.toBe(chatMessage.requestId);
		resolveNewChatResult({
			type: "new_chat_result",
			requestId: cliMessage.requestId!,
			ok: true,
			conversationId: "cli-conversation",
		});
		resolveNewChatResult({
			type: "new_chat_result",
			requestId: chatMessage.requestId!,
			ok: true,
			conversationId: "normal-conversation",
		});
		expect(await native).toBe("cli-conversation");
		expect(await normal).toBe("normal-conversation");
	});
	it("allows SSH startup beyond the local timeout and correlates its later acknowledgement", async () => {
		vi.useFakeTimers();
		try {
			let requestId = "";
			const native = requestNativeCliChat(
				(message) => {
					if (message.type === "new_cli_chat") requestId = message.requestId!;
					return true;
				},
				{ preset: "claude" },
				"ssh://tester@example.test:22/project",
			);
			const result = vi.fn();
			void native.then(result);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(result).not.toHaveBeenCalled();
			resolveNewChatResult({ type: "new_chat_result", requestId, ok: true, conversationId: "remote-created" });
			expect(await native).toBe("remote-created");
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects disconnected and failed CLI creations", async () => {
		expect(await requestNativeCliChat(() => false, { preset: "claude" }, "/project", 10)).toBeNull();
		expect(
			await requestNativeCliChat(
				(message) => {
					if (message.type === "new_cli_chat")
						resolveNewChatResult({ type: "new_chat_result", requestId: message.requestId!, ok: false });
					return true;
				},
				{ preset: "codex" },
				"/project",
				10,
			),
		).toBeNull();
	});
	it("rejects failed and timed-out requests", async () => {
		expect(await requestNewChat(() => false, 10)).toBeNull();
		expect(
			await requestNewChat((message) => {
				if (message.type === "new_chat")
					resolveNewChatResult({ type: "new_chat_result", requestId: message.requestId!, ok: false });
				return true;
			}, 10),
		).toBeNull();
		expect(await requestNewChat(() => true, 5)).toBeNull();
	});
	it("user switching to B cannot impersonate a successful new_chat", async () => {
		const sent: ClientMessage[] = [];
		let active = "A";
		const api = createPluginHostApi({
			send: (message) => {
				sent.push(message);
				if (message.type === "new_chat") {
					active = "B";
					resolveNewChatResult({ type: "new_chat_result", requestId: message.requestId!, ok: false });
				}
				return true;
			},
			isReady: () => true,
			getCwd: () => "/project",
			getWorkspaceRoots: () => [],
			listSessions: () => [],
			getConversationId: () => active,
			isConversationBlank: () => false,
			setView: () => {},
			timeoutMs: 10,
			pollMs: 1,
		});
		const onResult = vi.fn();
		api.startChat({ prompt: "deploy", newChat: true, onResult });
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(sent.map((message) => message.type)).toEqual(["new_chat"]);
		expect(onResult).toHaveBeenCalledExactlyOnceWith(false);
	});
});
