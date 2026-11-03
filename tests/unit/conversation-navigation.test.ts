import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifySessionSwitch, registerSessionSwitchSink, resetComposerSinks } from "../../web/src/composer-bridge";

// Exercise the send path without mounting the application's socket/runtime tree.
const source = readFileSync(new URL("../../web/src/use-chat.ts", import.meta.url), "utf8");
const begin = source.indexOf("\t\t// Every conversation entry point");
const end = source.indexOf('\t\tif (msg.type === "set_cwd" && msg.path)', begin);
const navigation = source.slice(begin, end);

const transitionBegin = source.indexOf('\t\tif (msg.type === "set_cwd" && msg.path)');
const transitionEnd = source.indexOf("\t\tif (isWsOpen(ws)) {", transitionBegin);
const transitionLogic = source.slice(transitionBegin, transitionEnd).replace(/\(s\?:\s*string\)/g, "(s)");

afterEach(resetComposerSinks);

describe("conversation navigation from group view", () => {
	it.each([
		{ type: "open_shared_conversation", owner: "bot-client", id: "c1" },
		{ type: "take_over_conversation", owner: "bot-client", id: "c1" },
		{ type: "switch_conversation", id: "c1" },
		{ type: "switch_session", sessionId: "session-1" },
		{ type: "switch_session", path: "/project/session.jsonl" },
		{ type: "new_chat" },
	])("leaves the group when sending $type", (msg) => {
		let activeGroupId: string | null = "group-1";
		const leaveGroup = vi.fn(() => {
			activeGroupId = null;
		});
		registerSessionSwitchSink(leaveGroup);
		runInNewContext(navigation, { msg, curState: null, notifySessionSwitch, dispatch: vi.fn() });
		expect(activeGroupId).toBeNull();
		expect(leaveGroup).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ type: "get_state" },
		{ type: "peek_elsewhere_question", owner: "bot-client", id: "question-1" },
		{ type: "switch_conversation", id: "" },
		{ type: "switch_session" },
	])("keeps the group for $type without a navigation target", (msg) => {
		const leaveGroup = vi.fn();
		registerSessionSwitchSink(leaveGroup);
		runInNewContext(navigation, { msg, curState: null, notifySessionSwitch, dispatch: vi.fn() });
		expect(leaveGroup).not.toHaveBeenCalled();
	});

	it("suppresses transition_start when target session matches currently active session (exact or substring)", () => {
		const dispatch = vi.fn();
		const curState = {
			sessionId: "0191a07a-32d0-7208-b133-cf7870ab850e",
			sessionFile: "E:/pi-web-ui/.sessions/--E--pi-web-ui--/2026-04-18_0191a07a-32d0-7208-b133-cf7870ab850e.jsonl",
			conversationId: "c1",
		};

		// 1. 目标正是当前 sessionId
		runInNewContext(transitionLogic, {
			msg: { type: "switch_session", sessionId: "0191a07a-32d0-7208-b133-cf7870ab850e" },
			curState,
			dispatch,
		});
		expect(dispatch).not.toHaveBeenCalled();

		// 2. 目标是截断的前缀/短 UUID 子串
		runInNewContext(transitionLogic, {
			msg: { type: "switch_session", sessionId: "1a07a-32d0-7208-b133-cf7870ab850e" },
			curState,
			dispatch,
		});
		expect(dispatch).not.toHaveBeenCalled();

		// 3. 目标是不同会话时正常触发 transition_start
		runInNewContext(transitionLogic, {
			msg: { type: "switch_session", sessionId: "other-session-uuid" },
			curState,
			dispatch,
		});
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "transition_start",
				kind: "session",
				target: "other-session-uuid",
			}),
		);
	});
});
