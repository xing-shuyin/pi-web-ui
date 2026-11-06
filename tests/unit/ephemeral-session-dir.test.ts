import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

describe("临时会话（Ephemeral Session）临时会话目录隔离与扩展兼容", () => {
	it("为 in-memory 临时会话注入隔离临时 sessionDir，且保持 isPersisted 为 false", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-ephemeral-test-"));
		const cwd = join(base, "proj");
		const agentDir = join(base, "agent");
		const convId = "c-test-ephemeral";
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		try {
			const sessionManager = SessionManager.inMemory(cwd);
			const ephemeralDir = join(agentDir, "ephemeral-sessions", convId);
			mkdirSync(ephemeralDir, { recursive: true });
			(sessionManager as unknown as { sessionDir: string }).sessionDir = ephemeralDir;

			expect(sessionManager.getSessionDir()).toBe(ephemeralDir);
			expect(sessionManager.getSessionDir()).not.toBe("");
			expect(existsSync(sessionManager.getSessionDir())).toBe(true);

			expect(sessionManager.isPersisted()).toBe(false);

			rmSync(ephemeralDir, { recursive: true, force: true });
			expect(existsSync(ephemeralDir)).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("满足 SoL-Pi runtimeRoot 对 sessionDir 与 sessionId 的安全校验", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-solpi-test-"));
		const ephemeralDir = join(base, "ephemeral-sessions", "c1");
		mkdirSync(ephemeralDir, { recursive: true });

		try {
			const sm = SessionManager.inMemory(base);
			(sm as unknown as { sessionDir: string }).sessionDir = ephemeralDir;

			const sessionDir = sm.getSessionDir();
			if (!sessionDir) throw new Error("SoL-Pi requires a persistent Pi session directory");
			const sessionId = sm.getSessionId();
			if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(sessionId)) {
				throw new Error("SoL-Pi requires a safe Pi session id");
			}
			const solPiRoot = join(sessionDir, "sol-pi", sessionId);

			expect(solPiRoot).toContain("ephemeral-sessions");
			expect(solPiRoot).toContain(sessionId);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
