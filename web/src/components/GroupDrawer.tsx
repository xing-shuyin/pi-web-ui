import { memo, useEffect } from "react";
import { FiX } from "react-icons/fi";
import type { GroupDetail, GroupDevice, GroupBotConversation } from "../device-group-messages";
import { GroupDeliveries } from "./GroupDeliveries";
import { DeviceFileTransfer } from "./DeviceFileTransfer";
import { GroupCanvasBinding } from "./GroupCanvasBinding";
import { GroupBotPresets } from "./GroupBotPresets";
import { GroupBlackboardView } from "./GroupBlackboardView";
import { GroupWebhooks } from "./GroupWebhooks";
import { GroupRouterSettings, type GroupRouterConfig } from "./GroupRouterSettings";
import { GroupWorkItems } from "./GroupWorkItems";
import { isZhLocale, useI18n } from "../i18n";

export type GroupDrawerTab =
	"blackboard" | "deliveries" | "transfers" | "canvas" | "presets" | "bots" | "webhooks" | "router" | "work-items";

interface GroupDrawerProps {
	isOpen: boolean;
	activeTab: GroupDrawerTab;
	onClose: () => void;
	onSelectTab?: (tab: GroupDrawerTab) => void;
	roomId: string;
	detail: (GroupDetail & { room: { router?: GroupRouterConfig } }) | null;
	devices: GroupDevice[];
	members: GroupDevice[];
	conversations: GroupBotConversation[];
	attentionCount: number;
	disabled: boolean;
	conversationError: string;
	onRefreshGroup?: () => void;
	onRefreshConversations?: () => void;
}

const noop = () => {};

export const GroupDrawer = memo(function GroupDrawer({
	isOpen,
	activeTab,
	onClose,
	roomId,
	detail,
	devices,
	members,
	conversations,
	attentionCount,
	disabled,
	conversationError,
	onRefreshGroup,
	onRefreshConversations,
}: GroupDrawerProps) {
	const { locale } = useI18n();
	const zh = isZhLocale(locale);

	useEffect(() => {
		if (!isOpen) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isOpen, onClose]);

	if (!isOpen) return null;

	const titleMap: Record<GroupDrawerTab, { icon: string; title: string; badge?: number }> = {
		router: { icon: "🧭", title: zh ? "群组 AI Router" : "Group AI Router" },
		"work-items": { icon: "🗂", title: zh ? "群组工单与 Router 运行" : "Work Items & Router Runs" },
		blackboard: {
			icon: "📋",
			title: zh ? "群组共享共识黑板" : "Group Shared Blackboard",
			badge: detail?.room.blackboard?.version,
		},
		deliveries: {
			icon: "📦",
			title: zh ? "交付与待办事项" : "Deliveries & Attention",
			badge: attentionCount > 0 ? attentionCount : conversations.length > 0 ? conversations.length : undefined,
		},
		transfers: {
			icon: "📁",
			title: zh ? "跨机大文件传输与断点续传" : "Cross-Device File Transfers",
		},
		canvas: {
			icon: "🎨",
			title: zh ? "群画布工作流" : "Group Canvas Workflow",
		},
		presets: {
			icon: "🤖",
			title: zh ? "Bot 预设与规则配置" : "Bot Presets & Settings",
		},
		bots: {
			icon: "👥",
			title: zh ? "群协作 Bot 成员清单" : "Collaborating Bots",
			badge: members.length,
		},
		webhooks: {
			icon: "🔗",
			title: zh ? "群组 Webhook 集成" : "Group Webhooks",
			badge: detail?.room.webhooks?.filter((w) => w.enabled).length,
		},
	};
	const currentTitle = titleMap[activeTab] || { icon: "📦", title: zh ? "群协同" : "Collaboration" };

	return (
		<div className="group-drawer-overlay" role="dialog" aria-modal="true" aria-label={currentTitle.title}>
			<div className="group-drawer-backdrop" onClick={onClose} aria-hidden />
			<aside className="group-drawer-panel" onClick={(e) => e.stopPropagation()}>
				<div className="group-drawer-header">
					<div className="group-drawer-title-box">
						<span className="group-drawer-title-icon">{currentTitle.icon}</span>
						<h3 className="group-drawer-title">{currentTitle.title}</h3>
						{currentTitle.badge !== undefined && currentTitle.badge > 0 && (
							<span
								className={`group-drawer-badge ${activeTab === "deliveries" && attentionCount > 0 ? "attention" : ""}`}
							>
								{currentTitle.badge}
							</span>
						)}
					</div>
					<button
						type="button"
						className="btn group-drawer-close-btn"
						onClick={onClose}
						title={zh ? "关闭抽屉 (Esc)" : "Close Drawer (Esc)"}
						aria-label={zh ? "关闭" : "Close"}
					>
						<FiX />
					</button>
				</div>

				<div className="group-drawer-body">
					{activeTab === "router" && (
						<div className="group-drawer-pane">
							<GroupRouterSettings
								key={roomId}
								roomId={roomId}
								router={detail?.room.router}
								disabled={disabled}
								onSaved={onRefreshGroup ?? noop}
							/>
						</div>
					)}
					{activeTab === "work-items" && (
						<div className="group-drawer-pane">
							<GroupWorkItems
								key={roomId}
								roomId={roomId}
								tasks={detail?.tasks}
								disabled={disabled}
								onChanged={onRefreshGroup}
							/>
						</div>
					)}
					{activeTab === "blackboard" && (
						<div className="group-drawer-pane">
							<GroupBlackboardView
								roomId={roomId}
								blackboard={detail?.room.blackboard}
								disabled={disabled}
								onSaved={onRefreshGroup ?? noop}
							/>
						</div>
					)}

					{activeTab === "deliveries" && (
						<div className="group-drawer-pane">
							<GroupDeliveries
								roomId={roomId}
								conversations={conversations}
								bots={devices}
								disabled={disabled}
								error={conversationError}
								onRefresh={onRefreshConversations}
							/>
						</div>
					)}

					{activeTab === "transfers" && (
						<div className="group-drawer-pane">
							<DeviceFileTransfer roomId={roomId} bots={devices} disabled={disabled} />
						</div>
					)}

					{activeTab === "canvas" && (
						<div className="group-drawer-pane">
							<GroupCanvasBinding
								roomId={roomId}
								binding={detail?.room.canvasBinding}
								onSaved={onRefreshGroup ?? noop}
							/>
						</div>
					)}

					{activeTab === "presets" && (
						<div className="group-drawer-pane">
							<GroupBotPresets bots={members} onSaved={onRefreshGroup ?? noop} />
						</div>
					)}

					{activeTab === "webhooks" && (
						<div className="group-drawer-pane">
							<GroupWebhooks roomId={roomId} disabled={disabled} />
						</div>
					)}

					{activeTab === "bots" && (
						<div className="group-drawer-pane group-members-overview">
							<div className="grp-section-title">
								<span>{zh ? "群协作 Bot 成员清单" : "Collaborating Bots"}</span>
								<span className="grp-count">({members.length})</span>
							</div>
							<div className="grp-bot-list">
								{members.map((bot) => (
									<div key={bot.id} className="grp-bot-card">
										<div className="grp-bot-card-top">
											<div className="grp-bot-title">
												<span className={`grp-bot-indicator ${bot.online !== false ? "online" : "offline"}`} />
												<strong>{bot.name}</strong>
												{!detail?.room.router?.enabled && bot.id === detail?.room.primaryBotId && (
													<span className="grp-primary-badge">{zh ? "主协调" : "Primary"}</span>
												)}
											</div>
											<span className="grp-bot-status-text">
												{bot.online !== false ? (zh ? "在线就绪" : "Online Ready") : zh ? "离线" : "Offline"}
											</span>
										</div>
										<div className="grp-bot-info">
											{bot.deviceName && (
												<div className="grp-bot-device">
													<span>🖥 {zh ? "设备: " : "Device: "}</span>
													<code>{bot.deviceName}</code>
												</div>
											)}
											<div className="grp-bot-id">
												<span>ID: </span>
												<code title={bot.id}>{bot.id}</code>
											</div>
										</div>
										{bot.tools && bot.tools.length > 0 && (
											<div className="grp-bot-tools">
												<span className="grp-tools-label">{zh ? "授权工具: " : "Tools: "}</span>
												<div className="grp-tools-chips">
													{bot.tools.map((tool) => (
														<span key={tool} className="grp-tool-chip">
															{tool}
														</span>
													))}
												</div>
											</div>
										)}
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			</aside>
		</div>
	);
});
