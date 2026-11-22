import { describe, expect, it } from "vitest";
import { parseTabs, tabsRefusal } from "../../server/tabs.js";
import { managedRefusal } from "../../server/managed.js";
import type { ServerMessage } from "../../server/protocol.js";
import { REQUEST_REPLIES, refuse, type RefusalRequest } from "../../server/ws-refusal.js";

/**
 * issue #980 的回归：被策略拒绝的请求型消息必须**同时**产出 notice 与它自己的失败回包，
 * 客户端才能把 loading 位落下来；notice 不许替代结果包。
 */

function collect(): { sent: ServerMessage[]; send: (message: ServerMessage) => void } {
	const sent: ServerMessage[] = [];
	return { sent, send: (message) => sent.push(message) };
}

/** 复现 #980 的拒绝环境：PI_WEB_TABS=chat，search/git/terminal 都被关掉。 */
const CHAT_ONLY_TABS = parseTabs({ PI_WEB_TABS: "chat" });
const MANAGED = true;

function refusalOf(type: string): string {
	const refusal = managedRefusal(type, MANAGED) ?? tabsRefusal(type, CHAT_ONLY_TABS);
	expect(refusal, `${type} 在此环境下应当被拒`).toBeTruthy();
	return refusal!;
}

function reject(type: string, msg: Omit<RefusalRequest, "type">): { sent: ServerMessage[]; reply: ServerMessage } {
	const { sent, send } = collect();
	const reason = refusalOf(type);
	const returned = refuse({ ...msg, type }, { text: reason, error: reason }, send);
	expect(returned).toEqual(sent);
	const replies = sent.filter((message) => message.type !== "notice");
	expect(replies, `${type} 必须只产出一条结果包`).toHaveLength(1);
	return { sent, reply: replies[0]! };
}

describe("策略拒绝：notice + 该请求自己的失败回包（issue #980）", () => {
	it("search_files → notice + search_files_result{reqId, ok:false}", () => {
		const { sent, reply } = reject("search_files", { reqId: 7, query: "abc" });
		expect(sent[0]).toMatchObject({ type: "notice", level: "error" });
		// notice 是附加提示，排在结果包之前（客户端先亮提示，再用回包落 loading）。
		expect(reply).toEqual({ type: "search_files_result", reqId: 7, ok: false, results: [] });
	});

	it("search_sessions → session_search_results（异名回包），reqId 与 query 原样带回", () => {
		const { reply } = reject("search_sessions", { reqId: 9, query: "深层链接" });
		expect(reply).toEqual({ type: "session_search_results", reqId: 9, query: "深层链接", ok: false, results: [] });
	});

	it("scm_status → scm_data{kind:'status', ok:false, error}", () => {
		const { reply } = reject("scm_status", { reqId: 3 });
		expect(reply).toMatchObject({ type: "scm_data", reqId: 3, kind: "status", ok: false });
		expect((reply as { error?: string }).error).toBe(refusalOf("scm_status"));
	});

	it("new_cli_chat → new_chat_result（该 result 没有 error 字段，按现有形状回）", () => {
		const { reply } = reject("new_cli_chat", { requestId: "host-new-chat-7" });
		expect(reply).toEqual({ type: "new_chat_result", requestId: "host-new-chat-7", ok: false });
		expect(Object.hasOwn(reply, "error")).toBe(false);
	});

	it("new_chat 的拒绝（工作目录切不过去就不建会话）也回同一条 new_chat_result", () => {
		const { sent, send } = collect();
		refuse(
			{ type: "new_chat", requestId: "host-new-chat-8", cwd: "ssh://build-box/srv/app" },
			{ text: "无法切换到该工作目录", textEn: "Cannot switch to that workspace", error: "cwd-unavailable" },
			send,
		);
		expect(sent.map((message) => message.type)).toEqual(["notice", "new_chat_result"]);
		expect(sent[1]).toEqual({ type: "new_chat_result", requestId: "host-new-chat-8", ok: false });
	});

	it("managed 实例的插件目录同步：plugin_catalog_sync_result 带 error", () => {
		const { reply } = reject("plugin_catalog_sync", { requestId: "sync-1", source: "https://example.com/index.json" });
		expect(reply).toMatchObject({ type: "plugin_catalog_sync_result", requestId: "sync-1", ok: false });
		expect((reply as { error?: string }).error).toBe(refusalOf("plugin_catalog_sync"));
	});
});

describe("拒绝回包的对账与可见性", () => {
	it("notice 永远带 textEn（缺省回落 text），拒绝文案不再只有一种语言字段", () => {
		const { sent, send } = collect();
		refuse({ type: "hello" }, { text: "拒绝" }, send);
		expect(sent).toEqual([{ type: "notice", level: "error", text: "拒绝", textEn: "拒绝" }]);

		const explicit = collect();
		refuse({ type: "hello" }, { text: "拒绝", textEn: "Refused" }, explicit.send);
		expect(explicit.sent[0]).toMatchObject({ text: "拒绝", textEn: "Refused" });
	});

	it("请求没带关联 id：只发 notice，不伪造一条对不上账的结果包", () => {
		for (const msg of [{ type: "search_files", query: "q" }, { type: "new_chat" }, { type: "scm_history" }]) {
			const { sent, send } = collect();
			refuse(msg, { text: "拒绝" }, send);
			expect(sent.map((message) => message.type)).toEqual(["notice"]);
		}
	});

	it("未知/非请求型消息：只发 notice（不猜回包类型）", () => {
		const { sent, send } = collect();
		refuse({ type: "no_such_message", reqId: 1, requestId: "x" }, { text: "Unknown message type" }, send);
		expect(sent.map((message) => message.type)).toEqual(["notice"]);
	});

	it("注册表按 type 精确命中：同一条消息只产出一条结果包（不重复发射）", () => {
		const { sent, send } = collect();
		refuse({ type: "scm_commitmsg", reqId: 11 }, { text: "denied", error: "tab-disabled" }, send);
		expect(sent).toHaveLength(2);
		expect(sent.filter((message) => message.type === "scm_data")).toHaveLength(1);
		expect(sent[1]).toMatchObject({ type: "scm_data", reqId: 11, kind: "commitmsg", ok: false, error: "tab-disabled" });
	});

	it("注册表键覆盖了 5 类 tab 策略请求（search / git / terminal 的实际拒绝路径）", () => {
		for (const type of [
			"search_files",
			"search_sessions",
			"scm_status",
			"scm_history",
			"scm_filediff",
			"scm_commit",
			"terminal_cli_paste",
			"terminal_cli_control",
			"new_cli_chat",
		]) {
			expect(REQUEST_REPLIES[type as keyof typeof REQUEST_REPLIES], `${type} 未登记回包`).toBeDefined();
		}
	});
});
