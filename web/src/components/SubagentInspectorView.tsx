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
import { isZhLocale, useLocale } from "../i18n";

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

function getRoleBadge(type?: string, isZh = true): { icon: string; label: string; desc: string } {
	const t = (type || "").toLowerCase();
	switch (t) {
		case "review":
			return {
				icon: "⚖️",
				label: isZh ? "审查者 (Review)" : "Reviewer",
				desc: isZh ? "只读审查代码与架构" : "Read-only audit",
			};
		case "implement":
			return {
				icon: "🛠️",
				label: isZh ? "实施者 (Implement)" : "Implementer",
				desc: isZh ? "编写与重构代码" : "Code modification",
			};
		case "explore":
			return {
				icon: "🔍",
				label: isZh ? "探索者 (Explore)" : "Explorer",
				desc: isZh ? "调查依赖与路径" : "Codebase discovery",
			};
		case "test":
			return {
				icon: "🧪",
				label: isZh ? "测试者 (Test)" : "Tester",
				desc: isZh ? "执行验证套件" : "Test verification",
			};
		default:
			return {
				icon: "👥",
				label: isZh ? "通用助手 (General)" : "General",
				desc: isZh ? "通用协同智能体" : "General agent",
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
	const isZh = isZhLocale(useLocale());
	const data = useMemo(() => parseSubagentData(args, details, output), [args, details, output]);
	const copyPrompt = useCopyFeedback({ duration: 1200 });
	const copyOutput = useCopyFeedback({ duration: 1200 });

	const [isEnvExpanded, setIsEnvExpanded] = useState(false);
	const [isPromptExpanded, setIsPromptExpanded] = useState(true);

	const isSpawnAction = data.action === "spawn";
	const [activeTab, setActiveTab] = useState<"spawn" | "result">(isSpawnAction ? "spawn" : "result");

	const roleMeta = getRoleBadge(data.type, isZh);
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
						🚀 {isZh ? "任务使命与指派 (Prompt)" : "Mission & Prompt"}
					</button>
					<button
						type="button"
						className={`subagent-mode-btn${activeTab === "result" ? " active" : ""}`}
						onClick={() => setActiveTab("result")}
					>
						📋 {isZh ? "交付成果与产出 (Result)" : "Deliverables & Output"}
					</button>
				</div>

				<div className="subagent-conv-badge">
					<span>{isZh ? "子代理" : "Subagent"}:</span>
					<strong>{targetConvId || (isZh ? "未绑定" : "unbound")}</strong>
				</div>
			</div>

			<div className="subagent-hud-grid">
				<div className="subagent-hud-card accent">
					<span className="subagent-hud-label">{isZh ? "角色与类型" : "Role & Type"}</span>
					<span className="subagent-hud-val">
						<span>{roleMeta.icon}</span>
						<span>{data.type || "general"}</span>
					</span>
					<span className="subagent-hud-sub">{data.template ? `模板: ${data.template}` : roleMeta.desc}</span>
				</div>

				<div className="subagent-hud-card green">
					<span className="subagent-hud-label">{isZh ? "执行模型" : "Model & Thinking"}</span>
					<span className="subagent-hud-val">{data.model || (isZh ? "跟随宿主" : "inherit host")}</span>
					<span className="subagent-hud-sub">
						{data.thinking ? `${isZh ? "思考" : "thinking"}: ${data.thinking}` : isZh ? "标准思考档位" : "default"}
					</span>
				</div>

				<div className="subagent-hud-card blue">
					<span className="subagent-hud-label">{isZh ? "隔离工作区" : "Isolation"}</span>
					<span className="subagent-hud-val">
						<FiGitBranch />
						<span>
							{data.worktree?.branch
								? data.worktree.branch.replace(/^agent\//, "")
								: data.isolation === "worktree"
									? isZh
										? "独立分支隔离"
										: "worktree"
									: isZh
										? "共享主工作区"
										: "shared workspace"}
						</span>
					</span>
					<span className="subagent-hud-sub">
						{data.worktree?.uncommittedCount !== undefined
							? `${isZh ? "变更文件" : "files"}: ${data.worktree.uncommittedCount}`
							: data.isolation === "worktree"
								? isZh
									? "Git Worktree 物理隔离"
									: "Dedicated worktree"
								: isZh
									? "无分支隔离"
									: "No git branch"}
					</span>
				</div>

				<div className="subagent-hud-card amber">
					<span className="subagent-hud-label">{isZh ? "运行指标" : "Metrics"}</span>
					<span className="subagent-hud-val">
						{statusClass === "run"
							? isZh
								? "⟳ 执行中..."
								: "Running..."
							: duration || (isZh ? "已完成" : "Completed")}
					</span>
					<span className="subagent-hud-sub">
						{data.messageCount !== undefined
							? `${isZh ? "交互" : "turns"}: ${data.messageCount} ${isZh ? "轮" : ""}`
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
								<span>{isZh ? "🎯 指派任务使命 (Mission Prompt)" : "Mission Prompt"}</span>
							</span>
							<button
								type="button"
								className={`subagent-btn${copyPrompt.copied ? " copied" : ""}`}
								onClick={() => void copyPrompt.copy(data.prompt || "")}
							>
								{copyPrompt.copied ? <FiCheck /> : <FiCopy />}
								<span>{copyPrompt.copied ? (isZh ? "已复制" : "Copied") : isZh ? "复制指令" : "Copy"}</span>
							</button>
						</div>
						<div className="subagent-section-body">
							<div className="subagent-prompt-box">
								{data.prompt || (isZh ? "(无明确 prompt，或通过 steer/消息派发)" : "(No explicit prompt)")}
							</div>
						</div>
					</div>

					<div className="subagent-section-card">
						<div className="subagent-section-header clickable" onClick={() => setIsEnvExpanded((prev) => !prev)}>
							<span className="subagent-section-title">
								<FiLayers style={{ color: "var(--blue)" }} />
								<span>{isZh ? "🛡️ 运行环境与调度配置" : "Runtime Environment & Config"}</span>
							</span>
							<span style={{ fontSize: 11, color: "var(--text-dim)" }}>
								{isEnvExpanded ? (isZh ? "收起 ▲" : "Collapse ▲") : isZh ? "展开 ▼" : "Expand ▼"}
							</span>
						</div>
						{isEnvExpanded && (
							<div className="subagent-section-body">
								<table className="subagent-spec-table">
									<tbody>
										<tr>
											<td className="label">{isZh ? "工作目录" : "CWD"}</td>
											<td className="val">{data.cwd || "（继承主项目路径）"}</td>
										</tr>
										<tr>
											<td className="label">{isZh ? "隔离策略" : "Isolation"}</td>
											<td className="val">
												{data.isolation === "worktree"
													? isZh
														? "🌿 Git Worktree 独立分支隔离"
														: "Git Worktree isolation"
													: isZh
														? "共享主工作区"
														: "Shared workspace"}
											</td>
										</tr>
										{data.worktree?.path && (
											<tr>
												<td className="label">{isZh ? "工作树路径" : "Worktree Path"}</td>
												<td className="val">{data.worktree.path}</td>
											</tr>
										)}
										<tr>
											<td className="label">{isZh ? "自动唤醒" : "Notify Strategy"}</td>
											<td className="val">
												{data.notifyOnDone === false
													? isZh
														? "已禁用自动通知 (静默)"
														: "Disabled"
													: isZh
														? "终态自动通知唤醒父级 (notifyOnDone: true)"
														: "Auto-notify on complete"}
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
								<span>{isZh ? "📋 任务执行交付报告 (Deliverables)" : "Deliverables"}</span>
							</span>
							<button
								type="button"
								className={`subagent-btn${copyOutput.copied ? " copied" : ""}`}
								onClick={() => void copyOutput.copy(finalOutput)}
							>
								{copyOutput.copied ? <FiCheck /> : <FiCopy />}
								<span>{copyOutput.copied ? (isZh ? "已复制" : "Copied") : isZh ? "复制产出" : "Copy"}</span>
							</button>
						</div>
						<div className="subagent-section-body">
							<div className="subagent-output-box">
								{finalOutput ||
									(statusClass === "run"
										? isZh
											? "⟳ 子代理正在后台执行并流式生成结果中..."
											: "Running and generating output..."
										: isZh
											? "（暂无产出文本）"
											: "(No output yet)")}
							</div>
						</div>
					</div>

					{data.prompt && (
						<div className="subagent-section-card">
							<div className="subagent-section-header clickable" onClick={() => setIsPromptExpanded((prev) => !prev)}>
								<span className="subagent-section-title">
									<FiZap style={{ color: "var(--text-dim)" }} />
									<span>{isZh ? "🎯 关联指派 Prompt" : "Associated Prompt"}</span>
								</span>
								<span style={{ fontSize: 11, color: "var(--text-dim)" }}>
									{isPromptExpanded ? (isZh ? "收起 ▲" : "Collapse ▲") : isZh ? "展开 ▼" : "Expand ▼"}
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
					<span>
						{targetConvId
							? isZh
								? "可直接切换至子代理会话查看完整上下文交互与各轮工具调用。"
								: "Switch to this subagent conversation to view full chat history."
							: isZh
								? "子代理未绑定有效会话 ID。"
								: "Subagent ID not resolved."}
					</span>
				</div>

				<div className="subagent-dock-btns">
					{targetConvId && (
						<button type="button" className="subagent-btn primary" onClick={handleSwitchConversation}>
							<FiUsers />
							<span>{isZh ? "切换到该子会话 ➔" : "Switch to Conversation ➔"}</span>
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
