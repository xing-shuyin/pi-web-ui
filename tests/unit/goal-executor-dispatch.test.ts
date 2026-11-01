import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

function makeFakeSession() {
	const sentMessages: { text: string; options?: { deliverAs?: string } }[] = [];
	const emitted: any[] = [];
	let isStreaming = false;

	const execSession = {
		get isStreaming() {
			return isStreaming;
		},
		sendUserMessage: vi.fn(async (text: string, options?: { deliverAs?: string }) => {
			sentMessages.push({ text, options });
		}),
	};

	const mainSession = {
		isStreaming: false,
		prompt: vi.fn(async () => {}),
	};

	const cs = fakeClientSession() as any;
	cs.convs = new Map<string, any>();
	cs.emit = (msg: any) => emitted.push(msg);
	cs.flushSnapshot = vi.fn();
	cs.getLang = () => "zh";
	cs.slash = {
		exec: vi.fn(async (name: string, _args: string) => {
			if (name === "model" || name === "help") return true;
			return false;
		}),
	};

	const execConv = {
		id: "exec-1",
		title: "执行者",
		session: execSession,
	};
	cs.convs.set("exec-1", execConv);

	const mainConv: any = {
		id: "main-1",
		title: "主会话",
		planMode: false,
		delegateMode: false,
		session: mainSession,
		goal: {
			phase: "executing",
			round: 1,
			reviewing: true,
		},
		roleExec: {
			convId: "exec-1",
			generation: 1,
		},
	};
	cs.convs.set("main-1", mainConv);
	cs.activeId = "main-1";

	return {
		cs,
		mainConv,
		execConv,
		execSession,
		mainSession,
		sentMessages,
		emitted,
		setStreaming: (s: boolean) => {
			isStreaming = s;
		},
	};
}

describe("Goal 2.0 执行期主会话插话自动转发给执行者 (#625)", () => {
	it("当目标处于 executing 且执行者活跃时，主会话插话自动转发给执行者并发送 notice", async () => {
		const { cs, mainConv, sentMessages, emitted, setStreaming } = makeFakeSession();
		setStreaming(true);

		const handled = await (ClientSession.prototype as any).dispatchToGoalExecutor.call(
			cs,
			mainConv,
			"需要去除健康探针",
		);

		expect(handled).toBe(true);
		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0]?.text).toBe("需要去除健康探针");
		expect(sentMessages[0]?.options).toEqual({ deliverAs: "steer" });
		expect(emitted.some((m) => m.type === "notice" && m.text.includes("已同步至目标执行者"))).toBe(true);
	});

	it("非流式执行时无需 deliverAs=steer 正常发送", async () => {
		const { cs, mainConv, sentMessages, setStreaming } = makeFakeSession();
		setStreaming(false);

		const handled = await (ClientSession.prototype as any).dispatchToGoalExecutor.call(
			cs,
			mainConv,
			"请注意包含单元测试",
		);

		expect(handled).toBe(true);
		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0]?.text).toBe("请注意包含单元测试");
		expect(sentMessages[0]?.options).toBeUndefined();
	});

	it("原生斜杠命令由本地消费，不转发给执行者", async () => {
		const { cs, mainConv, sentMessages } = makeFakeSession();

		const handled = await (ClientSession.prototype as any).dispatchToGoalExecutor.call(cs, mainConv, "/model");

		expect(handled).toBe(true);
		expect(cs.slash.exec).toHaveBeenCalledWith("model", "");
		expect(sentMessages.length).toBe(0);
	});

	it("计划模式开启时优先规划，不自动转发", async () => {
		const { cs, mainConv, sentMessages } = makeFakeSession();
		mainConv.planMode = true;

		const handled = await (ClientSession.prototype as any).dispatchToGoalExecutor.call(cs, mainConv, "补充信息");

		expect(handled).toBe(false);
		expect(sentMessages.length).toBe(0);
	});

	it("目标非 executing 阶段（如 idle、reviewing）不转发，返回 false", async () => {
		const { cs, mainConv, sentMessages } = makeFakeSession();
		mainConv.goal.phase = "reviewing";

		const handled = await (ClientSession.prototype as any).dispatchToGoalExecutor.call(cs, mainConv, "补充信息");

		expect(handled).toBe(false);
		expect(sentMessages.length).toBe(0);
	});

	it("目标执行者不存在或已销毁时不转发，返回 false", async () => {
		const { cs, mainConv, sentMessages } = makeFakeSession();
		mainConv.roleExec = { convId: "exec-dead", generation: 1 };

		const handled = await (ClientSession.prototype as any).dispatchToGoalExecutor.call(cs, mainConv, "补充信息");

		expect(handled).toBe(false);
		expect(sentMessages.length).toBe(0);
	});

	it("流式执行期间若 queue=true（补充按钮），则以 deliverAs=followUp 投递", async () => {
		const { cs, mainConv, sentMessages, setStreaming } = makeFakeSession();
		setStreaming(true);

		const handled = await (ClientSession.prototype as any).dispatchToGoalExecutor.call(
			cs,
			mainConv,
			"结束本轮后再检查日志",
			true,
		);

		expect(handled).toBe(true);
		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0]?.options).toEqual({ deliverAs: "followUp" });
	});

	it("当 sendUserMessage 抛错时仍返回 true 并弹错误通知，绝不退回主会话并发起跑模型", async () => {
		const { cs, mainConv, execSession, emitted, setStreaming } = makeFakeSession();
		setStreaming(true);
		execSession.sendUserMessage.mockRejectedValueOnce(new Error("transport closed"));

		const handled = await (ClientSession.prototype as any).dispatchToGoalExecutor.call(cs, mainConv, "补充信息");

		expect(handled).toBe(true);
		expect(emitted.some((m) => m.type === "notice" && m.level === "error" && m.text.includes("同步消息失败"))).toBe(
			true,
		);
	});
});
