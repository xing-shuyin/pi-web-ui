import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { serializeMessage } from "../../server/serialize.js";
import { fakeClientSession } from "../helpers/fake-session.js";

function conversation(id: string) {
	return {
		id,
		session: {
			sessionFile: resolve(`restart-resume-${id}.jsonl`),
			isIdle: true,
			sendCustomMessage: vi.fn().mockResolvedValue(undefined),
		},
		promptInFlight: false,
		promptedSinceActive: false,
		viewOnly: true,
	};
}

function clientFor(conversations: { id: string; session: { sessionFile?: string } }[]) {
	const client: any = fakeClientSession({
		disposed: false,
		activeId: "view",
		convs: new Map(conversations.map((conv) => [conv.id, conv])),
		quiesceBlocked: vi.fn().mockReturnValue(false),
		prompt: vi.fn(),
		emit: vi.fn(),
		flushSnapshot: vi.fn(),
		emitConversations: vi.fn(),
		switchSession: vi.fn(async (file: string) => {
			client.activeId = conversations.find((conv) => conv.session.sessionFile === file)?.id;
		}),
		switchConversation: vi.fn(async (id: string) => {
			client.activeId = id;
		}),
	});
	return client;
}

function interrupted(conv: ReturnType<typeof conversation>) {
	return { title: conv.id, cwd: process.cwd(), at: 1, sessionFile: conv.session.sessionFile };
}

describe("restart continuation", () => {
	it("uses an SDK custom message that stays hidden in live and restored history", async () => {
		const taskDir = mkdtempSync(join(tmpdir(), "restart-resume-test-"));
		let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
		try {
			const services = await createAgentSessionServices({ cwd: taskDir, agentDir: taskDir });
			({ session } = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.create(taskDir, taskDir),
			}));
			const captured: any[] = [];
			vi.spyOn(session.agent, "prompt").mockImplementation(async (messages) => {
				captured.push(...(Array.isArray(messages) ? messages : [messages]));
			});
			const conv = { id: "restored", session, promptInFlight: false, viewOnly: true, promptedSinceActive: false };
			const client = clientFor([conv]);

			await client.continueResumedConversation(session.sessionFile);

			expect(client.prompt).not.toHaveBeenCalled();
			expect(captured).toHaveLength(1);
			expect(captured[0]).toMatchObject({ role: "custom", customType: "restart-resume", display: false });
			expect(serializeMessage(captured[0], 1)).toBeNull();
			expect(serializeMessage(JSON.parse(JSON.stringify(captured[0])), 1)).toBeNull();
			expect(conv.promptedSinceActive).toBe(true);
			expect(conv.viewOnly).toBe(false);
		} finally {
			session?.dispose();
			rmSync(taskDir, { recursive: true, force: true });
		}
	});

	it("starts all interrupted runs without waiting for streamed completion and restores the view", async () => {
		const first = conversation("first");
		const second = conversation("second");
		const view = conversation("view");
		const client = clientFor([first, second, view]);
		let finishFirst!: () => void;
		first.session.sendCustomMessage.mockImplementation(
			() =>
				new Promise<void>((resolveRun) => {
					finishFirst = resolveRun;
				}),
		);
		try {
			await client.resumeInterrupted([interrupted(first), interrupted(second)]);

			expect(first.session.sendCustomMessage).toHaveBeenCalledOnce();
			expect(second.session.sendCustomMessage).toHaveBeenCalledOnce();
			expect(second.session.sendCustomMessage).toHaveBeenCalledWith(
				expect.objectContaining({ customType: "restart-resume", display: false }),
				{ triggerTurn: true },
			);
			expect(client.activeId).toBe("view");
			expect(client.prompt).not.toHaveBeenCalled();
			expect(client.restartInterruptedFiles.size).toBe(0);
		} finally {
			finishFirst?.();
		}
	});

	it("keeps the restored session as the target when the user switches during reopening", async () => {
		const target = conversation("target");
		const view = conversation("view");
		const client = clientFor([target, view]);
		client.switchSession.mockImplementation(async () => {
			client.activeId = "view";
		});

		await client.resumeInterrupted([interrupted(target)]);

		expect(target.session.sendCustomMessage).toHaveBeenCalledOnce();
		expect(view.session.sendCustomMessage).not.toHaveBeenCalled();
		expect(client.switchConversation).not.toHaveBeenCalled();
		expect(client.activeId).toBe("view");
	});

	it.each(["closed", "busy", "submitting", "disposed", "quiescing"])("skips a %s session", async (state) => {
		const target = conversation("target");
		const client = clientFor([target]);
		if (state === "closed") client.convs.clear();
		if (state === "busy") target.session.isIdle = false;
		if (state === "submitting") target.promptInFlight = true;
		if (state === "disposed") client.disposed = true;
		if (state === "quiescing") client.quiesceBlocked.mockReturnValue(true);

		await client.continueResumedConversation(target.session.sessionFile);

		expect(target.session.sendCustomMessage).not.toHaveBeenCalled();
		expect(client.prompt).not.toHaveBeenCalled();
	});

	it("surfaces a failed continuation while still starting the other interrupted run", async () => {
		const first = conversation("first");
		const second = conversation("second");
		const client = clientFor([first, second]);
		first.session.sendCustomMessage.mockRejectedValue(new Error("resume failed"));

		await client.resumeInterrupted([interrupted(first), interrupted(second)]);

		expect(client.emit).toHaveBeenCalledWith(
			expect.objectContaining({ level: "error", textEn: "Error: resume failed" }),
		);
		expect(second.session.sendCustomMessage).toHaveBeenCalledOnce();
	});

	it("does not emit stale completion or failure updates after the session was replaced", async () => {
		const target = conversation("target");
		const client = clientFor([target]);
		target.session.sendCustomMessage.mockImplementation(async () => {
			target.session = conversation("replacement").session;
			throw new Error("old session failed");
		});

		await client.continueResumedConversation(target.session.sessionFile);

		expect(client.emit).not.toHaveBeenCalled();
		expect(client.flushSnapshot).not.toHaveBeenCalled();
		expect(client.emitConversations).not.toHaveBeenCalled();
	});
});
