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
		} catch {
			// ignore cleanup error
		}
	});

	it("returns undefined when session has no permission entry", () => {
		const sm = SessionManager.create(tempDir);
		expect(readPermissionFromSession(sm)).toBeUndefined();
	});

	it("persists and restores permission preset across reload", () => {
		const sm = SessionManager.create(tempDir);
		// Pi SessionManager flushes entries to file once the first assistant response arrives
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
		sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as any);

		const sessionFile = sm.getSessionFile();
		expect(sessionFile).toBeDefined();

		// Simulate user switching permission to danger-full-access
		sm.appendCustomEntry("permission/preset", { preset: "danger-full-access" });

		// Read back from the same manager
		expect(readPermissionFromSession(sm)).toBe("danger-full-access");

		// Open afresh from file (simulating project switch or session reopen)
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
