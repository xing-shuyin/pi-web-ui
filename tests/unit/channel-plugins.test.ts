import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramBotBridge } from "../../plugins/telegram/index.mjs";
import { DiscordBotBridge } from "../../plugins/discord/index.mjs";
import { SlackBotBridge } from "../../plugins/slack/index.mjs";
import { MatrixBotBridge } from "../../plugins/matrix/index.mjs";

const cfg = {
	botToken: "test-token",
	appToken: "test-app",
	accessToken: "test-matrix",
	homeserverUrl: "https://matrix.test",
};
const channels = [
	{
		name: "telegram",
		Bridge: TelegramBotBridge,
		inbound: (b: any, text: string, scope: string) =>
			b.onInboundMessage({
				message_id: 1,
				from: { id: 7 },
				chat: { id: 5, type: "private" },
				message_thread_id: Number(scope),
				text,
			}),
	},
	{
		name: "discord",
		Bridge: DiscordBotBridge,
		inbound: (b: any, text: string, scope: string) =>
			b.onInboundMessage({ id: "1", author: { id: "7" }, channel_id: scope, content: text }),
	},
	{
		name: "slack",
		Bridge: SlackBotBridge,
		inbound: (b: any, text: string, scope: string) =>
			b.onInboundEvent({ user: "7", channel: "5", channel_type: "im", thread_ts: scope, ts: scope, text }),
	},
	{
		name: "matrix",
		Bridge: MatrixBotBridge,
		inbound: (b: any, text: string, scope: string) =>
			b.onInboundMessage("!room:test", {
				event_id: `$${scope}-${text}`,
				sender: "@user:test",
				content: { msgtype: "m.text", body: text, "m.relates_to": { rel_type: "m.thread", event_id: scope } },
			}),
	},
];

afterEach(() => vi.unstubAllGlobals());

for (const channel of channels) {
	describe(`${channel.name} shared channel contract`, () => {
		function setup(chat?: any) {
			const requests: any[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: any, init: any = {}) => {
					let body: any;
					try {
						body = JSON.parse(init.body || "{}");
					} catch {
						body = {};
					}
					requests.push({ url: String(url), body });
					return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, event_id: "$sent", ts: "1" }), {
						headers: { "content-type": "application/json" },
					});
				}),
			);
			const host = {
				cwd: process.cwd(),
				chat: chat || vi.fn(async () => ({ conversationId: "actual", runId: "run" })),
				abortRun: vi.fn(async () => ({ ok: true })),
			};
			const bridge: any = new channel.Bridge({ host, getConfig: () => cfg, log: vi.fn() });
			return { bridge, host, requests };
		}

		it("returns browser continuations to the original channel and rejects unowned or duplicate events", async () => {
			const chat = vi.fn(async () => ({
				conversationId: "c1",
				clientId: `plugin:${channel.name}:owned`,
				sessionId: "stable-channel-session",
				runId: "channel-run",
			}));
			const { bridge, requests } = setup(chat);
			await channel.inbound(bridge, "hello", "1");
			await bridge.handleRunEvent({ type: "run_end", conversationId: "c1", runId: "channel-run" });
			requests.length = 0;
			const identity = { conversationId: "renamed", clientId: "browser-owner", sessionId: "stable-channel-session" };
			await bridge.handleRunEvent({ ...identity, type: "run_start", runId: "foreign-plugin-run" });
			await bridge.handleRunEvent({
				...identity,
				type: "message",
				runId: "foreign-plugin-run",
				message: { role: "assistant", content: "must-not-deliver" },
			});
			await bridge.handleRunEvent({ ...identity, type: "run_end", runId: "foreign-plugin-run" });
			await bridge.handleRunEvent({ ...identity, type: "run_start" });
			await bridge.handleRunEvent({
				...identity,
				type: "message",
				message: { role: "assistant", content: "browser-channel-answer" },
			});
			await bridge.handleRunEvent({ ...identity, type: "run_end" });
			await bridge.handleRunEvent({ ...identity, type: "run_end" });
			expect(requests.filter((r) => JSON.stringify(r.body).includes("browser-channel-answer"))).toHaveLength(1);
			expect(requests.some((r) => JSON.stringify(r.body).includes("must-not-deliver"))).toBe(false);
			await channel.inbound(bridge, "/new", "1");
			requests.length = 0;
			await bridge.handleRunEvent({ ...identity, type: "run_start" });
			await bridge.handleRunEvent({
				...identity,
				type: "message",
				message: { role: "assistant", content: "stale-channel-answer" },
			});
			await bridge.handleRunEvent({ ...identity, type: "run_end" });
			expect(requests.some((r) => JSON.stringify(r.body).includes("stale-channel-answer"))).toBe(false);
		});

		it("never forwards an unknown command to the model", async () => {
			const { bridge, host, requests } = setup();
			await channel.inbound(bridge, "/definitely_unknown", "1");
			expect(host.chat).not.toHaveBeenCalled();
			expect(requests.some((r) => JSON.stringify(r.body).includes("help"))).toBe(true);
		});

		it("isolates the same sender across channels or threads", async () => {
			let n = 0;
			const chat = vi.fn(async (_request: any) => ({ conversationId: `actual-${++n}`, runId: `run-${n}` }));
			const { bridge } = setup(chat);
			await channel.inbound(bridge, "hello", "1");
			await channel.inbound(bridge, "hello", "2");
			expect(chat).toHaveBeenCalledTimes(2);
			expect(chat.mock.calls[0][0].accountId).not.toBe(chat.mock.calls[1][0].accountId);
			if (chat.mock.calls[0][0].conversationId || chat.mock.calls[1][0].conversationId)
				expect(chat.mock.calls[0][0].conversationId).not.toBe(chat.mock.calls[1][0].conversationId);
		});

		it("stops the stable run rather than a stale conversation owner", async () => {
			const { bridge, host } = setup();
			await channel.inbound(bridge, "hello", "1");
			await channel.inbound(bridge, "/stop", "1");
			expect(host.abortRun).toHaveBeenCalledWith("run");
		});

		for (const command of ["/new", "/clear", "/reset", "／NEW", "/ClEaR"]) {
			it(`${command} changes the daemon account so history really resets`, async () => {
				const { bridge, host } = setup();
				await channel.inbound(bridge, "first", "1");
				await bridge.handleRunEvent({ type: "run_end", conversationId: "actual", runId: "run" });
				await channel.inbound(bridge, command, "1");
				await channel.inbound(bridge, "second", "1");
				expect(host.chat).toHaveBeenCalledTimes(2);
				expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
				expect(host.chat.mock.calls[1][0].conversationId).not.toBe("actual");
			});
		}

		it("reuses the host receipt conversation ID and ignores other runs", async () => {
			const { bridge, host, requests } = setup();
			await channel.inbound(bridge, "hello", "1");
			await bridge.handleRunEvent({
				type: "message",
				conversationId: "actual",
				runId: "unowned-run",
				message: { role: "assistant", content: "must-not-deliver" },
			});
			await bridge.handleRunEvent({ type: "run_end", conversationId: "actual", runId: "unowned-run" });
			await bridge.handleRunEvent({ type: "run_end", conversationId: "actual", runId: "run" });
			await channel.inbound(bridge, "follow up", "1");
			expect(host.chat).toHaveBeenCalledTimes(2);
			expect(host.chat.mock.calls[1][0].conversationId).toBe("actual");
			expect(requests.some((r) => JSON.stringify(r.body).includes("must-not-deliver"))).toBe(false);
		});

		it("delivers early completion by stable runId after the host renames the conversation", async () => {
			let bridge: any;
			const chat = vi.fn(async () => {
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "renamed-before-receipt",
					runId: "stable-run",
					message: { role: "assistant", content: "contract-delivery" },
				});
				await bridge.handleRunEvent({ type: "run_end", conversationId: "renamed-again", runId: "stable-run" });
				return { conversationId: "receipt-conversation", runId: "stable-run" };
			});
			const setupResult = setup(chat);
			bridge = setupResult.bridge;
			await channel.inbound(bridge, "hello", "1");
			expect(setupResult.requests.filter((r) => JSON.stringify(r.body).includes("contract-delivery"))).toHaveLength(1);
			expect(bridge.pendingRuns.size).toBe(0);
		});
	});
}
