import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordBotBridge } from "../../plugins/discord/index.mjs";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
function setup() {
	let nextRun = 0;
	const host = {
		cwd: process.cwd(),
		chat: vi.fn(async (_req: any) => ({ conversationId: `host-${++nextRun}`, runId: `run-${nextRun}` })),
		abortRun: vi.fn(async (_id: string) => ({ ok: true })),
		fs: {
			statPath: vi.fn(async (_path: string) => ({ type: "dir" })),
			mkdirPath: vi.fn(),
			writePath: vi.fn(),
			readPath: vi.fn(async () => Buffer.from("image")),
		},
	};
	const bridge: any = new DiscordBotBridge({ host, getConfig: () => ({ allowAllSenders: true, botToken: "test" }) });
	bridge.botUser = { id: "bot" };
	bridge.reply = vi.fn(async (_route: any, _text: string) => {});
	const send = (text: string, attachments: any[] = [], channel = "channel") =>
		bridge.onInboundMessage({ author: { id: "user" }, channel_id: channel, content: text, attachments });
	const state = () => bridge.stateFor({ userId: "user", channelId: "channel", sessionThread: "" });
	return { host, bridge, send, state };
}

afterEach(() => vi.unstubAllGlobals());
describe("Discord reset lifecycle", () => {
	it.each(["/new", "/clear", "/reset", "/NEW", "／ＣｌＥａＲ", "／ＲＥＳＥＴ"])(
		"starts a blank independent session for %s",
		async (command) => {
			const { send, state, host, bridge } = setup();
			await send("old");
			const old = { ...state() };
			await send(command);
			expect(host.chat).toHaveBeenCalledTimes(1);
			expect(state().conversationId).not.toBe(old.conversationId);
			expect(state().epoch).not.toBe(old.epoch);
			expect(state().busy).toBeFalsy();
			await send("next");
			expect(host.chat.mock.calls[1][0].conversationId).not.toBe(old.conversationId);
			expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
			await bridge.handleRunEvent({ type: "run_end", runId: old.runId });
			expect(state().busy).toBe(true);
			expect(state().runId).toBe("run-2");
		},
	);
	it.each(["/new", "/clear", "/reset", "／ＮＥＷ"])(
		"runs the supplied prompt once in a fresh session for %s",
		async (command) => {
			const { send, host } = setup();
			await send("old");
			await send(`  ${command}　／new literal prompt\nnext line`);
			expect(host.chat).toHaveBeenCalledTimes(2);
			expect(host.chat.mock.calls[1][0].text).toBe("／new literal prompt\nnext line");
			expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
		},
	);
	it("aborts a late receipt without replacing the new session or clearing its busy flag", async () => {
		const { send, host, state, bridge } = setup();
		const receipt = deferred<{ conversationId: string; runId: string }>();
		host.chat.mockImplementationOnce(() => receipt.promise);
		const oldTask = send("old");
		await send("/reset fresh");
		const current = { ...state() };
		receipt.resolve({ conversationId: "late", runId: "late-run" });
		await oldTask;
		expect(host.abortRun).toHaveBeenCalledWith("late-run");
		expect(state()).toMatchObject(current);
		await bridge.handleRunEvent({ type: "run_end", runId: "late-run" });
		expect(state().busy).toBe(true);
		expect(bridge.reply).not.toHaveBeenCalled();
	});
	it("ignores late dispatch failures", async () => {
		const { send, host, state, bridge } = setup();
		const receipt = deferred<any>();
		host.chat.mockImplementationOnce(() => receipt.promise);
		const oldTask = send("old");
		await send("/clear new prompt");
		receipt.reject(new Error("old failure"));
		await oldTask;
		expect(state().busy).toBe(true);
		expect(bridge.reply).not.toHaveBeenCalled();
	});
	it("cancels a download on reset and suppresses its delayed failure", async () => {
		const { send, host, state, bridge } = setup();
		const download = deferred<Response>();
		let signal!: AbortSignal;
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: any, init: any) => {
				signal = init.signal;
				return download.promise;
			}),
		);
		const oldTask = send("old", [{ url: "https://cdn.discordapp.com/image", content_type: "image/png" }]);
		await send("/new next");
		expect(signal.aborted).toBe(true);
		download.reject(new Error("cancelled old download"));
		await oldTask;
		expect(host.chat).toHaveBeenCalledTimes(1);
		expect(host.chat.mock.calls[0][0].text).toBe("next");
		expect(state().busy).toBe(true);
		expect(bridge.reply).not.toHaveBeenCalled();
	});
	it.each(["/cwd", "/workspace", "／ＷＯＲＫＳＰＡＣＥ", "/CWD"])(
		"switches workspace with fresh identity for %s",
		async (command) => {
			const { send, state, host } = setup();
			await send("old");
			const previous = state().conversationId;
			await send(`${command} ${process.cwd()}`);
			expect(state().cwd).toBe(process.cwd());
			expect(state().conversationId).not.toBe(previous);
			await send("next");
			expect(host.chat.mock.calls[1][0].cwd).toBe(process.cwd());
			expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
		},
	);
	it("does not let late workspace validation undo a later reset", async () => {
		const { send, host, state } = setup();
		const stat = deferred<{ type: string }>();
		host.fs.statPath.mockImplementationOnce(() => stat.promise);
		const switching = send(`/workspace ${process.cwd()}`);
		await send("/reset fresh");
		const current = { ...state() };
		stat.resolve({ type: "dir" });
		await switching;
		expect(state()).toMatchObject(current);
	});
	it.each(["HIGH", "DeFaUlT"])("rotates context when setting thinking %s", async (level) => {
		const { send, host, state, bridge } = setup();
		await send("/thinking low");
		await send("old");
		await bridge.handleRunEvent({ type: "run_end", runId: state().runId });
		const previous = { ...state() };
		await send(`/thinking ${level}`);
		expect(state().conversationId).not.toBe(previous.conversationId);
		expect(state().epoch).not.toBe(previous.epoch);
		expect(state().thinkingLevel).toBe(level === "HIGH" ? "high" : undefined);
		await send("next");
		expect(host.chat.mock.calls[1][0].thinkingLevel).toBe(level === "HIGH" ? "high" : undefined);
		expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
	});
	it("keeps the context on thinking query, invalid value or busy mutation", async () => {
		const { send, state } = setup();
		await send("/thinking low");
		await send("active");
		const current = { ...state() };
		await send("/thinking");
		await send("/thinking invalid");
		await send("/thinking HIGH");
		await send("/thinking DEFAULT");
		expect(state()).toMatchObject(current);
	});
	it("recognizes model DEFAULT without changing provider/model casing", async () => {
		const { send, state } = setup();
		await send("/model Provider/Model");
		expect(state().model).toBe("Provider/Model");
		const previous = { ...state() };
		await send("/model DEFAULT");
		expect(state().model).toBeUndefined();
		expect(state().conversationId).not.toBe(previous.conversationId);
		expect(state().epoch).not.toBe(previous.epoch);
	});
	it.each(["/reset fresh", "/model Provider/New", "/thinking HIGH"])(
		"stops remaining output chunks after %s during delivery",
		async (command) => {
			const { send, state, bridge } = setup();
			await send("old");
			const oldRunId = state().runId;
			await bridge.handleRunEvent({
				type: "message",
				runId: oldRunId,
				message: { role: "assistant", content: "x".repeat(6000) },
			});
			const first = deferred<Response>();
			const started = deferred<void>();
			const fetchMock = vi.fn(() => {
				started.resolve();
				return first.promise;
			});
			vi.stubGlobal("fetch", fetchMock);
			bridge.reply = (DiscordBotBridge.prototype as any).reply;
			const delivery = bridge.handleRunEvent({ type: "run_end", runId: oldRunId });
			await started.promise;
			bridge.reply = vi.fn(async () => {});
			await send(command);
			first.resolve(new Response(JSON.stringify({ id: "sent" }), { status: 200 }));
			await delivery;
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(bridge.status.messagesReplied).toBe(0);
			if (command.startsWith("/reset")) expect(state().busy).toBe(true);
		},
	);
	it("only dispatches the newest of overlapping reset prompts", async () => {
		const { send, host } = setup();
		await Promise.all([send("/new superseded"), send("/reset newest")]);
		expect(host.chat).toHaveBeenCalledTimes(1);
		expect(host.chat.mock.calls[0][0].text).toBe("newest");
	});
	it("keeps the active session on workspace query or invalid path", async () => {
		const { send, state, host } = setup();
		await send("active");
		const current = { ...state() };
		await send("/WORKSPACE");
		await send("/cwd relative");
		host.fs.statPath.mockResolvedValueOnce({ type: "file" });
		await send(`/workspace ${process.cwd()}`);
		expect(state()).toMatchObject(current);
		expect(host.abortRun).not.toHaveBeenCalled();
	});
	it("preserves settings and isolates other channels", async () => {
		const { send, host, state } = setup();
		await send("/model provider/model");
		await send("/thinking high");
		await send("other", [], "other-channel");
		await send("/clear fresh");
		expect(host.chat.mock.calls[1][0]).toMatchObject({ model: "provider/model", thinkingLevel: "high" });
		expect(state().busy).toBe(true);
	});
});
