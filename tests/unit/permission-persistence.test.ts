import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendModeEntry, MODE_ENTRY_TYPES, readPermissionFromSession } from "../../server/permission-preset.js";

describe("Conversation Permission Persistence", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "perm-test-"));
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	it("returns undefined when session has no permission entry", () => {
		const sm = SessionManager.create(tempDir);
		expect(readPermissionFromSession(sm)).toBeUndefined();
	});

	it("persists and restores permission preset across reload", () => {
		const sm = SessionManager.create(tempDir);
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
		sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as any);

		const sessionFile = sm.getSessionFile();
		expect(sessionFile).toBeDefined();

		sm.appendCustomEntry("permission/preset", { preset: "danger-full-access" });

		expect(readPermissionFromSession(sm)).toBe("danger-full-access");

		const reopened = SessionManager.open(sessionFile!);
		expect(readPermissionFromSession(reopened)).toBe("danger-full-access");
	});

	it("restores the latest permission when switched multiple times", () => {
		const sm = SessionManager.create(tempDir);
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
		sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as any);

		const sessionFile = sm.getSessionFile();

		sm.appendCustomEntry("permission/preset", { preset: "danger-full-access" });
		sm.appendCustomEntry("permission/preset", { preset: "read-only" });
		sm.appendCustomEntry("permission/preset", { preset: "danger-full-access" });

		const reopened = SessionManager.open(sessionFile!);
		expect(readPermissionFromSession(reopened)).toBe("danger-full-access");
	});
});

describe("appendModeEntry：写结果三态（issues #968）", () => {
	it("写进转录 = ok，且能沿叶链读回", () => {
		const dir = mkdtempSync(join(tmpdir(), "perm-entry-"));
		const sm = SessionManager.create(dir);
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
		expect(appendModeEntry(sm, MODE_ENTRY_TYPES.permission, { preset: "read-only" })).toBe("ok");
		expect(readPermissionFromSession(sm)).toBe("read-only");
		rmSync(dir, { recursive: true, force: true });
	});

	it("没有 sessionManager / 写不进去 = failed（调用方必须保持旧值）", () => {
		expect(appendModeEntry(undefined, MODE_ENTRY_TYPES.plan, { enabled: true })).toBe("failed");
		expect(
			appendModeEntry(
				{
					appendCustomEntry: () => {
						throw new Error("disk full");
					},
					isPersisted: () => true,
				},
				MODE_ENTRY_TYPES.plan,
				{ enabled: true },
			),
		).toBe("failed");
	});

	it("未落盘的会话 = transient（不报错，但也不宣称已保存）", () => {
		expect(
			appendModeEntry({ appendCustomEntry: () => {}, isPersisted: () => false }, MODE_ENTRY_TYPES.delegate, {
				enabled: true,
			}),
		).toBe("transient");
	});
});
