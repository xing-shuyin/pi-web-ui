import { useCallback, useEffect, useRef, useState } from "react";
import { FiChevronDown, FiChevronRight, FiCpu, FiSettings } from "react-icons/fi";
import { useT } from "../i18n";
import { DEVICE_GROUPS_CHANGED, deviceGroupRequest } from "./DeviceGroupSection";
import { openBotManagement, openDirectRoom, openRoomView } from "../open-direct-room";
import { BotMemoryDialog } from "./BotMemoryDialog";
import "./agent-bots.css";

/**
 * 左栏「智能体」区 = 对话入口：把 Bot 当一等对话对象。
 *
 * 直聊不是新系统：每个 Bot 对应一个 `kind: "direct"` 的房间（服务端确定性 id），
 * 点开走的是同一套 `GroupConversation` 房间视图，因此流式、停止、恢复、历史全都免费复用。
 * 这里只负责列表与状态（草案确认、导入）；「打开直聊」与「跳转到设备中心管理」的实现
 * 统一收在 ../open-direct-room.ts，Bot 身份的创建/编辑/权限一律去设备中心。
 */

type DirectRoomBot = {
	id: string;
	name: string;
	deviceId: string;
	enabled: boolean;
	revision: number;
};

type DirectRoom = { id: string; name: string; bot?: DirectRoomBot };

type BotRow = {
	id: string;
	name: string;
	enabled: boolean;
	deviceName?: string;
	online?: boolean;
};

type BotDraft = {
	id: string;
	name: string;
	description: string;
	systemPrompt: string;
	cwd: string;
	tools: string[];
	trigger: "on_demand" | "always_on" | "scheduled";
	rationale?: string;
	bootstrap: boolean;
	highPrivilegeTools: string[];
	createdBy: "model" | "human";
	createdAt: number;
};

export function AgentBotsSection({
	active = true,
	selectedRoomId,
}: {
	active?: boolean;
	selectedRoomId?: string | null;
}) {
	const t = useT();
	const [bots, setBots] = useState<BotRow[] | null>(null);
	const [rooms, setRooms] = useState<DirectRoom[]>([]);
	const [drafts, setDrafts] = useState<BotDraft[]>([]);
	const [grants, setGrants] = useState<Record<string, string[]>>({});
	const [approving, setApproving] = useState<string | null>(null);
	const [memoryBot, setMemoryBot] = useState<BotRow | null>(null);
	const [importing, setImporting] = useState(false);
	const [notice, setNotice] = useState("");
	const importInput = useRef<HTMLInputElement | null>(null);
	const [error, setError] = useState("");
	const [collapsed, setCollapsed] = useState(false);
	const [pending, setPending] = useState<string | null>(null);
	const generation = useRef(0);

	const load = useCallback(async () => {
		const token = ++generation.current;
		const controller = new AbortController();
		try {
			const [botList, directRooms, draftList] = await Promise.all([
				deviceGroupRequest<{ bots: BotRow[] }>("bots", controller.signal),
				deviceGroupRequest<{ rooms: DirectRoom[] }>("direct-rooms", controller.signal),
				deviceGroupRequest<{ drafts: BotDraft[] }>("bot-drafts", controller.signal),
			]);
			if (token !== generation.current) return;
			setBots((botList.bots ?? []).filter((bot) => bot.enabled).sort((a, b) => a.name.localeCompare(b.name)));
			setRooms(directRooms.rooms ?? []);
			setDrafts(draftList.drafts ?? []);
			setError("");
		} catch (cause) {
			if (token !== generation.current) return;
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);

	useEffect(() => {
		if (!active) return;
		void load();
		const refresh = () => void load();
		window.addEventListener(DEVICE_GROUPS_CHANGED, refresh);
		window.addEventListener("pi-web-ui:device-bots-changed", refresh);
		// 草案由主对话里的 agent_bot 工具产生（没有前端事件），这里低频轮询兜底：
		// 5s 一次只读本地文件，比让用户"刷新页面才看到确认卡"更合理。
		const timer = window.setInterval(refresh, 5000);
		return () => {
			window.removeEventListener(DEVICE_GROUPS_CHANGED, refresh);
			window.removeEventListener("pi-web-ui:device-bots-changed", refresh);
			window.clearInterval(timer);
		};
	}, [active, load]);

	const startChat = useCallback(
		async (bot: BotRow) => {
			setPending(bot.id);
			try {
				await openDirectRoom(bot.id, { knownRoomId: rooms.find((room) => room.bot?.id === bot.id)?.id });
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setPending(null);
			}
		},
		[rooms],
	);

	const confirmDraft = useCallback(
		async (draft: BotDraft) => {
			const approved = grants[draft.id] ?? [];
			if (draft.highPrivilegeTools.some((tool) => !approved.includes(tool))) return;
			const controller = new AbortController();
			setApproving(draft.id);
			try {
				const result = await deviceGroupRequest<{ roomId?: string }>(
					`bot-drafts/${encodeURIComponent(draft.id)}/approve`,
					controller.signal,
					{
						approvedTools: [
							...new Set([...draft.tools.filter((tool) => !draft.highPrivilegeTools.includes(tool)), ...approved]),
						],
					},
				);
				window.dispatchEvent(new CustomEvent("pi-web-ui:device-bots-changed"));
				await load();
				if (result.roomId) openRoomView(result.roomId);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setApproving(null);
			}
		},
		[grants, load],
	);
	const discardDraft = useCallback(
		async (draft: BotDraft) => {
			const controller = new AbortController();
			setApproving(draft.id);
			try {
				await deviceGroupRequest(`bot-drafts/${encodeURIComponent(draft.id)}/discard`, controller.signal, {});
				await load();
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setApproving(null);
			}
		},
		[load],
	);

	const importBundle = useCallback(
		async (file: File) => {
			setImporting(true);
			setError("");
			try {
				const bundle = JSON.parse(await file.text()) as unknown;
				const result = await deviceGroupRequest<{ bot: BotRow; imported: number; skipped: number; roomId?: string }>(
					"bot-import",
					new AbortController().signal,
					{ bundle },
				);
				setNotice(
					t("agentBots.importDone", {
						name: result.bot.name,
						imported: String(result.imported),
						skipped: String(result.skipped),
					}),
				);
				await load();
				if (result.roomId) openRoomView(result.roomId);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : t("agentBots.importFailed"));
			} finally {
				setImporting(false);
			}
		},
		[load, t],
	);

	if (!bots && !error) {
		return (
			<section className="lp-bots-section" aria-busy="true">
				<div className="lp-bots-header">
					<span className="lp-bots-title">
						<FiCpu aria-hidden="true" />
						{t("agentBots.title")}
					</span>
					<span className="lp-bots-loading">{t("loading")}</span>
				</div>
			</section>
		);
	}

	return (
		<section className="lp-bots-section" aria-label={t("agentBots.title")}>
			<div className="lp-bots-header">
				<button
					type="button"
					className="lp-bots-toggle"
					aria-expanded={!collapsed}
					aria-label={collapsed ? t("agentBots.expand") : t("agentBots.collapse")}
					onClick={() => setCollapsed((value) => !value)}
				>
					{collapsed ? <FiChevronRight aria-hidden="true" /> : <FiChevronDown aria-hidden="true" />}
					<FiCpu aria-hidden="true" />
					<span className="lp-bots-title">{t("agentBots.title")}</span>
					{botCount(bots) > 0 && <span className="lp-bots-count">{botCount(bots)}</span>}
				</button>
				<div className="lp-bots-actions">
					<button
						type="button"
						className="lp-bots-manage"
						title={t("agentBots.manageTip")}
						aria-label={t("agentBots.manageTip")}
						onClick={openBotManagement}
					>
						<FiSettings aria-hidden="true" />
						<span>{t("agentBots.manage")}</span>
					</button>
					<button
						type="button"
						className="lp-bots-import"
						title={t("agentBots.importBot")}
						disabled={importing}
						onClick={() => importInput.current?.click()}
					>
						{importing ? "…" : "＋"}
					</button>
				</div>
				<input
					ref={importInput}
					type="file"
					accept="application/json,.json"
					hidden
					onChange={(event) => {
						const file = event.target.files?.[0];
						event.target.value = "";
						if (file) void importBundle(file);
					}}
				/>
			</div>
			{!collapsed && (
				<div className="lp-bots-body">
					{notice && <p className="lp-bots-notice">{notice}</p>}
					{error && (
						<div className="lp-bots-error">
							<span>{t("agentBots.failed")}</span>
							<button type="button" onClick={() => void load()}>
								{t("retryNow")}
							</button>
						</div>
					)}
					{drafts.length > 0 && (
						<div className="lp-bot-drafts">
							<p className="lp-bot-drafts-title">{t("agentBots.drafts")}</p>
							<p className="lp-bot-drafts-hint">{t("agentBots.draftHint")}</p>
							{drafts.map((draft) => {
								const granted = grants[draft.id] ?? [];
								const ready = draft.highPrivilegeTools.every((tool) => granted.includes(tool));
								const busy = approving === draft.id;
								return (
									<div key={draft.id} className="lp-bot-draft">
										<div className="lp-bot-draft-head">
											<strong>{draft.name}</strong>
											<span className="lp-bot-draft-badge">
												{draft.trigger === "on_demand"
													? t("agentBots.triggerOnDemand")
													: t("agentBots.triggerReserved")}
											</span>
										</div>
										<p className="lp-bot-draft-desc">{draft.description}</p>
										{draft.trigger !== "on_demand" && (
											<p className="lp-bot-draft-meta">
												{t("agentBots.triggerReservedHint", { trigger: draft.trigger })}
											</p>
										)}
										<p className="lp-bot-draft-meta" title={draft.cwd}>
											{t("agentBots.workspace")}: {draft.cwd}
										</p>
										{draft.rationale && <p className="lp-bot-draft-meta">{draft.rationale}</p>}
										{draft.tools.length > 0 && (
											<p className="lp-bot-draft-meta" title={draft.tools.join(", ")}>
												{t("agentBots.tools")}: {draft.tools.join(", ")}
											</p>
										)}
										{draft.highPrivilegeTools.length > 0 && (
											<div className="lp-bot-draft-grants">
												{draft.highPrivilegeTools.map((tool) => (
													<label key={tool} className="lp-bot-draft-grant">
														<input
															type="checkbox"
															checked={granted.includes(tool)}
															onChange={(event) =>
																setGrants((current) => ({
																	...current,
																	[draft.id]: event.target.checked
																		? [...new Set([...(current[draft.id] ?? []), tool])]
																		: (current[draft.id] ?? []).filter((item) => item !== tool),
																}))
															}
														/>
														<span>{tool}</span>
													</label>
												))}
											</div>
										)}
										{draft.bootstrap && <p className="lp-bot-draft-meta">✓ {t("agentBots.bootstrap")}</p>}
										<div className="lp-bot-draft-actions">
											<button
												type="button"
												className="lp-bot-draft-primary"
												disabled={!ready || busy}
												onClick={() => void confirmDraft(draft)}
											>
												{busy ? t("agentBots.approving") : t("agentBots.approve")}
											</button>
											<button type="button" disabled={busy} onClick={() => void discardDraft(draft)}>
												{t("cancel")}
											</button>
										</div>
									</div>
								);
							})}
						</div>
					)}
					{!error && (!bots || bots.length === 0) && <p className="lp-bots-empty">{t("agentBots.empty")}</p>}
					{(bots ?? []).map((bot) => {
						const room = rooms.find((entry) => entry.bot?.id === bot.id);
						const isActive = Boolean(room && selectedRoomId === room.id);
						return (
							<div key={bot.id} className="lp-bot-item">
								<button
									type="button"
									className={`lp-bot-row${isActive ? " is-active" : ""}`}
									title={t("botChat", { name: bot.name })}
									aria-pressed={isActive}
									disabled={pending !== null}
									onClick={() => void startChat(bot)}
								>
									<span className={`lp-bot-avatar${bot.online ? " is-online" : ""}`} aria-hidden="true">
										{bot.name.slice(0, 1).toUpperCase()}
									</span>
									<span className="lp-bot-meta">
										<span className="lp-bot-name">{bot.name}</span>
										<span className="lp-bot-sub">
											{pending === bot.id
												? t("agentBots.starting")
												: bot.online === false
													? t("agentBots.offline")
													: (bot.deviceName ?? "Bot")}
										</span>
									</span>
								</button>
								<button
									type="button"
									className="lp-bot-memory"
									title={t("agentBots.memoryOpen")}
									aria-label={t("botMemory.title")}
									onClick={() => setMemoryBot(bot)}
								>
									🧠
								</button>
							</div>
						);
					})}
				</div>
			)}
			{memoryBot && (
				<BotMemoryDialog botId={memoryBot.id} botName={memoryBot.name} onClose={() => setMemoryBot(null)} />
			)}
		</section>
	);
}

function botCount(bots: BotRow[] | null): number {
	return bots?.length ?? 0;
}
