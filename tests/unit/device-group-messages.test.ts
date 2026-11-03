import { describe, expect, it } from "vitest";
import {
	groupConversationState,
	groupDeviceHits,
	groupMessageTargets,
	groupSendAttempt,
	formatGroupDisplayText,
	formatGroupTaskChip,
	formatDeviceFailureReport,
	type GroupDetail,
	type GroupTask,
} from "../../web/src/device-group-messages";
const devices = [
	{ id: "a", name: "Twin" },
	{ id: "b", name: "Twin" },
];
function reportDetail(status: GroupTask["status"]): GroupDetail {
	return {
		room: { id: "room", name: "Room", botIds: ["a", "b"] },
		bots: [{ id: "a", name: "Twin", deviceId: "host", deviceName: "Studio PC" }, devices[1]],
		messages: [
			{
				id: "dispatch",
				text: "work",
				createdAt: 1,
				sender: { type: "human", id: "human", name: "Human" },
				taskIds: ["t"],
			},
			{
				id: "report",
				text: "**result**",
				createdAt: 3,
				sender: { type: "bot", id: "a", name: "Twin", sourceDeviceId: "host" },
				taskIds: ["t"],
			},
		],
		tasks: [{ id: "t", deviceId: "host", botId: "a", text: "work", createdAt: 2, status, report: "**result**" }],
	};
}
describe("group conversation adapter", () => {
	it("uses stable ids for duplicate device names and never dispatches plain chat", () => {
		expect(groupDeviceHits(devices, "Twin").map((h) => h.text)).toEqual(["@Twin(a)", "@Twin(b)"]);
		expect(groupMessageTargets("hello @Twin", devices)).toEqual([]);
		expect(groupMessageTargets("@Twin(b) @Twin(b)", devices)).toEqual(["b"]);
		expect(groupMessageTargets("@Twin(outsider)", devices)).toEqual([]);
	});
	it("renders task reports as real assistant markdown and retains sender/status labels", () => {
		const { state, labels } = groupConversationState(
			"room",
			{
				room: { id: "room", name: "Room", botIds: ["a"] },
				bots: devices,
				messages: [{ id: "m", text: "hi", createdAt: 1, sender: { name: "Human" } }],
				tasks: [
					{
						id: "t",
						deviceId: "host",
						botId: "a",
						text: "work",
						createdAt: 2,
						status: "completed",
						report: "**done**",
					},
					{ id: "q", deviceId: "host", botId: "b", text: "next", createdAt: 3, status: "queued" },
				],
			},
			devices,
		);
		expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
		expect(state.messages[1].content).toEqual([{ type: "text", text: "**done**" }]);
		expect(labels.get("group-message:m")).toBe("Human");
		expect(labels.get("group-task:q")).toBe("Twin · host · Queued");
		expect(state.messages[2].content[0].type).toBe("text");
		expect((state.messages[2].content[0] as { text: string }).text).toContain("Task Queued");
		expect((state.messages[2].content[0] as { text: string }).text).toContain("next");
		expect(groupConversationState("other", null, devices).state.messages).toEqual([]);
	});

	it("renders running task with active progress as structured card", () => {
		const devices = [{ id: "a", name: "Coder", deviceId: "host", deviceName: "host", enabled: true }];
		const { state } = groupConversationState(
			"room",
			{
				room: { id: "room", name: "Room", botIds: ["a"] },
				bots: devices,
				messages: [],
				tasks: [
					{
						id: "t1",
						deviceId: "host",
						botId: "a",
						text: "build project",
						createdAt: 10,
						status: "running",
						progress: {
							phase: "tool",
							toolName: "bash",
							text: "running npm test",
							taskId: "t1",
							attemptId: "att1",
						} as any,
					},
				],
			},
			devices,
			true,
		);
		const content = (state.messages[0].content[0] as { text: string }).text;
		expect(content).toContain("任务执行中");
		expect(content).toContain("build project");
		expect(content).toContain("bash");
		expect(content).toContain("running npm test");
	});

	it("sanitizes long UUID mention tokens for clean display", () => {
		const raw = "@win(fe2dfb80-efe8-46a7-acb1-fe0f24b1c43a) 优化代码";
		expect(formatGroupDisplayText(raw)).toBe("@win 优化代码");
	});

	it("extracts bot prefix and summary text cleanly for task chips", () => {
		const raw = "@win(fe2dfb80-efe8-46a7-acb1-fe0f24b1c43a) 优化代码";
		const chip = formatGroupTaskChip(raw, "win");
		expect(chip.botPrefix).toBe("@win");
		expect(chip.summary).toBe("优化代码");
	});

	it("formats technical device execution failures into readable markdown quotes", () => {
		const failure =
			"Device task failed [phase=model; category=execution_failed]. Local agent execution failed; inspect the retained task conversation on the target device.";
		const formattedZh = formatDeviceFailureReport(failure, true);
		expect(formattedZh).toContain("任务执行中断 · 模型推理阶段");
		expect(formattedZh).toContain("模型推理阶段");
		expect(formattedZh).toContain("execution_failed");

		const formattedEn = formatDeviceFailureReport(failure, false);
		expect(formattedEn).toContain("Task Interrupted · Model Execution");
		expect(formattedEn).toContain("execution_failed");
	});
	it.each(["completed", "failed", "interrupted"] as const)(
		"shows a linked %s report once with Bot, device and status",
		(status) => {
			const detail = reportDetail(status);
			const { state, labels } = groupConversationState("room", detail, devices);
			expect(state.messages.map((m) => m.id)).toEqual(["group-message:dispatch", "group-message:report"]);
			expect(state.messages[1].content).toEqual([{ type: "text", text: "**result**" }]);
			expect(labels.get("group-message:report")).toBe(
				`Twin · Studio PC · ${{ completed: "Completed", failed: "Failed", interrupted: "Interrupted" }[status]}`,
			);
			expect(labels.has("group-task:t")).toBe(false);
		},
	);
	it("keeps identical responses from different Bots and different tasks", () => {
		const detail = reportDetail("completed");
		detail.tasks.push(
			{ ...detail.tasks[0], id: "t2", botId: "b", deviceId: "host-b" },
			{ ...detail.tasks[0], id: "t3" },
		);
		detail.messages.push(
			{
				...detail.messages[1],
				id: "report2",
				taskIds: ["t2"],
				sender: { type: "bot", id: "b", name: "Twin", sourceDeviceId: "host-b" },
			},
			{ ...detail.messages[1], id: "report3", taskIds: ["t3"] },
		);
		const { state, labels } = groupConversationState("room", detail, devices);
		expect(state.messages.map((m) => m.id)).toEqual([
			"group-message:dispatch",
			"group-message:report",
			"group-message:report2",
			"group-message:report3",
		]);
		expect(labels.get("group-message:report2")).toBe("Twin · host-b · Completed");
	});
	it("keeps pending task statuses alongside human dispatch and standalone Bot messages", () => {
		const detail = reportDetail("running");
		delete detail.tasks[0].report;
		detail.messages = [
			detail.messages[0],
			{
				id: "standalone",
				text: "hello",
				createdAt: 3,
				sender: { type: "bot", id: "a", name: "Twin", sourceDeviceId: "host" },
			},
		];
		detail.tasks.push({ ...detail.tasks[0], id: "queued", status: "queued", botId: "b" });
		const { state, labels } = groupConversationState("room", detail, devices, true);
		expect(state.messages).toHaveLength(4);
		expect(labels.get("group-task:t")).toBe("Twin · Studio PC · 运行中");
		expect(labels.get("group-task:queued")).toBe("Twin · host · 排队中");
		expect(labels.get("group-message:standalone")).toBe("Twin · Studio PC");
	});
	it("falls back to task reports when report messages were pruned and retains unlinked history", () => {
		const detail = reportDetail("completed");
		detail.messages[1].taskIds = ["pruned-task"];
		const { state, labels } = groupConversationState("room", detail, devices);
		expect(state.messages.map((m) => m.id)).toEqual(["group-message:dispatch", "group-task:t", "group-message:report"]);
		expect(labels.get("group-task:t")).toBe("Twin · Studio PC · Completed");
		expect(labels.get("group-message:report")).toBe("Twin · Studio PC");
		delete detail.messages[1].taskIds;
		expect(groupConversationState("room", detail, devices).state.messages).toHaveLength(3);
		detail.messages.pop();
		expect(groupConversationState("room", detail, devices).state.messages.map((m) => m.id)).toEqual([
			"group-message:dispatch",
			"group-task:t",
		]);
	});
	it("does not suppress tasks linked by a human or another Bot with identical text", () => {
		const detail = reportDetail("completed");
		detail.messages[1].sender.id = "b";
		expect(groupConversationState("room", detail, devices).state.messages).toHaveLength(3);
		detail.messages.pop();
		expect(groupConversationState("room", detail, devices).state.messages).toHaveLength(2);
	});
	it("retries the same request with the same key and rotates for changed room/body/targets", () => {
		let n = 0;
		const key = () => String(++n);
		const first = groupSendAttempt(null, "r", "hello", ["b", "a"], key);
		expect(groupSendAttempt(first, "r", "hello", ["a", "b"], key)).toBe(first);
		expect(groupSendAttempt(first, "other", "hello", ["a", "b"], key).key).not.toBe(first.key);
		expect(groupSendAttempt(first, "r", "changed", ["a", "b"], key).key).not.toBe(first.key);
		expect(groupSendAttempt(first, "r", "hello", [], key).key).not.toBe(first.key);
	});
});
