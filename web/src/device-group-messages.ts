import type { UiMessage, UiState } from "./types";
import type { AtHit } from "./at-mention";
import type { Translate } from "./i18n";

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
	t: Translate,
): AtHit[] {
	return devices.flatMap((bot) => {
		const choices = [
			{
				providerId: "host:group-devices",
				providerLabel: t("newChat"),
				title: bot.name,
				hint: bot.id,
				text: `@${bot.name} · ${t("newChat")}`,
			},
			...conversations
				.filter((c) => c.botId === bot.id && c.status !== "closed" && !c.stale)
				.map((c) => ({
					providerId: "host:group-conversations",
					providerLabel: t("deviceGroupMentionContinue"),
					title: `${bot.name} · ${c.name || t("groupDeliveriesUntitledConversation")}`,
					hint: c.id,
					text: `@${bot.name} · ${t("deviceGroupMentionContinuePrefix")}${c.name || t("groupDeliveriesUntitledConversation")}`,
				})),
		];
		return choices.filter((hit) =>
			`${hit.title} ${hit.providerLabel} ${bot.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
		);
	});
}

export type GroupWebhook = import("../../server/device-center/store.js").GroupWebhook;
export type GroupWebhookEventType = import("../../server/device-center/store.js").GroupWebhookEventType;

export type GroupMessage = {
	id: string;
	text: string;
	createdAt: number;
	sender: { name: string; type?: "human" | "bot" | "webhook"; id?: string; sourceDeviceId?: string };
	taskIds?: string[];
	targetBotIds?: string[];
	replyToMessageId?: string;
	/** 从私聊投递过来的消息：保留来源，渲染时标注"来自与 X 的私聊"。 */
	sharedFrom?: { mode: "as_bot" | "as_forward"; sourceRoomId: string; botId: string; messageIds: string[] };
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
	status: "queued" | "waiting" | "running" | "completed" | "failed" | "interrupted";
	/** 排队原因（`bot_busy` = 同 Bot 已有任务在跑；`dependency` = 上一轮还没结束）。 */
	blockReason?: string;
	blockReasonDetail?: string;
	queuedReason?: string;
	dependsOnTaskId?: string;
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
		/** `direct` = 与单个 Bot 的私聊房间（无成员/黑板/路由/画布）；缺省为群组。 */
		kind?: "group" | "direct";
		botIds: string[];
		primaryBotId?: string;
		canvasBinding?: { deviceId: string; graphId: string; cwd: string; title: string };
		blackboard?: import("../../server/device-center/store.js").GroupBlackboard;
		webhooks?: GroupWebhook[];
		hubRelayBaseUrl?: string;
	};
	bots: GroupDevice[];
	messages: GroupMessage[];
	tasks: GroupTask[];
};

export function groupDeviceToken(device: GroupDevice): string {
	return `@${device.name}(${device.id})`;
}

export function formatGroupDisplayText(text: string): string {
	return text.replace(/@([^\s()]+)\([a-f0-9-]{8,}\)/g, "@$1");
}

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

export function formatDeviceFailureReport(raw: string, t: Translate): string {
	if (!raw.includes("Device task failed")) return formatGroupDisplayText(raw);
	const match = raw.match(/Device task failed\s*\[phase=([^;]+);\s*category=([^\]]+)\]\.\s*(.*)/s);
	if (!match) return formatGroupDisplayText(raw);
	const [, phase, category, detail] = match;
	const phaseMap: Record<string, string> = {
		model: t("deviceGroupFailurePhaseModel"),
		tool: t("deviceGroupFailurePhaseTool"),
		approval: t("deviceGroupFailurePhaseApproval"),
		connection: t("deviceGroupFailurePhaseConnection"),
		handshake: t("deviceGroupFailurePhaseHandshake"),
		init: t("deviceGroupFailurePhaseInit"),
		switch_session: t("deviceGroupFailurePhaseSwitchSession"),
		new_chat: t("deviceGroupFailurePhaseNewChat"),
	};
	const phaseLabel = phaseMap[phase] || phase;
	const cleanDetail = detail.trim();
	return [
		t("deviceGroupFailureTitle", { phase: phaseLabel }),
		`>`,
		t("deviceGroupFailureMeta", { phase, category }),
		`>`,
		`> ${cleanDetail || t("deviceGroupFailureDetailFallback")}`,
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
export function groupMessageTargets(text: string, devices: readonly GroupDevice[]): string[] {
	return [...new Set(devices.filter((d) => text.includes(groupDeviceToken(d))).map((d) => d.id))];
}
export function groupConversationState(
	roomId: string,
	detail: GroupDetail | null,
	devices: readonly GroupDevice[],
	t: Translate,
): { state: UiState; labels: ReadonlyMap<string, string> } {
	const labels = new Map<string, string>();
	const entries: UiMessage[] = [];
	const bots = new Map(devices.map((bot) => [bot.id, bot]));
	for (const bot of detail?.bots ?? []) bots.set(bot.id, { ...bots.get(bot.id), ...bot });
	const statuses: Record<string, string> = {
		queued: t("groupWorkItemsStatusQueued"),
		waiting: t("deviceGroupStatusWaitingDependency"),
		running: t("tabRunning"),
		completed: t("groupWorkItemsStatusCompleted"),
		failed: t("groupWorkItemsStatusFailed"),
		interrupted: t("groupWorkItemsStatusInterrupted"),
	};
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
		let text = isBot ? formatDeviceFailureReport(rawText, t) : formatGroupDisplayText(rawText);
		if (message.sharedFrom) {
			const botName = bots.get(message.sharedFrom.botId)?.name ?? message.sharedFrom.botId;
			const label =
				message.sharedFrom.mode === "as_bot"
					? t("deviceGroupSharedFromBot", { bot: botName })
					: t("deviceGroupSharedFromForward", { bot: botName });
			text = `${label}\n\n${text}`;
		}
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
			const tag = message.sender.type === "webhook" ? " [Webhook]" : "";
			labels.set(id, `${message.sender.name}${tag}`);
			continue;
		}
		const linkedTasks = (message.taskIds ?? [])
			.map((taskId) => tasks.get(taskId))
			.filter((task): task is GroupTask => !!task && task.botId === message.sender.id);
		for (const task of linkedTasks) if (task.report) reportedTasks.add(task.id);
		const status = [...new Set(linkedTasks.map((task) => statuses[task.status]))].join(" · ");
		const isPrimary = Boolean(detail?.room.primaryBotId && message.sender.id === detail.room.primaryBotId);
		const coordinatorTag = isPrimary ? ` [${t("deviceGroupCoordinatorTag")}]` : "";
		const sender = `${botLabel(message.sender.id, message.sender.name, message.sender.sourceDeviceId)}${coordinatorTag}`;
		labels.set(id, status ? `${sender} · ${status}` : sender);
	}
	for (const task of detail?.tasks ?? []) {
		if (reportedTasks.has(task.id) || task.kind === "result") continue;
		const id = `group-task:${task.id}`;
		const bot = bots.get(task.botId);
		const isSubagentTask = Boolean(task.parentTaskId || (task.sourceBotId && task.sourceBotId !== task.botId));
		const subagentTag = t("deviceGroupWorkerSubagent");
		const labelPrefix = botLabel(task.botId, bot?.name ?? task.botId, task.deviceId);
		const statusLabel =
			task.status === "waiting"
				? task.dependsOnTaskId
					? t("groupConversationWaitingUpstream")
					: t("deviceGroupStatusWaitingDependency")
				: (statuses[task.status] ?? task.status);
		labels.set(
			id,
			isSubagentTask ? `${labelPrefix} [${subagentTag}] · ${statusLabel}` : `${labelPrefix} · ${statusLabel}`,
		);
		const rawReport = task.report;
		const taskText = formatGroupDisplayText(task.text);
		let body: string;
		if (rawReport) {
			if (isSubagentTask) {
				const summaryTitle = t("deviceGroupSubagentSummary");
				body = [
					t("deviceGroupSubagentCompleted", { bot: bot?.name ?? task.botId }),
					t("deviceGroupInstructionLine", {
						label: t("deviceGroupInstructionAssigned"),
						text: taskText,
					}),
					``,
					`<details>`,
					`<summary>${summaryTitle}</summary>`,
					``,
					formatDeviceFailureReport(rawReport, t),
					``,
					`</details>`,
				].join("\n");
			} else {
				body = formatDeviceFailureReport(rawReport, t);
			}
		} else if (task.status === "running") {
			const phaseLabel = isSubagentTask ? t("deviceGroupSubagentRunning") : t("deviceGroupTaskRunning");
			const progressPhase = task.progress?.phase;
			const toolName = task.progress?.toolName;
			const progressText = task.progress?.text?.trim();
			body = [
				`⏳ **${phaseLabel}**${isSubagentTask ? ` · \`@${bot?.name ?? task.botId}\`` : ""}`,
				t("deviceGroupInstructionLine", {
					label: isSubagentTask ? t("deviceGroupInstructionAssigned") : t("deviceGroupInstructionGoal"),
					text: taskText,
				}),
				...(progressPhase
					? [
							t("deviceGroupProgressPhaseLine", {
								phase: progressPhase,
								tool: toolName ? ` · \`${toolName}\`` : "",
							}),
						]
					: []),
				...(progressText ? [``, `> ${progressText}`] : []),
			].join("\n");
		} else if (task.status === "waiting") {
			const depTask = task.dependsOnTaskId ? tasks.get(task.dependsOnTaskId) : undefined;
			const depBot = depTask ? (bots.get(depTask.botId)?.name ?? depTask.botId) : undefined;
			const depSummary = depTask ? formatGroupTaskChip(depTask.text, depBot).summary : task.dependsOnTaskId;
			const waitingHeader = t("deviceGroupWaitingUpstreamTitle");
			body = [
				`${waitingHeader}${isSubagentTask ? ` · \`@${bot?.name ?? task.botId}\`` : ""}`,
				t("deviceGroupInstructionLine", {
					label: isSubagentTask ? t("deviceGroupInstructionAssigned") : t("deviceGroupInstructionGoal"),
					text: taskText,
				}),
				...(task.dependsOnTaskId
					? [
							t("deviceGroupDependsOnLine", {
								dep: `${depBot ? `@${depBot} · ` : ""}${depSummary || task.dependsOnTaskId}`,
							}),
						]
					: []),
			].join("\n");
		} else if (task.status === "queued") {
			const queueLabel = isSubagentTask ? t("deviceGroupSubagentQueued") : t("deviceGroupTaskQueued");
			body = [
				`⏱️ **${queueLabel}**${isSubagentTask ? ` · \`@${bot?.name ?? task.botId}\`` : ""}`,
				t("deviceGroupInstructionLine", {
					label: isSubagentTask ? t("deviceGroupInstructionAssigned") : t("deviceGroupInstructionGoal"),
					text: taskText,
				}),
			].join("\n");
		} else if (task.status === "failed" && isSubagentTask) {
			body = [
				t("deviceGroupSubagentFailed", { bot: bot?.name ?? task.botId }),
				t("deviceGroupInstructionLine", {
					label: t("deviceGroupInstructionAssigned"),
					text: taskText,
				}),
				...(rawReport ? [``, formatDeviceFailureReport(rawReport, t)] : []),
			].join("\n");
		} else {
			body = `${statuses[task.status] || task.status}\n\n${taskText}`;
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
