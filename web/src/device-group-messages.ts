import type { UiMessage, UiState } from "./types";
import type { AtHit } from "./at-mention";

export type GroupDevice = {
	id: string;
	name: string;
	deviceId?: string;
	deviceName?: string;
	enabled?: boolean;
	online?: boolean;
	revision?: number;
	tools?: string[];
};
export type GroupBotConversation = Pick<import("./types").DeviceConversation, "id" | "botId" | "name"> & {
	status: string;
	/** Bot registration changed (revision, device, membership); this conversation can no longer continue. */
	stale?: boolean;
	closedReason?: string;
} & Partial<
		Pick<
			import("./types").DeviceConversation,
			"latestDelivery" | "latestReview" | "deliveryCount" | "reviewCount" | "deliverySummaryTruncated" | "attention"
		>
	> & {
		deliveries?: import("./types").DeviceDelivery[];
		reviews?: import("./types").DeviceReview[];
	};

export function groupConversationHits(
	devices: readonly GroupDevice[],
	conversations: readonly GroupBotConversation[],
	query: string,
	zh: boolean,
): AtHit[] {
	return devices.flatMap((bot) => {
		const choices = [
			{
				providerId: "host:group-devices",
				providerLabel: zh ? "新对话" : "New conversation",
				title: bot.name,
				hint: bot.id,
				text: `@${bot.name} · ${zh ? "新对话" : "New conversation"}`,
			},
			...conversations
				.filter((c) => c.botId === bot.id && c.status !== "closed" && !c.stale)
				.map((c) => ({
					providerId: "host:group-conversations",
					providerLabel: zh ? "继续对话" : "Continue conversation",
					title: `${bot.name} · ${c.name || (zh ? "未命名对话" : "Untitled conversation")}`,
					hint: c.id,
					text: `@${bot.name} · ${zh ? "继续：" : "Continue: "}${c.name || (zh ? "未命名对话" : "Untitled conversation")}`,
				})),
		];
		return choices.filter((hit) =>
			`${hit.title} ${hit.providerLabel} ${bot.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
		);
	});
}

export type GroupMessage = {
	id: string;
	text: string;
	createdAt: number;
	sender: { name: string; type?: "human" | "bot"; id?: string; sourceDeviceId?: string };
	taskIds?: string[];
	targetBotIds?: string[];
	replyToMessageId?: string;
};
export type GroupTask = {
	progress?: import("../../server/protocol").DeviceTaskProgress;
	attemptId?: string;
	id: string;
	deviceId: string;
	botId: string;
	conversationId?: string;
	text: string;
	report?: string;
	status: "queued" | "running" | "completed" | "failed" | "interrupted";
	createdAt: number;
	botRevision?: number;
	planOnly?: boolean;
	plan?: import("./group-capabilities").GroupTaskPlan;
	canvasRef?: import("./group-capabilities").GroupCanvasRef;
	parentTaskId?: string;
	rootTaskId?: string;
	sourceBotId?: string;
	sourceConversationId?: string;
	kind?: "message" | "request" | "reply" | "result";
	resultOfTaskId?: string;
	dispatchDepth?: number;
};
export type GroupDetail = {
	room: {
		id: string;
		name: string;
		botIds: string[];
		primaryBotId?: string;
		canvasBinding?: { deviceId: string; graphId: string; cwd: string; title: string };
		blackboard?: import("../../server/device-center/store.js").GroupBlackboard;
	};
	bots: GroupDevice[];
	messages: GroupMessage[];
	tasks: GroupTask[];
};

export function groupDeviceToken(device: GroupDevice): string {
	return `@${device.name}(${device.id})`;
}

/** Formats @name(uuid) mentions to clean @name for display, hiding ugly UUIDs. */
export function formatGroupDisplayText(text: string): string {
	return text.replace(/@([^\s()]+)\([a-f0-9-]{8,}\)/g, "@$1");
}

/** Separates bot prefix from task instruction for clean chip display. */
export function formatGroupTaskChip(text: string, botName?: string): { botPrefix: string; summary: string } {
	const cleaned = formatGroupDisplayText(text);
	const match = cleaned.match(/^@([^\s()]+)\s*(.*)$/);
	if (match) {
		return {
			botPrefix: `@${match[1]}`,
			summary: match[2].trim() || cleaned,
		};
	}
	return {
		botPrefix: botName ? `@${botName}` : "",
		summary: cleaned,
	};
}

/** Formats raw technical execution failure reports into structured, human-readable markdown. */
export function formatDeviceFailureReport(raw: string, zh = true): string {
	if (!raw.includes("Device task failed")) return formatGroupDisplayText(raw);
	const match = raw.match(/Device task failed\s*\[phase=([^;]+);\s*category=([^\]]+)\]\.\s*(.*)/s);
	if (!match) return formatGroupDisplayText(raw);
	const [, phase, category, detail] = match;
	const phaseMap: Record<string, string> = zh
		? {
				model: "模型推理阶段",
				tool: "工具调用阶段",
				approval: "权限审批阶段",
				connection: "网络连接",
				handshake: "设备握手",
				init: "环境初始化",
				switch_session: "会话切换",
				new_chat: "新建会话",
			}
		: {
				model: "Model Execution",
				tool: "Tool Execution",
				approval: "Approval Phase",
				connection: "Network Connection",
				handshake: "Device Handshake",
				init: "Initialization",
				switch_session: "Session Switch",
				new_chat: "New Chat",
			};
	const phaseLabel = phaseMap[phase] || phase;
	const cleanDetail = detail.trim();
	if (zh) {
		return [
			`> ⚠️ **任务执行中断 · ${phaseLabel}**`,
			`>`,
			`> **执行阶段**：\`${phase}\` · **错误类型**：\`${category}\``,
			`>`,
			`> ${cleanDetail || "远端设备执行异常，现场任务会话已完整保留在目标设备上，可前往排查或重新提交。"}`,
		].join("\n");
	}
	return [
		`> ⚠️ **Task Interrupted · ${phaseLabel}**`,
		`>`,
		`> **Phase**: \`${phase}\` · **Category**: \`${category}\``,
		`>`,
		`> ${cleanDetail || "Remote agent execution failed; task session is safely retained on target device."}`,
	].join("\n");
}

export function groupDeviceHits(devices: readonly GroupDevice[], query: string): AtHit[] {
	return devices
		.filter((d) => `${d.name} ${d.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
		.map((d) => ({
			providerId: "host:group-devices",
			providerLabel: "Bot",
			title: d.name,
			hint: d.id,
			text: groupDeviceToken(d),
		}));
}
/** Targets come only from explicit stable-id tokens, never ambiguous display names. */
export function groupMessageTargets(text: string, devices: readonly GroupDevice[]): string[] {
	return [...new Set(devices.filter((d) => text.includes(groupDeviceToken(d))).map((d) => d.id))];
}
export function groupConversationState(
	roomId: string,
	detail: GroupDetail | null,
	devices: readonly GroupDevice[],
	zh = false,
): { state: UiState; labels: ReadonlyMap<string, string> } {
	const labels = new Map<string, string>();
	const entries: UiMessage[] = [];
	const bots = new Map(devices.map((bot) => [bot.id, bot]));
	for (const bot of detail?.bots ?? []) bots.set(bot.id, { ...bots.get(bot.id), ...bot });
	const statuses = zh
		? { queued: "排队中", running: "运行中", completed: "已完成", failed: "失败", interrupted: "已中断" }
		: { queued: "Queued", running: "Running", completed: "Completed", failed: "Failed", interrupted: "Interrupted" };
	const tasks = new Map((detail?.tasks ?? []).map((task) => [task.id, task]));
	const reportedTasks = new Set<string>();
	const botLabel = (botId: string | undefined, name: string, deviceId?: string) => {
		const bot = botId ? bots.get(botId) : undefined;
		const device = bot?.deviceName || deviceId || bot?.deviceId;
		return device ? `${name} · ${device}` : name;
	};
	for (const message of detail?.messages ?? []) {
		const id = `group-message:${message.id}`;
		const isBot = message.sender.type === "bot";
		const rawText = message.text;
		let text = isBot ? formatDeviceFailureReport(rawText, zh) : formatGroupDisplayText(rawText);
		// Replies stay anchored to the message they answer; retention may have evicted the parent.
		const parent = message.replyToMessageId
			? detail?.messages.find((entry) => entry.id === message.replyToMessageId)
			: undefined;
		if (parent) {
			const quoted = formatGroupDisplayText(parent.text).replace(/\s+/g, " ").slice(0, 120);
			text = `> ↩ ${parent.sender.name}: ${quoted}\n\n${text}`;
		}
		entries.push({
			id,
			role: isBot ? "assistant" : "user",
			timestamp: message.createdAt,
			content: [{ type: "text", text }],
		});
		if (!isBot) {
			labels.set(id, message.sender.name);
			continue;
		}
		// Hub report messages link to tasks; human dispatch messages also carry taskIds.
		// Match the stable Bot id too, never report text or display names.
		const linkedTasks = (message.taskIds ?? [])
			.map((taskId) => tasks.get(taskId))
			.filter((task): task is GroupTask => !!task && task.botId === message.sender.id);
		for (const task of linkedTasks) if (task.report) reportedTasks.add(task.id);
		const status = [...new Set(linkedTasks.map((task) => statuses[task.status]))].join(" · ");
		const isPrimary = Boolean(detail?.room.primaryBotId && message.sender.id === detail.room.primaryBotId);
		const coordinatorTag = isPrimary ? ` [${zh ? "群组主管" : "Coordinator"}]` : "";
		const sender = `${botLabel(message.sender.id, message.sender.name, message.sender.sourceDeviceId)}${coordinatorTag}`;
		labels.set(id, status ? `${sender} · ${status}` : sender);
	}
	for (const task of detail?.tasks ?? []) {
		if (reportedTasks.has(task.id) || task.kind === "result") continue;
		const id = `group-task:${task.id}`;
		const bot = bots.get(task.botId);
		const isSubagentTask = Boolean(task.parentTaskId || (task.sourceBotId && task.sourceBotId !== task.botId));
		const subagentTag = zh ? "协同子代理" : "Worker Subagent";
		const labelPrefix = botLabel(task.botId, bot?.name ?? task.botId, task.deviceId);
		labels.set(
			id,
			isSubagentTask
				? `${labelPrefix} [${subagentTag}] · ${statuses[task.status]}`
				: `${labelPrefix} · ${statuses[task.status]}`,
		);
		const rawReport = task.report;
		const taskText = formatGroupDisplayText(task.text);
		let body: string;
		if (rawReport) {
			if (isSubagentTask) {
				const summaryTitle = zh ? "📋 展开查看工作内容与交付详情" : "📋 View Detailed Delivery & Evidence";
				body = [
					`> 🤖 **${zh ? "协同子代理交付完成" : "Worker Subagent Completed"}** · \`@${bot?.name ?? task.botId}\``,
					`>`,
					`> 🎯 **${zh ? "分配指令" : "Instruction"}**：${taskText}`,
					``,
					`<details>`,
					`<summary>${summaryTitle}</summary>`,
					``,
					formatDeviceFailureReport(rawReport, zh),
					``,
					`</details>`,
				].join("\n");
			} else {
				body = formatDeviceFailureReport(rawReport, zh);
			}
		} else if (task.status === "running") {
			const phaseLabel = isSubagentTask
				? zh
					? "协同子代理执行中"
					: "Worker Subagent Running"
				: zh
					? "任务执行中"
					: "Task Running";
			const progressPhase = task.progress?.phase;
			const toolName = task.progress?.toolName;
			const progressText = task.progress?.text?.trim();
			body = [
				`> ⏳ **${phaseLabel}**${isSubagentTask ? ` · \`@${bot?.name ?? task.botId}\`` : ""}`,
				`>`,
				`> **${zh ? (isSubagentTask ? "分配指令" : "目标指令") : isSubagentTask ? "Instruction" : "Instruction"}**：${taskText}`,
				...(progressPhase
					? [
							`> **${zh ? "执行阶段" : "Phase"}**：\`${progressPhase}\`${toolName ? ` · ${zh ? "工具" : "Tool"}: \`${toolName}\`` : ""}`,
						]
					: []),
				...(progressText ? [`>`, `> ${progressText}`] : []),
			].join("\n");
		} else if (task.status === "queued") {
			const queueLabel = isSubagentTask
				? zh
					? "协同子代理排队等待调度"
					: "Worker Subagent Queued"
				: zh
					? "任务排队等待调度"
					: "Task Queued";
			body = [
				`> ⏱️ **${queueLabel}**${isSubagentTask ? ` · \`@${bot?.name ?? task.botId}\`` : ""}`,
				`>`,
				`> **${zh ? (isSubagentTask ? "分配指令" : "目标指令") : isSubagentTask ? "Instruction" : "Instruction"}**：${taskText}`,
			].join("\n");
		} else if (task.status === "failed" && isSubagentTask) {
			body = [
				`> ❌ **${zh ? "协同子代理执行失败" : "Worker Subagent Failed"}** · \`@${bot?.name ?? task.botId}\``,
				`>`,
				`> 🎯 **${zh ? "分配指令" : "Instruction"}**：${taskText}`,
				...(rawReport ? [``, formatDeviceFailureReport(rawReport, zh)] : []),
			].join("\n");
		} else {
			body = `${statuses[task.status]}\n\n${taskText}`;
		}
		entries.push({
			id,
			role: "assistant",
			timestamp: task.createdAt,
			content: [
				{
					type: "text",
					text: body,
				},
			],
		});
	}
	entries.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
	const state: UiState = {
		clientId: "device-group",
		cwd: "",
		sessionId: `device-group:${roomId}`,
		conversationId: `device-group:${roomId}`,
		rev: 0,
		messages: entries,
		streamingMessage: null,
		isStreaming: false,
		model: null,
		thinkingLevel: "",
		availableThinkingLevels: [],
		queue: { steering: [], followUp: [] },
		tools: [],
		version: 0,
		piConfigured: true,
		piAgentInstalled: true,
		stats: {
			totalMessages: entries.length,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			contextUsage: { tokens: null, contextWindow: 0, percent: null },
		},
	};
	return { state, labels };
}

export function groupSendAttempt(
	previous: { fingerprint: string; key: string } | null,
	roomId: string,
	text: string,
	targets: readonly string[],
	newKey: () => string,
) {
	const fingerprint = JSON.stringify({ roomId, text, targetBotIds: [...targets].sort() });
	return previous?.fingerprint === fingerprint ? previous : { fingerprint, key: newKey() };
}
