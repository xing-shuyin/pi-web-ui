import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifySessionSwitch, registerSessionSwitchSink, resetComposerSinks } from "../../web/src/composer-bridge";

// Exercise the send path without mounting the application's socket/runtime tree.
const source = readFileSync(new URL("../../web/src/use-chat.ts", import.meta.url), "utf8");
const begin = source.indexOf("\t\t// Every conversation entry point");
const end = source.indexOf('\t\tif (msg.type === "set_cwd" && msg.path)', begin);
const navigation = source.slice(begin, end);

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
});
