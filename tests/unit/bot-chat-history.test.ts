import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BOT_CHAT_ENTRY, botChatSessionDir, listBotChatTranscripts } from "../../server/device-center/bot-chat.js";

/**
 * 私聊历史列表：默认入口只回最近一份，"新开对话"之后旧记录必须还能从界面找到。
 * 这里守三件事：只列这个 Bot 的转录、新的在前、标题取首条用户消息。
 */

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeTranscript(dir: string, name: string, botId: string, text: string | undefined, mtime: number): string {
	const lines = [JSON.stringify({ type: "session", cwd: "/w" })];
	if (text !== undefined)
		lines.push(
			JSON.stringify({
				type: "message",
				message: { role: "user", content: [{ type: "text", text }] },
			}),
		);
	lines.push(JSON.stringify({ type: "custom", customType: BOT_CHAT_ENTRY, data: { botId } }));
	const path = join(dir, name);
	writeFileSync(path, lines.join("\n"), "utf8");
	utimesSync(path, mtime / 1000, mtime / 1000);
	return path;
}

describe("listBotChatTranscripts", () => {
	it("只列这个 Bot 的转录，按更新时间倒序，并取首条用户消息当标题", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "bot-history-"));
		roots.push(agentDir);
		const dir = botChatSessionDir(agentDir, "bot-1");
		mkdirSync(dir, { recursive: true });
		const older = writeTranscript(dir, "2026-01-01_a.jsonl", "bot-1", "帮我审这个 PR", 1_000);
		const newer = writeTranscript(dir, "2026-01-02_b.jsonl", "bot-1", "写个发布说明", 2_000);
		writeTranscript(dir, "2026-01-03_c.jsonl", "bot-2", "别的 Bot", 3_000);
		writeFileSync(join(dir, "not-a-transcript.txt"), "x");

		const rows = listBotChatTranscripts(agentDir, "bot-1");
		expect(rows.map((row) => row.path)).toEqual([newer, older]);
		expect(rows[0].title).toBe("写个发布说明");
		expect(rows[1].title).toBe("帮我审这个 PR");
		expect(rows.every((row) => row.bytes > 0)).toBe(true);
	});

	it("没有用户消息时不给标题（由界面做本地化兜底），空目录返回空数组", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "bot-history-"));
		roots.push(agentDir);
		const dir = botChatSessionDir(agentDir, "bot-1");
		mkdirSync(dir, { recursive: true });
		writeTranscript(dir, "only-system.jsonl", "bot-1", undefined, 1_000);
		const rows = listBotChatTranscripts(agentDir, "bot-1");
		expect(rows).toHaveLength(1);
		expect(rows[0].title).toBeUndefined();
		expect(listBotChatTranscripts(agentDir, "bot-missing")).toEqual([]);
	});

	it("limit 生效（默认入口不列无限多）", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "bot-history-"));
		roots.push(agentDir);
		const dir = botChatSessionDir(agentDir, "bot-1");
		mkdirSync(dir, { recursive: true });
		for (let index = 0; index < 5; index++)
			writeTranscript(dir, `2026-01-0${index + 1}_x.jsonl`, "bot-1", `第 ${index + 1} 条`, 1_000 + index);
		expect(listBotChatTranscripts(agentDir, "bot-1", 2)).toHaveLength(2);
	});
});
