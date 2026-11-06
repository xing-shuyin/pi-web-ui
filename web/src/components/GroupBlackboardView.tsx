import { useState, useCallback, useEffect, useMemo } from "react";
import {
	FiEdit3,
	FiCheck,
	FiX,
	FiRefreshCw,
	FiFileText,
	FiClock,
	FiUser,
	FiCopy,
	FiLayers,
	FiCode,
	FiList,
	FiAlertTriangle,
} from "react-icons/fi";
import { Markdown } from "./Markdown";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n } from "../i18n";
import { useCopyFeedback } from "../use-copy-feedback";
import type { GroupBlackboard } from "../../../server/device-center/store";

export interface BlackboardSectionDef {
	id: string;
	titleZh: string;
	titleEn: string;
	aliases: string[];
}

export const PRESET_SECTIONS: BlackboardSectionDef[] = [
	{
		id: "architecture",
		titleZh: "架构设计",
		titleEn: "Architecture",
		aliases: ["架构设计", "系统架构", "architecture", "system architecture", "架构契约", "技术方案"],
	},
	{
		id: "contracts",
		titleZh: "接口契约",
		titleEn: "Contracts",
		aliases: ["接口契约", "接口规范", "contracts", "api contracts", "api规范", "协议契约", "数据契约"],
	},
	{
		id: "progress",
		titleZh: "任务分工",
		titleEn: "Task Progress",
		aliases: ["任务分工", "分工与进度", "progress", "tasks", "task progress", "流水线分工", "任务流水线"],
	},
	{
		id: "blockers",
		titleZh: "阻塞与决策",
		titleEn: "Blockers & Decisions",
		aliases: ["阻塞与决策", "决策记录", "blockers", "decisions", "风险与阻塞", "关键技术决策"],
	},
];

export interface ParsedSection {
	id: string;
	title: string;
	content: string;
	rawHeader: string;
}

export function parseMarkdownSections(markdown: string): { preamble: string; sections: ParsedSection[] } {
	if (!markdown || !markdown.trim()) return { preamble: "", sections: [] };

	const lines = markdown.split(/\r?\n/);
	const sections: ParsedSection[] = [];
	let currentTitle = "";
	let currentHeader = "";
	let currentLines: string[] = [];
	const preambleLines: string[] = [];
	let inFirstSection = false;

	for (const line of lines) {
		const match = line.match(/^##\s+(.+)$/);
		if (match) {
			const titleText = match[1].trim();
			if (!inFirstSection) {
				inFirstSection = true;
			} else {
				sections.push({
					id: resolveSectionId(currentTitle),
					title: currentTitle,
					content: currentLines.join("\n").trim(),
					rawHeader: currentHeader,
				});
				currentLines = [];
			}
			currentTitle = titleText;
			currentHeader = line;
			continue;
		}

		if (inFirstSection) {
			currentLines.push(line);
		} else {
			preambleLines.push(line);
		}
	}

	if (inFirstSection && currentTitle) {
		sections.push({
			id: resolveSectionId(currentTitle),
			title: currentTitle,
			content: currentLines.join("\n").trim(),
			rawHeader: currentHeader,
		});
	}

	return {
		preamble: preambleLines.join("\n").trim(),
		sections,
	};
}

function resolveSectionId(title: string): string {
	const lower = title.toLowerCase();
	for (const preset of PRESET_SECTIONS) {
		if (preset.aliases.some((alias) => lower.includes(alias.toLowerCase()))) {
			return preset.id;
		}
	}
	return `custom-${encodeURIComponent(title.slice(0, 32))}`;
}

export function assembleMarkdownSection(
	fullContent: string,
	sectionId: string,
	sectionTitle: string,
	newSectionContent: string,
): string {
	const { preamble, sections } = parseMarkdownSections(fullContent);
	const existingIdx = sections.findIndex((s) => s.id === sectionId);

	if (existingIdx >= 0) {
		sections[existingIdx].content = newSectionContent.trim();
	} else {
		sections.push({
			id: sectionId,
			title: sectionTitle,
			content: newSectionContent.trim(),
			rawHeader: `## ${sectionTitle}`,
		});
	}

	const parts: string[] = [];
	if (preamble) parts.push(preamble);
	for (const s of sections) {
		if (s.rawHeader) parts.push(s.rawHeader);
		else parts.push(`## ${s.title}`);
		if (s.content) parts.push(s.content);
	}
	return parts.join("\n\n");
}

interface GroupBlackboardViewProps {
	roomId: string;
	blackboard?: GroupBlackboard | null;
	disabled?: boolean;
	onSaved?: () => void;
}

export function GroupBlackboardView({ roomId, blackboard, disabled = false, onSaved }: GroupBlackboardViewProps) {
	const { locale } = useI18n();
	const zh = isZhLocale(locale);

	const [activeTab, setActiveTab] = useState<string>("all");
	const [isEditing, setIsEditing] = useState(false);
	const [title, setTitle] = useState(blackboard?.title ?? "");
	const [content, setContent] = useState(blackboard?.content ?? "");
	const [sectionContent, setSectionContent] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const { copied, copy } = useCopyFeedback({ duration: 1800 });

	const parsed = useMemo(() => parseMarkdownSections(blackboard?.content ?? ""), [blackboard?.content]);

	const availableTabs = useMemo(() => {
		const tabs: Array<{ id: string; label: string; count?: number; isCustom?: boolean }> = [
			{ id: "all", label: zh ? "全量共识" : "All Consensus" },
		];
		for (const preset of PRESET_SECTIONS) {
			const found = parsed.sections.find((s) => s.id === preset.id);
			tabs.push({
				id: preset.id,
				label: zh ? preset.titleZh : preset.titleEn,
				count: found?.content ? 1 : 0,
			});
		}
		for (const sec of parsed.sections) {
			if (!PRESET_SECTIONS.some((p) => p.id === sec.id)) {
				tabs.push({
					id: sec.id,
					label: sec.title,
					count: sec.content ? 1 : 0,
					isCustom: true,
				});
			}
		}
		return tabs;
	}, [parsed.sections, zh]);

	useEffect(() => {
		if (!isEditing) {
			setTitle(blackboard?.title ?? "");
			setContent(blackboard?.content ?? "");
		}
	}, [blackboard, isEditing]);

	const activeSection = useMemo(() => {
		if (activeTab === "all") return null;
		return parsed.sections.find((s) => s.id === activeTab) ?? null;
	}, [activeTab, parsed.sections]);

	const activePresetDef = useMemo(() => {
		return PRESET_SECTIONS.find((p) => p.id === activeTab);
	}, [activeTab]);

	const handleStartEdit = useCallback(() => {
		setError(null);
		if (activeTab === "all") {
			setTitle(blackboard?.title ?? "");
			setContent(blackboard?.content ?? "");
		} else {
			const existing = parsed.sections.find((s) => s.id === activeTab);
			setSectionContent(existing?.content ?? "");
		}
		setIsEditing(true);
	}, [activeTab, blackboard, parsed.sections]);

	const handleCancelEdit = useCallback(() => {
		setIsEditing(false);
		setError(null);
		if (activeTab === "all") {
			setTitle(blackboard?.title ?? "");
			setContent(blackboard?.content ?? "");
		} else {
			setSectionContent("");
		}
	}, [activeTab, blackboard]);

	const handleSave = useCallback(async () => {
		setSaving(true);
		setError(null);
		try {
			const expectedVersion = blackboard?.version ?? 0;

			if (activeTab !== "all") {
				let sectionSaved = false;
				try {
					const secRes = await fetch(
						withToken(
							appUrl(
								`/api/device-center/rooms/${encodeURIComponent(roomId)}/blackboard/sections/${encodeURIComponent(activeTab)}`,
							),
						),
						{
							method: "PUT",
							credentials: "same-origin",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								content: sectionContent,
								expectedVersion,
							}),
						},
					);
					if (secRes.ok) {
						sectionSaved = true;
					}
				} catch {}

				if (!sectionSaved) {
					const sectionTitle = activePresetDef
						? zh
							? activePresetDef.titleZh
							: activePresetDef.titleEn
						: activeSection?.title || activeTab;

					const newFullContent = assembleMarkdownSection(
						blackboard?.content ?? "",
						activeTab,
						sectionTitle,
						sectionContent,
					);

					const fullRes = await fetch(
						withToken(appUrl(`/api/device-center/rooms/${encodeURIComponent(roomId)}/blackboard`)),
						{
							method: "PUT",
							credentials: "same-origin",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								title: blackboard?.title || undefined,
								content: newFullContent,
								expectedVersion,
							}),
						},
					);

					const data = await fullRes.json().catch(() => ({}));
					if (!fullRes.ok) {
						if (fullRes.status === 409) {
							throw new Error(
								zh
									? "黑板已被其他成员更新，版本发生冲突，请刷新后重试。"
									: "Blackboard has been updated by another member (version conflict). Refresh and retry.",
							);
						}
						throw new Error(data.error || String(fullRes.status));
					}
				}
			} else {
				if (!content.trim()) {
					setError(zh ? "黑板内容不能为空" : "Blackboard content cannot be empty");
					setSaving(false);
					return;
				}

				const response = await fetch(
					withToken(appUrl(`/api/device-center/rooms/${encodeURIComponent(roomId)}/blackboard`)),
					{
						method: "PUT",
						credentials: "same-origin",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							title: title.trim() || undefined,
							content,
							expectedVersion,
						}),
					},
				);

				const data = await response.json().catch(() => ({}));
				if (!response.ok) {
					if (response.status === 409) {
						throw new Error(
							zh
								? "黑板已被其他成员更新，版本发生冲突，请刷新后重试。"
								: "Blackboard has been updated by another member (version conflict). Refresh and retry.",
						);
					}
					throw new Error(data.error || String(response.status));
				}
			}

			setIsEditing(false);
			onSaved?.();
		} catch (err: any) {
			setError(err?.message || (zh ? "保存黑板失败" : "Failed to save blackboard"));
		} finally {
			setSaving(false);
		}
	}, [activeTab, blackboard, content, sectionContent, title, roomId, zh, activePresetDef, activeSection, onSaved]);

	const currentContentToCopy = useMemo(() => {
		if (activeTab === "all") return blackboard?.content ?? "";
		return activeSection?.content ?? "";
	}, [activeTab, blackboard?.content, activeSection?.content]);

	const formattedTime = blackboard?.updatedAt
		? new Date(blackboard.updatedAt).toLocaleTimeString(locale, {
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			})
		: "";

	const renderPlaceholder = (tabId: string) => {
		switch (tabId) {
			case "architecture":
				return zh
					? "架构设计与技术栈决策规范\n\n例如：\n- 系统分层与目录拓扑\n- 事件模型与状态机规范\n- 核心数据流驱动方式"
					: "Architecture & System Design\n\ne.g.\n- Topology & Layering\n- Event & State Machine\n- Core Data Flow";
			case "contracts":
				return zh
					? "接口契约与数据模型定义\n\n例如：\n- REST / RPC 接口路由与方法\n- 请求入参和响应出参 JSON Schema\n- 错误码与异常契约"
					: "Interface Contracts & Schemas\n\ne.g.\n- Endpoints & Methods\n- Request & Response Schemas\n- Error Codes";
			case "progress":
				return zh
					? "任务流水线分工与进度追踪\n\n例如：\n- [ ] @BotA: 数据层适配与测试\n- [ ] @BotB: 业务层实现\n- [ ] @BotC: 验证与交付物汇总"
					: "Task Pipeline & Assignments\n\ne.g.\n- [ ] @BotA: Data layer\n- [ ] @BotB: Business logic\n- [ ] @BotC: Verification";
			case "blockers":
				return zh
					? "阻塞卡点与关键技术决策记录 (ADR)\n\n例如：\n- 决策：采用 SSE 替代长轮询\n- 阻塞：依赖的设备驱动尚未注册"
					: "Blockers & Architecture Decision Records (ADR)\n\ne.g.\n- Decision: Use SSE instead of polling\n- Blocker: Missing device driver";
			default:
				return zh ? "在此输入该分区的 Markdown 格式内容..." : "Enter Markdown content for this section...";
		}
	};

	return (
		<div className="dg-blackboard-view">
			<div className="dg-blackboard-header">
				<div className="dg-blackboard-meta">
					<span className="dg-blackboard-badge" title={zh ? "黑板协议版本" : "Protocol version"}>
						{blackboard?.version ? `v${blackboard.version}` : zh ? "未初始化" : "Initial"}
					</span>
					{blackboard?.updatedBy && (
						<span className="dg-blackboard-updater" title={zh ? "最后更新者" : "Last updated by"}>
							<FiUser style={{ marginRight: 4 }} />
							{blackboard.updatedBy.name} ({blackboard.updatedBy.type === "bot" ? "Bot" : zh ? "人工" : "Human"})
						</span>
					)}
					{formattedTime && (
						<span className="dg-blackboard-time" title={zh ? "更新时间" : "Updated at"}>
							<FiClock style={{ marginRight: 4 }} />
							{formattedTime}
						</span>
					)}
				</div>
				<div className="dg-blackboard-actions">
					<button
						type="button"
						className="btn secondary sm"
						onClick={() => copy(currentContentToCopy)}
						disabled={!currentContentToCopy.trim()}
						title={zh ? "复制当前查看的黑板内容" : "Copy current content to clipboard"}
					>
						{copied ? (
							<FiCheck style={{ color: "var(--green)", marginRight: 4 }} />
						) : (
							<FiCopy style={{ marginRight: 4 }} />
						)}
						{copied ? (zh ? "已复制" : "Copied") : zh ? "复制" : "Copy"}
					</button>

					{!isEditing ? (
						<button
							type="button"
							className="btn secondary sm"
							onClick={handleStartEdit}
							disabled={disabled}
							title={zh ? "编辑黑板内容" : "Edit blackboard content"}
						>
							<FiEdit3 style={{ marginRight: 4 }} />
							{activeTab === "all" ? (zh ? "编辑共识" : "Edit All") : zh ? "编辑此分区" : "Edit Section"}
						</button>
					) : (
						<div className="dg-edit-btn-group">
							<button type="button" className="btn secondary sm" onClick={handleCancelEdit} disabled={saving}>
								<FiX style={{ marginRight: 4 }} />
								{zh ? "取消" : "Cancel"}
							</button>
							<button
								type="button"
								className="btn primary sm"
								onClick={handleSave}
								disabled={saving || (activeTab === "all" ? !content.trim() : !sectionContent.trim())}
							>
								{saving ? (
									<FiRefreshCw className="spin" style={{ marginRight: 4 }} />
								) : (
									<FiCheck style={{ marginRight: 4 }} />
								)}
								{saving ? (zh ? "保存中..." : "Saving...") : zh ? "提交保存" : "Save"}
							</button>
						</div>
					)}
				</div>
			</div>

			<div className="dg-bb-tabs" role="tablist">
				{availableTabs.map((tab) => {
					const isActive = activeTab === tab.id;
					return (
						<button
							key={tab.id}
							type="button"
							role="tab"
							aria-selected={isActive}
							className={`dg-bb-tab ${isActive ? "active" : ""}`}
							onClick={() => {
								if (isEditing) handleCancelEdit();
								setActiveTab(tab.id);
							}}
						>
							{tab.id === "all" && <FiLayers style={{ marginRight: 4 }} />}
							{tab.id === "architecture" && <FiLayers style={{ marginRight: 4 }} />}
							{tab.id === "contracts" && <FiCode style={{ marginRight: 4 }} />}
							{tab.id === "progress" && <FiList style={{ marginRight: 4 }} />}
							{tab.id === "blockers" && <FiAlertTriangle style={{ marginRight: 4 }} />}
							<span>{tab.label}</span>
							{tab.count !== undefined && tab.count > 0 && <span className="dg-bb-tab-dot" />}
						</button>
					);
				})}
			</div>

			{error && (
				<div className="dg-error-banner" role="alert">
					{error}
				</div>
			)}

			{isEditing ? (
				<div className="dg-blackboard-editor">
					{activeTab === "all" ? (
						<>
							<div className="dg-editor-field">
								<label className="dg-field-label">{zh ? "共识主题 / 标题 (可选)" : "Title / Subject (Optional)"}</label>
								<input
									type="text"
									className="dg-input"
									placeholder={zh ? "例如：系统统一重构规范 (RFC-089)" : "e.g. Unified System Redesign RFC"}
									value={title}
									onChange={(e) => setTitle(e.target.value)}
									maxLength={200}
									disabled={saving}
								/>
							</div>
							<div className="dg-editor-field">
								<div className="dg-field-header">
									<label className="dg-field-label">
										{zh ? "结构化 Markdown 全量内容" : "Structured Markdown Content"}
									</label>
									<span className="dg-field-bytes">{new TextEncoder().encode(content).length} bytes</span>
								</div>
								<textarea
									className="dg-textarea"
									rows={14}
									placeholder={
										zh
											? "# 群组共享共识\n\n## 架构设计\n- 统一事件模型\n- 接口规范定义\n\n## 任务分工\n- [ ] BotA: 调研接口\n- [ ] BotB: 实现测试"
											: "# Shared Consensus\n\n## Architecture\n- Unified event model\n\n## Pipeline\n- [ ] BotA: Draft interfaces"
									}
									value={content}
									onChange={(e) => setContent(e.target.value)}
									disabled={saving}
								/>
							</div>
						</>
					) : (
						<div className="dg-editor-field">
							<div className="dg-field-header">
								<label className="dg-field-label">
									{zh
										? `编辑分区：${activePresetDef ? activePresetDef.titleZh : activeSection?.title || activeTab}`
										: `Edit Section: ${activePresetDef ? activePresetDef.titleEn : activeSection?.title || activeTab}`}
								</label>
								<span className="dg-field-bytes">{new TextEncoder().encode(sectionContent).length} bytes</span>
							</div>
							<textarea
								className="dg-textarea"
								rows={12}
								placeholder={renderPlaceholder(activeTab)}
								value={sectionContent}
								onChange={(e) => setSectionContent(e.target.value)}
								disabled={saving}
							/>
						</div>
					)}
				</div>
			) : (
				<div className="dg-blackboard-content">
					{activeTab === "all" ? (
						<>
							{blackboard?.title && <h3 className="dg-blackboard-title">{blackboard.title}</h3>}
							{blackboard?.content ? (
								<div className="dg-blackboard-markdown">
									<Markdown text={blackboard.content} />
								</div>
							) : (
								<div className="dg-blackboard-empty">
									<FiFileText style={{ fontSize: 32, opacity: 0.4, marginBottom: 8 }} />
									<p>
										{zh
											? "当前群组黑板为空。点击右上角“编辑共识”为所有协作 Bot 确立技术架构契约与长期记忆。"
											: "Blackboard is empty. Click 'Edit All' to set shared contracts and long-term memory."}
									</p>
								</div>
							)}
						</>
					) : (
						<>
							<div className="dg-bb-section-header">
								<h4 className="dg-bb-section-title">
									{activePresetDef
										? zh
											? activePresetDef.titleZh
											: activePresetDef.titleEn
										: activeSection?.title || activeTab}
								</h4>
							</div>
							{activeSection?.content ? (
								<div className="dg-blackboard-markdown">
									<Markdown text={activeSection.content} />
								</div>
							) : (
								<div className="dg-blackboard-empty">
									<FiFileText style={{ fontSize: 32, opacity: 0.4, marginBottom: 8 }} />
									<p>
										{zh
											? "该分区当前尚无记录内容。点击右上角“编辑此分区”快速添加共识与规则。"
											: "No content in this section yet. Click 'Edit Section' to add consensus and specifications."}
									</p>
								</div>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}
