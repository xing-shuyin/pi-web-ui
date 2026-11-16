import { useMemo, useState } from "react";
import {
	FiArrowRight,
	FiCheck,
	FiCopy,
	FiFolder,
	FiGitBranch,
	FiLayers,
	FiLock,
	FiTerminal,
	FiUsers,
	FiZap,
} from "react-icons/fi";
import { closeToolInspector } from "../tool-inspector-state";
import { useCopyFeedback } from "../use-copy-feedback";
import { useT, type Translate } from "../i18n";

export interface SubagentParsedData {
	action: string;
	prompt?: string;
	type?: string;
	template?: string;
	model?: string;
	thinking?: string;
	isolation?: string;
	cwd?: string;
	runId?: string;
	convId?: string;
	executionId?: string;
	notifyOnDone?: boolean | "manual";
	message?: string;
	summary?: string;
	state?: string;
	streaming?: boolean;
	messageCount?: number;
	output?: string;
	worktree?: {
		branch?: string;
		path?: string;
		uncommittedCount?: number;
		aheadCount?: number;
		isDirty?: boolean;
		error?: string;
	};
	consultRequests?: Array<{
		runId: string;
		requestId: string;
		questions?: Array<{ id: string; question: string }>;
	}>;
}

export function parseSubagentData(
	argsText: string | undefined,
	details: unknown,
	output: string | undefined,
): SubagentParsedData {
	const out: SubagentParsedData = {
		action: "spawn",
	};

	if (argsText) {
		try {
			const parsed = JSON.parse(argsText) as Record<string, unknown>;
			if (parsed && typeof parsed === "object") {
				if (typeof parsed.action === "string") out.action = parsed.action.trim().toLowerCase();
				if (typeof parsed.prompt === "string") out.prompt = parsed.prompt;
				if (typeof parsed.type === "string") out.type = parsed.type;
				if (typeof parsed.template === "string") out.template = parsed.template;
				if (typeof parsed.model === "string") out.model = parsed.model;
				if (typeof parsed.thinking === "string") out.thinking = parsed.thinking;
				if (typeof parsed.isolation === "string") out.isolation = parsed.isolation;
				if (typeof parsed.cwd === "string") out.cwd = parsed.cwd;
				if (typeof parsed.runId === "string") out.runId = parsed.runId;
				if (typeof parsed.message === "string") out.message = parsed.message;
				if (typeof parsed.summary === "string") out.summary = parsed.summary;
				if (typeof parsed.notifyOnDone === "boolean" || parsed.notifyOnDone === "manual") {
					out.notifyOnDone = parsed.notifyOnDone;
				}
			}
		} catch {}
	}

	if (details && typeof details === "object") {
		const det = details as Record<string, unknown>;
		if (typeof det.convId === "string") out.convId = det.convId;
		if (typeof det.executionId === "string") out.executionId = det.executionId;
		if (typeof det.type === "string" && !out.type) out.type = det.type;
		if (typeof det.model === "string" && !out.model) out.model = det.model;
		if (typeof det.thinkingLevel === "string" && !out.thinking) out.thinking = det.thinkingLevel;
		if (typeof det.state === "string") out.state = det.state;
		if (typeof det.streaming === "boolean") out.streaming = det.streaming;
		if (typeof det.messageCount === "number") out.messageCount = det.messageCount;
		if (typeof det.prompt === "string" && !out.prompt) out.prompt = det.prompt;
		if (typeof det.output === "string") out.output = det.output;

		if (det.worktree && typeof det.worktree === "object") {
			const wt = det.worktree as Record<string, unknown>;
			out.worktree = {
				branch: typeof wt.branch === "string" ? wt.branch : undefined,
				path: typeof wt.path === "string" ? wt.path : undefined,
				uncommittedCount: typeof wt.uncommittedCount === "number" ? wt.uncommittedCount : undefined,
				aheadCount: typeof wt.aheadCount === "number" ? wt.aheadCount : undefined,
				isDirty: typeof wt.isDirty === "boolean" ? wt.isDirty : undefined,
				error: typeof wt.error === "string" ? wt.error : undefined,
			};
		}

		if (Array.isArray(det.requests)) {
			out.consultRequests = det.requests as SubagentParsedData["consultRequests"];
		}
	}

	if (!out.convId) {
		if (out.runId && /^sa-[0-9a-f]{8}/.test(out.runId)) {
			out.convId = out.runId;
		} else if (output) {
			const m = /sa-[0-9a-f]{8}/.exec(output);
			if (m) out.convId = m[0];
		}
	}

	return out;
}

function getRoleBadge(type: string | undefined, t: Translate): { icon: string; label: string; desc: string } {
	const normalized = (type || "").toLowerCase();
	switch (normalized) {
		case "review":
			return {
				icon: "⚖️",
				label: t("subagentInspector.roleReviewLabel"),
				desc: t("subagentInspector.roleReviewDesc"),
			};
		case "implement":
			return {
				icon: "🛠️",
				label: t("subagentInspector.roleImplementLabel"),
				desc: t("subagentInspector.roleImplementDesc"),
			};
		case "explore":
			return {
				icon: "🔍",
				label: t("subagentInspector.roleExploreLabel"),
				desc: t("subagentInspector.roleExploreDesc"),
			};
		case "test":
			return {
				icon: "🧪",
				label: t("subagentInspector.roleTestLabel"),
				desc: t("subagentInspector.roleTestDesc"),
			};
		default:
			return {
				icon: "👥",
				label: t("subagentInspector.roleGeneralLabel"),
				desc: t("subagentInspector.roleGeneralDesc"),
			};
	}
}

export function SubagentInspectorView({
	args,
	details,
	output,
	duration,
	statusClass,
	isError,
}: {
	name: string;
	args?: string;
	details?: unknown;
	output?: string;
	duration?: string;
	statusClass?: "ok" | "run" | "err" | "idle";
	isError?: boolean;
}) {
	const t = useT();
	const data = useMemo(() => parseSubagentData(args, details, output), [args, details, output]);
	const copyPrompt = useCopyFeedback({ duration: 1200 });
	const copyOutput = useCopyFeedback({ duration: 1200 });

	const [isEnvExpanded, setIsEnvExpanded] = useState(false);
	const [isPromptExpanded, setIsPromptExpanded] = useState(true);

	const isSpawnAction = data.action === "spawn";
	const [activeTab, setActiveTab] = useState<"spawn" | "result">(isSpawnAction ? "spawn" : "result");

	const roleMeta = getRoleBadge(data.type, t);
	const finalOutput = data.output || output || "";
	const targetConvId = data.convId || (data.runId && /^sa-[0-9a-f]{8}/.test(data.runId) ? data.runId : undefined);

	const handleSwitchConversation = () => {
		if (!targetConvId) return;
		closeToolInspector();
		window.dispatchEvent(new CustomEvent<string>("pi-web-ui:switch-conversation", { detail: targetConvId }));
	};

	return (
		<div className="subagent-inspector-container">
			<style>{`
				.subagent-inspector-container {
					display: flex;
					flex-direction: column;
					gap: 12px;
					padding: 16px;
					width: 100%;
					box-sizing: border-box;
					background: var(--bg);
					color: var(--text);
					font-family: var(--sans);
				}

				/* 顶部形态切换条 */
				.subagent-mode-switcher {
					display: flex;
					align-items: center;
					justify-content: space-between;
					background: var(--bg-elev);
					border: 1px solid var(--border);
					border-radius: 8px;
					padding: 6px 12px;
					gap: 12px;
				}

				.subagent-mode-tabs {
					display: flex;
					background: var(--bg-elev2);
					border: 1px solid var(--border-soft);
					border-radius: 6px;
					padding: 2px;
					gap: 2px;
				}

				.subagent-mode-btn {
					background: transparent;
					border: none;
					color: var(--text-dim);
					font-size: 12px;
					font-weight: 500;
					padding: 4px 10px;
					border-radius: 4px;
					cursor: pointer;
					transition: all 0.15s ease;
					white-space: nowrap;
				}

				.subagent-mode-btn:hover {
					color: var(--text);
				}

				.subagent-mode-btn.active {
					background: var(--bg-elev);
					color: var(--accent);
					font-weight: 600;
					box-shadow: 0 1px 3px rgba(0,0,0,0.15);
				}

				.subagent-conv-badge {
					font-family: var(--mono);
					font-size: 11.5px;
					color: var(--text-dim);
					display: flex;
					align-items: center;
					gap: 6px;
				}

				.subagent-conv-badge strong {
					color: var(--accent);
				}

				/* HUD 核心指标网格 */
				.subagent-hud-grid {
					display: grid;
					grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
					gap: 10px;
				}

				.subagent-hud-card {
					background: var(--bg-elev);
					border: 1px solid var(--border-soft);
					border-radius: 6px;
					padding: 10px 12px;
					display: flex;
					flex-direction: column;
					gap: 4px;
					position: relative;
					overflow: hidden;
				}

				.subagent-hud-card::before {
					content: "";
					position: absolute;
					top: 0;
					left: 0;
					bottom: 0;
					width: 3px;
					background: var(--border);
				}

				.subagent-hud-card.accent::before { background: var(--accent); }
				.subagent-hud-card.green::before { background: var(--green); }
				.subagent-hud-card.blue::before { background: var(--blue); }
				.subagent-hud-card.amber::before { background: var(--amber); }

				.subagent-hud-label {
					font-size: 10.5px;
					color: var(--text-faint);
					text-transform: uppercase;
					letter-spacing: 0.5px;
					font-weight: 600;
				}

				.subagent-hud-val {
					font-size: 13px;
					font-weight: 600;
					color: var(--text);
					display: flex;
					align-items: center;
					gap: 6px;
					white-space: nowrap;
					overflow: hidden;
					text-overflow: ellipsis;
				}

				.subagent-hud-sub {
					font-size: 11px;
					color: var(--text-dim);
					font-family: var(--mono);
					white-space: nowrap;
					overflow: hidden;
					text-overflow: ellipsis;
				}

				/* 结构化卡片共通 */
				.subagent-section-card {
					background: var(--bg-elev);
					border: 1px solid var(--border);
					border-radius: 8px;
					overflow: hidden;
					display: flex;
					flex-direction: column;
				}

				.subagent-section-header {
					background: var(--bg-elev2);
					border-bottom: 1px solid var(--border-soft);
					padding: 8px 12px;
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 8px;
					font-size: 12.5px;
					font-weight: 600;
					color: var(--text);
				}

				.subagent-section-header.clickable {
					cursor: pointer;
					user-select: none;
				}

				.subagent-section-header.clickable:hover {
					background: var(--bg-elev);
				}

				.subagent-section-title {
					display: flex;
					align-items: center;
					gap: 6px;
				}

				.subagent-section-body {
					padding: 12px;
					display: flex;
					flex-direction: column;
					gap: 8px;
				}

				.subagent-prompt-box {
					font-size: 13px;
					line-height: 1.6;
					color: var(--text);
					background: var(--bg);
					border: 1px solid var(--border-soft);
					border-radius: 6px;
					padding: 10px 12px;
					white-space: pre-wrap;
					word-break: break-word;
					max-height: 320px;
					overflow-y: auto;
				}

				.subagent-output-box {
					font-size: 12.5px;
					line-height: 1.6;
					color: var(--text);
					background: var(--bg);
					border: 1px solid var(--border-soft);
					border-radius: 6px;
					padding: 12px;
					white-space: pre-wrap;
					word-break: break-word;
					font-family: var(--mono);
					max-height: 380px;
					overflow-y: auto;
				}

				/* 环境与参数清单表格 */
				.subagent-spec-table {
					width: 100%;
					border-collapse: collapse;
					font-size: 12px;
				}

				.subagent-spec-table tr {
					border-bottom: 1px solid var(--border-soft);
				}

				.subagent-spec-table tr:last-child {
					border-bottom: none;
				}

				.subagent-spec-table td {
					padding: 6px 8px;
				}

				.subagent-spec-table td.label {
					width: 120px;
					color: var(--text-faint);
					font-weight: 500;
				}

				.subagent-spec-table td.val {
					color: var(--text);
					font-family: var(--mono);
				}

				/* 底部快捷操作条 */
				.subagent-action-dock {
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 12px;
					background: var(--bg-elev);
					border: 1px solid var(--border);
					border-radius: 8px;
					padding: 10px 14px;
					flex-wrap: wrap;
				}

				.subagent-dock-tip {
					font-size: 12px;
					color: var(--text-dim);
					display: flex;
					align-items: center;
					gap: 6px;
					flex: 1;
					min-width: 220px;
				}

				.subagent-dock-btns {
					display: flex;
					align-items: center;
					gap: 8px;
					flex-wrap: wrap;
				}

				.subagent-btn {
					background: var(--bg-elev2);
					border: 1px solid var(--border);
					color: var(--text);
					font-size: 12px;
					font-weight: 500;
					padding: 5px 10px;
					border-radius: 6px;
					cursor: pointer;
					display: inline-flex;
					align-items: center;
					gap: 6px;
					transition: all 0.15s;
					white-space: nowrap;
				}

				.subagent-btn:hover {
					border-color: var(--text-faint);
					color: var(--text);
				}

				.subagent-btn.primary {
					background: var(--accent);
					border-color: var(--accent);
					color: var(--accent-contrast);
				}

				.subagent-btn.primary:hover {
					opacity: 0.92;
				}

				.subagent-btn.copied {
					color: var(--green);
					border-color: var(--green);
				}
			`}</style>

			<div className="subagent-mode-switcher">
				<div className="subagent-mode-tabs">
					<button
						type="button"
						className={`subagent-mode-btn${activeTab === "spawn" ? " active" : ""}`}
						onClick={() => setActiveTab("spawn")}
					>
						🚀 {t("subagentInspector.tabMission")}
					</button>
					<button
						type="button"
						className={`subagent-mode-btn${activeTab === "result" ? " active" : ""}`}
						onClick={() => setActiveTab("result")}
					>
						📋 {t("subagentInspector.tabResult")}
					</button>
				</div>

				<div className="subagent-conv-badge">
					<span>{t("subagentInspector.subagentLabel")}:</span>
					<strong>{targetConvId || t("subagentInspector.unbound")}</strong>
				</div>
			</div>

			<div className="subagent-hud-grid">
				<div className="subagent-hud-card accent">
					<span className="subagent-hud-label">{t("subagentInspector.roleTypeLabel")}</span>
					<span className="subagent-hud-val">
						<span>{roleMeta.icon}</span>
						<span>{data.type || "general"}</span>
					</span>
					<span className="subagent-hud-sub">
						{data.template ? t("subagentInspector.templatePrefix", { template: data.template }) : roleMeta.desc}
					</span>
				</div>

				<div className="subagent-hud-card green">
					<span className="subagent-hud-label">{t("subagentInspector.modelLabel")}</span>
					<span className="subagent-hud-val">{data.model || t("subagentInspector.modelInherit")}</span>
					<span className="subagent-hud-sub">
						{data.thinking
							? t("subagentInspector.thinkingValue", { thinking: data.thinking })
							: t("subagentInspector.thinkingDefault")}
					</span>
				</div>

				<div className="subagent-hud-card blue">
					<span className="subagent-hud-label">{t("subagentInspector.isolationLabel")}</span>
					<span className="subagent-hud-val">
						<FiGitBranch />
						<span>
							{data.worktree?.branch
								? data.worktree.branch.replace(/^agent\//, "")
								: data.isolation === "worktree"
									? t("subagentInspector.isolationWorktree")
									: t("subagentInspector.isolationShared")}
						</span>
					</span>
					<span className="subagent-hud-sub">
						{data.worktree?.uncommittedCount !== undefined
							? t("subagentInspector.filesCount", { count: data.worktree.uncommittedCount })
							: data.isolation === "worktree"
								? t("subagentInspector.worktreeDedicated")
								: t("subagentInspector.noGitBranch")}
					</span>
				</div>

				<div className="subagent-hud-card amber">
					<span className="subagent-hud-label">{t("subagentInspector.metricsLabel")}</span>
					<span className="subagent-hud-val">
						{statusClass === "run" ? t("subagentInspector.running") : duration || t("subagentInspector.completed")}
					</span>
					<span className="subagent-hud-sub">
						{data.messageCount !== undefined
							? t("subagentInspector.turnsCount", { count: data.messageCount })
							: `action: ${data.action}`}
					</span>
				</div>
			</div>

			{activeTab === "spawn" && (
				<>
					<div className="subagent-section-card">
						<div className="subagent-section-header">
							<span className="subagent-section-title">
								<FiZap style={{ color: "var(--accent)" }} />
								<span>{t("subagentInspector.missionHeader")}</span>
							</span>
							<button
								type="button"
								className={`subagent-btn${copyPrompt.copied ? " copied" : ""}`}
								onClick={() => void copyPrompt.copy(data.prompt || "")}
							>
								{copyPrompt.copied ? <FiCheck /> : <FiCopy />}
								<span>{copyPrompt.copied ? t("copied") : t("subagentInspector.copyPrompt")}</span>
							</button>
						</div>
						<div className="subagent-section-body">
							<div className="subagent-prompt-box">{data.prompt || t("subagentInspector.promptEmpty")}</div>
						</div>
					</div>

					<div className="subagent-section-card">
						<div className="subagent-section-header clickable" onClick={() => setIsEnvExpanded((prev) => !prev)}>
							<span className="subagent-section-title">
								<FiLayers style={{ color: "var(--blue)" }} />
								<span>{t("subagentInspector.envHeader")}</span>
							</span>
							<span style={{ fontSize: 11, color: "var(--text-dim)" }}>
								{isEnvExpanded ? t("subagentInspector.collapse") : t("subagentInspector.expand")}
							</span>
						</div>
						{isEnvExpanded && (
							<div className="subagent-section-body">
								<table className="subagent-spec-table">
									<tbody>
										<tr>
											<td className="label">{t("subagentInspector.cwdLabel")}</td>
											<td className="val">{data.cwd || t("subagentInspector.cwdInherited")}</td>
										</tr>
										<tr>
											<td className="label">{t("subagentInspector.isolationStrategyLabel")}</td>
											<td className="val">
												{data.isolation === "worktree"
													? t("subagentInspector.worktreeIsolationValue")
													: t("subagentInspector.isolationShared")}
											</td>
										</tr>
										{data.worktree?.path && (
											<tr>
												<td className="label">{t("subagentInspector.worktreePathLabel")}</td>
												<td className="val">{data.worktree.path}</td>
											</tr>
										)}
										<tr>
											<td className="label">{t("subagentInspector.notifyLabel")}</td>
											<td className="val">
												{data.notifyOnDone === false
													? t("subagentInspector.notifyDisabled")
													: t("subagentInspector.notifyAuto")}
											</td>
										</tr>
									</tbody>
								</table>
							</div>
						)}
					</div>
				</>
			)}

			{activeTab === "result" && (
				<>
					<div className="subagent-section-card">
						<div className="subagent-section-header">
							<span className="subagent-section-title">
								<FiTerminal style={{ color: "var(--green)" }} />
								<span>{t("subagentInspector.resultHeader")}</span>
							</span>
							<button
								type="button"
								className={`subagent-btn${copyOutput.copied ? " copied" : ""}`}
								onClick={() => void copyOutput.copy(finalOutput)}
							>
								{copyOutput.copied ? <FiCheck /> : <FiCopy />}
								<span>{copyOutput.copied ? t("copied") : t("subagentInspector.copyOutput")}</span>
							</button>
						</div>
						<div className="subagent-section-body">
							<div className="subagent-output-box">
								{finalOutput ||
									(statusClass === "run" ? t("subagentInspector.outputRunning") : t("subagentInspector.outputEmpty"))}
							</div>
						</div>
					</div>

					{data.prompt && (
						<div className="subagent-section-card">
							<div className="subagent-section-header clickable" onClick={() => setIsPromptExpanded((prev) => !prev)}>
								<span className="subagent-section-title">
									<FiZap style={{ color: "var(--text-dim)" }} />
									<span>{t("subagentInspector.associatedPromptHeader")}</span>
								</span>
								<span style={{ fontSize: 11, color: "var(--text-dim)" }}>
									{isPromptExpanded ? t("subagentInspector.collapse") : t("subagentInspector.expand")}
								</span>
							</div>
							{isPromptExpanded && (
								<div className="subagent-section-body">
									<div className="subagent-prompt-box" style={{ maxHeight: 180 }}>
										{data.prompt}
									</div>
								</div>
							)}
						</div>
					)}
				</>
			)}

			<div className="subagent-action-dock">
				<div className="subagent-dock-tip">
					<span>💡</span>
					<span>{targetConvId ? t("subagentInspector.dockTipBound") : t("subagentInspector.dockTipUnbound")}</span>
				</div>

				<div className="subagent-dock-btns">
					{targetConvId && (
						<button type="button" className="subagent-btn primary" onClick={handleSwitchConversation}>
							<FiUsers />
							<span>{t("subagentInspector.switchConversation")}</span>
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
