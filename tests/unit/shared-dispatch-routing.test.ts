import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService } from "../../server/agent-service-daemon.js";
import { ClientSession } from "../../server/agent-service.js";
import type { ClientMessage } from "../../server/protocol.js";
import { fakeClientSession, fakeAgentService } from "../helpers/fake-session.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "shared-route-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const conv = { id: "shared", cwd, independent: false };
	const owner = fakeClientSession() as any;
	owner.convs = new Map([[conv.id, conv]]);
	owner.activeId = "other";
	owner.cwd = join(cwd, "other");
	owner.getLang = () => "en";
	owner.emit = vi.fn();
	owner.disposed = false;
	const send = vi.fn();
	const binding = { owner, conversation: conv, send, close: vi.fn() };
	const service = fakeAgentService() as any;
	service.sharedConversationTarget = () => binding;
	cleanups.push(() => binding.close());
	const dispatch = (message: ClientMessage) => service.dispatchSharedConversationMessage("viewer", message);
	return { cwd, conv, owner, send, binding, dispatch };
}
async function settle() {
	await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("shared dispatch actual routes", () => {
	it("reads and writes the shared workspace through the real FilesService and replies to viewer", async () => {
		const { cwd, owner, send, dispatch } = fixture();
		writeFileSync(join(cwd, "example.txt"), "shared content");
		expect(dispatch({ type: "read_file", path: "example.txt" })).toBe(true);
		await settle();
		expect(JSON.stringify(send.mock.calls)).toContain("shared content");
		expect(owner.emit).not.toHaveBeenCalled();
		dispatch({ type: "write_file", path: "example.txt", text: "new shared content" });
		await settle();
		dispatch({ type: "read_file", path: "example.txt" });
		await settle();
		await vi.waitFor(() => expect(JSON.stringify(send.mock.calls)).toContain("new shared content"));
		expect(owner.activeId).toBe("other");
	});
	it("runs terminal commands with captured target cwd and rejects foreign terminal identities", () => {
		const { conv, owner, dispatch, send } = fixture();
		const tm = { runCommand: vi.fn(), input: vi.fn(), has: (id: string) => id === "shared-term" };
		owner.getTerminalManager = vi.fn(() => tm);
		dispatch({
			type: "run_command",
			terminalId: "new-term",
			command: { name: "pwd", command: "pwd" },
			cols: 80,
			rows: 24,
		});
		expect(tm.runCommand).toHaveBeenCalledWith("new-term", { name: "pwd", command: "pwd" }, 80, 24, conv.cwd);
		dispatch({ type: "terminal_input", terminalId: "foreign", data: "danger" });
		dispatch({ type: "terminal_input", terminalId: "shared-term", conversationId: "other", data: "danger" });
		expect(tm.input).not.toHaveBeenCalled();
		expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "notice", level: "error" }));
		expect(owner.activeId).toBe("other");
	});
	it("routes goals, wizard, prefs, preset and lifecycle explicitly without activation", async () => {
		const { owner, conv, dispatch } = fixture();
		for (const method of [
			"setGoal",
			"clearGoal",
			"startGoalWizard",
			"setGoalPrefs",
			"applyPreset",
			"persistConversation",
			"dismissConversation",
		])
			owner[method] = vi.fn().mockResolvedValue(undefined);
		dispatch({ type: "set_goal", goal: "goal", maxRounds: 3, locked: false });
		dispatch({ type: "clear_goal" });
		dispatch({ type: "start_goal_wizard", text: "survey" });
		dispatch({ type: "set_goal_prefs", maxRounds: 3 });
		dispatch({ type: "apply_preset", name: "preset" });
		dispatch({ type: "persist_conversation", id: conv.id });
		dispatch({ type: "dismiss_conversation", id: "other" });
		expect(owner.setGoal.mock.calls[0][2]).toBe(conv);
		expect(owner.clearGoal).toHaveBeenCalledWith(conv);
		expect(owner.startGoalWizard.mock.calls[0][2]).toBe(conv);
		expect(owner.setGoalPrefs.mock.calls[0][1]).toBe(conv);
		expect(owner.applyPreset).toHaveBeenCalledWith("preset", conv);
		expect(owner.persistConversation).toHaveBeenCalledWith(conv.id);
		expect(owner.dismissConversation).not.toHaveBeenCalled();
		expect(owner.activeId).toBe("other");
		await settle();
	});
	it("catches synchronous and asynchronous route failures and leaves global settings available", async () => {
		const { owner, dispatch, send } = fixture();
		owner.setModel = vi.fn().mockRejectedValue(new Error("model failed"));
		owner.abortBash = vi.fn(() => {
			throw new Error("bash failed");
		});
		dispatch({ type: "set_model", modelId: "provider/model" });
		dispatch({ type: "abort_bash" });
		await settle();
		expect(JSON.stringify(send.mock.calls)).toContain("model failed");
		expect(JSON.stringify(send.mock.calls)).toContain("bash failed");
		expect(dispatch({ type: "get_settings" })).toBe(false);
		expect(dispatch({ type: "question_answer", id: "q", answers: [] })).toBe(false);
	});
});
