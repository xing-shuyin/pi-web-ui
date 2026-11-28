import { mkdtempSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UniversalSession, UniversalSessionStore, MockAgentDriver } from "../../server/universal/index.js";
import type { AgentEventSink } from "../../server/universal/driver-base.js";
import type { ConversationSummary, ServerMessage } from "../../server/protocol.js";
import { diffStreamingCues } from "../../web/src/streaming-cues.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function controlledDriver(cwd: string) {
	const driver = new MockAgentDriver(cwd);
	const started = deferred();
	const done = deferred();
	let sink!: AgentEventSink;
	const abort = vi.spyOn(driver, "abort").mockImplementation(async () => {
		done.resolve();
	});
	vi.spyOn(driver, "sendPrompt").mockImplementation(async (_prompt, _attachments, events) => {
		sink = events;
		started.resolve();
		await done.promise;
	});
	return {
		driver,
		abort,
		started: started.promise,
		sink: () => sink,
		finish: () => {
			sink.onTurnComplete();
			done.resolve();
		},
	};
}

function latestConversations(frames: ServerMessage[]): ConversationSummary[] {
	const frame = [...frames]
		.reverse()
		.find((item): item is Extract<ServerMessage, { type: "conversations" }> => item.type === "conversations");
	return frame?.conversations ?? [];
}

describe("UniversalSession concurrent conversations", () => {
	let dir: string;
	let sessions: UniversalSession[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "universal-concurrent-"));
		sessions = [];
	});

	afterEach(async () => {
		for (const session of sessions) session.dispose();
		await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});

	function makeSession(cwd: string, driver: MockAgentDriver, driverFactory?: (cwd: string) => MockAgentDriver) {
		const frames: ServerMessage[] = [];
		const session = new UniversalSession({
			clientId: "concurrent-test",
			cwd,
			dataDir: dir,
			agentDir: dir,
			store: new UniversalSessionStore(dir),
			driver,
			driverFactory,
			send: (frame) => frames.push(structuredClone(frame)),
		});
		sessions.push(session);
		return { session, frames };
	}

	it("keeps the old conversation running and does not emit a completion cue when switching away", async () => {
		const first = controlledDriver(dir);
		const second = controlledDriver(dir);
		const { session, frames } = makeSession(dir, first.driver, () => second.driver);
		const firstPrompt = session.prompt("first task");
		await first.started;
		const firstId = session.activeConversationId();
		const before = latestConversations(frames);
		const previousMap = new Map(before.map((conv) => [conv.id, !!conv.isStreaming]));

		await session.newChat();
		const secondId = session.activeConversationId();
		const afterSwitch = latestConversations(frames);
		expect(afterSwitch.find((conv) => conv.id === firstId)?.isStreaming).toBe(true);
		expect(Boolean(afterSwitch.find((conv) => conv.id === secondId)?.isStreaming)).toBe(false);
		expect(diffStreamingCues(previousMap, secondId, false, afterSwitch, firstId).finishedConvs).toEqual([]);
		expect(first.abort).not.toHaveBeenCalled();

		const secondPrompt = session.prompt("second task");
		await second.started;
		expect(latestConversations(frames).find((conv) => conv.id === firstId)?.isStreaming).toBe(true);
		expect(latestConversations(frames).find((conv) => conv.id === secondId)?.isStreaming).toBe(true);
		expect(first.abort).not.toHaveBeenCalled();

		first.sink().onTextDelta("first answer");
		second.sink().onTextDelta("second answer");
		first.sink().onTextDelta(" first continuation");
		const deltas = frames.filter(
			(frame): frame is Extract<ServerMessage, { type: "message_delta" }> => frame.type === "message_delta",
		);
		expect(deltas.filter((frame) => frame.conversationId === firstId).map((frame) => frame.seq)).toEqual([1, 2]);
		expect(deltas.filter((frame) => frame.conversationId === secondId).map((frame) => frame.seq)).toEqual([1]);
		second.finish();
		await secondPrompt;
		expect(latestConversations(frames).find((conv) => conv.id === firstId)?.isStreaming).toBe(true);
		expect(latestConversations(frames).find((conv) => conv.id === secondId)?.isStreaming).toBe(false);
		expect(first.abort).not.toHaveBeenCalled();

		await session.switchConversation(firstId);
		expect(session.isStreaming).toBe(true);
		first.finish();
		await firstPrompt;
		expect(session.isStreaming).toBe(false);
	});

	it("does not interrupt a running conversation when switching projects", async () => {
		const otherDir = join(dir, "other-project");
		mkdirSync(otherDir);
		const first = controlledDriver(dir);
		const second = controlledDriver(otherDir);
		const { session } = makeSession(dir, first.driver, () => second.driver);
		const firstPrompt = session.prompt("long task");
		await first.started;

		await session.setCwd(otherDir);
		expect(first.abort).not.toHaveBeenCalled();
		expect((first.driver as any).cwd).toBe(dir);
		expect((second.driver as any).cwd).toBe(otherDir);
		expect(session.activeConversations()).toBe(1);
		const secondPrompt = session.prompt("other project task");
		await second.started;
		expect(session.activeConversations()).toBe(2);
		expect(first.abort).not.toHaveBeenCalled();

		second.finish();
		await secondPrompt;
		expect(session.activeConversations()).toBe(1);
		first.finish();
		await firstPrompt;
	});

	it("stopping the active conversation leaves background generation running", async () => {
		const first = controlledDriver(dir);
		const second = controlledDriver(dir);
		const { session } = makeSession(dir, first.driver, () => second.driver);
		const firstPrompt = session.prompt("background task");
		await first.started;
		const firstId = session.activeConversationId();
		await session.newChat();
		const secondPrompt = session.prompt("active task");
		await second.started;

		await session.abort();
		await secondPrompt;
		expect(second.abort).toHaveBeenCalledTimes(1);
		expect(first.abort).not.toHaveBeenCalled();
		expect(session.activeConversations()).toBe(1);

		await session.switchConversation(firstId);
		expect(session.isStreaming).toBe(true);
		first.finish();
		await firstPrompt;
	});

	it("switching to a finished conversation while another is running routes new prompts to the finished conversation", async () => {
		const store = new UniversalSessionStore(dir);
		const first = controlledDriver(dir);
		const second = controlledDriver(dir);
		const secondResume = vi.spyOn(second.driver, "resumeSession");
		const firstPromptSpy = first.driver.sendPrompt as ReturnType<typeof vi.fn>;
		const secondPromptSpy = second.driver.sendPrompt as ReturnType<typeof vi.fn>;

		const frames: ServerMessage[] = [];
		const session = new UniversalSession({
			clientId: "concurrent-test",
			cwd: dir,
			dataDir: dir,
			agentDir: dir,
			store,
			driver: first.driver,
			driverFactory: () => second.driver,
			send: (frame) => frames.push(structuredClone(frame)),
		});
		sessions.push(session);

		const finishedId = "uconv-finished-b";
		await store.saveConversation(dir, {
			id: finishedId,
			cwd: dir,
			engine: "claude",
			title: "Finished B",
			driverSessionId: "sid-finished-b",
			createdAt: 1000,
			updatedAt: 1000,
			messages: [
				{ id: "u-old", role: "user", content: [{ type: "text", text: "old question" }], timestamp: 1000 },
				{ id: "a-old", role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: 1001 },
			],
		});

		const runningId = session.activeConversationId();
		const runningTurn = session.prompt("task on A");
		await first.started;

		await session.switchSession(finishedId);
		expect(session.activeConversationId()).toBe(finishedId);
		expect(session.isStreaming).toBe(false);
		expect(first.abort).not.toHaveBeenCalled();

		const bTurn = session.prompt("follow-up on B");
		await second.started;

		expect(session.activeConversations()).toBe(2);
		expect(secondResume).toHaveBeenCalledWith("sid-finished-b");
		expect(secondPromptSpy).toHaveBeenCalledWith("follow-up on B", expect.anything(), expect.anything());
		expect(firstPromptSpy).toHaveBeenCalledTimes(1);
		expect(firstPromptSpy).not.toHaveBeenCalledWith("follow-up on B", expect.anything(), expect.anything());
		expect(session.getMessagesOfConversation(runningId)?.map((m) => m.content)).not.toContainEqual([
			{ type: "text", text: "follow-up on B" },
		]);
		expect(
			session
				.getMessagesOfConversation(finishedId)
				?.some((m) => m.content.some((b) => b.type === "text" && b.text === "follow-up on B")),
		).toBe(true);

		second.finish();
		await bTurn;
		first.finish();
		await runningTurn;
	});
});
