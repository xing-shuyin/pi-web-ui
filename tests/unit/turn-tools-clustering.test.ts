import { describe, expect, it } from "vitest";
import { clusterMessages, estimateClusterHeight } from "../../web/src/components/MessageList.js";
import type { UiMessage } from "../../web/src/types.js";

describe("回合工具流聚类与隔离机制 (Turn Tool Trail)", () => {
	it("同一回答回合内的连续中间工具消息精确聚合成同一个工具集群", () => {
		const messages: UiMessage[] = [
			{ id: "u1", role: "user", content: [{ type: "text", text: "查找文件" }] } as unknown as UiMessage,
			{
				id: "a1",
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "想一下" },
					{ type: "toolCall", id: "tc1", name: "grep" },
				],
			} as unknown as UiMessage,
			{ id: "tr1", role: "toolResult" } as unknown as UiMessage,
			{
				id: "a2",
				role: "assistant",
				content: [{ type: "toolCall", id: "tc2", name: "read" }],
			} as unknown as UiMessage,
			{ id: "tr2", role: "toolResult" } as unknown as UiMessage,
			{
				id: "a3",
				role: "assistant",
				content: [{ type: "toolCall", id: "tc3", name: "bash" }],
			} as unknown as UiMessage,
			{
				id: "a4",
				role: "assistant",
				content: [{ type: "text", text: "这是最终回答正文" }],
			} as unknown as UiMessage,
		];

		const clustered = clusterMessages(messages);
		expect(clustered.length).toBe(3);

		// 项 1：用户提问
		expect(clustered[0].type).toBe("single");
		if (clustered[0].type === "single") {
			expect(clustered[0].message.id).toBe("u1");
		}

		// 项 2：连续工具集群（a1, a2, a3）
		expect(clustered[1].type).toBe("tool_cluster");
		if (clustered[1].type === "tool_cluster") {
			expect(clustered[1].id).toBe("cluster-a1");
			expect(clustered[1].messages.length).toBe(3);
			expect(clustered[1].messages.map((m) => m.id)).toEqual(["a1", "a2", "a3"]);
		}

		// 项 3：最终正文回答
		expect(clustered[2].type).toBe("single");
		if (clustered[2].type === "single") {
			expect(clustered[2].message.id).toBe("a4");
		}
	});

	it("多回合对话之间严格隔离，绝不跨回合串联混排", () => {
		const messages: UiMessage[] = [
			// 第一回合
			{ id: "u1", role: "user", content: [{ type: "text", text: "提问一" }] } as unknown as UiMessage,
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "grep" }],
			} as unknown as UiMessage,
			{
				id: "a2",
				role: "assistant",
				content: [{ type: "toolCall", id: "tc2", name: "read" }],
			} as unknown as UiMessage,
			{
				id: "a3",
				role: "assistant",
				content: [{ type: "text", text: "回答一" }],
			} as unknown as UiMessage,

			// 第二回合
			{ id: "u2", role: "user", content: [{ type: "text", text: "提问二" }] } as unknown as UiMessage,
			{
				id: "a4",
				role: "assistant",
				content: [{ type: "toolCall", id: "tc3", name: "edit" }],
			} as unknown as UiMessage,
			{
				id: "a5",
				role: "assistant",
				content: [{ type: "toolCall", id: "tc4", name: "bash" }],
			} as unknown as UiMessage,
			{
				id: "a6",
				role: "assistant",
				content: [{ type: "text", text: "回答二" }],
			} as unknown as UiMessage,
		];

		const clustered = clusterMessages(messages);
		expect(clustered.length).toBe(6);

		// 第一回合结构
		expect(clustered[0].type).toBe("single"); // u1
		expect(clustered[1].type).toBe("tool_cluster"); // a1 + a2
		if (clustered[1].type === "tool_cluster") {
			expect(clustered[1].messages.map((m) => m.id)).toEqual(["a1", "a2"]);
		}
		expect(clustered[2].type).toBe("single"); // a3

		// 第二回合结构
		expect(clustered[3].type).toBe("single"); // u2
		expect(clustered[4].type).toBe("tool_cluster"); // a4 + a5
		if (clustered[4].type === "tool_cluster") {
			expect(clustered[4].messages.map((m) => m.id)).toEqual(["a4", "a5"]);
		}
		expect(clustered[5].type).toBe("single"); // a6
	});

	it("流式末尾候选消息平滑聚类：首帧尚无内容或仅为空文本时，紧随已有工具集群保持聚类，防止瞬时 single 闪烁", () => {
		const baseMessages: UiMessage[] = [
			{ id: "u1", role: "user", content: [{ type: "text", text: "请查找并读取" }] } as unknown as UiMessage,
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "grep" }],
			} as unknown as UiMessage,
			{ id: "tr1", role: "toolResult" } as unknown as UiMessage,
		];

		// 场景 A：首帧流式消息 content 为空数组，紧随已有的 a1 工具集群
		const streamingEmpty: UiMessage = {
			id: "stream-1",
			role: "assistant",
			content: [],
		} as unknown as UiMessage;

		const clusteredEmpty = clusterMessages([...baseMessages, streamingEmpty]);
		expect(clusteredEmpty.length).toBe(2);
		expect(clusteredEmpty[0].type).toBe("single"); // u1
		expect(clusteredEmpty[1].type).toBe("tool_cluster");
		if (clusteredEmpty[1].type === "tool_cluster") {
			// stream-1 平滑进入已有集群，绝不提前以 single 形式坠落到下一行
			expect(clusteredEmpty[1].messages.map((m) => m.id)).toEqual(["a1", "stream-1"]);
		}

		// 场景 B：首帧流式消息仅带空 text 块
		const streamingEmptyText: UiMessage = {
			id: "stream-1",
			role: "assistant",
			content: [{ type: "text", text: "   " }],
		} as unknown as UiMessage;

		const clusteredEmptyText = clusterMessages([...baseMessages, streamingEmptyText]);
		expect(clusteredEmptyText.length).toBe(2);
		expect(clusteredEmptyText[1].type).toBe("tool_cluster");
		if (clusteredEmptyText[1].type === "tool_cluster") {
			expect(clusteredEmptyText[1].messages.map((m) => m.id)).toEqual(["a1", "stream-1"]);
		}

		// 场景 C：下一帧流式消息带出了第二个 toolCall（read），顺理成章保持在集群内
		const streamingWithTool: UiMessage = {
			id: "stream-1",
			role: "assistant",
			content: [{ type: "toolCall", id: "tc2", name: "read" }],
		} as unknown as UiMessage;

		const clusteredTool = clusterMessages([...baseMessages, streamingWithTool]);
		expect(clusteredTool.length).toBe(2);
		expect(clusteredTool[1].type).toBe("tool_cluster");
		if (clusteredTool[1].type === "tool_cluster") {
			expect(clusteredTool[1].messages.map((m) => m.id)).toEqual(["a1", "stream-1"]);
		}

		// 场景 D：若流式消息产生非空正文，则立即脱离工具集群，作为 single 在下方独立渲染
		const streamingWithText: UiMessage = {
			id: "stream-1",
			role: "assistant",
			content: [{ type: "text", text: "已找到相应文件，正在处理..." }],
		} as unknown as UiMessage;

		const clusteredWithText = clusterMessages([...baseMessages, streamingWithText]);
		expect(clusteredWithText.length).toBe(3);
		expect(clusteredWithText[0].type).toBe("single"); // u1
		expect(clusteredWithText[1].type).toBe("tool_cluster"); // a1
		if (clusteredWithText[1].type === "tool_cluster") {
			expect(clusteredWithText[1].messages.map((m) => m.id)).toEqual(["a1"]);
		}
		expect(clusteredWithText[2].type).toBe("single"); // stream-1 作为独立正文流
		if (clusteredWithText[2].type === "single") {
			expect(clusteredWithText[2].message.id).toBe("stream-1");
		}
	});

	it("estimateClusterHeight 为未实测的工具集群提供稳定的基线高度", () => {
		const emptyMessages: UiMessage[] = [];
		expect(estimateClusterHeight(emptyMessages)).toBe(48);

		const fiveTools: UiMessage[] = [
			{ id: "a1" } as UiMessage,
			{ id: "a2" } as UiMessage,
			{ id: "a3" } as UiMessage,
			{ id: "a4" } as UiMessage,
			{ id: "a5" } as UiMessage,
		];
		// 5 * 52 = 260px
		expect(estimateClusterHeight(fiveTools)).toBe(260);
	});

	it("密集工具流阈值校验：连续 4 个及以上工具时 cluster.messages.length 准确反映密集度", () => {
		const smallTrail: UiMessage[] = [
			{ id: "a1", role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read" }] } as unknown as UiMessage,
			{ id: "a2", role: "assistant", content: [{ type: "toolCall", id: "t2", name: "grep" }] } as unknown as UiMessage,
			{ id: "a3", role: "assistant", content: [{ type: "toolCall", id: "t3", name: "bash" }] } as unknown as UiMessage,
		];
		const smallCluster = clusterMessages(smallTrail);
		expect(smallCluster.length).toBe(1);
		expect(smallCluster[0].type).toBe("tool_cluster");
		if (smallCluster[0].type === "tool_cluster") {
			// 小于 4 个工具，不触发密集收敛
			expect(smallCluster[0].messages.length >= 4).toBe(false);
		}

		const denseTrail: UiMessage[] = [
			...smallTrail,
			{ id: "a4", role: "assistant", content: [{ type: "toolCall", id: "t4", name: "edit" }] } as unknown as UiMessage,
			{ id: "a5", role: "assistant", content: [{ type: "toolCall", id: "t5", name: "bash" }] } as unknown as UiMessage,
		];
		const denseCluster = clusterMessages(denseTrail);
		expect(denseCluster.length).toBe(1);
		expect(denseCluster[0].type).toBe("tool_cluster");
		if (denseCluster[0].type === "tool_cluster") {
			// 达到 5 个工具，准确满足密集集群阈值（>= 4）
			expect(denseCluster[0].messages.length >= 4).toBe(true);
		}
	});

	it("极简行文字级输入流：mergeTurns 把整回合助手产出（含正文）并成一个流单元，且在用户提问处断开", () => {
		const messages: UiMessage[] = [
			{ id: "u1", role: "user", content: [{ type: "text", text: "清掉未使用 import 并提交" }] } as unknown as UiMessage,
			{
				id: "a1",
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "想" },
					{ type: "toolCall", id: "tc1", name: "bash" },
				],
			} as unknown as UiMessage,
			{
				id: "a2",
				role: "assistant",
				// 带正文的消息在普通模式下会打断集群，极简行文下必须并入同一回合流
				content: [
					{ type: "text", text: "先清掉那个未使用 import。" },
					{ type: "toolCall", id: "tc2", name: "bash" },
				],
			} as unknown as UiMessage,
			{ id: "a3", role: "assistant", content: [{ type: "toolCall", id: "tc3", name: "edit" }] } as unknown as UiMessage,
			{ id: "tr3", role: "toolResult" } as unknown as UiMessage,
			{ id: "u2", role: "user", content: [{ type: "text", text: "继续" }] } as unknown as UiMessage,
			{
				id: "a4",
				role: "assistant",
				content: [{ type: "toolCall", id: "tc4", name: "write" }],
			} as unknown as UiMessage,
		];

		const flow = clusterMessages(messages, { mergeTurns: true });
		// u1 / 回合流(a1,a2,a3) / u2 / 回合流(a4)
		expect(flow.map((it) => it.type)).toEqual(["single", "tool_cluster", "single", "tool_cluster"]);
		const turn = flow[1];
		expect(turn.type).toBe("tool_cluster");
		if (turn.type === "tool_cluster") {
			expect(turn.id).toBe("cluster-a1");
			expect(turn.messages.map((m) => m.id)).toEqual(["a1", "a2", "a3"]);
			// 正文与胶囊同处一条流 → 高度按行内流粗估，远小于逐消息块级估算
			expect(estimateClusterHeight(turn.messages, true)).toBeLessThan(estimateClusterHeight(turn.messages));
		}

		// 对照：普通主题下同一串消息会被 a2 的正文打断（a1 单独一簇、a3 另起一簇）
		const normal = clusterMessages(messages);
		expect(normal.map((it) => it.type)).toEqual([
			"single",
			"tool_cluster",
			"single",
			"tool_cluster",
			"single",
			"tool_cluster",
		]);
	});

	it("自定义消息与目标审查折叠消息不并入字级输入流，保持独立成块", () => {
		const messages: UiMessage[] = [
			{ id: "a1", role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash" }] } as unknown as UiMessage,
			{ id: "c1", role: "custom", customType: "file", content: [] } as unknown as UiMessage,
		];
		const flow = clusterMessages(messages, { mergeTurns: true });
		expect(flow.map((it) => it.type)).toEqual(["tool_cluster", "single"]);
	});
});
