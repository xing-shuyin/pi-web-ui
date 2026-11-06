import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupOrphanedSessionDirs } from "../../server/agent-service.js";

describe("cleanupOrphanedSessionDirs 单元测试", () => {
	it("清理超过 TTL 的孤儿临时会话目录，保留活跃目录", () => {
		const tempBase = mkdtempSync(join(tmpdir(), "pi-ephemeral-test-"));
		try {
			const subRoot = join(tempBase, "subagent-sessions");
			const ephRoot = join(tempBase, "ephemeral-sessions");
			mkdirSync(subRoot, { recursive: true });
			mkdirSync(ephRoot, { recursive: true });

			const oldSub = join(subRoot, "sa-old");
			const newSub = join(subRoot, "sa-new");
			const oldEph = join(ephRoot, "eph-old");
			const newEph = join(ephRoot, "eph-new");

			mkdirSync(oldSub, { recursive: true });
			mkdirSync(newSub, { recursive: true });
			mkdirSync(oldEph, { recursive: true });
			mkdirSync(newEph, { recursive: true });

			writeFileSync(join(oldSub, "data.txt"), "hello");
			writeFileSync(join(newSub, "data.txt"), "world");

			const threeDaysAgo = (Date.now() - 3 * 24 * 3600_000) / 1000;
			utimesSync(oldSub, threeDaysAgo, threeDaysAgo);
			utimesSync(oldEph, threeDaysAgo, threeDaysAgo);

			cleanupOrphanedSessionDirs(tempBase, 24 * 3600_000);

			expect(existsSync(oldSub)).toBe(false);
			expect(existsSync(oldEph)).toBe(false);
			expect(existsSync(newSub)).toBe(true);
			expect(existsSync(newEph)).toBe(true);
		} finally {
			try {
				rmSync(tempBase, { recursive: true, force: true });
			} catch {}
		}
	});

	it("目录不存在时安全跳过无报错", () => {
		const nonExistent = join(tmpdir(), "pi-non-existent-agent-dir-" + Date.now());
		expect(() => cleanupOrphanedSessionDirs(nonExistent)).not.toThrow();
	});
});
