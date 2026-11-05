import { describe, expect, it } from "vitest";
import { reducer, type ChatState } from "../../web/src/use-chat.js";
import type { SessionSummary } from "../../web/src/types.js";

describe("工作区稳定性与多项目会话隔离", () => {
	const initialChatState: ChatState = {
		state: {
			cwd: "/path/to/project-main",
			sessionFile: "/path/to/project-main/session-1.jsonl",
		} as any,
		sessions: [
			{
				path: "/path/to/project-main/session-1.jsonl",
				displayName: "主项目会话",
				modified: 1000,
			} as SessionSummary,
		],
		projectSessions: {},
		projects: [{ path: "/path/to/project-main", lastUsed: 1000 }],
		conversations: [],
		elsewhere: [],
	} as any;

	it("拉取非当前项目的会话列表时，绝不覆盖当前项目的 sessions，且写入 projectSessions 字典", () => {
		const targetProject = "/path/to/project-other";
		const otherSessions: SessionSummary[] = [
			{
				path: "/path/to/project-other/session-other.jsonl",
				displayName: "外部项目会话",
				modified: 2000,
			} as SessionSummary,
		];

		const nextState = reducer(initialChatState, {
			type: "sessions",
			sessions: otherSessions,
			cwd: targetProject,
		});

		// 1. 当前项目的 sessions 必须完好无损，绝不被冲刷
		expect(nextState.sessions.length).toBe(1);
		expect(nextState.sessions[0]?.displayName).toBe("主项目会话");

		// 2. 外部项目的 sessions 存入 projectSessions 独立隔离字典中
		const normTarget = "/path/to/project-other";
		expect(nextState.projectSessions?.[normTarget]).toBeDefined();
		expect(nextState.projectSessions?.[normTarget]?.length).toBe(1);
		expect(nextState.projectSessions?.[normTarget]?.[0]?.displayName).toBe("外部项目会话");
	});

	it("拉取无历史会话的项目（空数组）时，当前项目的会话绝不被清空", () => {
		const emptyProject = "/path/to/empty-project";
		const nextState = reducer(initialChatState, {
			type: "sessions",
			sessions: [],
			cwd: emptyProject,
		});

		// 当前项目的会话依然完整
		expect(nextState.sessions.length).toBe(1);
		expect(nextState.sessions[0]?.displayName).toBe("主项目会话");

		// 空项目的 projectSessions 记录为 []
		expect(nextState.projectSessions?.[emptyProject]).toEqual([]);
	});

	it("拉取当前项目的最新会话时，正确更新当前 sessions 与当前项目归属缓存", () => {
		const updatedSessions: SessionSummary[] = [
			{
				path: "/path/to/project-main/session-2.jsonl",
				displayName: "主项目新会话",
				modified: 3000,
			} as SessionSummary,
		];

		const nextState = reducer(initialChatState, {
			type: "sessions",
			sessions: updatedSessions,
			cwd: "/path/to/project-main",
		});

		expect(nextState.sessions.length).toBe(1);
		expect(nextState.sessions[0]?.displayName).toBe("主项目新会话");
		expect(nextState.projectSessions?.["/path/to/project-main"]).toEqual(updatedSessions);
	});
});
