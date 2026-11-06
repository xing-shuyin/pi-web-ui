import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BUILTIN_UI_ITEMS } from "../../web/src/ui-slots.js";

describe("persist conversation / solidify subagent", () => {
	it("contextmenu.session 中包含 host:conv-persist 内置条目", () => {
		const item = BUILTIN_UI_ITEMS.find((x) => x.id === "host:conv-persist");
		expect(item).toBeDefined();
		expect(item?.slot).toBe("contextmenu.session");
		expect(item?.labelKey).toBe("persistSubagent");
		expect(item?.icon).toBe("save");
	});

	it("将 inMemory 会话固化到磁盘后，原有消息全部保留且后续消息能持续追加写盘", () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-persist-test-"));
		try {
			const sm = SessionManager.inMemory(tmp);
			expect(sm.isPersisted()).toBe(false);
			expect(sm.getSessionFile()).toBeUndefined();

			sm.appendMessage({
				role: "user",
				content: [{ type: "text", text: "请分析代码" }],
				timestamp: new Date().toISOString(),
			} as never);
			sm.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "分析结果如下..." }],
				timestamp: new Date().toISOString(),
			} as never);

			const sessionDir = join(tmp, ".pi", "sessions");
			const sessionFile = join(sessionDir, "persisted-session.jsonl");

			const entries = (sm as unknown as { fileEntries: unknown[] }).fileEntries;
			const lines = entries.map((e: unknown) => JSON.stringify(e)).join("\n") + "\n";
			const fs = require("node:fs");
			fs.mkdirSync(sessionDir, { recursive: true });
			fs.writeFileSync(sessionFile, lines, "utf8");

			sm.setSessionFile(sessionFile);
			(sm as unknown as { sessionDir: string }).sessionDir = sessionDir;
			(sm as unknown as { persist: boolean }).persist = true;
			(sm as unknown as { flushed: boolean }).flushed = true;

			expect(sm.isPersisted()).toBe(true);
			expect(sm.getSessionFile()).toBe(sessionFile);
			expect(existsSync(sessionFile)).toBe(true);

			sm.appendMessage({
				role: "user",
				content: [{ type: "text", text: "继续深入第二步" }],
				timestamp: new Date().toISOString(),
			} as never);
			sm.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "第二步完成" }],
				timestamp: new Date().toISOString(),
			} as never);

			const content = readFileSync(sessionFile, "utf8");
			const parsedLines = content
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l));
			expect(parsedLines.length).toBe(5);
			expect(parsedLines[0].type).toBe("session");
			expect(parsedLines[1].message.content[0].text).toBe("请分析代码");
			expect(parsedLines[2].message.content[0].text).toBe("分析结果如下...");
			expect(parsedLines[3].message.content[0].text).toBe("继续深入第二步");
			expect(parsedLines[4].message.content[0].text).toBe("第二步完成");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
