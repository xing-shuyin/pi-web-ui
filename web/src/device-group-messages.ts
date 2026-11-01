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
				.filter((c) => c.botId === bot.id && c.status !== "closed")
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
};
export type GroupTask = {
	progress?: import("../../server/protocol").DeviceTaskProgress;
	attemptId?: string;
	id: string;
	deviceId: string;
	botId: string;
	text: string;
	report?: string;
	status: "queued" | "running" | "completed" | "failed" | "interrupted";
	createdAt: number;
	botRevision?: number;
	planOnly?: boolean;
	plan?: import("./group-capabilities").GroupTaskPlan;
	canvasRef?: import("./group-capabilities").GroupCanvasRef;
};
export type GroupDetail = {
	room: {
		id: string;
		name: string;
		botIds: string[];
		primaryBotId?: string;
		canvasBinding?: { deviceId: string; graphId: string; cwd: string; title: string };
	};
	bots: GroupDevice[];
	messages: GroupMessage[];
	tasks: GroupTask[];
};

export function groupDeviceToken(device: GroupDevice): string {
	return `@${device.name}(${device.id})`;
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
		entries.push({
			id,
			role: message.sender.type === "bot" ? "assistant" : "user",
			timestamp: message.createdAt,
			content: [{ type: "text", text: message.text }],
		});
		if (message.sender.type !== "bot") {
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
		const sender = botLabel(message.sender.id, message.sender.name, message.sender.sourceDeviceId);
		labels.set(id, status ? `${sender} · ${status}` : sender);
	}
	for (const task of detail?.tasks ?? []) {
		if (reportedTasks.has(task.id)) continue;
		const id = `group-task:${task.id}`;
		const bot = bots.get(task.botId);
		labels.set(id, `${botLabel(task.botId, bot?.name ?? task.botId, task.deviceId)} · ${statuses[task.status]}`);
		entries.push({
			id,
			role: "assistant",
			timestamp: task.createdAt,
			content: [
				{
					type: "text",
					text:
						task.report ||
						`${statuses[task.status]}\n\n${task.text}${task.status === "running" && task.progress ? `\n\n${task.progress.phase === "tool" ? task.progress.toolName || "tool" : task.progress.phase}\n${task.progress.text || ""}` : ""}`,
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
