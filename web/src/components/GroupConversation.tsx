import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";
import { GroupDeliveries } from "./GroupDeliveries";
import { GroupNativeInteractions } from "./GroupNativeInteractions";
import { DeviceFileTransfer } from "./DeviceFileTransfer";
import { GroupTaskDetails } from "./GroupTaskDetails";
import { GroupWorkspaceActions } from "./GroupWorkspaceActions";
import { GroupCanvasBinding } from "./GroupCanvasBinding";
import { GroupBotPresets } from "./GroupBotPresets";
import { appUrl } from "../base-url";
import { openGroupEventStream, taskProgressMatches, acceptTaskProgress } from "../group-event-stream";
import { randomUuid } from "../uuid";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n, useT } from "../i18n";
import { groupAttention } from "../group-attention";
import { buildUiSlots, type UiSlotEntry } from "../ui-slots";
import { groupConversationState, groupSendAttempt, type GroupDetail, type GroupDevice } from "../device-group-messages";

type PersistentConversation = import("../device-group-messages").GroupBotConversation;

class GroupRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code = "",
	) {
		super(message);
	}
}
async function request<T>(path: string, signal: AbortSignal, body?: object): Promise<T> {
	const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
		method: body ? "POST" : "GET",
		credentials: "same-origin",
		signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
		...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok)
		throw new GroupRequestError(response.status, data.error || String(response.status), data.code ?? "");
	return data;
}
const emptyMap = new Map();
const noop = () => {};
export function GroupConversation({
	roomId,
	active = true,
	onBack,
	uiHeaderSlots,
	uiActionSlots,
}: {
	roomId: string;
	active?: boolean;
	onBack?: () => void;
	uiHeaderSlots?: UiSlotEntry[];
	uiActionSlots?: UiSlotEntry[];
}) {
	// Key the entire stream/composer lifecycle by room, including in-flight mutations and drafts.
	return (
		<GroupRoom
			key={roomId}
			roomId={roomId}
			active={active}
			onBack={onBack}
			uiHeaderSlots={uiHeaderSlots}
			uiActionSlots={uiActionSlots}
		/>
	);
}
function GroupRoom({
	roomId,
	active,
	onBack,
	uiHeaderSlots,
	uiActionSlots,
}: {
	roomId: string;
	active: boolean;
	onBack?: () => void;
	uiHeaderSlots?: UiSlotEntry[];
	uiActionSlots?: UiSlotEntry[];
}) {
	const { locale } = useI18n();
	const zh = isZhLocale(locale);
	const [detail, setDetail] = useState<GroupDetail | null>(null);
	const devices: GroupDevice[] = detail?.bots ?? [];
	const [error, setError] = useState("");
	const [unavailable, setUnavailable] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const [interactionsRevision, setInteractionsRevision] = useState(0);
	const [eventsConnected, setEventsConnected] = useState(false);
	const [conversations, setConversations] = useState<PersistentConversation[]>([]);
	const [conversationError, setConversationError] = useState("");
	const [activeToolTab, setActiveToolTab] = useState<"deliveries" | "transfers" | "canvas" | "presets" | null>(null);
	const [viewTaskId, setViewTaskId] = useState<string | null>(null);
	const handleCloseDetails = useCallback(() => setViewTaskId(null), []);
	function invalidatesRoom(cause: unknown): boolean {
		return (
			cause instanceof GroupRequestError &&
			(cause.status === 404 || cause.status === 403 || (cause.status === 409 && cause.code === "REPAIR_REQUIRED"))
		);
	}
	function explain(cause: unknown): string {
		if (cause instanceof GroupRequestError && cause.status === 409 && cause.code === "REPAIR_REQUIRED")
			return zh
				? "设备绑定已失效，请返回设备设置重新绑定。"
				: "Device binding expired. Return to device settings and bind again.";
		return cause instanceof Error ? cause.message : String(cause);
	}
	const generation = useRef(0);
	const mutation = useRef<AbortController | null>(null);
	const retry = useRef<{ fingerprint: string; key: string } | null>(null);
	const sending = useRef(false);
	useEffect(() => {
		const token = ++generation.current;
		const progress = new Map<string, import("../../../server/protocol").DeviceTaskProgress>();
		let stream: (() => void) | null = null;
		let connected = false;
		let dirty = false;
		let controller: AbortController | null = null;
		let inflight = false;
		async function poll() {
			if (generation.current !== token || !active || document.visibilityState === "hidden") return;
			if (inflight) {
				dirty = true;
				return;
			}
			dirty = false;
			inflight = true;
			controller = new AbortController();
			const signal = controller.signal;
			try {
				const base = `rooms/${encodeURIComponent(roomId)}`;
				const [room, list] = await Promise.allSettled([
					request<GroupDetail>(base, signal),
					request<{ conversations: PersistentConversation[] }>(`${base}/conversations`, signal),
				]);
				if (generation.current !== token || signal.aborted) return;
				if (list.status === "fulfilled" && Array.isArray(list.value.conversations)) {
					setConversations(list.value.conversations);
					setConversationError("");
				} else {
					setConversationError(
						zh ? "无法更新对话列表，请稍后重试。" : "Could not refresh conversations. Try again shortly.",
					);
				}
				if (room.status === "rejected") throw room.reason;
				setDetail({
					...room.value,
					tasks: room.value.tasks.map((task) => ({
						...task,
						progress: taskProgressMatches(task, progress.get(task.id)) ? progress.get(task.id) : undefined,
					})),
				});
				for (const id of progress.keys())
					if (!room.value.tasks.some((task) => taskProgressMatches(task, progress.get(id)))) progress.delete(id);
				setUnavailable(false);
			} catch (cause) {
				if (generation.current !== token || signal.aborted) return;
				if (invalidatesRoom(cause)) {
					setDetail(null);
					setUnavailable(true);
				}
				setError(explain(cause));
			} finally {
				inflight = false;
				if (dirty && generation.current === token) void poll();
			}
		}
		function connect() {
			if (
				generation.current !== token ||
				!active ||
				document.visibilityState === "hidden" ||
				stream ||
				typeof EventSource === "undefined"
			)
				return;
			stream = openGroupEventStream(
				withToken(appUrl(`/api/device-center/rooms/${encodeURIComponent(roomId)}/events`)),
				{
					alive: () => generation.current === token && document.visibilityState !== "hidden",
					sync: () => {
						setInteractionsRevision((value) => value + 1);
						void poll();
					},
					connected: (value) => {
						connected = value;
						setEventsConnected(value);
					},
					progress: (value) => {
						const previous = progress.get(value.taskId);
						if (!acceptTaskProgress(previous, value) || (progress.size >= 128 && !previous)) return;
						progress.set(value.taskId, value);
						setDetail((current) =>
							current
								? {
										...current,
										tasks: current.tasks.map((task) =>
											taskProgressMatches(task, value) ? { ...task, progress: value } : task,
										),
									}
								: current,
						);
					},
				},
			);
		}
		void poll();
		connect();
		const timer = window.setInterval(() => {
			if (!connected) void poll();
		}, 2000);
		const visibility = () => {
			if (document.visibilityState === "hidden") {
				controller?.abort();
				dirty = false;
				stream?.();
				stream = null;
				connected = false;
				setEventsConnected(false);
			} else {
				void poll();
				connect();
			}
		};
		document.addEventListener("visibilitychange", visibility);
		return () => {
			++generation.current;
			setEventsConnected(false);
			stream?.();
			controller?.abort();
			mutation.current?.abort();
			clearInterval(timer);
			document.removeEventListener("visibilitychange", visibility);
		};
	}, [roomId, active, refresh]);
	const { state, labels } = useMemo(
		() => groupConversationState(roomId, detail, devices, zh),
		[roomId, detail, devices, zh],
	);
	const t = useT();
	const uiSlots = useMemo(() => {
		return buildUiSlots([], {
			locale,
			t: (k: string) => t(k as any),
		});
	}, [locale, t]);
	const headerSlots: UiSlotEntry[] = useMemo(
		() => uiHeaderSlots ?? (uiSlots["device.group.header"] ?? []).filter((e) => !e.hidden),
		[uiHeaderSlots, uiSlots],
	);
	const actionSlots: UiSlotEntry[] = useMemo(
		() => uiActionSlots ?? (uiSlots["device.group.actions"] ?? []).filter((e) => !e.hidden),
		[uiActionSlots, uiSlots],
	);
	const members = devices.filter((d) => d.enabled !== false && detail?.room.botIds.includes(d.id));
	const attentionCount = useMemo(
		() => conversations.filter((conversation) => Boolean(groupAttention(conversation))).length,
		[conversations],
	);
	async function send(
		text: string,
		targets: string[],
		conversationId?: string,
		options?: { planOnly?: boolean },
	): Promise<boolean> {
		if (!active || unavailable || !detail || sending.current) return false;
		const destination = conversationId;
		const selected = conversations.find((conversation) => conversation.id === destination);
		if (
			destination &&
			(!selected ||
				selected.status === "closed" ||
				conversationError ||
				!members.some((bot) => bot.id === selected.botId))
		) {
			setError(
				zh
					? "所选对话不可用，请重新选择对话或新建任务。"
					: "Selected conversation is unavailable. Choose a conversation or New task.",
			);
			return false;
		}
		if (selected && targets.some((id) => id !== selected.botId)) {
			setError(
				zh
					? "继续对话只能发送给原 Bot，请移除其他目标。"
					: "Continue with the original Bot only. Remove other targets.",
			);
			return false;
		}
		if (targets.some((id) => !detail.room.botIds.includes(id))) return false;
		const planOnly = options?.planOnly === true;
		const planningBots = selected
			? members.filter((bot) => bot.id === selected.botId)
			: members.filter((bot) => targets.includes(bot.id) || (!targets.length && bot.id === detail.room.primaryBotId));
		if (planOnly && planningBots.some((bot) => !bot.tools?.includes("plan_update"))) {
			setError(
				zh
					? "所选 Bot 未授权 plan_update，请先在 Bot 工具白名单中启用。"
					: "Selected Bot is not authorized to use plan_update. Enable it in the Bot tool allowlist first.",
			);
			return false;
		}
		retry.current = groupSendAttempt(
			retry.current,
			JSON.stringify([roomId, destination, planOnly]),
			text,
			targets,
			randomUuid,
		);
		const controller = new AbortController();
		mutation.current = controller;
		const token = generation.current;
		sending.current = true;
		try {
			const base = `rooms/${encodeURIComponent(roomId)}`;
			await request(
				destination ? `${base}/conversations/${encodeURIComponent(destination)}/messages` : `${base}/messages`,
				controller.signal,
				destination
					? { text, kind: "message", idempotencyKey: retry.current.key, ...(planOnly ? { planOnly: true } : {}) }
					: { text, targetBotIds: targets, idempotencyKey: retry.current.key, ...(planOnly ? { planOnly: true } : {}) },
			);
			if (controller.signal.aborted || generation.current !== token) return false;
			retry.current = null;
			setError("");
			setRefresh((n) => n + 1);
			return true;
		} catch (cause) {
			if (!controller.signal.aborted && generation.current === token) {
				if (destination) {
					setError(
						zh
							? "继续对话失败，请重试或重新选择目标。"
							: "Could not continue the conversation. Retry or choose a target.",
					);
					return false;
				}
				if (invalidatesRoom(cause)) {
					setDetail(null);
					setUnavailable(true);
				}
				setError(explain(cause));
			}
			return false;
		} finally {
			if (mutation.current === controller) {
				sending.current = false;
				mutation.current = null;
			}
		}
	}
	return (
		<>
			<div className="dg-head">
				<div className="dg-head-info">
					<strong className="dg-head-title">{detail?.room.name ?? (zh ? "群聊" : "Group")}</strong>
					{members.length > 0 && (
						<span
							className="dg-head-pill"
							title={members.map((m) => (m.deviceId ? `${m.name} (${m.deviceId})` : m.name)).join(", ")}
						>
							<span className="dg-head-pill-dot" />
							<span>
								{members.length} {zh ? "位协作 Bot" : "Bots"}
							</span>
						</span>
					)}
				</div>
				<div className="dg-head-nav">
					<button
						type="button"
						className={`dg-nav-tab ${activeToolTab === "deliveries" ? "active" : ""} ${attentionCount > 0 ? "has-attention" : ""}`}
						onClick={() => setActiveToolTab((cur) => (cur === "deliveries" ? null : "deliveries"))}
						title={zh ? "交付与审查" : "Deliveries & Reviews"}
					>
						<span className="dg-nav-icon">📦</span>
						<span className="dg-nav-text">{zh ? "交付与待办" : "Deliveries"}</span>
						{attentionCount > 0 ? (
							<span className="dg-nav-badge attention">{attentionCount}</span>
						) : conversations.length > 0 ? (
							<span className="dg-nav-badge">{conversations.length}</span>
						) : null}
					</button>
					<button
						type="button"
						className={`dg-nav-tab ${activeToolTab === "transfers" ? "active" : ""}`}
						onClick={() => setActiveToolTab((cur) => (cur === "transfers" ? null : "transfers"))}
						title={zh ? "跨机大文件传输与断点续传" : "File Transfers"}
					>
						<span className="dg-nav-icon">📁</span>
						<span className="dg-nav-text">{zh ? "文件传输" : "Transfers"}</span>
					</button>
					<button
						type="button"
						className={`dg-nav-tab ${activeToolTab === "canvas" ? "active" : ""}`}
						onClick={() => setActiveToolTab((cur) => (cur === "canvas" ? null : "canvas"))}
						title={zh ? "群画布引用" : "Group Canvas"}
					>
						<span className="dg-nav-icon">🎨</span>
						<span className="dg-nav-text">{zh ? "群画布" : "Canvas"}</span>
						{detail?.room.canvasBinding && <span className="dg-nav-dot active" />}
					</button>
					<button
						type="button"
						className={`dg-nav-tab ${activeToolTab === "presets" ? "active" : ""}`}
						onClick={() => setActiveToolTab((cur) => (cur === "presets" ? null : "presets"))}
						title={zh ? "Bot 配置与预设" : "Bot Presets"}
					>
						<span className="dg-nav-icon">🤖</span>
						<span className="dg-nav-text">{zh ? "Bot 预设" : "Presets"}</span>
					</button>
				</div>
				<div className="dg-head-actions">
					{headerSlots.map((entry: UiSlotEntry) => (
						<button key={entry.id} type="button" className="btn secondary" title={entry.label}>
							{entry.label}
						</button>
					))}
					{onBack && (
						<button type="button" className="btn dg-back-btn" onClick={onBack}>
							{zh ? "返回对话" : "Back to chat"}
						</button>
					)}
				</div>
			</div>
			{error && (
				<div className="dg-error-banner" role="alert">
					{error}
					{unavailable
						? zh
							? "此群聊已删除或你已不在群中，请返回。"
							: "This group is unavailable or you are no longer a member. Return to chat."
						: null}
				</div>
			)}
			<div className={`dg-tools-shelf ${activeToolTab ? "open" : "collapsed"}`}>
				<div className="dg-tools-shelf-header">
					<span className="dg-tools-shelf-title">
						{activeToolTab === "deliveries" && (zh ? "📦 交付与待办事项" : "📦 Deliveries & Attention")}
						{activeToolTab === "transfers" && (zh ? "📁 跨机大文件传输与断点续传" : "📁 Cross-Device File Transfers")}
						{activeToolTab === "canvas" && (zh ? "🎨 群画布工作流" : "🎨 Group Canvas Workflow")}
						{activeToolTab === "presets" && (zh ? "🤖 Bot 配置与预设" : "🤖 Bot Configuration & Presets")}
					</span>
					<button
						type="button"
						className="btn dg-tools-close-btn"
						onClick={() => setActiveToolTab(null)}
						title={zh ? "收起面板" : "Collapse panel"}
					>
						✕ {zh ? "收起" : "Close"}
					</button>
				</div>
				<div className="dg-tools-shelf-content">
					<div className={`dg-tool-pane ${activeToolTab === "deliveries" ? "active" : ""}`}>
						<GroupDeliveries
							roomId={roomId}
							conversations={conversations}
							bots={devices}
							disabled={!active || unavailable}
							error={conversationError}
						/>
					</div>
					<div className={`dg-tool-pane ${activeToolTab === "transfers" ? "active" : ""}`}>
						<DeviceFileTransfer roomId={roomId} bots={devices} disabled={!active || unavailable} />
					</div>
					<div className={`dg-tool-pane ${activeToolTab === "canvas" ? "active" : ""}`}>
						<GroupCanvasBinding
							roomId={roomId}
							binding={detail?.room.canvasBinding}
							onSaved={() => setRefresh((n) => n + 1)}
						/>
					</div>
					<div className={`dg-tool-pane ${activeToolTab === "presets" ? "active" : ""}`}>
						<GroupBotPresets bots={members} onSaved={() => setRefresh((n) => n + 1)} />
					</div>
				</div>
			</div>
			{(attentionCount > 0 || (detail?.tasks && detail.tasks.length > 0)) && (
				<div className="dg-tasks-strip">
					{attentionCount > 0 && (
						<button
							type="button"
							className={`dg-task-chip dg-attention-chip ${activeToolTab === "deliveries" ? "active" : ""}`}
							onClick={() => setActiveToolTab((cur) => (cur === "deliveries" ? null : "deliveries"))}
							title={zh ? "查看需要处理的交付与事项" : "View items needing attention"}
						>
							<span className="dg-attention-dot" />
							<span className="dg-attention-text">
								{zh ? `${attentionCount} 项待处理` : `${attentionCount} need attention`}
							</span>
						</button>
					)}
					{detail?.tasks &&
						detail.tasks.slice(0, 4).map((task) => (
							<div key={task.id} className="dg-task-chip">
								<span className={`dg-task-status-dot status-${task.status}`} />
								<span className="dg-task-title" title={task.text}>
									{task.text.length > 28 ? task.text.slice(0, 28) + "..." : task.text}
								</span>
								<button type="button" className="btn dg-task-detail-btn" onClick={() => setViewTaskId(task.id)}>
									{zh ? "详情" : "Details"}
								</button>
							</div>
						))}
				</div>
			)}
			<GroupNativeInteractions
				roomId={roomId}
				disabled={!active || unavailable}
				refreshKey={interactionsRevision}
				connected={eventsConnected}
			/>
			{(() => {
				const activeTask =
					detail?.tasks.find((t) => t.id === viewTaskId) ??
					detail?.tasks.find((t) => t.status === "running") ??
					detail?.tasks.at(-1);
				return (
					<GroupWorkspaceActions
						roomId={roomId}
						activeTaskId={activeTask?.id}
						taskSnapshotRevision={activeTask?.botRevision}
						planState={activeTask?.plan}
						uiSlotEntries={actionSlots}
						onStartPlanExecution={
							activeTask?.status === "completed"
								? async (taskId) => {
										await request(
											`rooms/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(taskId)}/approve-plan`,
											new AbortController().signal,
											{},
										);
										setRefresh((n) => n + 1);
									}
								: undefined
						}
					/>
				);
			})()}
			<MessageList state={state} liveOutputs={emptyMap} toolStatuses={emptyMap} messageLabels={labels} readOnly />
			{viewTaskId && <GroupTaskDetails roomId={roomId} taskId={viewTaskId} onClose={handleCloseDetails} />}
			<ChatInput
				groupDevices={members}
				groupPrimaryBotName={members.find((bot) => bot.id === detail?.room.primaryBotId)?.name}
				groupConversations={conversations}
				groupConversationError={conversationError}
				onGroupSend={send}
				streaming={false}
				messages={state.messages}
				slashCommands={[]}
				modelState={null}
				models={[]}
				modelsLoading={false}
				attachments={[]}
				onRemoveAttachment={noop}
				onAddImageFiles={noop}
				onAddLocalFiles={noop}
				onNotice={(_level, text) => setError(text)}
				onSent={noop}
				onManageModels={noop}
				providerKeys={{}}
				quickPhrases={[]}
				quickPhrasesEnabled={false}
				groupReady={active && !!detail && !unavailable}
				sessionId={`device-group:${roomId}`}
				conversationId={`device-group:${roomId}`}
			/>
		</>
	);
}
