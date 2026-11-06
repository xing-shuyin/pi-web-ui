import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readPermissionFromSession } from "../../server/permission-preset.js";

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
