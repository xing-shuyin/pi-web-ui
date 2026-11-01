import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApprovalAuditLogger, sanitizeAuditParams } from "../../server/approval-audit.js";

describe("审批决策审计日志 (ApprovalAuditLogger - Issue #722)", () => {
	let tempDir: string;
	let logger: ApprovalAuditLogger;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "audit-test-"));
		logger = new ApprovalAuditLogger(tempDir);
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	it("正常追加结构化审计日志", () => {
		logger.record({
			conversationId: "conv-1",
			toolName: "bash",
			params: { command: "rm -rf ./build" },
			decision: "approved",
			decisionSource: "user_dialog",
			scope: "category",
			categoryId: "bash.rm-rf",
			reason: "用户批准删除构建目录",
		});

		expect(existsSync(logger.getFilePath())).toBe(true);
		const entries = logger.readRecentEntries(10);
		expect(entries.length).toBe(1);
		expect(entries[0].toolName).toBe("bash");
		expect(entries[0].decision).toBe("approved");
		expect(entries[0].decisionSource).toBe("user_dialog");
		expect(entries[0].scope).toBe("category");
		expect(entries[0].categoryId).toBe("bash.rm-rf");
		expect(entries[0].isoTime).toBeDefined();
		expect(entries[0].timestamp).toBeGreaterThan(0);
	});

	it("记录多种决策来源（静默放行、规则阻断、批量放行）", () => {
		logger.record({
			conversationId: "conv-2",
			toolName: "bash",
			params: { command: "npm test" },
			decision: "approved",
			decisionSource: "suppressed_disabled",
			reason: "全局审批关闭放行",
		});

		logger.record({
			conversationId: "conv-2",
			toolName: "write",
			params: { path: ".env" },
			decision: "denied",
			decisionSource: "rule_denied",
			categoryId: "file.sensitive.env",
			reason: "命中敏感配置文件阻断规则",
		});

		const entries = logger.readRecentEntries(10);
		expect(entries.length).toBe(2);
		expect(entries[0].decisionSource).toBe("suppressed_disabled");
		expect(entries[1].decision).toBe("denied");
		expect(entries[1].decisionSource).toBe("rule_denied");
	});

	it("参数过长时自动摘录与截断，防止塞满磁盘", () => {
		const hugeString = "a".repeat(5000);
		const sanitized = sanitizeAuditParams({ code: hugeString, normal: "ok" }) as Record<string, string>;

		expect(sanitized.code.length).toBeLessThan(1200);
		expect(sanitized.code).toContain("[truncated 5000 chars]");
		expect(sanitized.normal).toBe("ok");
	});
});
