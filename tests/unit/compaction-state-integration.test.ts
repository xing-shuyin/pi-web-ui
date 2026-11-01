import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

let dir: string;
let file: string;
let original: Buffer;
const doneType = "pi-web-ui/compaction-done";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "compaction-state-integration-"));
	file = join(dir, "session.jsonl");
	// Preserve even noncanonical whitespace: host recovery must never reserialize SDK entries.
	writeFileSync(
		file,
		'{ "type": "session", "id": "original", "version": 3 }\n{"type":"message","message":{"role":"user","content":"keep me"}}\n',
	);
	original = readFileSync(file);
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function fixture(persisted = true, sessionFile: string | undefined = file) {
	const manager = {
		isPersisted: vi.fn(() => persisted),
		appendCustomEntry: vi.fn(),
	};
	const conv = {
		session: { sessionFile: sessionFile as string | undefined, sessionManager: manager },
		compactionState: { reason: "manual", startedAt: 1234 },
	};
	const session = Object.assign(fakeClientSession(), {
		emit: vi.fn(),
		sinks: new Set(),
		pendingNotices: [],
	});
	return { session, conv, manager };
}

function expectPersistenceWarning(session: ReturnType<typeof fixture>["session"]) {
	expect(session.emit).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({
			type: "notice",
			level: "warning",
			text: expect.stringContaining("压缩恢复状态保存失败"),
			textEn: expect.stringContaining("Failed to save compaction recovery state"),
		}),
	);
}

describe("ClientSession compaction recovery integration", () => {
	it("creates and clears the sidecar while recording the outcome only through the SDK", () => {
		const { session, conv, manager } = fixture();
		const sidecar = `${file}.compaction-state.json`;
		session.markCompactionPending(conv);
		expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual({ version: 1, reason: "manual", startedAt: 1234 });
		expect(manager.appendCustomEntry).not.toHaveBeenCalled();
		expect(readFileSync(file)).toEqual(original);
		const outcome = { status: "completed", tokensBefore: 9000, tokensAfter: 2000 };
		session.clearCompactionPending(conv, outcome);
		expect(manager.appendCustomEntry).toHaveBeenCalledExactlyOnceWith(doneType, { reason: "manual", ...outcome });
		expect(existsSync(sidecar)).toBe(false);
		// A spy-only SDK deliberately writes nothing; the host must not append or rewrite for it.
		expect(readFileSync(file)).toEqual(original);
		expect(session.emit).not.toHaveBeenCalled();
	});

	it.each(["completed", "failed", "cancelled"])(
		"lets the SDK append a %s entry before removing pending recovery state",
		(status) => {
			const { session, conv, manager } = fixture();
			const sidecar = `${file}.compaction-state.json`;
			let sdkEntry = "";
			manager.appendCustomEntry.mockImplementation((customType, data) => {
				expect(existsSync(sidecar)).toBe(true);
				expect(readFileSync(file)).toEqual(original);
				sdkEntry = `${JSON.stringify({ type: "custom", customType, data })}\n`;
				appendFileSync(file, sdkEntry);
			});
			session.markCompactionPending(conv);
			const outcome = { status, error: status === "failed" ? "model unavailable" : undefined };
			session.clearCompactionPending(conv, outcome);
			expect(manager.appendCustomEntry).toHaveBeenCalledExactlyOnceWith(doneType, { reason: "manual", ...outcome });
			expect(readFileSync(file)).toEqual(Buffer.concat([original, Buffer.from(sdkEntry)]));
			expect(existsSync(sidecar)).toBe(false);
			session.noticeInterruptedCompaction(conv);
			expect(session.emit).not.toHaveBeenCalled();
		},
	);

	it("can clear pending recovery without an outcome and without appending a transcript entry", () => {
		const { session, conv, manager } = fixture();
		session.markCompactionPending(conv);
		session.clearCompactionPending(conv);
		expect(existsSync(`${file}.compaction-state.json`)).toBe(false);
		expect(manager.appendCustomEntry).not.toHaveBeenCalled();
		expect(readFileSync(file)).toEqual(original);
	});

	it.each([false, true])(
		"consumes interrupted state once and routes the notice without changing the transcript (has sink: %s)",
		(hasSink) => {
			const { session, conv, manager } = fixture();
			session.markCompactionPending(conv);
			const restored = fixture();
			if (hasSink) restored.session.sinks.add(vi.fn());
			const notice = expect.objectContaining({
				type: "notice",
				level: "warning",
				text: expect.stringContaining("服务端重启打断"),
				textEn: expect.stringContaining("interrupted by a server restart"),
			});
			restored.session.noticeInterruptedCompaction(restored.conv);
			if (hasSink) {
				expect(restored.session.emit).toHaveBeenCalledExactlyOnceWith(notice);
				expect(restored.session.pendingNotices).toEqual([]);
			} else {
				expect(restored.session.emit).not.toHaveBeenCalled();
				expect(restored.session.pendingNotices).toEqual([notice]);
			}
			expect(existsSync(`${file}.compaction-state.json`)).toBe(false);
			// Rechecking recovery must not duplicate either emitted or queued notices.
			restored.session.noticeInterruptedCompaction(restored.conv);
			expect(restored.session.emit).toHaveBeenCalledTimes(hasSink ? 1 : 0);
			expect(restored.session.pendingNotices).toEqual(hasSink ? [] : [notice]);
			expect(manager.appendCustomEntry).not.toHaveBeenCalled();
			expect(restored.manager.appendCustomEntry).not.toHaveBeenCalled();
			expect(readFileSync(file)).toEqual(original);
		},
	);

	it.each([false, true])("does not create sidecars without a durable session (missing file: %s)", (missingFile) => {
		const { session, conv, manager } = fixture(missingFile);
		if (missingFile) conv.session.sessionFile = undefined;
		session.markCompactionPending(conv);
		session.noticeInterruptedCompaction(conv);
		session.clearCompactionPending(conv, { status: "cancelled" });
		expect(manager.appendCustomEntry).toHaveBeenCalledExactlyOnceWith(doneType, {
			reason: "manual",
			status: "cancelled",
		});
		expect(existsSync(`${file}.compaction-state.json`)).toBe(false);
		expect(readFileSync(file)).toEqual(original);
		expect(session.emit).not.toHaveBeenCalled();
	});

	it("reports sidecar creation I/O failure as a visible warning", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		// A regular file cannot be used as a parent directory on any supported OS.
		const { session, conv } = fixture(true, join(file, "nested.jsonl"));
		expect(() => session.markCompactionPending(conv)).not.toThrow();
		expectPersistenceWarning(session);
		expect(readFileSync(file)).toEqual(original);
	});

	it("retains pending state and reports failure when the SDK cannot append", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { session, conv, manager } = fixture();
		session.markCompactionPending(conv);
		const pending = readFileSync(`${file}.compaction-state.json`);
		manager.appendCustomEntry.mockImplementation(() => {
			throw new Error("SDK disk full");
		});
		expect(() => session.clearCompactionPending(conv, { status: "failed" })).not.toThrow();
		expect(manager.appendCustomEntry).toHaveBeenCalledExactlyOnceWith(doneType, { reason: "manual", status: "failed" });
		expect(readFileSync(`${file}.compaction-state.json`)).toEqual(pending);
		expect(readFileSync(file)).toEqual(original);
		expectPersistenceWarning(session);
	});

	it.each(["clearCompactionPending", "noticeInterruptedCompaction"])(
		"reports sidecar I/O failure from %s",
		(method) => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			const { session, conv } = fixture();
			// Reading/removing a directory as a state file fails without OS-specific permission tricks.
			mkdirSync(`${file}.compaction-state.json`);
			writeFileSync(join(`${file}.compaction-state.json`, "keep"), "occupied");
			expect(() => session[method](conv)).not.toThrow();
			expectPersistenceWarning(session);
			expect(readFileSync(file)).toEqual(original);
		},
	);
});
