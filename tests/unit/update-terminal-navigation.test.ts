import { describe, expect, it, vi } from "vitest";

describe("update terminal navigation & selection (#832)", () => {
	it("skips auto shell creation when skipAutoCreate is requested", () => {
		const createShell = vi.fn().mockReturnValue(true);
		const setView = vi.fn();
		const setDrawer = vi.fn();
		const terminalOpenRequested = { current: false };
		const terminals: any[] = [];

		const handleViewChange = (v: string, opts?: { skipAutoCreate?: boolean }) => {
			if (opts?.skipAutoCreate) {
				terminalOpenRequested.current = false;
			} else {
				terminalOpenRequested.current = v === "terminal" && terminals.length === 0;
				if (terminalOpenRequested.current && createShell()) {
					terminalOpenRequested.current = false;
				}
			}
			setView(v);
			setDrawer(null);
		};

		// 1. Regular click on terminal view with 0 terminals: should create shell
		handleViewChange("terminal");
		expect(createShell).toHaveBeenCalledTimes(1);
		expect(setView).toHaveBeenCalledWith("terminal");

		createShell.mockClear();
		setView.mockClear();

		// 2. Jump from update with skipAutoCreate: should NOT create regular shell
		handleViewChange("terminal", { skipAutoCreate: true });
		expect(createShell).not.toHaveBeenCalled();
		expect(terminalOpenRequested.current).toBe(false);
		expect(setView).toHaveBeenCalledWith("terminal");
	});

	it("selects target terminal and requests skipAutoCreate on runUpdate (fresh terminal)", () => {
		const created: any[] = [];
		const selected: string[] = [];
		const viewChanges: Array<{ view: string; opts?: { skipAutoCreate?: boolean } }> = [];

		const terminal = {
			create: vi.fn((meta: any) => created.push(meta)),
			restart: vi.fn(),
			select: vi.fn((id: string) => selected.push(id)),
		};
		const onViewChange = vi.fn((view: string, opts?: { skipAutoCreate?: boolean }) => {
			viewChanges.push({ view, opts });
		});

		// Emulate runUpdate logic with empty terminals
		const chat = { ready: true, terminals: [] as any[], activeConversationId: "conv-1", state: { cwd: "/cwd" } };
		const title = "系统更新";
		const cmd = { name: title, command: "npm i -g pi-web-ui@latest", cwd: "${pwd}" };
		const existing = chat.terminals.find((tm) => tm.title === title);
		const targetId = existing ? existing.id : "test-new-id";

		if (existing) {
			terminal.restart(existing.id);
		} else {
			terminal.create({
				id: targetId,
				conversationId: chat.activeConversationId,
				title,
				cwd: chat.state.cwd,
				cols: 80,
				rows: 24,
				running: true,
				exitCode: null,
				command: cmd,
			});
		}
		terminal.select?.(targetId);
		onViewChange("terminal", { skipAutoCreate: true });

		expect(terminal.create).toHaveBeenCalledOnce();
		expect(terminal.restart).not.toHaveBeenCalled();
		expect(terminal.select).toHaveBeenCalledWith("test-new-id");
		expect(onViewChange).toHaveBeenCalledWith("terminal", { skipAutoCreate: true });
	});

	it("restarts and selects existing terminal on runUpdate reuse", () => {
		const existingTerm = { id: "existing-update-id", title: "系统更新", conversationId: "conv-1" };
		const chat = {
			ready: true,
			terminals: [existingTerm],
			activeConversationId: "conv-1",
			state: { cwd: "/cwd" },
		};
		const restart = vi.fn();
		const select = vi.fn();
		const onViewChange = vi.fn();
		const appSend = vi.fn();

		const title = "系统更新";
		const cmd = { name: title, command: "npm i -g pi-web-ui@latest", cwd: "${pwd}" };
		const existing = chat.terminals.find((tm) => tm.title === title);
		const targetId = existing ? existing.id : "new-id";

		if (existing) {
			restart(existing.id);
			appSend({
				type: "run_command",
				terminalId: existing.id,
				conversationId: existing.conversationId,
				command: cmd,
				cols: 80,
				rows: 24,
			});
		}
		select(targetId);
		onViewChange("terminal", { skipAutoCreate: true });

		expect(restart).toHaveBeenCalledWith("existing-update-id");
		expect(select).toHaveBeenCalledWith("existing-update-id");
		expect(appSend).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "run_command",
				terminalId: "existing-update-id",
			}),
		);
		expect(onViewChange).toHaveBeenCalledWith("terminal", { skipAutoCreate: true });
	});
});
