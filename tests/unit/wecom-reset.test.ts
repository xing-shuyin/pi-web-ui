import { afterEach, describe, expect, it, vi } from "vitest";
import { WecomBotBridge } from "../../plugins/wecom/index.mjs";

const aliases = ["/new", "/clear", "/reset", "/NEW", "/ClEaR", "／ＲＥＳＥＴ", "/ｎｅｗ", "／clear"];
afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function setup(config: Record<string, unknown> = {}) {
	const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });
	vi.stubGlobal("fetch", fetch);
	const accounts = new Map<string, string>();
	let sequence = 0;
	const host = {
		chat: vi.fn(async (req: any) => {
			expect(req.accountId).toMatch(/^wc_/);
			const conversationId = req.conversationId || accounts.get(req.accountId) || `conversation-${++sequence}`;
			accounts.set(req.accountId, conversationId);
			return { conversationId, runId: `run-${sequence}` };
		}),
		abortRun: vi.fn().mockResolvedValue({ ok: true }),
	};
	const bridge = new WecomBotBridge({
		host,
		getConfig: () => ({ webhookKey: "key", ...config }),
		log: () => {},
	});
	const send = (content: string, extra: any = {}) =>
		bridge.onInboundMessage({ fromUserName: "user", content, ...extra });
	const finish = (conversationId: string, runId: string, content = "answer") => {
		void bridge.handleRunEvent({ type: "message", conversationId, runId, message: { role: "assistant", content } });
		return bridge.handleRunEvent({ type: "run_end", conversationId, runId });
	};
	return { bridge, host, send, finish, fetch };
}

describe("WeCom reset command generation isolation", () => {
	it.each(aliases)("%s executes a literal prompt in a new host account", async (alias) => {
		const { host, send, finish } = setup();
		await send("old");
		const prompt = "/stop  保留 ＡＢＣ\n第二行  ";
		await send(alias + " " + prompt);
		expect(host.chat).toHaveBeenCalledTimes(2);
		const fresh = host.chat.mock.calls[1][0];
		expect(fresh.text).toBe(prompt);
		expect(fresh.accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
		expect(fresh).not.toHaveProperty("conversationId");
		await finish("new-renamed", "run-2");
		await send("followup");
		expect(host.chat.mock.calls[2][0]).toMatchObject({ accountId: fresh.accountId, conversationId: "new-renamed" });
	});

	it.each([
		["／ＭＯＤＥＬ Provider/Model", { model: "Provider/Model" }],
		["/model DEFAULT", {}],
		["／ＴＨＩＮＫＩＮＧ HiGh", { thinkingLevel: "high" }],
		["/thinking DEFAULT", {}],
		["／ＣＷＤ C:/project  with spaces", { cwd: "C:/project  with spaces" }],
		["/ＷＯＲＫＳＰＡＣＥ C:/other", { cwd: "C:/other" }],
		["/cwd DEFAULT", {}],
		["/workspace DeFaUlT", {}],
	] as const)("%s rotates the account and invalidates a delayed dispatch", async (command, settings) => {
		const { host, send, finish, fetch } = setup();
		const old = deferred<{ conversationId: string; runId: string }>();
		host.chat.mockImplementationOnce(() => old.promise);
		const dispatch = send("old");
		await send(command);
		await send("fresh");
		expect(host.chat).toHaveBeenCalledTimes(2);
		const fresh = host.chat.mock.calls[1][0];
		expect(fresh).toMatchObject(settings);
		expect(fresh.accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
		expect(fresh).not.toHaveProperty("conversationId");
		old.resolve({ conversationId: "old", runId: "old-run" });
		await dispatch;
		await finish("old-renamed", "old-run", "stale");
		await finish("fresh-renamed", "run-1");
		await send("followup");
		expect(host.chat.mock.calls[2][0]).toMatchObject({ accountId: fresh.accountId, conversationId: "fresh-renamed" });
		expect(fetch.mock.calls.map((call) => call[1].body).join("\n")).not.toContain("stale");
	});

	it("DEFAULT restores configured defaults, queries and invalid setters leave the current account intact", async () => {
		const { host, send, finish } = setup();
		await send("/model p/custom");
		await send("/thinking high");
		await send("/cwd C:/custom");
		await send("first");
		await finish("first", "run-1");
		for (const command of ["/model", "/thinking", "／ＣＷＤ", "/workspace", "/model invalid", "/thinking impossible"])
			await send(command);
		await send("same");
		expect(host.chat.mock.calls[1][0]).toMatchObject({
			accountId: host.chat.mock.calls[0][0].accountId,
			conversationId: "first",
		});
		await finish("first", "run-1");
		await send("/model DEFAULT");
		await send("/thinking DEFAULT");
		await send("/workspace DEFAULT");
		await send("defaults");
		const request = host.chat.mock.calls[2][0];
		expect(request).not.toHaveProperty("model");
		expect(request).not.toHaveProperty("thinkingLevel");
		expect(request).not.toHaveProperty("cwd");
		expect(request.accountId).not.toBe(host.chat.mock.calls[1][0].accountId);
	});

	it("DEFAULT restores panel model, thinking and workspace defaults", async () => {
		const { host, send } = setup({ model: "panel/model", thinkingLevel: "medium", workspace: "C:/panel" });
		await send("/model custom/model");
		await send("/thinking HIGH");
		await send("/cwd C:/custom");
		await send("/model DEFAULT");
		await send("/thinking DeFaUlT");
		await send("／ＷＯＲＫＳＰＡＣＥ DEFAULT");
		await send("hello");
		expect(host.chat.mock.calls[0][0]).toMatchObject({
			model: "panel/model",
			thinkingLevel: "medium",
			cwd: "C:/panel",
		});
	});

	it("a newer reset invalidates an older reset prompt before dispatch", async () => {
		const { send, host } = setup();
		const old = send("/new stale prompt");
		const fresh = send("／ＲＥＳＥＴ /stop");
		await Promise.all([old, fresh]);
		expect(host.chat).toHaveBeenCalledTimes(1);
		expect(host.chat.mock.calls[0][0].text).toBe("/stop");
	});

	it.each(aliases)("%s resets an idle binding and repeated resets keep the latest account", async (alias) => {
		const { host, send, finish } = setup();
		await send("first");
		await finish("first-renamed", "run-1");
		await send(alias);
		await send(alias);
		await send("fresh");
		expect(host.chat).toHaveBeenCalledTimes(2);
		const fresh = host.chat.mock.calls[1][0];
		expect(fresh.accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
		expect(fresh).not.toHaveProperty("conversationId");
		await finish("fresh-renamed", "run-2");
		await send("followup");
		expect(host.chat.mock.calls[2][0]).toMatchObject({ accountId: fresh.accountId, conversationId: "fresh-renamed" });
	});
	it.each(aliases)("%s detaches a busy run and the host's implicit account binding", async (alias) => {
		const { host, send, finish, fetch } = setup();
		await send("old");
		await send(alias);
		await send("fresh");
		expect(host.chat).toHaveBeenCalledTimes(2);
		const [oldRequest, freshRequest] = host.chat.mock.calls.map(([req]) => req);
		expect(freshRequest.accountId).not.toBe(oldRequest.accountId);
		expect(freshRequest).not.toHaveProperty("conversationId");
		await finish("old-renamed", "run-1", "stale answer");
		await finish("new-renamed", "run-2", "fresh answer");
		expect(fetch.mock.calls.map((call) => call[1].body).join("\n")).not.toContain("stale answer");
		await send("followup");
		expect(host.chat.mock.calls[2][0]).toMatchObject({
			accountId: freshRequest.accountId,
			conversationId: "new-renamed",
		});
		expect(host.abortRun).toHaveBeenCalledWith("run-1");
	});

	it.each(aliases)("%s overtakes a pending host.chat without its late receipt clearing the new lock", async (alias) => {
		const { bridge, host, send, finish, fetch } = setup();
		const old = deferred<{ conversationId: string; runId: string }>();
		const fresh = deferred<{ conversationId: string; runId: string }>();
		host.chat.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
		const oldDispatch = send("old");
		await send(alias);
		const freshDispatch = send("fresh");
		await bridge.handleRunEvent({
			type: "message",
			conversationId: "old",
			runId: "old-run",
			message: { role: "assistant", content: "stale early reply" },
		});
		old.resolve({ conversationId: "old", runId: "old-run" });
		await oldDispatch;
		await send("must remain busy");
		expect(host.chat).toHaveBeenCalledTimes(2);
		fresh.resolve({ conversationId: "fresh", runId: "fresh-run" });
		await freshDispatch;
		await finish("old-renamed", "old-run", "stale late reply");
		await finish("fresh-renamed", "fresh-run", "fresh reply");
		await send("followup");
		expect(host.chat.mock.calls[2][0]).toMatchObject({
			accountId: host.chat.mock.calls[1][0].accountId,
			conversationId: "fresh-renamed",
		});
		expect(fetch.mock.calls.map((call) => call[1].body).join("\n")).not.toContain("stale");
		expect(host.abortRun).toHaveBeenCalledWith("old-run");
	});

	it("suppresses stale dispatch errors and preserves other scopes and preferences", async () => {
		const { host, send, finish, fetch } = setup();
		await send("/model provider/model");
		await send("/thinking high");
		await send("/workspace C:/project");
		await send("other scope", { chatId: "other" });
		const old = deferred<{ conversationId: string; runId: string }>();
		host.chat.mockImplementationOnce(() => old.promise);
		const dispatch = send("old");
		await send("/clear");
		old.reject(new Error("stale error"));
		await dispatch;
		await send("new");
		expect(host.chat.mock.calls[2][0]).toMatchObject({
			model: "provider/model",
			thinkingLevel: "high",
			cwd: "C:/project",
		});
		await finish("other-renamed", "run-1");
		await send("other followup", { chatId: "other" });
		expect(host.chat.mock.calls[3][0]).toMatchObject({
			accountId: host.chat.mock.calls[0][0].accountId,
			conversationId: "other-renamed",
		});
		expect(fetch.mock.calls.map((call) => call[1].body).join("\n")).not.toContain("stale error");
	});

	it("stops unsent reply chunks when reset overtakes webhook delivery", async () => {
		const { send, finish, fetch } = setup();
		await send("old");
		const firstChunk = deferred<any>();
		fetch.mockImplementationOnce(() => firstChunk.promise);
		const delivery = finish("old", "run-1", "测".repeat(3000));
		await send("/new");
		firstChunk.resolve({ ok: true, json: async () => ({ errcode: 0 }) });
		await delivery;
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
