import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TerminalManager } from "../../server/terminals.js";
import { handleTerminalMessage } from "../../server/dispatch-domain-handlers.js";
import type { DispatchSession } from "../../server/engine-service.js";
import type { ServerMessage } from "../../server/protocol.js";

describe("terminal attachment and ownership", () => {
	it("attaches live/history without spawning, writing input or restarting", () => {
		const messages: ServerMessage[] = [];
		const manager = new TerminalManager((m) => messages.push(m), tmpdir(), undefined, "client");
		const write = vi.fn();
		const kill = vi.fn();
		const resize = vi.fn();
		const entry = {
			id: "same",
			pty: { write, kill, resize },
			cols: 80,
			rows: 24,
			exited: false,
			output: "retained",
			pendingOut: "last",
			flushTimer: null,
		};
		(manager as any).terms.set("same", entry);
		expect(manager.attach("same", 100, 30)).toBe(true);
		expect(resize).toHaveBeenCalledWith(100, 30);
		expect(write).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
		expect(messages.at(-1)).toEqual({
			type: "terminal_output",
			terminalId: "same",
			data: "retained",
			reset: true,
			ownerKind: "client",
		});
		entry.exited = true;
		(manager as any).terms.delete("same");
		(manager as any).history.set("same", entry);
		expect(manager.attach("same", 80, 24)).toBe(true);
		expect(resize).toHaveBeenCalledTimes(1);
		expect(manager.attach("missing", 80, 24)).toBe(false);
		expect(write).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
	});
	it("tags ordinary conversation terminal separately from its purpose", () => {
		const manager = new TerminalManager(() => {}, tmpdir());
		(manager as any).terms.set("agent", {
			id: "agent",
			title: "Agent",
			cwd: tmpdir(),
			cols: 80,
			rows: 24,
			exited: false,
			exitCode: null,
			agentBash: false,
		});
		expect(manager.list()[0]).toMatchObject({ ownerKind: "conversation", agentBash: false });
	});
	it("refreshes new-spawn project boundary without changing existing terminal ownership", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-terminal-root-"));
		const first = join(root, "a"),
			second = join(root, "b");
		mkdirSync(first);
		mkdirSync(second);
		let cwd = first;
		try {
			const manager = new TerminalManager(
				() => {},
				() => cwd,
				undefined,
				"client",
			);
			const safe = (path: string) => (manager as any).safeCwd(path);
			expect(safe(first)).toBe(first);
			expect(safe(second)).toBeNull();
			cwd = second;
			expect(safe(second)).toBe(second);
			expect(safe(first)).toBeNull();
			expect(safe(root)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("dispatches attach and input using explicit owner, without creation", () => {
		const attach = vi.fn(),
			create = vi.fn(),
			runCommand = vi.fn(),
			input = vi.fn();
		const findTerminalManager = vi.fn(() => ({ attach, create, runCommand, input }));
		const cs = { findTerminalManager } as unknown as DispatchSession;
		expect(
			handleTerminalMessage(
				{
					type: "terminal_attach",
					terminalId: "same",
					conversationId: "conv",
					ownerKind: "conversation",
					cols: 100,
					rows: 30,
				},
				cs,
			),
		).toBe(true);
		expect(findTerminalManager).toHaveBeenLastCalledWith("same", "conv", "conversation");
		expect(attach).toHaveBeenCalledWith("same", 100, 30);
		expect(create).not.toHaveBeenCalled();
		expect(runCommand).not.toHaveBeenCalled();
		handleTerminalMessage(
			{ type: "terminal_input", terminalId: "same", conversationId: "conv", ownerKind: "client", data: "x" },
			cs,
		);
		expect(findTerminalManager).toHaveBeenLastCalledWith("same", "conv", "client");
		expect(input).toHaveBeenCalledWith("same", "x");
	});
});
