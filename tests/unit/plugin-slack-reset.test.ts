import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackBotBridge } from "../../plugins/slack/index.mjs";

afterEach(() => vi.unstubAllGlobals());

function setup() {
	const host = {
		cwd: process.cwd(),
		chat: vi.fn<any>(async () => ({ conversationId: "actual", runId: "run" })),
		abortRun: vi.fn(async () => ({ ok: true })),
		fs: { statPath: vi.fn<any>(async () => ({ type: "dir" })) },
	};
	const bridge: any = new SlackBotBridge({ host, getConfig: () => ({ allowAllSenders: true }) });
	bridge.reply = vi.fn(async () => {});
	const send = (text: string) => bridge.onInboundEvent({ user: "u", channel: "c", channel_type: "im", text });
	const state = () => [...bridge.channelStates.values()][0] as any;
	return { host, bridge, send, state };
}

describe("Slack reset command lifecycle", () => {
	it("stops old reply chunks after reset during the first send", async () => {
		const { bridge, send } = setup();
		const sent: any[] = [];
		bridge.getConfig = () => ({ allowAllSenders: true, botToken: "test-token" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: any, init: any) => {
				sent.push(JSON.parse(init.body));
				if (sent.length === 1) await send("/reset");
				return Response.json({ ok: true });
			}),
		);
		await send("hello");
		await bridge.handleRunEvent({
			type: "message",
			runId: "run",
			message: { role: "assistant", content: "old output ".repeat(1000) },
		});
		bridge.reply = (SlackBotBridge.prototype as any).reply;
		await bridge.handleRunEvent({ type: "run_end", runId: "run" });
		expect(sent.filter((body) => body.text.includes("old output"))).toHaveLength(1);
	});
	it.each(["/new", "/clear", "／ReSeT"])("%s dispatches its literal prompt after reset", async (command) => {
		const { host, send, bridge } = setup();
		await send("/reset");
		for (const prompt of ["/model DEFAULT", "DeFaUlT", "／UNKNOWN keep CASE"]) {
			await send(command + " " + prompt);
			expect(host.chat).toHaveBeenLastCalledWith(expect.objectContaining({ text: prompt }));
			await bridge.handleRunEvent({ type: "run_end", runId: "run" });
		}
	});
	it("does not dispatch reset prompts while busy", async () => {
		const { host, send } = setup();
		await send("running");
		for (const command of ["/new", "/clear", "／RESET"]) await send(command + " do not run");
		expect(host.chat).toHaveBeenCalledTimes(1);
	});
	it.each(["/new", "/clear", "／ReSeT", "/model DEFAULT", "/thinking HIGH", "/workspace", "/cwd"])(
		"%s rotates context without dispatching",
		async (command) => {
			const { send, state, host } = setup();
			await send("/status");
			const before = { ...state() };
			await send(["/cwd", "/workspace"].includes(command) ? `${command} ${process.cwd()}` : command);
			expect(state().epoch).not.toBe(before.epoch);
			expect(state().conversationId).not.toBe(before.conversationId);
			expect(host.chat).not.toHaveBeenCalled();
		},
	);
	it("consumes fullwidth unknown commands and query commands without resetting", async () => {
		const { send, state, host, bridge } = setup();
		await send("/status");
		const epoch = state().epoch;
		for (const cmd of [
			"／WHAT",
			"／MoDeL",
			"／THINKING",
			"／CWD",
			"／WORKSPACE",
			"／HELP",
			"／STATUS",
			"／STOP",
			"／ABORT",
		])
			await send(cmd);
		expect(state().epoch).toBe(epoch);
		expect(host.chat).not.toHaveBeenCalled();
		expect(bridge.reply.mock.calls.some(([, text]: any[]) => text.includes("Unknown command"))).toBe(true);
	});
	it("rejects a workspace validation that races a new run", async () => {
		const { send, state, host } = setup();
		let finish!: (value: any) => void;
		host.fs.statPath.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
		const changing = send(`/workspace ${process.cwd()}`);
		await send("hello");
		finish({ type: "dir" });
		await changing;
		expect(state().conversationId).toBe("actual");
		expect(state().cwd).toBeUndefined();
		expect(state().busy).toBe(true);
	});
	it("keeps all reset commands blocked until a dispatch receipt and run end", async () => {
		const { send, state, host, bridge } = setup();
		let finish!: (value: any) => void;
		host.chat.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
		const dispatch = send("hello");
		await Promise.resolve();
		const epoch = state().epoch;
		for (const cmd of [
			"/new",
			"/reset",
			"/clear",
			"/model DEFAULT",
			"/thinking HIGH",
			`/cwd ${process.cwd()}`,
			`/workspace ${process.cwd()}`,
		])
			await send(cmd);
		expect(state().epoch).toBe(epoch);
		await bridge.handleRunEvent({ type: "run_end", runId: "run" });
		finish({ conversationId: "actual", runId: "run" });
		await dispatch;
		await send("／RESET");
		expect(state().epoch).not.toBe(epoch);
		expect(state().conversationId).not.toBe("actual");
	});
});
