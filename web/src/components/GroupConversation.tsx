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
import { GroupDrawer, type GroupDrawerTab } from "./GroupDrawer";
import { useOverlayZIndex } from "../overlay-stack";
import "./group-share.css";
import type { GroupRouterConfig } from "./GroupRouterSettings";
import { GroupSteerModal } from "./GroupSteerModal";
import { appUrl } from "../base-url";
import { openGroupEventStream, taskProgressMatches, acceptTaskProgress } from "../group-event-stream";
import { randomUuid } from "../uuid";
import { withToken } from "../auth-token";
import { useI18n, useT } from "../i18n";
import { groupAttention } from "../group-attention";
import { buildUiSlots, type UiSlotEntry } from "../ui-slots";
import {
	groupConversationState,
	groupSendAttempt,
	formatGroupTaskChip,
	type GroupDetail,
	type GroupDevice,
} from "../device-group-messages";
import { setActiveGroupRoomData } from "../group-active-context";

type PersistentConversation = import("../device-group-messages").GroupBotConversation;
type RouterGroupDetail = GroupDetail & { room: { router?: GroupRouterConfig; kind?: "group" | "direct" } };

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
	const t = useT();
	const [detail, setDetail] = useState<RouterGroupDetail | null>(null);
	const devices: GroupDevice[] = detail?.bots ?? [];
	const [error, setError] = useState("");
	const [unavailable, setUnavailable] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const [interactionsRevision, setInteractionsRevision] = useState(0);
	const [eventsConnected, setEventsConnected] = useState(false);
	const [conversations, setConversations] = useState<PersistentConversation[]>([]);
	const [conversationError, setConversationError] = useState("");
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [drawerTab, setDrawerTab] = useState<GroupDrawerTab>("deliveries");
	/** 直聊房间（kind==="direct"）：没有黑板/路由/成员/画布，对应的头部入口与抽屉全部隐藏。 */
	const direct = detail?.room.kind === "direct";
	const [shareOpen, setShareOpen] = useState(false);
	const [shareGroups, setShareGroups] = useState<{ id: string; name: string; botIds: string[] }[]>([]);
	const [shareTarget, setShareTarget] = useState("");
	const [shareMode, setShareMode] = useState<"as_forward" | "as_bot">("as_forward");
	const [shareNote, setShareNote] = useState("");
	const [shareBusy, setShareBusy] = useState(false);
	const [shareNotice, setShareNotice] = useState("");
	const shareKey = useRef<string>("");
	const shareZIndex = useOverlayZIndex(shareOpen);
	const openShare = useCallback(() => {
		setShareOpen(true);
		setShareNotice("");
		shareKey.current = `share:${roomId}:${Date.now().toString(36)}`;
		const controller = new AbortController();
		void request<{ rooms: { id: string; name: string; botIds: string[] }[] }>("rooms", controller.signal)
			.then((data) => {
				const groups = (data.rooms ?? []).filter((room) => room.id !== roomId);
				setShareGroups(groups);
				setShareTarget((current) => current || groups[0]?.id || "");
			})
			.catch((cause) => setError(explain(cause)));
	}, [roomId]);
	const handleOpenDrawer = useCallback((tab: GroupDrawerTab) => {
		setDrawerTab(tab);
		setDrawerOpen(true);
	}, []);
	const handleCloseDrawer = useCallback(() => {
		setDrawerOpen(false);
	}, []);
	const [steerTask, setSteerTask] = useState<import("../device-group-messages").GroupTask | null>(null);
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
			return t("groupConversationDeviceBindingExpired");
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
					request<RouterGroupDetail>(base, signal),
					request<{ conversations: PersistentConversation[] }>(`${base}/conversations`, signal),
				]);
				if (generation.current !== token || signal.aborted) return;
				if (list.status === "fulfilled" && Array.isArray(list.value.conversations)) {
					setConversations(list.value.conversations);
					setConversationError("");
				} else {
					setConversationError(t("groupConversationConversationListFailed"));
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
	const { state, labels } = useMemo(() => {
		const displayDetail = detail?.room.router?.enabled
			? { ...detail, room: { ...detail.room, primaryBotId: undefined } }
			: detail;
		const result = groupConversationState(roomId, displayDetail, devices, t);
		const routerMessageIds = new Set(
			(detail?.messages ?? [])
				.filter((message) => String(message.sender.type) === "router")
				.map((message) => `group-message:${message.id}`),
		);
		const displayLabels = new Map(result.labels);
		for (const id of routerMessageIds) displayLabels.set(id, t("groupRouterLabel"));
		return {
			state: {
				...result.state,
				messages: result.state.messages.map((message) =>
					routerMessageIds.has(message.id) ? { ...message, role: "assistant" as const } : message,
				),
			},
			labels: displayLabels,
		};
	}, [roomId, detail, devices, t]);
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
	const directBot = detail?.room.kind === "direct" ? members[0] : undefined;
	const attentionCount = useMemo(
		() => conversations.filter((conversation) => Boolean(groupAttention(conversation))).length,
		[conversations],
	);
	const runningTasks = useMemo(
		() => (detail?.tasks ?? []).filter((task) => task.status === "running" || task.status === "queued"),
		[detail?.tasks],
	);

	const handleStopTask = useCallback(
		async (task: import("../device-group-messages").GroupTask) => {
			const convId =
				task.conversationId || conversations.find((c) => c.botId === task.botId && c.status !== "closed")?.id;
			if (!convId) return;
			try {
				await request(
					`rooms/${encodeURIComponent(roomId)}/conversations/${encodeURIComponent(convId)}/stop`,
					new AbortController().signal,
					{},
				);
				setRefresh((n) => n + 1);
			} catch (err: any) {
				setError(err?.message || t("groupConversationStopFailed"));
			}
		},
		[roomId, conversations, t],
	);

	useEffect(() => {
		setActiveGroupRoomData({
			roomId,
			detail,
			devices,
			members,
			conversations,
			attentionCount,
			disabled: !active || unavailable,
			conversationError,
		});
	}, [roomId, detail, devices, members, conversations, attentionCount, active, unavailable, conversationError]);

	useEffect(() => {
		return () => {
			setActiveGroupRoomData(null);
		};
	}, []);
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
			setError(t("groupConversationConversationUnavailable"));
			return false;
		}
		if (selected && targets.some((id) => id !== selected.botId)) {
			setError(t("groupConversationTargetMismatch"));
			return false;
		}
		if (targets.some((id) => !detail.room.botIds.includes(id))) return false;
		const planOnly = options?.planOnly === true;
		const planningBots = selected
			? members.filter((bot) => bot.id === selected.botId)
			: members.filter(
					(bot) =>
						targets.includes(bot.id) ||
						(!targets.length && !detail.room.router?.enabled && bot.id === detail.room.primaryBotId),
				);
		if (planOnly && planningBots.some((bot) => !bot.tools?.includes("plan_update"))) {
			setError(t("groupConversationPlanUpdateMissing"));
			return false;
		}
		const isPipeline = text.includes("->");
		retry.current = groupSendAttempt(
			retry.current,
			JSON.stringify([roomId, destination, planOnly, isPipeline]),
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
					? {
							text,
							kind: "message",
							idempotencyKey: retry.current.key,
							...(planOnly ? { planOnly: true } : {}),
							...(isPipeline ? { pipeline: true } : {}),
						}
					: {
							text,
							targetBotIds: targets,
							idempotencyKey: retry.current.key,
							...(planOnly ? { planOnly: true } : {}),
							...(isPipeline ? { pipeline: true } : {}),
						},
			);
			if (controller.signal.aborted || generation.current !== token) return false;
			retry.current = null;
			setError("");
			setRefresh((n) => n + 1);
			return true;
		} catch (cause) {
			if (!controller.signal.aborted && generation.current === token) {
				if (destination) {
					setError(t("groupConversationContinueFailed"));
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
					<div className="dg-head-brand">
						<span className="dg-brand-icon">⚡</span>
						<strong className="dg-head-title">{detail?.room.name ?? t("groupConversationDefaultTitle")}</strong>
					</div>
					{members.length > 0 && !direct && (
						<button
							type="button"
							className="dg-head-pill"
							onClick={() => handleOpenDrawer("bots")}
							title={t("groupConversationMembersHint")}
						>
							<span className="dg-head-pill-dot" />
							<span>{t("groupConversationMemberCount", { count: members.length })}</span>
						</button>
					)}
				</div>
				{!direct && (
					<div className="dg-head-nav">
						<button
							type="button"
							className={`dg-nav-tab ${drawerOpen && drawerTab === "router" ? "active" : ""}`}
							onClick={() => handleOpenDrawer("router")}
							title={
								detail?.room.router?.enabled
									? `${detail.room.router.deviceId} · ${detail.room.router.model} · ${detail.room.router.thinkingLevel}`
									: t("groupRouterDisabled")
							}
						>
							<span className="dg-nav-icon">🧭</span>
							<span className="dg-nav-text">
								AI Router ·{" "}
								{detail?.room.router?.enabled ? t("groupConversationRouterOn") : t("groupConversationRouterOff")}
							</span>
						</button>
						<button
							type="button"
							className={`dg-nav-tab ${drawerOpen && drawerTab === "work-items" ? "active" : ""}`}
							onClick={() => handleOpenDrawer("work-items")}
						>
							<span className="dg-nav-icon">🗂</span>
							<span className="dg-nav-text">{t("groupConversationWorkItems")}</span>
						</button>
						<button
							type="button"
							className={`dg-nav-tab ${drawerOpen && drawerTab === "blackboard" ? "active" : ""}`}
							onClick={() => handleOpenDrawer("blackboard")}
							title={t("groupConversationBlackboardTitle")}
						>
							<span className="dg-nav-icon">📋</span>
							<span className="dg-nav-text">{t("groupConversationBlackboard")}</span>
							{detail?.room.blackboard?.version ? (
								<span className="dg-nav-badge">v{detail.room.blackboard.version}</span>
							) : null}
						</button>
						<button
							type="button"
							className={`dg-nav-tab ${drawerOpen && drawerTab === "deliveries" ? "active" : ""} ${attentionCount > 0 ? "has-attention" : ""}`}
							onClick={() => handleOpenDrawer("deliveries")}
							title={t("groupConversationDeliveriesTitle")}
						>
							<span className="dg-nav-icon">📦</span>
							<span className="dg-nav-text">{t("groupConversationDeliveries")}</span>
							{attentionCount > 0 ? (
								<span className="dg-nav-badge attention">{attentionCount}</span>
							) : conversations.length > 0 ? (
								<span className="dg-nav-badge">{conversations.length}</span>
							) : null}
						</button>
						<button
							type="button"
							className={`dg-nav-tab ${drawerOpen && drawerTab === "transfers" ? "active" : ""}`}
							onClick={() => handleOpenDrawer("transfers")}
							title={t("groupConversationTransfersTitle")}
						>
							<span className="dg-nav-icon">📁</span>
							<span className="dg-nav-text">{t("groupConversationTransfers")}</span>
						</button>
						<button
							type="button"
							className={`dg-nav-tab ${drawerOpen && drawerTab === "canvas" ? "active" : ""}`}
							onClick={() => handleOpenDrawer("canvas")}
							title={t("groupConversationCanvasTitle")}
						>
							<span className="dg-nav-icon">🎨</span>
							<span className="dg-nav-text">{t("groupConversationCanvas")}</span>
							{detail?.room.canvasBinding && <span className="dg-nav-dot active" />}
						</button>
						<button
							type="button"
							className={`dg-nav-tab ${drawerOpen && drawerTab === "presets" ? "active" : ""}`}
							onClick={() => handleOpenDrawer("presets")}
							title={t("groupConversationPresetsTitle")}
						>
							<span className="dg-nav-icon">🤖</span>
							<span className="dg-nav-text">{t("groupConversationPresets")}</span>
						</button>
						<button
							type="button"
							className={`dg-nav-tab ${drawerOpen && drawerTab === "bots" ? "active" : ""}`}
							onClick={() => handleOpenDrawer("bots")}
							title={t("groupConversationMembersTitle")}
						>
							<span className="dg-nav-icon">👥</span>
							<span className="dg-nav-text">{t("groupConversationMembers")}</span>
						</button>
						<button
							type="button"
							className={`dg-nav-tab ${drawerOpen && drawerTab === "webhooks" ? "active" : ""}`}
							onClick={() => handleOpenDrawer("webhooks")}
							title={t("groupConversationWebhooksTitle")}
						>
							<span className="dg-nav-icon">🔗</span>
							<span className="dg-nav-text">{t("groupConversationWebhooks")}</span>
							{detail?.room.webhooks && detail.room.webhooks.filter((w) => w.enabled).length > 0 && (
								<span className="dg-nav-badge">{detail.room.webhooks.filter((w) => w.enabled).length}</span>
							)}
						</button>
					</div>
				)}
				<div className="dg-head-actions">
					{headerSlots.map((entry: UiSlotEntry) => (
						<button key={entry.id} type="button" className="btn secondary" title={entry.label}>
							{entry.label}
						</button>
					))}
					{direct && directBot && (
						<button
							type="button"
							className="btn dg-share-open"
							title={t("groupConversationShareHint")}
							onClick={openShare}
						>
							{t("groupConversationShareOpen")}
						</button>
					)}
					{onBack && (
						<button type="button" className="btn dg-back-btn" onClick={onBack} title={t("groupConversationBackTitle")}>
							← {t("groupConversationBack")}
						</button>
					)}
				</div>
			</div>
			{shareNotice && (
				<div className="dg-share-notice" role="status">
					{shareNotice}
				</div>
			)}
			{error && (
				<div className="dg-error-banner" role="alert">
					{error}
					{unavailable ? t("groupConversationUnavailable") : null}
				</div>
			)}
			<div className="dg-tools-shelf collapsed" aria-hidden="true" style={{ display: "none" }}>
				<div className="dg-tools-shelf-content">
					<div className="dg-tool-pane">
						<GroupDeliveries
							roomId={roomId}
							conversations={conversations}
							bots={devices}
							disabled={!active || unavailable}
							error={conversationError}
						/>
					</div>
					<div className="dg-tool-pane">
						<DeviceFileTransfer roomId={roomId} bots={devices} disabled={!active || unavailable} />
					</div>
					<div className="dg-tool-pane">
						<GroupCanvasBinding
							roomId={roomId}
							binding={detail?.room.canvasBinding}
							onSaved={() => setRefresh((n) => n + 1)}
						/>
					</div>
					<div className="dg-tool-pane">
						<GroupBotPresets bots={members} onSaved={() => setRefresh((n) => n + 1)} />
					</div>
				</div>
			</div>
			{(attentionCount > 0 || (detail?.tasks && detail.tasks.length > 0)) && (
				<div className="dg-tasks-strip">
					{attentionCount > 0 && (
						<button
							type="button"
							className={`dg-task-chip dg-attention-chip ${drawerOpen && drawerTab === "deliveries" ? "active" : ""}`}
							onClick={() => handleOpenDrawer("deliveries")}
							title={t("groupConversationAttentionHint")}
						>
							<span className="dg-attention-dot" />
							<span className="dg-attention-text">
								{t("groupConversationAttentionCount", { count: attentionCount })}
							</span>
						</button>
					)}
					{(() => {
						const allTasks = detail?.tasks ?? [];
						const activeTasks = allTasks.filter(
							(t) => t.status === "running" || t.status === "waiting" || t.status === "queued",
						);
						let displayTasks = allTasks.slice(-4);
						if (activeTasks.length > 0) {
							const relevantIds = new Set(activeTasks.map((t) => t.id));
							for (const t of activeTasks) {
								if (t.dependsOnTaskId) relevantIds.add(t.dependsOnTaskId);
							}
							const recentCompleted = allTasks.filter((t) => t.status === "completed").slice(-2);
							for (const t of recentCompleted) relevantIds.add(t.id);
							const filtered = allTasks.filter((t) => relevantIds.has(t.id));
							displayTasks = filtered.length > 0 ? filtered.slice(-6) : allTasks.slice(-6);
						}

						return displayTasks.map((task, index) => {
							const { botPrefix, summary } = formatGroupTaskChip(task.text);
							const prevTask = index > 0 ? displayTasks[index - 1] : undefined;
							const isPipelineStep =
								index > 0 &&
								(task.dependsOnTaskId === prevTask?.id ||
									(prevTask?.status === "completed" && (task.status === "running" || task.status === "waiting")) ||
									task.dependsOnTaskId !== undefined);

							return (
								<div key={task.id} className="dg-pipeline-step-wrapper">
									{isPipelineStep && (
										<span
											className="dg-pipeline-arrow"
											title={t("groupConversationPipelineDependency")}
											aria-hidden="true"
										>
											→
										</span>
									)}
									<div
										className={`dg-task-chip ${task.status === "running" ? "is-running" : ""} ${task.status === "waiting" ? "is-waiting" : ""}`}
									>
										<span
											className={`dg-task-status-dot status-${task.status}`}
											title={task.status === "waiting" ? t("groupConversationWaitingUpstream") : task.status}
										/>
										{task.status === "waiting" && (
											<span className="dg-task-waiting-badge">{t("groupConversationWaitingBadge")}</span>
										)}
										{task.status === "queued" && task.queuedReason && (
											<span className="dg-task-waiting-badge" title={task.queuedReason}>
												{task.blockReason === "bot_busy"
													? t("groupConversationQueuedBadge")
													: t("groupConversationBehindTurnBadge")}
											</span>
										)}
										{botPrefix && <strong className="dg-task-bot-prefix">{botPrefix}</strong>}
										<span className="dg-task-title" title={task.text}>
											{summary.length > 24 ? summary.slice(0, 24) + "..." : summary}
										</span>
										<button type="button" className="btn dg-task-detail-btn" onClick={() => setViewTaskId(task.id)}>
											{t("groupConversationDetails")}
										</button>
										{task.status === "running" && (
											<button
												type="button"
												className="btn dg-task-detail-btn"
												title={t("groupConversationSteerHint")}
												onClick={() => setSteerTask(task)}
											>
												{t("groupConversationSteer")}
											</button>
										)}
										{(task.status === "running" || task.status === "queued" || task.status === "waiting") && (
											<button
												type="button"
												className="btn dg-task-detail-btn dg-task-stop-action"
												title={t("groupConversationStopHint")}
												onClick={() => handleStopTask(task)}
											>
												{t("groupConversationStop")}
											</button>
										)}
									</div>
								</div>
							);
						});
					})()}
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
			{shareOpen && direct && directBot && (
				<div className="dg-share-backdrop" role="dialog" aria-modal="true" aria-label={t("groupConversationShareOpen")}>
					<div className="dg-share-dialog">
						<h3>{t("groupConversationShareOpen")}</h3>
						{(() => {
							const picked =
								[...(detail?.messages ?? [])].reverse().find((message) => String(message.sender.type) === "bot") ??
								detail?.messages?.at(-1);
							const target = shareGroups.find((group) => group.id === shareTarget);
							const canAsBot = Boolean(target?.botIds.includes(directBot.id));
							return (
								<>
									<p className="dg-share-hint">{t("groupConversationShareBody", { bot: directBot.name })}</p>
									<label className="dg-share-field">
										<span>{t("groupConversationShareTarget")}</span>
										<select
											value={shareTarget}
											onChange={(event) => {
												setShareTarget(event.target.value);
												setShareMode("as_forward");
											}}
										>
											{shareGroups.length === 0 && <option value="">{t("deviceGroupSectionEmpty")}</option>}
											{shareGroups.map((group) => (
												<option key={group.id} value={group.id}>
													{group.name}
												</option>
											))}
										</select>
									</label>
									<fieldset className="dg-share-modes">
										<label>
											<input
												type="radio"
												name="share-mode"
												checked={shareMode === "as_forward"}
												onChange={() => setShareMode("as_forward")}
											/>
											<span>{t("groupConversationShareAsMe")}</span>
										</label>
										<label className={canAsBot ? "" : "is-disabled"}>
											<input
												type="radio"
												name="share-mode"
												disabled={!canAsBot}
												checked={shareMode === "as_bot" && canAsBot}
												onChange={() => setShareMode("as_bot")}
											/>
											<span>
												{canAsBot
													? t("groupConversationShareAsBot", { bot: directBot.name })
													: t("groupConversationShareBotMissing")}
											</span>
										</label>
									</fieldset>
									<label className="dg-share-field">
										<span>{t("groupConversationShareNote")}</span>
										<textarea
											value={shareNote}
											maxLength={500}
											rows={3}
											placeholder={t("groupConversationShareNotePlaceholder")}
											onChange={(event) => setShareNote(event.target.value)}
										/>
									</label>
									<div className="dg-share-actions">
										<button
											type="button"
											className="btn"
											disabled={shareBusy}
											onClick={() => {
												if (!picked || !shareTarget) {
													setError(t("groupConversationShareEmpty"));
													return;
												}
												setShareBusy(true);
												void request(`bots/${encodeURIComponent(directBot.id)}/share`, new AbortController().signal, {
													sourceRoomId: roomId,
													targetRoomId: shareTarget,
													mode: shareMode === "as_bot" && canAsBot ? "as_bot" : "as_forward",
													messageIds: [picked.id],
													...(shareNote.trim() ? { note: shareNote.trim() } : {}),
													idempotencyKey: shareKey.current,
												})
													.then(() => {
														setShareOpen(false);
														setShareNote("");
														setShareNotice(t("groupConversationShareDone"));
													})
													.catch((cause) => setError(explain(cause)))
													.finally(() => setShareBusy(false));
											}}
										>
											{shareBusy ? t("groupConversationShareBusy") : t("groupConversationShare")}
										</button>
										<button type="button" className="btn secondary" onClick={() => setShareOpen(false)}>
											{t("cancel")}
										</button>
									</div>
								</>
							);
						})()}
					</div>
				</div>
			)}
			{viewTaskId && <GroupTaskDetails roomId={roomId} taskId={viewTaskId} onClose={handleCloseDetails} />}
			{steerTask && (
				<GroupSteerModal
					task={steerTask}
					botName={members.find((b) => b.id === steerTask.botId)?.name}
					deviceName={devices.find((d) => d.id === steerTask.botId)?.deviceName || steerTask.deviceId}
					onClose={() => setSteerTask(null)}
					onSubmit={async (text) => {
						await request(
							`rooms/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(steerTask.id)}/steer`,
							new AbortController().signal,
							{ text: text.trim() },
						);
						setRefresh((n) => n + 1);
					}}
				/>
			)}
			{!direct && (
				<GroupDrawer
					isOpen={drawerOpen}
					activeTab={drawerTab}
					onClose={handleCloseDrawer}
					onSelectTab={setDrawerTab}
					roomId={roomId}
					detail={detail}
					devices={devices}
					members={members}
					conversations={conversations}
					attentionCount={attentionCount}
					disabled={!active || unavailable}
					conversationError={conversationError}
					onRefreshGroup={() => setRefresh((n) => n + 1)}
					onRefreshConversations={() => setRefresh((n) => n + 1)}
				/>
			)}
			<ChatInput
				groupDevices={members}
				groupPrimaryBotName={
					detail?.room.router?.enabled
						? t("groupRouterLabel")
						: members.find((bot) => bot.id === detail?.room.primaryBotId)?.name
				}
				groupConversations={conversations}
				groupConversationError={conversationError}
				onGroupSend={send}
				streaming={runningTasks.length > 0}
				onAbort={runningTasks.length > 0 ? () => handleStopTask(runningTasks[0]) : undefined}
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
