import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAskQuestionTool } from "../../server/core/adapters/tools/ask-question.js";
import type { TransportPort } from "../../server/core/contracts/ports.js";
import { InteractionInbox, type InteractionKind } from "../../server/core/domains/interactions/index.js";
import { createAskUserWaiter, type AskUserWaiter } from "../../server/core/domains/interactions/questions.js";
import type { QuestionAnswer, ServerMessage, UiQuestion } from "../../server/protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

type PendingFrame = Extract<ServerMessage, { type: "question_pending" }>;

const questions: UiQuestion[] = [
	{
		id: "target",
		question: "先接哪一层？",
		header: "范围",
		options: [{ label: "域", recommended: true }, { label: "适配器" }],
	},
];

const answers: QuestionAnswer[] = [{ id: "target", selected: ["域"] }];

interface SettledCall {
	kind: InteractionKind;
	id: string;
	result: unknown;
}

function makeTransport() {
	const frames: ServerMessage[] = [];
	const state = { closed: false, throwOnSend: false };
	const transport: TransportPort = {
		send(msg) {
			if (state.throwOnSend) throw new Error("socket is gone");
			frames.push(msg);
		},
		isClosed: () => state.closed,
	};
	return { transport, frames, state };
}

function makeRig(options: { nextId?: () => string } = {}) {
	const settled: SettledCall[] = [];
	const inbox = new InteractionInbox((kind, id, result) => {
		settled.push({ kind, id, result: result as unknown });
	});
	const { transport, frames, state } = makeTransport();
	const waiter: AskUserWaiter = createAskUserWaiter({ inbox, transport, ...options });
	return { waiter, inbox, settled, frames, state };
}

function pendingFrames(frames: readonly ServerMessage[]): PendingFrame[] {
	return frames.filter((frame): frame is PendingFrame => frame.type === "question_pending");
}

function retractedIds(frames: readonly ServerMessage[]): string[] {
	const out: string[] = [];
	for (const frame of frames) {
		if (frame.type !== "question_retracted") continue;
		out.push((frame as { id: string }).id);
	}
	return out;
}

function signalOf(): AbortController {
	return new AbortController();
}

describe("interactions/questions · 发帧形状", () => {
	it("最小输入只发协议字段：id / questions / conversationId", () => {
		const { waiter, frames } = makeRig();
		void waiter.askUser(questions, signalOf().signal, "c1");

		expect(frames).toEqual([{ type: "question_pending", id: "q-1", questions, conversationId: "c1" }]);
	});

	it("字段一个都不多：不带 createdAt / owner / global / deadline / conversationTitle", () => {
		const { waiter, frames } = makeRig();
		void waiter.askUser(questions, signalOf().signal, "c1");

		const frame = pendingFrames(frames)[0] as unknown as Record<string, unknown>;
		expect(Object.keys(frame).sort()).toEqual(["conversationId", "id", "questions", "type"]);
	});

	it("没给会话 id 时帧里就不带这个字段", () => {
		const { waiter, frames } = makeRig();
		void waiter.askUser(questions, signalOf().signal);

		expect(pendingFrames(frames)[0]).toEqual({ type: "question_pending", id: "q-1", questions });
	});

	it("id 全由 nextId 决定；缺省时按递增序号发", () => {
		const injected = ["x-1", "x-2"];
		let i = 0;
		const custom = makeRig({ nextId: () => injected[i++] });
		void custom.waiter.askUser(questions, signalOf().signal, "c1");
		void custom.waiter.askUser(questions, signalOf().signal, "c1");
		expect(pendingFrames(custom.frames).map((frame) => frame.id)).toEqual(["x-1", "x-2"]);

		const byDefault = makeRig();
		void byDefault.waiter.askUser(questions, signalOf().signal, "c1");
		void byDefault.waiter.askUser(questions, signalOf().signal, "c1");
		expect(pendingFrames(byDefault.frames).map((frame) => frame.id)).toEqual(["q-1", "q-2"]);
	});

	it("源文件不读时钟（登记序号只是顺序，不是时间）", () => {
		const source = readFileSync(join(root, "server", "core", "domains", "interactions", "questions.ts"), "utf8");
		expect(source).not.toMatch(/Date\.now|new Date\(/);
	});
});

describe("interactions/questions · 回包结算", () => {
	it("answer 结算 promise、发一帧 question_retracted、收件箱与快照都摘掉", async () => {
		const { waiter, inbox, frames, settled } = makeRig();
		const waiting = waiter.askUser(questions, signalOf().signal, "c1");

		expect(waiter.answer("q-1", answers)).toBe(true);
		await expect(waiting).resolves.toEqual(answers);
		expect(waiter.pendingForSnapshot("c1")).toEqual([]);
		expect(inbox.has("q-1")).toBe(false);
		expect(retractedIds(frames)).toEqual(["q-1"]);
		expect(settled).toEqual([{ kind: "question", id: "q-1", result: answers }]);
	});

	it("同一 id 第二次 answer 返回 false，且不重复结算、不重复发收弹框帧", async () => {
		const { waiter, frames, settled } = makeRig();
		const waiting = waiter.askUser(questions, signalOf().signal, "c1");

		expect(waiter.answer("q-1", answers)).toBe(true);
		expect(waiter.answer("q-1", [], true, "再点一次")).toBe(false);
		await expect(waiting).resolves.toEqual(answers);
		expect(settled).toHaveLength(1);
		expect(retractedIds(frames)).toEqual(["q-1"]);
	});

	it("未知 id 返回 false，不发帧也不回调", () => {
		const { waiter, frames, settled } = makeRig();

		expect(waiter.answer("ghost", answers)).toBe(false);
		expect(frames).toEqual([]);
		expect(settled).toEqual([]);
	});

	it("取消回包结算成 cancelled，附言原样带进结果", async () => {
		const { waiter } = makeRig();
		const waiting = waiter.askUser(questions, signalOf().signal, "c1");

		expect(waiter.answer("q-1", [], true, "换个问法")).toBe(true);
		await expect(waiting).resolves.toEqual({ cancelled: true, reason: "换个问法" });
	});

	it("取消回包没给理由时不编 reason 字段", async () => {
		const { waiter } = makeRig();
		const waiting = waiter.askUser(questions, signalOf().signal, "c1");

		expect(waiter.answer("q-1", [], true)).toBe(true);
		const result = await waiting;
		expect(result).toEqual({ cancelled: true });
		expect(result).not.toHaveProperty("reason");
	});

	it("不取消就回空答案也不当成取消（answers 原样当结果）", async () => {
		const { waiter } = makeRig();
		const waiting = waiter.askUser(questions, signalOf().signal, "c1");

		expect(waiter.answer("q-1", [])).toBe(true);
		await expect(waiting).resolves.toEqual([]);
	});
});

describe("interactions/questions · 取消与通道", () => {
	it("cancelConversation 只结算本会话、返回条数，结果是带理由的取消", async () => {
		const { waiter, inbox } = makeRig();
		const first = waiter.askUser(questions, signalOf().signal, "c1");
		const second = waiter.askUser(questions, signalOf().signal, "c1");
		const elsewhere = waiter.askUser(questions, signalOf().signal, "c2");

		expect(waiter.cancelConversation("c1", "会话已关闭")).toBe(2);
		await expect(first).resolves.toEqual({ cancelled: true, reason: "会话已关闭" });
		await expect(second).resolves.toEqual({ cancelled: true, reason: "会话已关闭" });
		expect(waiter.pendingForSnapshot("c1")).toEqual([]);
		expect(waiter.pendingForSnapshot("c2").map((entry) => entry.id)).toEqual(["q-3"]);
		expect(inbox.size("question")).toBe(1);
		expect(waiter.cancelConversation("nope", "会话已关闭")).toBe(0);

		expect(waiter.answer("q-3", answers)).toBe(true);
		await expect(elsewhere).resolves.toEqual(answers);
	});

	it("signal.abort() 也结算：结果是取消，登记与快照一起清空", async () => {
		const { waiter, inbox, frames } = makeRig();
		const ac = signalOf();
		const waiting = waiter.askUser(questions, ac.signal, "c1");

		ac.abort();
		await expect(waiting).resolves.toEqual({ cancelled: true, reason: "提问已中止" });
		expect(waiter.pendingForSnapshot("c1")).toEqual([]);
		expect(inbox.size("question")).toBe(0);
		expect(retractedIds(frames)).toEqual(["q-1"]);
	});

	it("传入已经 abort 的信号：直接取消，不登记也不发帧", async () => {
		const { waiter, inbox, frames } = makeRig();
		const ac = signalOf();
		ac.abort();

		await expect(waiter.askUser(questions, ac.signal, "c1")).resolves.toEqual({
			cancelled: true,
			reason: "提问已中止",
		});
		expect(frames).toEqual([]);
		expect(inbox.size("question")).toBe(0);
	});

	it("通道已关：直接取消，不登记也不发帧（不悬挂）", async () => {
		const { waiter, inbox, frames, state } = makeRig();
		state.closed = true;

		await expect(waiter.askUser(questions, signalOf().signal, "c1")).resolves.toEqual({
			cancelled: true,
			reason: "通道已关闭，提问无法送达",
		});
		expect(frames).toEqual([]);
		expect(inbox.size("question")).toBe(0);
		expect(waiter.pendingForSnapshot("c1")).toEqual([]);
	});

	it("发帧抛错也不悬挂：结算成取消并清空登记", async () => {
		const { waiter, inbox, state } = makeRig();
		state.throwOnSend = true;

		await expect(waiter.askUser(questions, signalOf().signal, "c1")).resolves.toEqual({
			cancelled: true,
			reason: "提问帧发送失败",
		});
		expect(waiter.pendingForSnapshot("c1")).toEqual([]);
		expect(inbox.size("question")).toBe(0);
	});

	it("登记后通道关闭：answer 仍能结算，只是不再发收弹框帧", async () => {
		const { waiter, frames, state } = makeRig();
		const waiting = waiter.askUser(questions, signalOf().signal, "c1");
		state.closed = true;

		expect(waiter.answer("q-1", answers)).toBe(true);
		await expect(waiting).resolves.toEqual(answers);
		expect(retractedIds(frames)).toEqual([]);
	});

	it("结算之后再来的 abort 不动已结算的结果", async () => {
		const { waiter, frames } = makeRig();
		const ac = signalOf();
		const waiting = waiter.askUser(questions, ac.signal, "c1");

		expect(waiter.answer("q-1", answers)).toBe(true);
		ac.abort();
		await expect(waiting).resolves.toEqual(answers);
		expect(retractedIds(frames)).toEqual(["q-1"]);
	});

	it("id 撞车：登记失败直接取消，不影响已在等的那条", async () => {
		const { waiter, inbox } = makeRig({ nextId: () => "same" });
		const first = waiter.askUser(questions, signalOf().signal, "c1");

		await expect(waiter.askUser(questions, signalOf().signal, "c1")).resolves.toEqual({
			cancelled: true,
			reason: "提问 id 重复：same",
		});
		expect(inbox.size("question")).toBe(1);
		expect(waiter.pendingForSnapshot("c1").map((entry) => entry.id)).toEqual(["same"]);

		expect(waiter.answer("same", answers)).toBe(true);
		await expect(first).resolves.toEqual(answers);
	});
});

describe("interactions/questions · 快照", () => {
	it("pendingForSnapshot 只给本会话、按登记顺序、形状是 {id, questions}", () => {
		const { waiter } = makeRig();
		const other: UiQuestion[] = [{ id: "x", question: "另一个问题？" }];
		void waiter.askUser(questions, signalOf().signal, "c1");
		void waiter.askUser(other, signalOf().signal, "c1");
		void waiter.askUser(questions, signalOf().signal, "c2");

		expect(waiter.pendingForSnapshot("c1")).toEqual([
			{ id: "q-1", questions },
			{ id: "q-2", questions: other },
		]);
		expect(waiter.pendingForSnapshot("c2").map((entry) => entry.id)).toEqual(["q-3"]);
		expect(waiter.pendingForSnapshot("nope")).toEqual([]);
	});

	it("快照是登记时的拷贝：调用方回头改自己的数组不影响还在等的这条", async () => {
		const { waiter } = makeRig();
		const asked: UiQuestion[] = [{ id: "a", question: "A？" }];
		const waiting = waiter.askUser(asked, signalOf().signal, "c1");

		asked.push({ id: "b", question: "B？" });
		expect(waiter.pendingForSnapshot("c1")[0]?.questions.map((q) => q.id)).toEqual(["a"]);

		expect(waiter.answer("q-1", answers)).toBe(true);
		await expect(waiting).resolves.toEqual(answers);
	});
});

describe("adapters/tools/ask-question · 工具定义", () => {
	it("名字与描述沿用叶子定义，且带可执行的 execute", () => {
		const tool = createAskQuestionTool({ waiter: { askUser: async () => [] }, conversationId: "c1" });

		expect(tool.name).toBe("ask_user_question");
		expect(tool.label).toBeTruthy();
		expect(tool.description).toBeTruthy();
		expect(tool.promptSnippet).toBeTruthy();
		expect(tool.parameters).toBeTruthy();
		expect(typeof tool.execute).toBe("function");
	});

	it("execute 走 waiter：questions / 信号 / 会话 id 原样透传，文本按问题头拼", async () => {
		const calls: Array<{ questions: UiQuestion[]; conversationId: string | undefined }> = [];
		const waiter = {
			askUser: async (qs: UiQuestion[], _signal: AbortSignal, conversationId?: string) => {
				calls.push({ questions: qs, conversationId });
				return [{ id: "target", selected: ["域"], custom: "先接域" }];
			},
		};
		const tool = createAskQuestionTool({ waiter, conversationId: "c1" });
		const ac = signalOf();

		const out = (await tool.execute("call-1", { questions }, ac.signal, undefined, {} as any)) as {
			content: { type: string; text: string }[];
			details: { answers: QuestionAnswer[] };
		};

		expect(calls).toEqual([{ questions, conversationId: "c1" }]);
		expect(out.content[0]).toEqual({ type: "text", text: "范围: 域 (wrote: 先接域)" });
		expect(out.details.answers).toEqual([{ id: "target", selected: ["域"], custom: "先接域" }]);
	});

	it("全链路：真 waiter 发帧 → answer 回包 → execute 拿到答案文本", async () => {
		const { waiter, frames } = makeRig();
		const tool = createAskQuestionTool({ waiter, conversationId: "c1" });
		const running = tool.execute("call-1", { questions }, signalOf().signal, undefined, {} as any);

		const frame = pendingFrames(frames)[0];
		expect(frame).toMatchObject({ type: "question_pending", conversationId: "c1", questions });
		expect(waiter.answer(frame.id, [{ id: "target", selected: ["域", "适配器"] }])).toBe(true);

		const out = (await running) as { content: { text: string }[] };
		expect(out.content[0].text).toBe("范围: 域, 适配器");
		expect(waiter.pendingForSnapshot("c1")).toEqual([]);
	});

	it("用户取消：execute 抛错并带上附言", async () => {
		const { waiter, frames } = makeRig();
		const tool = createAskQuestionTool({ waiter, conversationId: "c1" });
		const running = tool.execute("call-1", { questions }, signalOf().signal, undefined, {} as any);

		expect(waiter.answer(pendingFrames(frames)[0].id, [], true, "不选了")).toBe(true);
		await expect(running).rejects.toThrow(/User cancelled the question/);
		await expect(running).rejects.toThrow(/附言：不选了/);
	});
});

describe("adapters/tools/ask-question · 分层", () => {
	it("适配器不直连 domains、也不引用 SDK（两个方向都只走窄口与叶子实现）", () => {
		const source = readFileSync(join(root, "server", "core", "adapters", "tools", "ask-question.ts"), "utf8");
		const importLines = source.split("\n").filter((line) => line.startsWith("import "));
		expect(importLines.join("\n")).not.toMatch(/domains|@earendil-works/);
	});
});
