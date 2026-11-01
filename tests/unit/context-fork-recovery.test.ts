import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { persistContextEvidence } from "../../server/context-evidence.js";
import { calibrateSessionLeaf } from "../../server/session-branch.js";
import { fakeClientSession } from "../helpers/fake-session.js";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(first: boolean) {
	const directory = await mkdtemp(join(tmpdir(), "same-session-reask-"));
	directories.push(directory);
	const manager = SessionManager.create(directory, directory);
	const add = (text: string) => manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	if (!first) add("retained question");
	const question = add("question to replace");
	for (let i = 0; i < 8; i++) add(`abandoned ${i}`);
	const file = manager.getSessionFile()!;
	const session: any = {
		sessionManager: manager,
		sessionFile: file,
		thinkingLevel: "high",
		agent: {
			state: { model: { provider: "test", id: "selected" }, messages: manager.buildSessionContext().messages },
		},
		reload: vi.fn(async () => {}),
		clearQueue: vi.fn(),
		setThinkingLevel: vi.fn((level) => manager.appendThinkingLevelChange(level)),
	};
	const runtime = { session, fork: vi.fn(), newSession: vi.fn() };
	const target: any = {
		id: "same-conversation",
		cwd: directory,
		session,
		runtime,
		uiMessageCache: new Map(),
		msgIds: new Map(),
		userSeqByTs: new Map(),
	};
	const client: any = Object.assign(fakeClientSession(), {
		activeId: target.id,
		convs: new Map([[target.id, target]]),
		sharedModelRuntime: {},
		quiesceBlocked: () => false,
		resolveUserMessageEntryId: () => question,
		applySessionOverrides: vi.fn(),
		restoreKeyForModel: vi.fn(async () => {}),
		applySessionModel: vi.fn(async (_session, model) => manager.appendModelChange(model.provider, model.id)),
		prompt: vi.fn(async (text) => {
			add(text);
		}),
		emit: vi.fn(),
		flushSnapshot: vi.fn(),
		invalidateSessionInfos: vi.fn(),
		scheduleSessionsRefresh: vi.fn(),
	});
	return { client, target, session, runtime, manager, file, directory };
}

describe("editMessage same-session recovery", () => {
	it.each([true, false])(
		"reasks in the same SDK manager/file and preserves evidence (first question: %s)",
		async (first) => {
			const { client, target, session, runtime, manager, file, directory } = await fixture(first);
			const artifact = (await persistContextEvidence(file, "evidence kept in place"))!;
			const before = await readdir(directory);
			const sessionId = manager.getSessionId();
			await client.editMessage("message", "edited question");
			expect(client.emit.mock.calls.filter(([event]: any[]) => event.level === "error")).toEqual([]);
			expect(runtime.fork).not.toHaveBeenCalled();
			expect(runtime.newSession).not.toHaveBeenCalled();
			expect(target.session).toBe(session);
			expect(runtime.session).toBe(session);
			expect(manager.getSessionId()).toBe(sessionId);
			expect(session.sessionFile).toBe(file);
			expect(client.convs.size).toBe(1);
			expect(await readdir(directory)).toEqual(before);
			expect(await readFile(artifact, "utf8")).toBe("evidence kept in place");
			expect(client.applySessionOverrides).toHaveBeenCalledExactlyOnceWith(target);
			expect(client.applySessionModel).toHaveBeenCalledExactlyOnceWith(session, session.agent.state.model);
			expect(session.setThinkingLevel).toHaveBeenCalledWith("high");
			expect(session.agent.state.messages.map((message: any) => message.content)).toEqual(
				first ? [] : ["retained question"],
			);
			const reopened = SessionManager.open(file);
			calibrateSessionLeaf(reopened);
			expect(reopened.buildSessionContext().messages.map((message: any) => message.content)).toEqual(
				first ? ["edited question"] : ["retained question", "edited question"],
			);
			expect(reopened.buildSessionContext().model).toEqual({ provider: "test", modelId: "selected" });
			expect(reopened.buildSessionContext().thinkingLevel).toBe("high");
		},
	);
	it("keeps the explicit selection durable even if reload fails before sending", async () => {
		const { client, session, file } = await fixture(false);
		session.reload.mockRejectedValue(new Error("reload failed"));
		await client.editMessage("message", "replacement");
		expect(client.prompt).not.toHaveBeenCalled();
		const reopened = SessionManager.open(file);
		calibrateSessionLeaf(reopened);
		expect(reopened.buildSessionContext().messages.map((message: any) => message.content)).toEqual([
			"retained question",
		]);
	});
});
