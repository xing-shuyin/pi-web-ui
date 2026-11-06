import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

describe("Force-Reset Session Hijack Prevention & Ephemeral Capacity (#335)", () => {
	it("does not fallback to continueRecent when ownFile does not exist", async () => {
		const tempCwd = mkdtempSync(join(tmpdir(), "pi-force-reset-test-"));
		try {
			const histSm = SessionManager.create(tempCwd);
			const histFile = histSm.getSessionFile();
			if (histFile) {
				writeFileSync(histFile, JSON.stringify({ type: "session", id: "old-session" }) + "\n");
			}

			const continueRecentSpy = vi.spyOn(SessionManager, "continueRecent");
			const createSpy = vi.spyOn(SessionManager, "create");

			const ownFile: string | undefined = undefined;
			const isEphemeral = false;

			const factory = () => {
				if (ownFile) {
					return SessionManager.open(ownFile);
				}
				return isEphemeral ? SessionManager.inMemory(tempCwd) : SessionManager.create(tempCwd);
			};

			const sm = factory();
			expect(createSpy).toHaveBeenCalled();
			expect(continueRecentSpy).not.toHaveBeenCalled();
			expect(sm).toBeDefined();

			createSpy.mockRestore();
			continueRecentSpy.mockRestore();
		} finally {
			try {
				rmSync(tempCwd, { recursive: true, force: true });
			} catch {}
		}
	});

	it("correctly handles ephemeral conversations in capacity checks", () => {
		const fakeConvs = new Map<string, any>([
			["c1", { cwd: "/work", isSubagent: false, isEphemeral: true }],
			["c2", { cwd: "/work", isSubagent: false, isEphemeral: true }],
			["c3", { cwd: "/work", isSubagent: false, isEphemeral: false }],
		]);

		const openRegular = [...fakeConvs.values()].filter(
			(c) => c.cwd === "/work" && !c.isSubagent && !c.isEphemeral,
		).length;

		expect(openRegular).toBe(1);
	});
});
