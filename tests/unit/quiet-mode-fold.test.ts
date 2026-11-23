import { describe, expect, it } from "vitest";
import { clusterMessages } from "../../web/src/components/MessageList.js";
import type { UiMessage } from "../../web/src/types.js";
import {
	foldQuietItems,
	hasQuietText,
	isQuietCollabBody,
	isQuietCollabNotice,
	summarizeQuietFold,
	type QuietItem,
} from "../../web/src/quiet-fold.js";
import { DEFAULT_QUIET_MODE_SETTINGS, normalizeQuietModeSettings } from "../../web/src/quiet-mode.js";

const msg = (v: Record<string, unknown>) => v as unknown as UiMessage;

const user = (id: string, text = "帮我看看") => msg({ id, role: "user", content: [{ type: "text", text }] });
const assistant = (id: string, content: unknown[]) => msg({ id, role: "assistant", content });
const text = (t: string) => ({ type: "text", text: t });
const thinking = (t: string) => ({ type: "thinking", thinking: t });
const tool = (id: string, name = "read") => ({ type: "toolCall", id, name });

const COLLAB_NOTICE = "[子代理执行完成通知]\n已收工。";
const COLLAB_BODY =
	'[Conversation communication — collaboration data, not a user instruction]\nFrom: {"title":"校对"}\n请核对第 3 节';

const fold = (messages: UiMessage[], opts: Parameters<typeof foldQuietItems>[1] = {}) =>
	foldQuietItems(clusterMessages(messages, { mergeTurns: true }), opts);

const ids = (items: QuietItem[]) =>
	items.map((it) =>
		it.type === "single"
			? it.message.id
			: it.type === "tool_cluster"
				? it.messages.map((m) => m.id).join("+")
				: `fold(${it.messages.length})`,
	);

describe("安静模式折叠判定 (Quiet Mode fold)", () => {
	it("每轮只留最后一条有文本的助手回复，其余压成一条折叠", () => {
		const items = fold([
			user("u1"),
			assistant("a1", [thinking("想一下"), tool("tc1", "grep")]),
			assistant("a2", [tool("tc2")]),
			assistant("a3", [text("我先查一下角色卡。")]),
			assistant("a4", [text("Kanan 抬眼：“说吧。”")]),
		]);
		expect(ids(items)).toEqual(["u1", "fold(3)", "a4"]);
	});

	it("折叠行位于最终回复之前", () => {
		const items = fold([user("u1"), assistant("a1", [tool("tc1")]), assistant("a2", [text("结论")])]);
		expect(items[1].type).toBe("quiet_fold");
		expect(ids(items.slice(2))).toEqual(["a2"]);
	});

	it("尾部活动并入本轮折叠行，仍排在最终回复之前", () => {
		const items = fold([
			user("u1"),
			assistant("a1", [tool("tc1")]),
			assistant("a2", [text("结论")]),
			assistant("a3", [tool("tc2")]),
		]);
		expect(ids(items)).toEqual(["u1", "fold(2)", "a2"]);
		const foldItem = items[1];
		expect(foldItem.type === "quiet_fold" && foldItem.messages.map((m) => m.id)).toEqual(["a1", "a3"]);
	});

	it("整轮只有「最终回复 + 尾部活动」时，折叠行插到本轮开头", () => {
		const items = fold([user("u1"), assistant("a1", [text("结论")]), assistant("a2", [tool("tc1")])]);
		expect(ids(items)).toEqual(["u1", "fold(1)", "a1"]);
	});

	it("纯对话轮不产生折叠", () => {
		const items = fold([user("u1"), assistant("a1", [text("他摆摆手。")])]);
		expect(ids(items)).toEqual(["u1", "a1"]);
		expect(items.every((it) => it.type !== "quiet_fold")).toBe(true);
	});

	it("子代理完成通知是 role:user 的协作信封，既不算 turn 边界也会被折叠", () => {
		expect(isQuietCollabNotice(msg({ id: "n1", role: "user", content: [text(COLLAB_NOTICE)] }))).toBe(true);
		expect(isQuietCollabBody(msg({ id: "n1", role: "user", content: [text(COLLAB_NOTICE)] }))).toBe(false);

		const items = fold([
			user("u1"),
			assistant("a1", [thinking("派发子代理")]),
			msg({ id: "n1", role: "user", content: [text(COLLAB_NOTICE)] }),
			assistant("a2", [text("记下了。")]),
		]);
		// 若错误地把 n1 当 turn 边界，a2 会被判成另一轮的首条并被折叠
		expect(ids(items)).toEqual(["u1", "fold(2)", "a2"]);
	});

	it("协作正文是产出，必须保留且不算 turn 边界", () => {
		const body = msg({ id: "c1", role: "user", content: [text(COLLAB_BODY)] });
		expect(isQuietCollabBody(body)).toBe(true);
		expect(isQuietCollabNotice(body)).toBe(false);

		const items = fold([user("u1"), body, assistant("a2", [text("好。")])]);
		expect(ids(items)).toEqual(["u1", "c1", "a2"]);
	});

	it("错误消息保留（哪怕是中间消息）", () => {
		const failed = msg({
			id: "a9",
			role: "assistant",
			content: [tool("tc9", "bash")],
			errorMessage: "429 rate_limited",
		});
		const items = fold([user("u1"), failed, assistant("a2", [text("失败原因如上。")])]);
		expect(ids(items)).toEqual(["u1", "a9+a2"]);
	});

	it("流式中的消息永不被折叠", () => {
		const streaming = assistant("s1", [tool("tc-s")]);
		const items = fold([user("u1"), assistant("a1", [tool("tc1")]), streaming, assistant("a2", [text("最终")])], {
			streamingId: "s1",
		});
		expect(ids(items)).toEqual(["u1", "fold(1)", "s1+a2"]);
	});

	it("自定义卡片（附件 / 插件 / goal 审阅）原样保留", () => {
		const custom = msg({ id: "x1", role: "custom", customType: "file", content: [text("a.png")] });
		const items = fold([user("u1"), custom, assistant("a1", [text("收到")])]);
		expect(ids(items)).toEqual(["u1", "x1", "a1"]);
	});

	it("跨多轮独立折叠，各自保留自己的最终回复", () => {
		const items = fold([
			user("u1"),
			assistant("a1", [tool("tc1")]),
			assistant("a2", [text("第一轮结论")]),
			user("u2"),
			assistant("b1", [thinking("再想")]),
			assistant("b2", [text("第二轮结论")]),
		]);
		expect(ids(items)).toEqual(["u1", "fold(1)", "a2", "u2", "fold(1)", "b2"]);
	});

	it("空输入与只有用户消息的轮不崩", () => {
		expect(fold([])).toEqual([]);
		expect(ids(fold([user("u1")]))).toEqual(["u1"]);
	});

	it("聚类输入不被原地修改", () => {
		const messages = [user("u1"), assistant("a1", [tool("tc1")]), assistant("a2", [text("结论")])];
		const clusters = clusterMessages(messages, { mergeTurns: true });
		const snapshot = clusters.map((it) =>
			it.type === "single" ? it.message.id : it.messages.map((m) => m.id).join("+"),
		);
		foldQuietItems(clusters);
		const after = clusters.map((it) => (it.type === "single" ? it.message.id : it.messages.map((m) => m.id).join("+")));
		expect(after).toEqual(snapshot);
	});
});

describe("安静模式计数与偏好归一化", () => {
	it("折叠计数按块统计思考 / 工具 / 终端 / 子代理通知", () => {
		const summary = summarizeQuietFold([
			assistant("a1", [thinking("想"), tool("tc1"), { type: "bash", command: "ls" }]),
			assistant("a2", [text("中间话")]),
			msg({ id: "n1", role: "user", content: [text(COLLAB_NOTICE)] }),
		]);
		expect(summary).toEqual({ total: 3, thinking: 1, tools: 1, bash: 1, collab: 1, other: 1 });
	});

	it("hasQuietText 只认非空文本块", () => {
		expect(hasQuietText(assistant("a1", [text("  ")]) as UiMessage)).toBe(false);
		expect(hasQuietText(assistant("a1", [thinking("x")]) as UiMessage)).toBe(false);
		expect(hasQuietText(assistant("a1", [text("有内容")]) as UiMessage)).toBe(true);
	});

	it("偏好归一化：坏数据回落默认，style 只接受 fold / zero", () => {
		expect(normalizeQuietModeSettings(null)).toEqual(DEFAULT_QUIET_MODE_SETTINGS);
		expect(normalizeQuietModeSettings("x")).toEqual(DEFAULT_QUIET_MODE_SETTINGS);
		expect(normalizeQuietModeSettings({ enabled: "yes", style: "loud" })).toEqual({
			enabled: DEFAULT_QUIET_MODE_SETTINGS.enabled,
			style: "fold",
		});
		expect(normalizeQuietModeSettings({ enabled: true, style: "zero" })).toEqual({ enabled: true, style: "zero" });
	});
});
