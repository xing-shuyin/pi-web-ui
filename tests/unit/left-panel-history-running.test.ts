import { describe, expect, it } from "vitest";
import type { ConversationSummary, SessionSummary } from "../../server/protocol.js";

function normalizeSessionPathKey(p?: string | null): string {
	if (!p) return "";
	return p.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

interface HistoryRunningInfo {
	convId: string;
	isStreaming: boolean;
	hasQuestion: boolean;
	hasError: boolean;
	error?: string;
}

function buildRunningInfoMap(
	runningConvs: (ConversationSummary & { elsewhere?: boolean })[],
): Map<string, HistoryRunningInfo> {
	const byId = new Map(runningConvs.map((c) => [c.id, c]));
	const kids = new Map<string, typeof runningConvs>();

	for (const c of runningConvs) {
		if (c.parentId && byId.has(c.parentId)) {
			const arr = kids.get(c.parentId) ?? [];
			arr.push(c);
			kids.set(c.parentId, arr);
		}
	}

	const getDescendants = (id: string) => {
		const res: typeof runningConvs = [];
		const queue = [...(kids.get(id) ?? [])];
		const visited = new Set<string>();
		while (queue.length > 0) {
			const item = queue.shift()!;
			if (visited.has(item.id)) continue;
			visited.add(item.id);
			res.push(item);
			const sub = kids.get(item.id);
			if (sub) queue.push(...sub);
		}
		return res;
	};

	const map = new Map<string, HistoryRunningInfo>();

	for (const c of runningConvs) {
		const descendants = getDescendants(c.id);
		const hasStreaming = descendants.some((d) => d.isStreaming || d.completionPending);
		const hasQuestion = descendants.some((d) => Boolean(d.hasQuestion));
		const hasError = descendants.some((d) => Boolean(d.error));

		const isStreaming = Boolean(c.isStreaming || c.completionPending || hasStreaming);
		const question = Boolean(c.hasQuestion || hasQuestion);
		const err = Boolean(c.error || hasError);

		const info: HistoryRunningInfo = {
			convId: c.id,
			isStreaming,
			hasQuestion: question,
			hasError: err,
			error: c.error,
		};

		if (c.sessionFile) {
			const normF = normalizeSessionPathKey(c.sessionFile);
			map.set(`file:${normF}`, info);
			const fn = normF.split("/").pop();
			if (fn) map.set(`fn:${fn}`, info);
		}
		if (c.sessionId) {
			map.set(`sid:${c.sessionId.trim().toLowerCase()}`, info);
		}
	}

	return map;
}

describe("历史会话运行态与去重逻辑", () => {
	it("跨平台路径能准确匹配（Windows 反斜杠 vs Linux 正斜杠与盘符大小写）", () => {
		const sessionFileWin = "C:\\Users\\admin\\.pi-web-ui\\sessions\\session-1.jsonl";
		const sessionFilePosix = "c:/users/admin/.pi-web-ui/sessions/session-1.jsonl";

		const runningMap = buildRunningInfoMap([
			{
				id: "c1",
				title: "主会话",
				cwd: "C:/proj",
				messageCount: 5,
				isStreaming: true,
				isSubagent: false,
				sessionFile: sessionFileWin,
			},
		]);

		const historySession: SessionSummary = {
			path: sessionFilePosix,
			firstMessage: "hello",
			messageCount: 5,
			modified: Date.now(),
		};

		const normP = normalizeSessionPathKey(historySession.path);
		const matched = runningMap.get(`file:${normP}`);
		expect(matched).toBeDefined();
		expect(matched?.isStreaming).toBe(true);
		expect(matched?.convId).toBe("c1");
	});

	it("后代子代理在 streaming 时，主历史会话行能感知到进行中状态", () => {
		const mainFile = "C:/sessions/main.jsonl";
		const runningMap = buildRunningInfoMap([
			{
				id: "c-root",
				title: "父会话",
				cwd: "C:/proj",
				messageCount: 3,
				isStreaming: false,
				isSubagent: false,
				sessionFile: mainFile,
			},
			{
				id: "c-sub-1",
				title: "子代理",
				cwd: "C:/proj",
				messageCount: 1,
				isStreaming: true,
				isSubagent: true,
				parentId: "c-root",
			},
		]);

		const matched = runningMap.get(`file:${normalizeSessionPathKey(mainFile)}`);
		expect(matched).toBeDefined();
		expect(matched?.isStreaming).toBe(true);
	});

	it("后代子代理有问卷提问时，主历史会话行感知到 hasQuestion", () => {
		const mainFile = "C:/sessions/main.jsonl";
		const runningMap = buildRunningInfoMap([
			{
				id: "c-root",
				title: "父会话",
				cwd: "C:/proj",
				messageCount: 3,
				isStreaming: false,
				isSubagent: false,
				sessionFile: mainFile,
			},
			{
				id: "c-sub-1",
				title: "子代理",
				cwd: "C:/proj",
				messageCount: 1,
				isStreaming: false,
				isSubagent: true,
				parentId: "c-root",
				hasQuestion: true,
			},
		]);

		const matched = runningMap.get(`file:${normalizeSessionPathKey(mainFile)}`);
		expect(matched).toBeDefined();
		expect(matched?.hasQuestion).toBe(true);
	});

	it("在 tab 模式下不进行跨面板去重，历史列表中保留完整历史项", () => {
		const convs: ConversationSummary[] = [
			{
				id: "c1",
				title: "画布的详情",
				cwd: "C:/proj",
				messageCount: 172,
				isStreaming: true,
				isSubagent: false,
				sessionFile: "C:/sessions/canvas.jsonl",
			},
		];
		const sessions: SessionSummary[] = [
			{
				path: "C:/sessions/canvas.jsonl",
				firstMessage: "hi",
				messageCount: 172,
				modified: Date.now(),
			},
			{
				path: "C:/sessions/other.jsonl",
				firstMessage: "test",
				messageCount: 10,
				modified: Date.now(),
			},
		];

		const convTab: string = "stream";
		const collapseConvs = false;
		const activeRunningFiles =
			convTab !== "split" || collapseConvs || convs.length === 0
				? new Set<string>()
				: new Set(convs.map((c) => normalizeSessionPathKey(c.sessionFile)));

		const filtered =
			activeRunningFiles.size === 0
				? sessions
				: sessions.filter((s) => !activeRunningFiles.has(normalizeSessionPathKey(s.path)));

		expect(filtered).toHaveLength(2);
		expect(filtered[0].path).toBe("C:/sessions/canvas.jsonl");
	});
});
