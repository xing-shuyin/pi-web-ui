import { describe, expect, it } from "vitest";
import {
	computeWindowStart,
	DEFAULT_HISTORY_CHARS,
	DEFAULT_HISTORY_WINDOW,
	estimateMessageChars,
	MessageWindowTap,
	pickWindowStart,
	readMessageWindowConfig,
} from "../../server/message-window.js";
import type { ServerMessage, UiMessage, UiState } from "../../server/protocol.js";

function msg(id: string): UiMessage {
	return { id, role: "user", content: [{ type: "text", text: id }] } as UiMessage;
}

function stateWith(convId: string, messages: UiMessage[]): UiState {
	return { conversationId: convId, messages, rev: 1 } as unknown as UiState;
}

function snapshot(convId: string, messages: UiMessage[]): ServerMessage {
	return { type: "snapshot", state: stateWith(convId, messages) } as ServerMessage;
}

function delta(convId: string, baseRev: number, appended: UiMessage[]): ServerMessage {
	return {
		type: "snapshot_delta",
		conversationId: convId,
		rev: baseRev + 1,
		baseRev,
		appended,
		state: stateWith(convId, []),
	} as unknown as ServerMessage;
}

function makeTap(total: number, windowSize = DEFAULT_HISTORY_WINDOW) {
	const out: ServerMessage[] = [];
	const tap = new MessageWindowTap((m) => out.push(m), { windowSize, charBudget: 0, pageSize: 30 });
	const full = Array.from({ length: total }, (_, i) => msg(`m${i}`));
	return { tap, out, full };
}

describe("shared execution owner isolation", () => {
	it("discards cached local IDs when switching between owners", () => {
		const { tap, out, full } = makeTap(6, 2);
		tap.setScope("owner-a");
		tap.accept(snapshot("c1", full));
		expect(tap.loadEarlier({ conversationId: "c1", all: true })).toBe(true);
		tap.setScope("owner-b");
		expect(tap.loadEarlier({ conversationId: "c1", all: true })).toBe(false);
		tap.accept(snapshot("c1", [msg("other-owner")]));
		const last = out.at(-1);
		expect(last?.type === "snapshot" && last.state.messages.map((m) => m.id)).toEqual(["other-owner"]);
		tap.setScope("owner-a");
		expect(tap.loadEarlier({ conversationId: "c1", all: true })).toBe(false);
	});
});

describe("readMessageWindowConfig", () => {
	it("缺省 300 条；off/0/false/no 关闭；非法值回落默认", () => {
		expect(readMessageWindowConfig({} as NodeJS.ProcessEnv).windowSize).toBe(DEFAULT_HISTORY_WINDOW);
		for (const off of ["0", "off", "false", "no"]) {
			expect(readMessageWindowConfig({ PI_WEB_HISTORY_WINDOW: off } as NodeJS.ProcessEnv).windowSize).toBe(0);
		}
		expect(readMessageWindowConfig({ PI_WEB_HISTORY_WINDOW: "abc" } as NodeJS.ProcessEnv).windowSize).toBe(
			DEFAULT_HISTORY_WINDOW,
		);
		expect(readMessageWindowConfig({ PI_WEB_HISTORY_WINDOW: "50" } as NodeJS.ProcessEnv).windowSize).toBe(50);
	});
});

describe("pickWindowStart（条数 + 字符预算取更严者）", () => {
	const messages = Array.from({ length: 10 }, (_, i) => msg(`m${i}`));

	it("无预算时只看条数", () => {
		expect(pickWindowStart(messages, { windowSize: 4, charBudget: 0 })).toBe(6);
	});

	it("字符超预算时往前收窄窗口（巨型 tool 输出场景）", () => {
		const heavy = [...messages.slice(0, 9), msg("x".repeat(1000))];
		expect(pickWindowStart(heavy, { windowSize: 10, charBudget: 500 })).toBe(9);
	});

	it("至少保留最后一条（单条就超预算也不空手）", () => {
		expect(pickWindowStart([msg("y".repeat(9999))], { windowSize: 10, charBudget: 10 })).toBe(0);
	});

	it("预算充裕时不裁", () => {
		expect(pickWindowStart(messages, { windowSize: 10, charBudget: DEFAULT_HISTORY_CHARS })).toBe(0);
	});

	it("窗口化关闭时恒为 0", () => {
		expect(pickWindowStart(messages, { windowSize: 0, charBudget: 100 })).toBe(0);
	});

	it("estimateMessageChars 只累加文本类字段（含图片 dataUrl）", () => {
		const m = {
			id: "z",
			role: "toolResult",
			content: [
				{ type: "text", text: "abc" },
				{ type: "image", dataUrl: "x".repeat(10) },
			],
		} as unknown as UiMessage;
		expect(estimateMessageChars(m)).toBe(13);
	});
});

describe("computeWindowStart", () => {
	it("短对话起点恒为 0", () => {
		expect(computeWindowStart(-1, 20, 300)).toBe(0);
	});

	it("长对话取尾部窗口", () => {
		expect(computeWindowStart(-1, 1000, 300)).toBe(700);
	});

	it("起点单调不增：客户端翻过的页不会被全量快照推回去", () => {
		expect(computeWindowStart(200, 1000, 300)).toBe(200);
	});

	it("消息变少（压缩重写）时以尾部窗口为准", () => {
		expect(computeWindowStart(200, 320, 300)).toBe(20);
	});

	it("windowSize<=0 时等于关闭窗口化", () => {
		expect(computeWindowStart(50, 1000, 0)).toBe(0);
	});
});

describe("MessageWindowTap", () => {
	it("关闭时原样透传（含全量快照）", () => {
		const { tap, out, full } = makeTap(1000, 0);
		tap.accept(snapshot("c1", full));
		expect((out[0] as Extract<ServerMessage, { type: "snapshot" }>).state.messages).toBe(full);
		expect((out[0] as Extract<ServerMessage, { type: "snapshot" }>).state.historyStart).toBeUndefined();
	});

	it("全量快照只下发尾部窗口并回填起点/总数", () => {
		const { tap, out, full } = makeTap(1000, 300);
		tap.accept(snapshot("c1", full));
		const s = out[0] as Extract<ServerMessage, { type: "snapshot" }>;
		expect(s.state.messages).toHaveLength(300);
		expect(s.state.messages[0]).toBe(full[700]);
		expect(s.state.historyStart).toBe(700);
		expect(s.state.historyTotal).toBe(1000);
	});

	it("短对话不做裁剪", () => {
		const { tap, out, full } = makeTap(100);
		tap.accept(snapshot("c1", full));
		const s = out[0] as Extract<ServerMessage, { type: "snapshot" }>;
		expect(s.state.messages).toBe(full);
		expect(s.state.historyStart).toBe(0);
	});

	it("loadEarlier 往前扩一页，回 earlier_messages（连续、不重叠）", () => {
		const { tap, out, full } = makeTap(1000, 300);
		tap.accept(snapshot("c1", full));
		tap.loadEarlier(30);
		const page = out[1] as Extract<ServerMessage, { type: "earlier_messages" }>;
		expect(page.type).toBe("earlier_messages");
		expect(page.messages).toHaveLength(30);
		expect(page.messages[0]).toBe(full[670]);
		expect(page.messages.at(-1)).toBe(full[699]);
		expect(page.historyStart).toBe(670);
		expect(page.historyStart + page.messages.length).toBe(700);
	});

	it("loadEarlier all=true 一路拉到最早；到底后回空页", () => {
		const { tap, out, full } = makeTap(1000, 300);
		tap.accept(snapshot("c1", full));
		tap.loadEarlier(undefined, true);
		const all = out[1] as Extract<ServerMessage, { type: "earlier_messages" }>;
		expect(all.historyStart).toBe(0);
		expect(all.messages).toHaveLength(700);
		tap.loadEarlier(undefined, true);
		const empty = out[2] as Extract<ServerMessage, { type: "earlier_messages" }>;
		expect(empty.messages).toEqual([]);
		expect(empty.historyStart).toBe(0);
	});

	it("翻过的页不会被后续全量快照推回（reconnect/get_state 不丢历史）", () => {
		const { tap, out, full } = makeTap(1000, 300);
		tap.accept(snapshot("c1", full));
		tap.loadEarlier(100);
		const startAfterPage = (out.at(-1) as Extract<ServerMessage, { type: "earlier_messages" }>).historyStart;
		expect(startAfterPage).toBe(600);
		tap.accept({ type: "snapshot", state: stateWith("c1", full) } as ServerMessage);
		const s = out.at(-1) as Extract<ServerMessage, { type: "snapshot" }>;
		expect(s.state.historyStart).toBe(600);
		expect(s.state.messages).toHaveLength(400);
	});

	it("增量：追加消息进缓存并回填计数，不动 rev/baseRev", () => {
		const { tap, out, full } = makeTap(1000, 300);
		tap.accept(snapshot("c1", full));
		tap.accept(delta("c1", 1, [msg("m1000")]));
		const d = out.at(-1) as Extract<ServerMessage, { type: "snapshot_delta" }>;
		expect(d.appended).toHaveLength(1);
		expect(d.baseRev).toBe(1);
		expect(d.state.historyStart).toBe(700);
		expect(d.state.historyTotal).toBe(1001);
	});

	it("没见过基线的增量原样透传（不猜缓存）", () => {
		const { tap, out } = makeTap(10);
		const d = delta("c9", 3, [msg("x")]);
		tap.accept(d);
		expect(out[0]).toBe(d);
	});

	it("非快照消息一律透传", () => {
		const { tap, out } = makeTap(10);
		const notice = { type: "notice", level: "info", text: "hi" } as ServerMessage;
		tap.accept(notice);
		expect(out[0]).toBe(notice);
	});

	it("未命中时返回 false；rehydrate 回水后当场成功服务", () => {
		const { tap, out, full } = makeTap(1000, 300);
		expect(tap.loadEarlier({ conversationId: "c_unknown", count: 30 })).toBe(false);
		expect(out).toHaveLength(0);

		tap.rehydrate("c_unknown", full, 700);
		expect(tap.loadEarlier({ conversationId: "c_unknown", count: 30 })).toBe(true);
		expect(out).toHaveLength(1);
		const page = out[0] as Extract<ServerMessage, { type: "earlier_messages" }>;
		expect(page.type).toBe("earlier_messages");
		expect(page.conversationId).toBe("c_unknown");
		expect(page.historyStart).toBe(670);
		expect(page.messages).toHaveLength(30);
	});

	it("beforeId 优先于下标进行不可变锚定（防止下标漂移）", () => {
		const { tap, out, full } = makeTap(1000, 300);
		tap.accept(snapshot("c1", full));
		const ok = tap.loadEarlier({ conversationId: "c1", count: 20, beforeId: "m700" });
		expect(ok).toBe(true);
		const page = out[1] as Extract<ServerMessage, { type: "earlier_messages" }>;
		expect(page.historyStart).toBe(680);
		expect(page.messages).toHaveLength(20);
		expect(page.messages.at(-1)?.id).toBe("m699");
	});

	it("keeps character-limited snapshots stable, including appended messages and explicit pages", () => {
		const out: ServerMessage[] = [];
		const tap = new MessageWindowTap((m) => out.push(m), { windowSize: 300, charBudget: 15, pageSize: 2 });
		const full = Array.from({ length: 10 }, (_, i) => msg(`message-${i}`));
		const latest = () => (out.at(-1) as Extract<ServerMessage, { type: "snapshot" }>).state;
		tap.accept(snapshot("c1", full));
		expect(latest().historyStart).toBe(9);
		const generation = latest().historyGeneration;
		for (let i = 0; i < 3; i++) {
			tap.accept(snapshot("c1", [...full]));
			expect(latest().historyStart).toBe(9);
		}
		tap.accept(snapshot("c1", [...full, msg("new")]));
		expect(latest().historyStart).toBe(9);
		expect(latest().historyGeneration).toBe(generation);
		tap.loadEarlier({ conversationId: "c1", beforeId: "message-9", before: 9, historyGeneration: generation });
		tap.accept(snapshot("c1", [...full, msg("new")]));
		expect(latest().historyStart).toBe(7);
	});

	it("rotates history generation on same-length rewrites and refuses stale pages", () => {
		const { tap, out, full } = makeTap(10, 3);
		tap.accept(snapshot("c1", full));
		const generation = (out[0] as Extract<ServerMessage, { type: "snapshot" }>).state.historyGeneration;
		full[0] = msg("replacement");
		tap.accept(snapshot("c1", full));
		const next = (out[1] as Extract<ServerMessage, { type: "snapshot" }>).state;
		expect(next.historyGeneration).not.toBe(generation);
		tap.loadEarlier({ conversationId: "c1", historyGeneration: generation, beforeId: "m7", before: 7 });
		expect(out.at(-1)).toMatchObject({ type: "earlier_messages", resyncRequired: true, messages: [] });
	});

	it("compaction resets the window and only pages from the new baseline", () => {
		const { tap, out, full } = makeTap(1000, 3);
		tap.accept(snapshot("c1", full));
		const old = (out[0] as Extract<ServerMessage, { type: "snapshot" }>).state;
		const compacted = Array.from({ length: 20 }, (_, i) => msg(`compacted-${i}`));
		tap.accept(snapshot("c1", compacted));
		const next = (out[1] as Extract<ServerMessage, { type: "snapshot" }>).state;
		expect(next.historyStart).toBe(17);
		expect(next.historyGeneration).not.toBe(old.historyGeneration);
		tap.loadEarlier({
			conversationId: "c1",
			beforeId: old.messages[0].id,
			before: old.historyStart,
			historyGeneration: old.historyGeneration,
		});
		expect(out.at(-1)).toMatchObject({ resyncRequired: true, messages: [] });
		tap.loadEarlier({
			conversationId: "c1",
			count: 2,
			beforeId: next.messages[0].id,
			before: next.historyStart,
			historyGeneration: next.historyGeneration,
		});
		expect(out.at(-1)).toMatchObject({
			historyGeneration: next.historyGeneration,
			before: 17,
			beforeId: "compacted-17",
			historyStart: 15,
			messages: [compacted[15], compacted[16]],
		});
	});

	it("rejects missing and displaced anchors instead of falling back to numeric cursors", () => {
		const { tap, out, full } = makeTap(10, 3);
		tap.accept(snapshot("c1", full));
		for (const opts of [
			{ beforeId: "deleted", before: 7 },
			{ beforeId: "m7", before: 6 },
		]) {
			tap.loadEarlier({ conversationId: "c1", ...opts });
			expect(out.at(-1)).toMatchObject({ resyncRequired: true, messages: [], historyStart: 7 });
		}
	});

	it("rehydrated caches have a new lineage and require a snapshot before paging", () => {
		const { tap, out, full } = makeTap(10, 3);
		tap.accept(snapshot("c1", full));
		const generation = (out[0] as Extract<ServerMessage, { type: "snapshot" }>).state.historyGeneration;
		const restored = new MessageWindowTap((m) => out.push(m), { windowSize: 3, charBudget: 0, pageSize: 2 });
		restored.rehydrate("c1", full, 7);
		restored.loadEarlier({ conversationId: "c1", historyGeneration: generation, beforeId: "m7", before: 7 });
		expect(out.at(-1)).toMatchObject({ resyncRequired: true, messages: [] });
	});

	it("before 下标自描述游标截取", () => {
		const { tap, out, full } = makeTap(1000, 300);
		tap.accept(snapshot("c1", full));
		const ok = tap.loadEarlier({ conversationId: "c1", count: 20, before: 500 });
		expect(ok).toBe(true);
		const page = out[1] as Extract<ServerMessage, { type: "earlier_messages" }>;
		expect(page.historyStart).toBe(480);
		expect(page.messages).toHaveLength(20);
		expect(page.messages[0].id).toBe("m480");
		expect(page.messages.at(-1)?.id).toBe("m499");
	});
});
