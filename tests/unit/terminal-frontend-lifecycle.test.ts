import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { _chatReducerForTest as reduce, type ChatState, type TerminalMeta } from "../../web/src/use-chat";
import { makeTerminalBridge } from "../../web/src/terminal-bridge";

const source = (path: string) => readFileSync(new URL(`../../web/src/${path}`, import.meta.url), "utf8");
const chatSource = source("use-chat.ts");
const termSource = source("components/TermXterm.tsx");
const execute = (code: string, context: Record<string, unknown>) =>
	runInNewContext(stripTypeScriptTypes(code), context);
const meta = (id: string, extra: Partial<TerminalMeta> = {}): TerminalMeta => ({
	id,
	title: id,
	cwd: "/test",
	cols: 80,
	rows: 24,
	running: true,
	exitCode: null,
	conversationId: "a",
	ownerKind: "client",
	...extra,
});
const state = (terminals: TerminalMeta[] = []): ChatState => ({ activeConversationId: "a", terminals }) as ChatState;

describe("terminal frontend lifecycle", () => {
	it.each([true, false])("mount only attaches existing terminals (running=%s)", (running) => {
		const send = vi.fn();
		const begin = termSource.indexOf("const raf = requestAnimationFrame(");
		const end = termSource.indexOf("const onData =", begin);
		execute(termSource.slice(begin, end), {
			requestAnimationFrame: (fn: () => void) => fn(),
			fit: { fit() {} },
			appSend: send,
			terminalId: "existing",
			routeConversationId: "a",
			ownerKind: "conversation",
			running,
			command: { command: "dangerous-rerun" },
			term: { cols: 100, rows: 30 },
		});
		expect(send.mock.calls.map(([m]) => m)).toEqual([
			{
				type: "terminal_attach",
				terminalId: "existing",
				conversationId: "a",
				ownerKind: "conversation",
				cols: 100,
				rows: 30,
			},
		]);
		expect(termSource).not.toMatch(/type: "(?:terminal_create|run_command|terminal_kill)"/);
	});

	it.each([false, true])("central creation sends a new draft once (command=%s)", (command) => {
		const draft = meta("new", command ? { command: { name: "test", command: "echo test", cwd: "/test" } } : {});
		const send = vi.fn((_message: unknown) => true);
		const dispatch = vi.fn();
		const chatApi = { current: { chat: { ready: true, terminals: [] as TerminalMeta[] } } };
		const begin = chatSource.indexOf("const terminalCreate = useCallback(");
		const end = chatSource.indexOf("const terminalClose =", begin);
		const create = execute(`${chatSource.slice(begin, end)}\nterminalCreate;`, {
			useCallback: (fn: unknown) => fn,
			chatApi,
			send,
			dispatch,
			readUiLocale: () => "en",
		}) as (m: TerminalMeta) => void;
		create(draft);
		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0][0]).toMatchObject({
			type: command ? "run_command" : "terminal_create",
			ownerKind: "client",
		});
		chatApi.current.chat.terminals = [draft];
		create(draft);
		expect(send).toHaveBeenCalledOnce();
		expect(dispatch).toHaveBeenCalledOnce();
	});

	it("authoritative lists remove missing entries and restore stopped history beside live tabs", () => {
		const next = reduce(state([meta("missing"), meta("live")]), {
			type: "terminal_list",
			conversationId: "a",
			terminals: [meta("live"), meta("history", { running: false, exitCode: 0 })],
		});
		expect(next.terminals.map((t) => t.id)).toEqual(["live", "history"]);
		expect(reduce(next, { type: "terminal_list", conversationId: "a", terminals: [] }).terminals).toEqual([]);
	});

	it("retains authoritative owner metadata without inferring ownership from agentBash", () => {
		const next = reduce(state(), {
			type: "terminal_list",
			conversationId: "other",
			terminals: [
				meta("client", { agentBash: true }),
				meta("ordinary-agent", { ownerKind: "conversation", agentBash: false }),
			],
		});
		expect(next.terminals.map((t) => t.id)).toEqual(["client", "ordinary-agent"]);
		expect(next.terminals.filter((terminal) => terminal.ownerKind === "client").map((terminal) => terminal.id)).toEqual(
			["client"],
		);
		expect(
			reduce(state(), {
				type: "terminal_list",
				conversationId: "a",
				terminals: [meta("ordinary-agent", { ownerKind: "conversation" })],
			}).terminals,
		).toHaveLength(1);
	});

	it("retains a target CLI list arriving before the conversation snapshot", () => {
		const next = reduce(state(), {
			type: "terminal_list",
			conversationId: "target-cli",
			terminals: [
				meta("native", { ownerKind: "conversation", nativeCli: { preset: "claude" } }),
				meta("unrelated-tool", { ownerKind: "conversation", agentBash: true }),
			],
		});
		expect(next.terminals.map((terminal) => terminal.id)).toEqual(["native", "unrelated-tool"]);
		expect(next.terminals[0].conversationId).toBe("target-cli");
	});
	it("exit and remove actions cannot affect another owner with the same ID", () => {
		const initial = state([meta("same"), meta("same", { ownerKind: "conversation" })]);
		const next = reduce(initial, {
			type: "terminal_exit",
			terminalId: "same",
			conversationId: "a",
			ownerKind: "conversation",
			exitCode: 2,
		});
		expect(next.terminals.map((t) => t.running)).toEqual([true, false]);
		expect(reduce(next, { type: "terminal_remove", id: "same", ownerKind: "client" }).terminals).toEqual([
			next.terminals[1],
		]);
	});

	it("isolates live and retained output across owners and conversations while client output follows switches", () => {
		const bridge = makeTerminalBridge();
		const display = () => ({ write: vi.fn(), reset: vi.fn(), dispose() {} });
		const client = display(),
			a = display(),
			b = display();
		bridge.register("old", "same", client, "client");
		bridge.register("a", "same", a, "conversation");
		bridge.register("b", "same", b, "conversation");
		bridge.write("new", "same", "client", true, "client");
		bridge.write("a", "same", "a", true, "conversation");
		expect(client.write).toHaveBeenCalledExactlyOnceWith("client");
		expect(a.write).toHaveBeenCalledExactlyOnceWith("a");
		expect(b.write).not.toHaveBeenCalled();
		const late = display();
		bridge.register("b", "same", late, "conversation");
		expect(late.write).not.toHaveBeenCalled();
		bridge.reconcile("a", [{ id: "same", ownerKind: "conversation" }]);
		const removed = display();
		bridge.register("any", "same", removed, "client");
		expect(removed.write).not.toHaveBeenCalled();
		const replay = display();
		bridge.register("a", "same", replay, "conversation");
		expect(replay.write).toHaveBeenCalledExactlyOnceWith("a");
	});
});
