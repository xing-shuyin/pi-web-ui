import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshClientSession } from "../dist/server/dsh/dsh-agent-service.js";
import { ClientStateStore } from "../dist/server/client-state.js";

let failures = 0;
const check = (name, okValue, extra = "") => {
	console.log(`${okValue ? "PASS" : "FAIL"} ${name}${okValue || !extra ? "" : "  — " + extra}`);
	if (!okValue) failures++;
};

const dataDir = mkdtempSync(join(tmpdir(), "dsh-stats-test-"));
const store = new ClientStateStore(join(dataDir, "client-state.json"));
const cs = DshClientSession.create("stats-test-client", process.cwd(), store, dataDir, join(dataDir, "agent"));

let notify = () => {};
cs.runtime = { onNotification: (h) => (notify = h), kill() {}, dispose() {} };
cs.attachRuntimeEvents();

const emitted = [];
cs.emit = (msg) => emitted.push(msg);

const conv = cs.addConversation("stats-session-1", process.cwd(), false);
cs.activeId = conv.id;
const state = () => cs.buildLightState(1);
const textOf = (s) => s.streamingMessage?.content?.map((c) => c.text ?? c.thinking ?? "").join("") ?? "";
const frame = (data) => notify("assistant.stream", { sessionId: "stats-session-1", frame: data });

check("初始 contextUsage.tokens === null", state().stats.contextUsage.tokens === null);

frame({ type: "start", attemptId: "a1", revision: 1, turn: 1, step: 1 });
frame({
	type: "chunk",
	attemptId: "a1",
	revision: 1,
	index: 0,
	time: 1000,
	chunk: { type: "block-start", index: 0, blockType: "text" },
});
frame({
	type: "chunk",
	attemptId: "a1",
	revision: 1,
	index: 1,
	time: 1001,
	chunk: { type: "text-delta", index: 0, text: "hello " },
});
frame({
	type: "chunk",
	attemptId: "a1",
	revision: 1,
	index: 2,
	time: 1002,
	chunk: { type: "text-delta", index: 0, text: "world" },
});
const streaming = state();
check("直播帧建出 streamingMessage", !!streaming.streamingMessage);
check("流式文本按 delta 累积", textOf(streaming) === "hello world", textOf(streaming));
const deltas = emitted.filter((m) => m.type === "message_delta");
check("每个 text-delta 一条 message_delta", deltas.length === 2, String(deltas.length));
check("message_delta.messageId 与流式消息 id 一致", deltas[0]?.messageId === streaming.streamingMessage?.id);

frame({
	type: "chunk",
	attemptId: "a1",
	revision: 1,
	index: 3,
	time: 1003,
	chunk: { type: "usage", usage: { inputTokens: 200, outputTokens: 8, cacheReadTokens: 1000, cacheWriteTokens: 50 } },
});
const used = state().stats;
check(
	"usage 帧 → tokens 四桶 + total",
	JSON.stringify(used.tokens) ===
		JSON.stringify({ input: 200, output: 8, cacheRead: 1000, cacheWrite: 50, total: 1258 }),
	JSON.stringify(used.tokens),
);
check("上下文 = prompt(1250) + output(8)", used.contextUsage.tokens === 1258, JSON.stringify(used.contextUsage));
check(
	"上下文百分比 = 1258 / 1M",
	Math.abs((used.contextUsage.percent ?? 0) - 0.1258) < 1e-9,
	String(used.contextUsage.percent),
);
check(
	"缓存命中率分母口径（read/(miss+read+write)）",
	1000 / (used.tokens.input + used.tokens.cacheRead + used.tokens.cacheWrite) === 0.8,
);

notify("session.event", {
	sessionId: "stats-session-1",
	event: {
		type: "assistant/message",
		seq: 9,
		time: 1100,
		data: {
			turn: 1,
			step: 1,
			message: { role: "assistant", id: "m1", time: 1100, content: [{ type: "text", text: "hello world" }] },
			usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
		},
	},
});
const after = state();
check("assistant/message 清空 streamingMessage", after.streamingMessage === null);
check(
	"assistant/message 进消息列表",
	cs.convs.get(conv.id).messages.some((m) => m.id === "a-m1"),
);
check(
	"assistant/message.usage 回填统计（新版形状）",
	JSON.stringify(after.stats.tokens) ===
		JSON.stringify({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }),
	JSON.stringify(after.stats.tokens),
);

const conv2 = cs.addConversation("stats-session-2", process.cwd(), false);
cs.activeId = conv2.id;
const legacy = (seq, time, chunk) =>
	notify("session.event", {
		sessionId: "stats-session-2",
		event: { type: "assistant/chunk", seq, time, data: { turn: 1, step: 1, chunk } },
	});
legacy(3, 1, { type: "block-start", index: 0, blockType: "text" });
legacy(4, 2, { type: "text-delta", index: 0, text: "old" });
legacy(5, 3, { type: "usage", usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 90 } });
check("老路径 streamingMessage 仍工作", textOf(state()) === "old", textOf(state()));
check(
	"老路径 usage 仍进统计",
	state().stats.tokens.input === 10 && state().stats.tokens.cacheRead === 90,
	JSON.stringify(state().stats.tokens),
);
legacy(6, 4, { type: "text-delta", index: 0, text: "DUP" });
check("未接管的会话老 chunk 正常追加（对照组）", textOf(state()) === "oldDUP", textOf(state()));

frame({ type: "start", attemptId: "b1", revision: 1, turn: 1, step: 1 });
notify("assistant.stream", {
	sessionId: "stats-session-2",
	frame: {
		type: "chunk",
		attemptId: "b1",
		revision: 1,
		index: 0,
		time: 5,
		chunk: { type: "block-start", index: 0, blockType: "text" },
	},
});
notify("assistant.stream", {
	sessionId: "stats-session-2",
	frame: {
		type: "chunk",
		attemptId: "b1",
		revision: 1,
		index: 1,
		time: 6,
		chunk: { type: "text-delta", index: 0, text: "new" },
	},
});
legacy(7, 7, { type: "text-delta", index: 0, text: "OLD-IGNORED" });
check("直播接管后持久 assistant/chunk 被忽略（不重复）", textOf(state()) === "new", textOf(state()));

const snapshotBefore = textOf(state()) + JSON.stringify(state().stats.tokens);
notify("assistant.stream", {
	sessionId: "someone-else",
	frame: { type: "chunk", index: 0, time: 1, chunk: { type: "text-delta", index: 0, text: "x" } },
});
check("未知 sessionId 的直播帧被忽略", textOf(state()) + JSON.stringify(state().stats.tokens) === snapshotBefore);

console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILED");
process.exit(failures === 0 ? 0 : 1);
