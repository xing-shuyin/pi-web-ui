import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TelegramBotBridge } from "../../plugins/telegram/index.mjs";
import { parseCommand } from "../../plugins/telegram/channel-behavior.mjs";

let cwd: string;
function deferred<T = any>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const message = (text: string, user = 1) => ({ text, chat: { id: 1, type: "private" }, from: { id: user } });
function setup() {
	let next = 0;
	const host = {
		cwd,
		chat: vi.fn(async (_req: any) => ({ conversationId: `c${++next}`, runId: `r${next}` })),
		abortRun: vi.fn(async (_id: string) => ({ ok: true })),
		models: { list: vi.fn(async () => [{ provider: "p", id: "m" }]) },
	};
	const bridge = new TelegramBotBridge({ host, getConfig: () => ({ allowAllSenders: true }), log: vi.fn() });
	bridge.status.botUsername = "mybot";
	bridge.send = vi.fn(async () => {});
	return { bridge, host };
}
beforeEach(async () => {
	cwd = await mkdtemp(path.join(tmpdir(), "telegram-reset-"));
});
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

it.each(["/new", "/CLEAR@MyBot", "／ＲＥＳＥＴ＠ｍｙｂｏｔ"])(
	"%s resets only the issuing peer and runs its prompt verbatim",
	async (command) => {
		const { bridge, host } = setup();
		await bridge.onInboundMessage(message("old"));
		await bridge.onInboundMessage(message("other", 2));
		const oldAccount = host.chat.mock.calls[0][0].accountId;
		await bridge.onInboundMessage(message(`${command}  /literal　fullwidth content`));
		expect(host.chat.mock.calls[2][0]).toMatchObject({ text: "/literal　fullwidth content" });
		expect(host.chat.mock.calls[2][0].conversationId).toBeUndefined();
		expect(host.chat.mock.calls[2][0].accountId).not.toBe(oldAccount);
		expect(host.abortRun).toHaveBeenCalledExactlyOnceWith("r1");
		await bridge.handleRunEvent({ runId: "r1", type: "run_end", conversationId: "stale" });
		await bridge.onInboundMessage(message("follow"));
		expect(host.chat.mock.calls[3][0].conversationId).toBe("c3");
		await bridge.onInboundMessage(message("follow", 2));
		expect(host.chat.mock.calls[4][0].conversationId).toBe("c2");
	},
);

it.each(["/reset", "/stop", "/MODEL p/m", "/thinking high", "/workspace"])(
	"%s invalidates a pending receipt and its queued messages",
	async (command) => {
		const { bridge, host } = setup();
		const receipt = deferred();
		const entered = deferred();
		host.chat.mockImplementationOnce(async () => {
			entered.resolve(null);
			return receipt.promise;
		});
		const old = bridge.onInboundMessage(message("old"));
		await entered.promise;
		const queued = bridge.onInboundMessage(message("discard me"));
		await bridge.onInboundMessage(message(command === "/workspace" ? `${command} ${cwd}` : command));
		await bridge.onInboundMessage(message("fresh"));
		expect(host.chat).toHaveBeenCalledTimes(2);
		const fresh = host.chat.mock.calls[1][0];
		expect(fresh.conversationId).toBeUndefined();
		if (command !== "/stop") expect(fresh.accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
		if (command.startsWith("/MODEL")) expect(fresh.model).toBe("p/m");
		if (command.startsWith("/thinking")) expect(fresh.thinkingLevel).toBe("high");
		await bridge.handleRunEvent({ runId: "late", type: "run_end", conversationId: "stale" });
		receipt.resolve({ conversationId: "stale", runId: "late" });
		await Promise.all([old, queued]);
		expect(host.abortRun).toHaveBeenCalledWith("late");
		expect(bridge.pendingRuns.has("late")).toBe(false);
		await bridge.onInboundMessage(message("follow"));
		expect(host.chat.mock.calls[2][0].conversationId).toBe("c1");
	},
);

it.each(["/reset", "/stop", "shutdown"])(
	"%s cancels downloads and queued work without blocking fresh dispatch",
	async (command) => {
		const { bridge, host } = setup();
		const download = deferred();
		const entered = deferred();
		let signal!: AbortSignal;
		bridge.downloadMedia = vi.fn(async (_media: any, _msg: any, cancel: AbortSignal) => {
			signal = cancel;
			entered.resolve(null);
			return download.promise;
		});
		const old = bridge.onInboundMessage({ ...message("photo"), photo: [{ file_id: "x" }] });
		await entered.promise;
		const queued = bridge.onInboundMessage(message("discard"));
		if (command === "shutdown") await bridge.stop();
		else await bridge.onInboundMessage(message(command));
		expect(signal.aborted).toBe(true);
		await bridge.onInboundMessage(message("fresh"));
		expect(host.chat).toHaveBeenCalledTimes(1);
		download.resolve({ prompt: "old media", attachment: {} });
		await Promise.all([old, queued]);
		expect(host.chat).toHaveBeenCalledTimes(1);
	},
);

it("ignores a preference validation that completes after reset", async () => {
	const { bridge, host } = setup();
	const models = deferred();
	host.models.list.mockImplementationOnce(() => models.promise);
	const setting = bridge.onInboundMessage(message("/model p/m"));
	await bridge.onInboundMessage(message("/new"));
	models.resolve([{ provider: "p", id: "m" }]);
	await setting;
	await bridge.onInboundMessage(message("fresh"));
	expect(host.chat.mock.calls[0][0].model).toBeUndefined();
});

it("queries preserve the conversation and rejects commands targeting another bot", async () => {
	const { bridge, host } = setup();
	await bridge.onInboundMessage(message("old"));
	for (const command of [
		"/cwd",
		"/workspace",
		"/model",
		"/thinking",
		"/definitely_unknown",
		"/reset@someoneelse prompt",
	])
		await bridge.onInboundMessage(message(command));
	await bridge.onInboundMessage(message("follow"));
	expect(host.chat.mock.calls[1][0].conversationId).toBe("c1");
	expect(host.abortRun).not.toHaveBeenCalled();
	expect(parseCommand("／ＷＯＲＫＳＰＡＣＥ＠ＭｙＢｏｔ　C:/Mixed Case")).toEqual({
		cmd: "/cwd",
		bot: "mybot",
		value: "C:/Mixed Case",
	});
});

it("invalidates runs before abort awaits, even when abort fails", async () => {
	const { bridge, host } = setup();
	await bridge.onInboundMessage(message("old"));
	const abort = deferred();
	host.abortRun.mockImplementationOnce(() => abort.promise);
	const reset = bridge.onInboundMessage(message("/reset"));
	await bridge.handleRunEvent({ runId: "r1", type: "run_end", conversationId: "stale", text: "old reply" });
	await bridge.onInboundMessage(message("fresh"));
	abort.resolve({ ok: false, error: "abort unavailable" });
	await reset;
	expect(host.chat.mock.calls[1][0].conversationId).toBeUndefined();
	expect(vi.mocked(bridge.send).mock.calls.some((call: any[]) => call[1].includes("old reply"))).toBe(false);
	expect(vi.mocked(bridge.send).mock.calls.some((call: any[]) => call[1].includes("abort unavailable"))).toBe(true);
});
